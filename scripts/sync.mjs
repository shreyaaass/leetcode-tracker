#!/usr/bin/env node
// Pulls your recent accepted LeetCode submissions and records them in data/progress.json.
// Also fills data/meta.json (difficulty + topic tags) for every problem in the plan.
// Runs in GitHub Actions on a schedule; safe to run repeatedly (idempotent).
//
//   node scripts/sync.mjs            # normal sync
//   node scripts/sync.mjs --meta     # only refresh metadata, skip submissions

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePlan, planSlugs, isOffLeetCode, applyEvent, dateInTz, addDays, DEFAULT_INTERVALS } from '../lib/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (f) => path.join(root, f);
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(p(f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => writeFile(p(f), JSON.stringify(v, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = await readJson('config.json', {});
const username = process.env.LEETCODE_USERNAME || config.leetcodeUsername;
const tz = config.timezone || 'UTC';
const intervals = config.intervals || DEFAULT_INTERVALS;
const reviseWindow = config.autoReviseWindowDays ?? 3;
const trackFrom = config.trackFrom || null; // ignore submissions before this date (YYYY-MM-DD)
const metaOnly = process.argv.includes('--meta');

async function gql(query, variables) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://leetcode.com/graphql/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://leetcode.com/',
          'User-Agent': 'Mozilla/5.0 (leetcode-tracker sync)',
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
      return json.data;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1500 * attempt);
    }
  }
}

const plan = parsePlan(await readJson('data/plan.json', {}), await readJson('data/a2z.json', []), await readJson('data/links.json', {}));
const progress = await readJson('data/progress.json', { version: 1, problems: {} });
progress.problems ||= {};
const meta = await readJson('data/meta.json', {});

let changed = false;

// 1) Submissions -> progress
if (!metaOnly) {
  if (!username) {
    console.warn('No LeetCode username set (config.json "leetcodeUsername" or LEETCODE_USERNAME). Skipping submissions.');
  } else {
    const data = await gql(
      `query r($username: String!, $limit: Int!) {
        recentAcSubmissionList(username: $username, limit: $limit) { id title titleSlug timestamp }
      }`,
      { username, limit: 20 },
    );
    const subs = (data.recentAcSubmissionList || [])
      .map((s) => ({ ...s, date: dateInTz(new Date(Number(s.timestamp) * 1000), tz) }))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    for (const s of subs) {
      if (trackFrom && s.date < trackFrom) continue;
      const slug = s.titleSlug;
      const entry = progress.problems[slug];
      if (entry?.history?.some((h) => h.date === s.date)) continue; // already counted that day

      let ev;
      if (!entry?.firstSolved) ev = { type: 'solve', date: s.date };
      else if (s.date > entry.lastActivity && entry.nextRevision && s.date >= addDays(entry.nextRevision, -reviseWindow)) ev = { type: 'revise', date: s.date };
      else if (s.date > (entry.lastActivity || '')) ev = { type: 'practice', date: s.date };
      else continue;

      progress.problems[slug] = applyEvent(entry, { ...ev, rating: 'good', source: 'sync' }, intervals);
      if (!meta[slug]) meta[slug] = { title: s.title };
      console.log(`+ ${ev.type.padEnd(8)} ${s.date}  ${slug}`);
      changed = true;
    }
    progress.lastSync = new Date().toISOString();
  }
}

// 2) Metadata for plan + tracked problems that we don't know yet
const wanted = [...new Set([...planSlugs(plan), ...Object.keys(progress.problems)])]
  .filter((slug) => !isOffLeetCode(slug) && !meta[slug]?.difficulty && !meta[slug]?.notFound);

for (const slug of wanted) {
  try {
    const data = await gql(
      `query q($titleSlug: String!) {
        question(titleSlug: $titleSlug) { questionFrontendId title difficulty topicTags { name } }
      }`,
      { titleSlug: slug },
    );
    const q = data.question;
    meta[slug] = q
      ? { id: q.questionFrontendId, title: q.title, difficulty: q.difficulty, topics: q.topicTags.map((t) => t.name) }
      : { ...(meta[slug] || {}), notFound: true };
    console.log(q ? `  meta     ${slug} (${q.difficulty})` : `! not found on LeetCode: ${slug} — fix the title/slug in plan.json`);
    changed = true;
  } catch (err) {
    console.warn(`  meta failed for ${slug}: ${err.message}`);
  }
  await sleep(250);
}

// Only write when something real changed, so the workflow doesn't commit every 3 hours.
if (changed) {
  await writeJson('data/progress.json', progress);
  await writeJson('data/meta.json', meta);
  console.log('Updated data files.');
} else {
  console.log('Nothing new.');
}
