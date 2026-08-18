#!/usr/bin/env node
/*
 * Checks the XPointer -> CFI conversion against a real EPUB.
 *
 * Builds XPointers in the shape KOReader produces, converts them to CFIs and
 * walks the CFI back to an element: the target must be exactly the same one.
 *
 * Usage: node selftest.js "/books/Author/Book.epub" [tag] [samples]
 */

const epubcfi = require('./epubcfi');

const epubPath = process.argv[2];
const tag = process.argv[3] || 'p';
const samples = Number(process.argv[4] || 5);

if (!epubPath) {
  console.error('usage: node selftest.js <book.epub> [tag] [samples]');
  process.exit(2);
}

const spine = epubcfi.loadSpine(epubPath);
console.log(`spine: ${spine.length} documents`);

let ok = 0;
let fail = 0;

for (let spineIndex = 0; spineIndex < spine.length && ok + fail < samples * 4; spineIndex++) {
  let document;
  try {
    document = epubcfi.loadSpineDocument(epubPath, spine, spineIndex);
  } catch (err) {
    console.log(`  DocFragment[${spineIndex + 1}]: could not open (${err.message})`);
    continue;
  }
  const elements = document.body ? document.body.querySelectorAll(tag) : [];
  if (!elements.length) continue;

  const picks = [1, Math.ceil(elements.length / 2), elements.length].filter((n, i, a) => a.indexOf(n) === i);
  for (const nth of picks) {
    const xpointer = `/body/DocFragment[${spineIndex + 1}]/body/div/${tag}[${nth}]/text().0`;
    try {
      const cfi = epubcfi.xPointerToCfi(epubPath, spine, xpointer, null);
      const contentPath = /^epubcfi\(\/6\/\d+!(.+)\)$/.exec(cfi)[1];
      const resolved = epubcfi.resolveCfiElement(document, contentPath);
      const expected = elements[nth - 1];
      const same = resolved === expected;
      if (same) ok++; else fail++;
      const preview = (expected.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' ');
      console.log(`  ${same ? 'ok  ' : 'FAIL'} DocFragment[${spineIndex + 1}] ${tag}[${nth}] -> ${cfi}  "${preview}"`);
    } catch (err) {
      fail++;
      console.log(`  FAIL DocFragment[${spineIndex + 1}] ${tag}[${nth}]: ${err.message}`);
    }
  }
}

console.log(`result: ${ok} round trips correct, ${fail} broken`);
process.exit(fail === 0 ? 0 : 1);
