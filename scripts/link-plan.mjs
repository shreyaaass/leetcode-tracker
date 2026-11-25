#!/usr/bin/env node
// Resolves every problem name in data/plan.json to a LeetCode slug and saves the result to
// data/links.json, which the dashboard and the sync use. Entries already in links.json are kept,
// so hand corrections survive re-runs. Pass --force to re-resolve everything.
//
//   node scripts/link-plan.mjs
//
// Order of attempts per name:
//   1. Striver's sheet catalog (data/a2z.json) — the sheet's own LeetCode link
//   2. The name itself as a LeetCode slug ("Jump Game" -> jump-game)
//   3. LeetCode search, accepted only if the title is a close match
// Anything else is left for manual tracking.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePlan, cleanName, nameSimilarity, slugify, buildCatalogIndex, lookupCatalog } from '../lib/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (f, fb) => { try { return JSON.parse(await readFile(path.join(root, f), 'utf8')); } catch { return fb; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const force = process.argv.includes('--force');

async function gql(query, variables) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch('https://leetcode.com/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com/', 'User-Agent': 'Mozilla/5.0 (leetcode-tracker link)' },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.errors) throw new Error(j.errors[0].message);
      return j.data;
    } catch (e) { if (i === 3) throw e; await sleep(1500 * i); }
  }
}
const getQuestion = async (slug) =>
  (await gql('query q($s: String!) { question(titleSlug: $s) { title titleSlug isPaidOnly } }', { s: slug })).question;
const search = async (kw) =>
  (await gql(`query p($f: QuestionListFilterInput) { questionList(categorySlug: "", limit: 20, skip: 0, filters: $f) { data { title titleSlug isPaidOnly } } }`,
    { f: { searchKeywords: kw } })).questionList.data;

const THEORY = /\b(introduction|theory|representation|learn|types|why|prerequisites?)\b/i;

const raw = await readJson('data/plan.json', {});
const catalog = await readJson('data/a2z.json', []);
const links = force ? {} : await readJson('data/links.json', {});
const index = buildCatalogIndex(catalog);

// Names that need resolving: entries without an explicit slug/url in the plan.
const names = [];
for (const d of parsePlan(raw)) for (const p of d.problems) {
  if (p.title && !p.link && p.slug === slugify(p.title) && !names.includes(p.title)) names.push(p.title);
}

let n = 0;
for (const name of names) {
  if (links[name]) continue;
  n++;
  const c = lookupCatalog(index, name);
  let entry;
  if (c) entry = c.leetcode ? { slug: c.leetcode, via: 'sheet' } : { slug: null, link: `https://takeuforward.org/practice/dsa/${c.tuf}`, via: 'sheet' };
  else {
    const clean = cleanName(name);
    let found = null;
    try {
      // 2) name as slug, also with a trailing number as roman ("jump-game-2" -> "jump-game-ii")
      for (const s of new Set([slugify(clean), slugify(clean).replace(/-(\d)$/, (_, d) => '-' + ['', 'i', 'ii', 'iii', 'iv'][d])])) {
        const q = await getQuestion(s); await sleep(200);
        if (q) { found = { slug: q.titleSlug, via: 'exact', lcTitle: q.title, paid: q.isPaidOnly || undefined }; break; }
      }
      // 3) search
      if (!found && !THEORY.test(name)) {
        const results = await search(clean.replace(/[^a-zA-Z0-9 ]+/g, ' ')); await sleep(200);
        const best = results.map((q) => ({ q, s: nameSimilarity(clean, q.title) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s >= 0.5) found = { slug: best.q.titleSlug, via: 'search', lcTitle: best.q.title, score: +best.s.toFixed(2), paid: best.q.isPaidOnly || undefined };
      }
    } catch (e) { console.warn(`! ${name}: ${e.message}`); }
    entry = found || (c ? { slug: null, link: `https://takeuforward.org/practice/dsa/${c.tuf}`, via: 'sheet' } : { slug: null, via: 'none' });
  }
  links[name] = entry;
  process.stdout.write(`\r${n} resolved`);
}
console.log();

// Hand-reviewed corrections (scripts/link-overrides.json) always win.
const overrides = await readJson('scripts/link-overrides.json', {});
for (const [name, slug] of Object.entries(overrides)) {
  if (name.startsWith('_') || !names.includes(name)) continue;
  const c = lookupCatalog(index, name);
  links[name] = slug ? { slug, via: 'reviewed' } : { slug: null, link: c && !c.leetcode ? `https://takeuforward.org/practice/dsa/${c.tuf}` : undefined, via: 'reviewed' };
}

// Keep links.json in plan order and drop names no longer in the plan.
const out = Object.fromEntries(names.map((k) => [k, links[k]]));
await writeFile(path.join(root, 'data/links.json'), JSON.stringify(out, null, 1) + '\n');

const vals = Object.entries(out);
const count = (f) => vals.filter(([, v]) => f(v)).length;
console.log(`${vals.length} names: ${count((v) => v.slug)} on LeetCode (sheet ${count((v) => v.via === 'sheet' && v.slug)}, exact ${count((v) => v.via === 'exact')}, search ${count((v) => v.via === 'search')}, reviewed ${count((v) => v.via === 'reviewed' && v.slug)}), ${count((v) => !v.slug)} manual`);
console.log('\nSearch matches to double-check:');
for (const [k, v] of vals) if (v.via === 'search') console.log(`  ${k}  ->  ${v.lcTitle} (${v.score})${v.paid ? ' [premium]' : ''}`);
