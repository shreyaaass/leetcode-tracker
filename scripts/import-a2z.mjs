#!/usr/bin/env node
// Builds data/a2z.json — a catalog of Striver's A2Z sheet problems with their LeetCode slugs.
// The plan parser uses it to link plan entries by name, so you don't have to add URLs by hand.
//
//   node scripts/import-a2z.mjs
//
// The sheet's data is embedded in the page's Next.js payload (self.__next_f.push chunks).
// If takeUforward changes their page format, this script is what needs fixing.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL_ = 'https://takeuforward.org/prep-hub/strivers-a2z-dsa-sheet';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/a2z.json');

const html = await (await fetch(URL_, { headers: { 'User-Agent': 'Mozilla/5.0 (leetcode-tracker import)' } })).text();

let raw = '';
for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
  try { raw += JSON.parse(m[1]); } catch {}
}
if (!raw) throw new Error('Could not find the sheet payload in the page — the page format may have changed.');

const cats = {};
for (const m of raw.matchAll(/\[\d+,\d+,"([^"]+)","category","((?:[^"\\]|\\.)*)",\[/g)) cats[m[1]] = m[2].trim();

const items = [];
const re = /\[\d+,(\d+),"([^"]+)","item","(\w+)","((?:[^"\\]|\\.)*)","[^"]*",\{[^}]*?"category":"([^"]+)"\}(.*?)\](?=,\[\d+,\d+,"|\]\]|\]$)/g;
for (const m of raw.matchAll(re)) {
  const [, , slug, kind, title, category, tail] = m;
  if (kind !== 'practice') continue;
  const lc = tail.match(/https?:\/\/leetcode\.com\/problems\/([a-z0-9-]+)/i);
  items.push({
    title: JSON.parse(`"${title}"`).trim(),
    tuf: slug,
    category: cats[category] || category,
    leetcode: lc ? lc[1].toLowerCase() : null,
  });
}
if (items.length < 100) throw new Error(`Only found ${items.length} problems — the page format may have changed.`);

await writeFile(out, JSON.stringify(items, null, 0).replace(/},{/g, '},\n{') + '\n');
console.log(`Wrote ${items.length} problems (${items.filter((i) => i.leetcode).length} with LeetCode links) to data/a2z.json`);
