# koinsight-booklore-bridge

Sends your KOReader reading statistics, highlights and notes into [BookLore](https://github.com/booklore-app/booklore), using [KoInsight](https://github.com/Ko-Insight/KoInsight) as the transport.

BookLore already syncs your reading **position** with KOReader, but nothing else: it never learns how long you read, and highlights made on the e-reader stay on the e-reader. This bridge fills that gap **without forking BookLore or swapping its image** — it only talks to the APIs the official build already exposes.

```
KOReader ──plugin──> KoInsight ──bridge──> BookLore
 statistics.sqlite    page stats           reading_sessions (heatmap, timeline)
 highlights/notes     annotations          annotations (highlights in the reader)
```

## What it does

- **Reading sessions.** Page statistics are grouped into sessions, split per device and cut on any pause longer than `GAP_MINUTES`. Session length is the **sum of per-page reading times**, not `end - start`, so a book left open on the table does not inflate your stats.
- **Highlights and notes.** KOReader XPointers are converted into EPUB CFIs, so highlights land on the right words inside BookLore's web reader, keeping color, style, note and chapter title.
- **No duplicates.** BookLore's API happily accepts the same session twice, so the bridge only imports sessions that have *cooled down* (nothing new for `GAP_MINUTES`) and keeps a watermark per book *and* device in `state.json`.

## How books are matched

By KOReader's **partial md5**, which is exactly what BookLore stores in `book_file.current_hash` — the same value its KOReader progress sync already relies on. Matching is therefore exact, with no title/author guessing.

The practical consequence: **the file on your e-reader must be the same file BookLore has**. Send books to the device from BookLore (OPDS or download) and everything matches; a copy downloaded elsewhere hashes differently and is skipped, with a line in the log saying so.

## Requirements

- BookLore (tested on 2.3.1) with `reading_sessions` support — its `POST /api/v1/reading-sessions` endpoint is what receives the data
- KoInsight, with the KoInsight plugin installed in KOReader
- Read access to BookLore's MariaDB (a `SELECT`, see below)
- The book library mounted read-only, if you want highlights

### Why it touches the database

BookLore exposes no endpoint that answers *"which book has this md5?"* — its `by-hash` endpoints only exist in a third-party fork. So the md5 → `book_id` lookup is a read-only `SELECT` against `book_file`. Everything the bridge **writes** goes through the regular HTTP API, authenticated as a normal user.

## Running it

Prebuilt images (`linux/amd64` and `linux/arm64`) are published on every push to `main`:

```
ghcr.io/lucasalbini/koinsight-booklore-bridge:latest
```

Docker Compose: copy `docker-compose.yml`, fill in the credentials and paths, then `docker compose up -d`.

Unraid: point the template at the image above, or build it yourself and use `local/koinsight-bridge:1.1`.

```bash
cp unraid/my-KoInsightBridge.xml /boot/config/plugins/dockerMan/templates-user/
# building from source instead of pulling:
docker build -t local/koinsight-bridge:1.1 .
```

Start with `DRY_RUN=1` to see what would be imported without writing anything.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KOINSIGHT_URL` | `http://KoInsight:3000` | KoInsight base URL |
| `BOOKLORE_URL` | `http://BookLore:6060` | BookLore base URL |
| `BOOKLORE_USER` / `BOOKLORE_PASS` | — | BookLore account that will own the sessions |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASS` | `MariaDB` / `3306` / `booklore` / `booklore` / — | BookLore's database, read-only |
| `GAP_MINUTES` | `30` | A pause longer than this closes a session |
| `INTERVAL_SECONDS` | `900` | Seconds between cycles |
| `MIN_SESSION_SECONDS` | `30` | Drops sessions shorter than this (0 imports everything) |
| `SYNC_ANNOTATIONS` | `1` | Set to `0` for reading sessions only |
| `LIBRARY_ROOT` | `/books` | Where the library is mounted inside the container |
| `DRY_RUN` | `0` | `1` logs what would be imported, writes nothing |
| `RUN_ONCE` | `0` | `1` runs a single cycle and exits (handy for cron) |
| `STATE_PATH` | `/data/state.json` | Where the watermark lives |

## The XPointer to CFI conversion

KOReader marks positions with XPointers (`/body/DocFragment[7]/body/div/p[21]/text().0`); BookLore uses EPUB CFIs. `epubcfi.js` reimplements BookLore's own `CfiConvertor.java` so both sides agree, quirks included:

- the last indexed segment resolves **globally** in the chapter (KOReader numbers elements per tag across the whole DocFragment, not among siblings);
- each CFI step is the element's position among its parent's element children times two, with `/4` for the body;
- `DocFragment[N]` is the Nth spine item, so the spine step is `(N) * 2`.

One deliberate divergence: **ranges are emitted in the spec's three-part form**, `epubcfi(parent,start,end)`. BookLore's Java converter produces a two-part variant, but its own reader rejects that — `selection.service.ts` discards any CFI without exactly two relative parts, and foliate-js only paints highlights in the three-part shape.

| Case | Output |
|---|---|
| Range inside one paragraph | `epubcfi(/6/14!/4/42,/1:0,/1:73)` |
| Single point | `epubcfi(/6/14!/4/42/1:10)` |
| Range across paragraphs | `epubcfi(/6/14!/4,/42/1:5,/44/1:40)` |

`selftest.js` checks this against a real book: it builds XPointers the way KOReader would, converts them and walks the CFI back to the element, which must be the same one.

```bash
docker run --rm -v /path/to/books:/books:ro local/koinsight-bridge:1.1 \
  node /app/selftest.js "/books/Author/Book.epub" p 5
```

## Limitations

- **EPUB only** for highlights. In PDFs KOReader stores page coordinates, which belong to a different BookLore endpoint (`PdfAnnotationController`). Those are logged as skipped.
- **KOReader only uploads annotations for the book currently open** when syncing; the KoInsight plugin has a bulk option for the backlog.
- Sessions are imported after they cool down, so the last one you read shows up on the next cycle rather than instantly.
- An annotation that fails to convert is recorded in `state.json` with its reason and is not retried, to keep the log clean. Delete its entry to try again.
- Reading **position** sync is untouched — that is BookLore's own KOReader progress sync and it stays as it is.

## Credits and license

- [BookLore](https://github.com/booklore-app/booklore) — `epubcfi.js` is a port of its `CfiConvertor.java`
- [KoInsight](https://github.com/Ko-Insight/KoInsight) — statistics dashboard and the KOReader plugin that feeds it
- [KOReader](https://github.com/koreader/koreader)

Licensed under **GPL-3.0**, matching BookLore, since the CFI conversion derives from its code. See [LICENSE](LICENSE).
