/*
 * XPointer (KOReader) -> EPUB CFI (BookLore) conversion.
 *
 * Mirrors org.booklore.util.koreader.CfiConvertor from BookLore, quirks
 * included: the last indexed XPointer segment is resolved globally within the
 * document (KOReader numbers elements per tag across the whole DocFragment,
 * not among siblings), each CFI step is the element's position among its
 * parent's element children times two, and /4 stands for the body.
 *
 * Ranges are emitted in the spec's three-part form,
 * epubcfi(parent,start_offset,end_offset), which is what BookLore's reader
 * expects: selection.service.ts drops any CFI that does not carry exactly two
 * relative parts, and foliate-js only paints a highlight in that shape. Note
 * that BookLore's own Java converter emits a two-part variant instead.
 */

const { execFileSync } = require('child_process');
const { parseHTML } = require('linkedom');

const XPOINTER_RE = /^\/body\/DocFragment\[(\d+)\]\/body(.*)$/;
const TEXT_OFFSET_RE = /\/text\(\)\.(\d+)$/;
const SEGMENT_INDEXED_RE = /^(\w+)\[(\d+)\]$/;

function unzipEntry(epubPath, entry) {
  return execFileSync('unzip', ['-p', epubPath, entry], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveRelative(basePath, href) {
  const baseDir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : '';
  const parts = (baseDir ? baseDir.split('/') : []).concat(decodeURIComponent(href).split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/* Spine order from the OPF: KOReader's DocFragment[N] is the Nth spine item. */
function loadSpine(epubPath) {
  const container = unzipEntry(epubPath, 'META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('container.xml has no full-path');
  const opf = unzipEntry(epubPath, opfPath);

  const manifest = new Map();
  for (const match of opf.matchAll(/<item\s[^>]*>/g)) {
    const id = /\sid="([^"]+)"/.exec(match[0])?.[1];
    const href = /\shref="([^"]+)"/.exec(match[0])?.[1];
    if (id && href) manifest.set(id, href);
  }

  const spine = [];
  for (const match of opf.matchAll(/<itemref\s[^>]*>/g)) {
    const idref = /\sidref="([^"]+)"/.exec(match[0])?.[1];
    if (idref && manifest.has(idref)) spine.push(resolveRelative(opfPath, manifest.get(idref)));
  }
  if (!spine.length) throw new Error('empty spine in OPF');
  return spine;
}

function loadSpineDocument(epubPath, spine, spineIndex) {
  if (spineIndex < 0 || spineIndex >= spine.length) {
    throw new Error(`DocFragment outside the spine (index ${spineIndex}, spine has ${spine.length})`);
  }
  const { document } = parseHTML(unzipEntry(epubPath, spine[spineIndex]));
  return document;
}

function resolveXPointerElement(document, elementPath) {
  const body = document.body;
  if (!body) throw new Error('document has no body');

  const segments = elementPath.split('/').filter(Boolean);
  if (!segments.length) return body;

  const last = segments[segments.length - 1];
  const indexed = SEGMENT_INDEXED_RE.exec(last);
  if (indexed) {
    const all = body.querySelectorAll(indexed[1]);
    const index = Number(indexed[2]) - 1;
    if (index < 0 || index >= all.length) {
      throw new Error(`${indexed[1]}[${indexed[2]}] out of range (${all.length} found)`);
    }
    return all[index];
  }

  let current = body;
  for (const segment of segments) {
    const withIndex = SEGMENT_INDEXED_RE.exec(segment);
    const tag = (withIndex ? withIndex[1] : segment).toLowerCase();
    const index = withIndex ? Number(withIndex[2]) - 1 : 0;
    const matching = [...current.children].filter((c) => c.tagName.toLowerCase() === tag);
    if (index >= matching.length) throw new Error(`segment ${segment} not found`);
    current = matching[index];
  }
  return current;
}

function buildCfiPath(element) {
  const parts = [];
  let current = element;
  while (current && current.tagName && current.tagName.toLowerCase() !== 'body') {
    const parent = current.parentElement;
    if (!parent) break;
    let position = 0;
    for (const sibling of parent.children) {
      position++;
      if (sibling === current) break;
    }
    parts.unshift(`/${position * 2}`);
    current = parent;
  }
  parts.unshift('/4');
  return parts.join('');
}

function parseXPointer(xpointer) {
  const offsetMatch = TEXT_OFFSET_RE.exec(xpointer);
  const textOffset = offsetMatch ? Number(offsetMatch[1]) : null;
  const withoutOffset = xpointer.replace(TEXT_OFFSET_RE, '');
  const match = XPOINTER_RE.exec(withoutOffset);
  if (!match) throw new Error(`unexpected XPointer format: ${xpointer}`);
  return { spineIndex: Number(match[1]) - 1, elementPath: match[2] || '', textOffset };
}

/* Converts a KOReader pos0/pos1 pair into the CFI BookLore's reader understands. */
function xPointerToCfi(epubPath, spine, pos0, pos1) {
  const start = parseXPointer(pos0);
  const document = loadSpineDocument(epubPath, spine, start.spineIndex);
  const spineStep = (start.spineIndex + 1) * 2;

  const elementPathOf = (parsed) => buildCfiPath(resolveXPointerElement(document, parsed.elementPath));
  const offsetOf = (parsed) => (parsed.textOffset != null ? `/1:${parsed.textOffset}` : '');

  const startPath = elementPathOf(start);
  const point = () => `epubcfi(/6/${spineStep}!${startPath}${offsetOf(start)})`;

  if (!pos1) return point();

  const end = parseXPointer(pos1);
  if (end.spineIndex !== start.spineIndex) throw new Error('highlight spans two DocFragments');
  const endPath = elementPathOf(end);

  if (startPath === endPath) {
    if (start.textOffset == null || end.textOffset == null || start.textOffset === end.textOffset) {
      return point();
    }
    return `epubcfi(/6/${spineStep}!${startPath},/1:${start.textOffset},/1:${end.textOffset})`;
  }

  /* Different elements: the parent is the longest common run of steps. */
  const startSteps = startPath.split('/').filter(Boolean);
  const endSteps = endPath.split('/').filter(Boolean);
  let common = 0;
  while (common < startSteps.length && common < endSteps.length && startSteps[common] === endSteps[common]) {
    common++;
  }
  if (common === startSteps.length || common === endSteps.length) common--;
  if (common < 1) throw new Error('highlight has no common ancestor');

  const relative = (steps, parsed) => {
    const rest = steps.slice(common);
    const path = rest.length ? `/${rest.join('/')}` : '';
    return `${path}${offsetOf(parsed)}` || '/1:0';
  };

  const parent = `/${startSteps.slice(0, common).join('/')}`;
  return `epubcfi(/6/${spineStep}!${parent},${relative(startSteps, start)},${relative(endSteps, end)})`;
}

/* CFI back to the element; used only to check the conversion.
 * The first step (/4) is the body itself, so it is dropped. */
function resolveCfiElement(document, contentPath) {
  let current = document.body;
  const steps = [...contentPath.matchAll(/\/(\d+)(?:\[.*?\])?(?::\d+)?/g)]
    .map((m) => Number(m[1]))
    .filter((step) => step % 2 === 0)
    .slice(1);
  for (const step of steps) {
    const childIndex = step / 2 - 1;
    const children = current.children;
    if (childIndex < 0 || childIndex >= children.length) return current;
    current = children[childIndex];
  }
  return current;
}

module.exports = {
  loadSpine,
  loadSpineDocument,
  xPointerToCfi,
  parseXPointer,
  resolveXPointerElement,
  resolveCfiElement,
};
