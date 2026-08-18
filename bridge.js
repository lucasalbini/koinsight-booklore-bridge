#!/usr/bin/env node
/*
 * KoInsight -> BookLore bridge
 *
 * Reads the per-page reading statistics KOReader uploaded to KoInsight, groups
 * them into reading sessions and pushes them to BookLore through
 * POST /api/v1/reading-sessions. Highlights and notes are converted from
 * KOReader XPointers to EPUB CFIs and pushed to POST /api/v1/annotations.
 *
 * Books are matched by KOReader's partial md5, which is the very same value
 * BookLore stores in book_file.current_hash (the one its progress sync already
 * relies on). Books with no match are skipped.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const epubcfi = require('./epubcfi');

const cfg = {
  koinsightUrl: (process.env.KOINSIGHT_URL || 'http://KoInsight:3000').replace(/\/$/, ''),
  bookloreUrl: (process.env.BOOKLORE_URL || 'http://BookLore:6060').replace(/\/$/, ''),
  bookloreUser: process.env.BOOKLORE_USER,
  booklorePass: process.env.BOOKLORE_PASS,
  dbHost: process.env.DB_HOST || 'MariaDB',
  dbPort: process.env.DB_PORT || '3306',
  dbName: process.env.DB_NAME || 'booklore',
  dbUser: process.env.DB_USER || 'booklore',
  dbPass: process.env.DB_PASS,
  gapSeconds: Number(process.env.GAP_MINUTES || 30) * 60,
  minSessionSeconds: Number(process.env.MIN_SESSION_SECONDS || 30),
  intervalSeconds: Number(process.env.INTERVAL_SECONDS || 900),
  libraryRoot: process.env.LIBRARY_ROOT || '/books',
  syncAnnotations: !/^(0|false|no)$/i.test(process.env.SYNC_ANNOTATIONS || '1'),
  dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN || ''),
  runOnce: /^(1|true|yes)$/i.test(process.env.RUN_ONCE || ''),
  statePath: process.env.STATE_PATH || '/data/state.json',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(cfg.statePath, 'utf8'));
  } catch {
    state = {};
  }
  state.imported = state.imported || {};
  state.annotations = state.annotations || {};
  return state;
}

function saveState(state) {
  if (cfg.dryRun) return;
  fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 2));
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* Groups a book's page stats into sessions, keeping devices apart: two devices
 * reading the same book must not collapse into a single session. */
function buildSessions(book) {
  const stats = (book.stats || []).slice().sort((a, b) => a.start_time - b.start_time);
  const byDevice = new Map();
  for (const s of stats) {
    const key = s.device_id || 'unknown';
    if (!byDevice.has(key)) byDevice.set(key, []);
    byDevice.get(key).push(s);
  }

  const sessions = [];
  for (const [device, list] of byDevice) {
    let cur = null;
    for (const s of list) {
      const start = Math.floor(s.start_time / 1000);
      const duration = Number(s.duration) || 0;
      if (cur && start - cur.end <= cfg.gapSeconds) {
        cur.end = Math.max(cur.end, start + duration);
        cur.duration += duration;
        cur.endPage = s.page;
        if (s.total_pages) cur.totalPages = s.total_pages;
      } else {
        if (cur) sessions.push(cur);
        cur = {
          md5: book.md5,
          title: book.title,
          device,
          start,
          end: start + duration,
          duration,
          startPage: s.page,
          endPage: s.page,
          totalPages: s.total_pages || book.total_pages || 0,
        };
      }
    }
    if (cur) sessions.push(cur);
  }
  return sessions;
}

/* KOReader md5 -> BookLore book_id. BookLore exposes no public endpoint for
 * this lookup, so it is a read-only query straight against its MariaDB. */
function resolveBooks(hashes) {
  const map = new Map();
  if (!hashes.length) return map;
  const inList = hashes.map((h) => `'${h.replace(/[^a-f0-9]/gi, '')}'`).join(',');
  const sql = `SELECT bf.current_hash, bf.book_id, COALESCE(bf.book_type,'EPUB'),
                      COALESCE(lp.path,''), COALESCE(bf.file_sub_path,''), bf.file_name
               FROM book_file bf
               JOIN book b ON b.id = bf.book_id
               LEFT JOIN library_path lp ON lp.id = b.library_path_id
               WHERE bf.current_hash IN (${inList})`;
  let out;
  try {
    out = execFileSync(
      'mariadb',
      ['-h', cfg.dbHost, '-P', String(cfg.dbPort), '-u', cfg.dbUser, '-D', cfg.dbName,
        '--batch', '--skip-column-names', '-e', sql],
      /* stderr is captured so the client's TLS notice does not repeat every cycle */
      { env: { ...process.env, MYSQL_PWD: cfg.dbPass }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    throw new Error(`MariaDB query failed: ${(err.stderr || err.message).toString().trim()}`);
  }
  for (const line of out.split('\n')) {
    const [hash, bookId, bookType, libraryPath, subPath, fileName] = line.split('\t');
    if (!hash || !bookId) continue;
    /* The stored path is BookLore's own (e.g. /books/...); here the library is
     * mounted at LIBRARY_ROOT, so only the prefix differs. */
    const relative = [subPath, fileName].filter(Boolean).join('/');
    map.set(hash, {
      bookId: Number(bookId),
      bookType,
      filePath: libraryPath ? `${cfg.libraryRoot}/${relative}` : null,
    });
  }
  return map;
}

async function login() {
  const res = await fetch(`${cfg.bookloreUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.bookloreUser, password: cfg.booklorePass }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('login response had no accessToken');
  return data.accessToken;
}

async function postSession(token, session, target) {
  const pct = (page) => (session.totalPages ? Number(((page / session.totalPages) * 100).toFixed(2)) : null);
  const startProgress = pct(session.startPage);
  const endProgress = pct(session.endPage);
  const body = {
    bookId: target.bookId,
    bookType: target.bookType,
    startTime: new Date(session.start * 1000).toISOString(),
    endTime: new Date(session.end * 1000).toISOString(),
    durationSeconds: session.duration,
    durationFormatted: formatDuration(session.duration),
    startProgress,
    endProgress,
    progressDelta:
      startProgress != null && endProgress != null
        ? Number((endProgress - startProgress).toFixed(2))
        : null,
  };
  const res = await fetch(`${cfg.bookloreUrl}/api/v1/reading-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} while saving session`);
}

/* KOReader names its colors; BookLore validates hex (^#[0-9A-Fa-f]{6}$). */
const COLOR_HEX = {
  yellow: '#FACC15', red: '#EF4444', blue: '#3B82F6', green: '#22C55E',
  purple: '#A855F7', orange: '#F97316', gray: '#9CA3AF', grey: '#9CA3AF',
};

/* KOReader drawer -> style accepted by BookLore */
const DRAWER_STYLE = {
  lighten: 'highlight', underscore: 'underline', strikeout: 'strikethrough',
  invert: 'highlight', squiggly: 'squiggly',
};

function annotationKey(a) {
  return [a.book_md5, a.datetime, a.page_ref || a.pos0 || ''].join('|');
}

async function postAnnotation(token, body) {
  const res = await fetch(`${cfg.bookloreUrl}/api/v1/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    const duplicate = /duplicate|constraint|already exists/i.test(detail);
    throw Object.assign(new Error(`HTTP ${res.status} ${detail}`), { duplicate });
  }
}

async function importAnnotations(books, state, tokenFactory) {
  const pending = [];
  for (const book of books) {
    for (const annotation of book.annotations || []) {
      const key = annotationKey({ ...annotation, book_md5: book.md5 });
      if (state.annotations[key]) continue;
      pending.push({ ...annotation, md5: book.md5, title: book.title, key });
    }
  }
  if (!pending.length) return;

  const targets = resolveBooks([...new Set(pending.map((a) => a.md5))]);
  const spineCache = new Map();
  let imported = 0;
  let failed = 0;
  let token = null;

  for (const annotation of pending) {
    const target = targets.get(annotation.md5);
    const text = (annotation.text || annotation.note || '').trim();
    try {
      if (!target) throw new Error('no matching book in BookLore');
      if (!text) throw new Error('annotation has no text (likely a bookmark)');
      if (target.bookType !== 'EPUB') throw new Error(`${target.bookType} is not supported yet`);
      if (!target.filePath || !fs.existsSync(target.filePath)) {
        throw new Error(`file not found at ${target.filePath}`);
      }
      const pos0 = annotation.pos0 || annotation.page_ref;
      if (!pos0) throw new Error('annotation has no position');

      if (!spineCache.has(target.filePath)) {
        spineCache.set(target.filePath, epubcfi.loadSpine(target.filePath));
      }
      const cfi = epubcfi.xPointerToCfi(target.filePath, spineCache.get(target.filePath), pos0, annotation.pos1);

      const body = {
        bookId: target.bookId,
        cfi,
        text: text.slice(0, 5000),
        color: COLOR_HEX[(annotation.color || '').toLowerCase()] || '#FACC15',
        style: DRAWER_STYLE[(annotation.drawer || '').toLowerCase()] || 'highlight',
        note: annotation.note ? annotation.note.slice(0, 5000) : undefined,
        chapterTitle: annotation.chapter ? annotation.chapter.slice(0, 500) : undefined,
      };

      if (cfg.dryRun) {
        log(`  [dry run] highlight book ${target.bookId} "${annotation.title}" ${cfi} :: ${text.slice(0, 60)}`);
        imported++;
        continue;
      }

      token = token || (await tokenFactory());
      await postAnnotation(token, body);
      state.annotations[annotation.key] = { status: 'ok', cfi };
      imported++;
      log(`  highlight imported: book ${target.bookId} "${annotation.title}" ${cfi}`);
    } catch (err) {
      if (err.duplicate) {
        state.annotations[annotation.key] = { status: 'ok', duplicate: true };
        continue;
      }
      failed++;
      /* Record the reason so the same attempt (and log line) is not repeated every cycle. */
      if (!cfg.dryRun) state.annotations[annotation.key] = { status: 'failed', reason: err.message };
      log(`  highlight skipped ("${annotation.title}"): ${err.message}`);
    }
  }

  if (imported || failed) {
    log(`highlights: ${imported} imported${cfg.dryRun ? ' (dry run)' : ''}, ${failed} skipped`);
  }
}

async function cycle() {
  const res = await fetch(`${cfg.koinsightUrl}/api/books`);
  if (!res.ok) throw new Error(`KoInsight answered HTTP ${res.status}`);
  const books = await res.json();

  const state = loadState();
  const now = Math.floor(Date.now() / 1000);
  const candidates = [];
  const open = [];

  for (const book of books) {
    for (const session of buildSessions(book)) {
      /* Watermark per book AND device: a device syncing older data later must
       * not be blocked by another device having moved ahead. */
      const already = state.imported[`${session.md5}|${session.device}`] || 0;
      if (session.end <= already) continue;
      /* The session may still grow: only import once it has cooled down,
       * otherwise the same reading would be sent twice (the API does not
       * deduplicate). */
      if (session.end > now - cfg.gapSeconds) { open.push(session); continue; }
      if (session.duration < cfg.minSessionSeconds) continue;
      candidates.push(session);
    }
  }

  let cachedToken = null;
  const getToken = async () => {
    if (!cachedToken) cachedToken = await login();
    return cachedToken;
  };

  if (!candidates.length) {
    log(`nothing new (${books.length} books in KoInsight, ${open.length} sessions still open)`);
    if (cfg.syncAnnotations) {
      await importAnnotations(books, state, getToken);
      saveState(state);
    }
    return;
  }

  const targets = resolveBooks([...new Set(candidates.map((s) => s.md5))]);
  let imported = 0;
  let skipped = 0;
  const token = cfg.dryRun ? null : await getToken();

  for (const session of candidates.sort((a, b) => a.start - b.start)) {
    const target = targets.get(session.md5);
    const when = new Date(session.start * 1000).toISOString().replace('T', ' ').slice(0, 16);
    if (!target) {
      skipped++;
      log(`  skipped (no matching book in BookLore): ${session.title} [${session.md5.slice(0, 8)}] ${when} ${formatDuration(session.duration)}`);
      continue;
    }
    if (cfg.dryRun) {
      log(`  [dry run] book ${target.bookId} "${session.title}" ${when} ${formatDuration(session.duration)} pages ${session.startPage}->${session.endPage}`);
      imported++;
      continue;
    }
    await postSession(token, session, target);
    const key = `${session.md5}|${session.device}`;
    state.imported[key] = Math.max(state.imported[key] || 0, session.end);
    imported++;
    log(`  imported: book ${target.bookId} "${session.title}" ${when} ${formatDuration(session.duration)}`);
  }

  if (cfg.syncAnnotations) await importAnnotations(books, state, getToken);

  saveState(state);
  log(`cycle done: ${imported} sessions${cfg.dryRun ? ' (dry run)' : ''}, ${skipped} skipped, ${open.length} still open`);
}

async function main() {
  if (!cfg.bookloreUser || !cfg.booklorePass) throw new Error('BOOKLORE_USER/BOOKLORE_PASS are not set');
  if (!cfg.dbPass) throw new Error('DB_PASS is not set');
  log(`bridge started (gap=${cfg.gapSeconds / 60}min, interval=${cfg.intervalSeconds}s, dry_run=${cfg.dryRun})`);
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      log('error:', err.message);
    }
    if (cfg.runOnce) return;
    await new Promise((r) => setTimeout(r, cfg.intervalSeconds * 1000));
  }
}

main().catch((err) => {
  log('fatal:', err.message);
  process.exit(1);
});
