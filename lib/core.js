// Shared logic used by both the dashboard (browser) and the sync script (Node).
// Pure functions only — no DOM, no network.

export const DEFAULT_INTERVALS = [14, 30, 60, 120, 240];
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

// ---------- dates (all dates are 'YYYY-MM-DD' strings in the user's timezone) ----------

export function dateInTz(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// ---------- plan parsing ----------

export function slugify(input) {
  if (!input) return '';
  const s = String(input).trim();
  const m = s.match(/leetcode\.com\/problems\/([a-z0-9-]+)/i);
  if (m) return m[1].toLowerCase();
  return s
    .toLowerCase()
    .replace(/^\d+\s*[.)-]\s*/, '') // "1. Two Sum" -> "Two Sum"
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normDifficulty(d) {
  if (!d) return null;
  const s = String(d).toLowerCase();
  if (s.startsWith('e')) return 'Easy';
  if (s.startsWith('m')) return 'Medium';
  if (s.startsWith('h')) return 'Hard';
  return null;
}

// Strip noise that old sheet names carry: "(DP-14)", "[use priority queue]", "(IMPORTANT)", "| Theory".
export function cleanName(str) {
  return String(str || '')
    .replace(/\(DP-\d+\)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\((important|theory)\)/gi, '')
    .replace(/\|\s*theory\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loose name key for matching names: "Insertion Sorting" ~ "Insertion Sort", "Jump Game 2" ~ "Jump Game II".
const ROMAN = { 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv' };
export function nameKey(str) {
  const words = cleanName(str).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3)
      : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  if (words.length > 1 && ROMAN[words.at(-1)]) words[words.length - 1] = ROMAN[words.at(-1)];
  return words.join(' ');
}

export function nameSimilarity(a, b) {
  const x = new Set(nameKey(a).split(' ')), y = new Set(nameKey(b).split(' '));
  let i = 0; for (const w of x) if (y.has(w)) i++;
  return i / (x.size + y.size - i || 1);
}

// Catalog = data/a2z.json: [{title, tuf, category, leetcode}]. Built by scripts/import-a2z.mjs.
export function buildCatalogIndex(catalog) {
  const exact = new Map();
  const list = [];
  for (const c of catalog || []) {
    for (const k of [nameKey(c.title), nameKey(c.tuf.replace(/-/g, ' '))]) if (k && !exact.has(k)) exact.set(k, c);
    list.push({ c, tokens: new Set(nameKey(c.title).split(' ')) });
  }
  return { exact, list };
}

export function lookupCatalog(index, title) {
  if (!index || !title) return null;
  const key = nameKey(title);
  if (index.exact.has(key)) return index.exact.get(key);
  // Fuzzy fallback: best token overlap, only if clearly the best match.
  const t = new Set(key.split(' '));
  let best = null, bestScore = 0, second = 0;
  for (const { c, tokens } of index.list) {
    let inter = 0; for (const w of t) if (tokens.has(w)) inter++;
    const score = inter / (t.size + tokens.size - inter);
    if (score > bestScore) { second = bestScore; bestScore = score; best = c; } else if (score > second) second = score;
  }
  return bestScore >= 0.75 && bestScore - second >= 0.1 ? best : null;
}

// Problems tracked by hand (not on LeetCode, or sharing a LeetCode problem with another
// plan entry) get a slug with this prefix so the sync never touches them.
export const MANUAL_PREFIX = 'm:';
export const isOffLeetCode = (slug) => slug.startsWith(MANUAL_PREFIX);
const lcUrl = (slug) => `https://leetcode.com/problems/${slug}/`;
const tufUrl = (slug) => `https://takeuforward.org/practice/dsa/${slug}`;

function normProblem(item, dayTopic, index, links) {
  const obj = typeof item === 'string'
    ? (/leetcode\.com\/problems\//i.test(item) ? { url: item } : { title: item.replace(/^\d+\s*[.)-]\s*/, '') })
    : item;
  const title = obj.title || obj.problem_name || obj.problemName || obj.name || obj.problem || obj.question || null;
  let link = obj.url || obj.link || obj.leetcode || null;
  let slug = obj.slug || obj.titleSlug || null;
  let auto = false;

  if (!slug && !link) {
    const L = links && title ? links[title] : null; // data/links.json (scripts/link-plan.mjs)
    const c = L ? null : lookupCatalog(index, title);
    if (L) {
      auto = true;
      if (L.slug) slug = L.slug;
      else { slug = MANUAL_PREFIX + slugify(title); link = L.link || null; }
    } else if (c) {
      auto = true;
      if (c.leetcode) slug = c.leetcode;
      else { slug = MANUAL_PREFIX + c.tuf; link = tufUrl(c.tuf); }
    }
  }
  slug ||= slugify(link || title);
  return {
    slug,
    title,
    link: link && !/leetcode\.com/i.test(link) ? link : null,
    auto,
    difficulty: normDifficulty(obj.difficulty || obj.level),
    subtopic: obj.subtopic || obj.subTopic || obj.topic || obj.category || obj.pattern || dayTopic || null,
  };
}

// Accepts {"1": [...], "2": [...]}, {"days": {...}}, or [[...], [...]].
// A day may be a list of problems or {topic, problems: [...]}.
// Problems may be strings (title / slug / URL) or objects.
// Names are linked to LeetCode via `links` (data/links.json) first, then `catalog` (data/a2z.json).
export function parsePlan(raw, catalog, links) {
  if (!raw) return [];
  const index = catalog ? buildCatalogIndex(catalog) : null;
  let days = raw.days || raw.plan || raw;
  const entries = Array.isArray(days)
    ? days.map((v, i) => [i + 1, v])
    : Object.entries(days).map(([k, v]) => [parseInt(String(k).replace(/\D/g, ''), 10), v]);

  const parsed = entries
    .filter(([n]) => Number.isFinite(n))
    .sort((a, b) => a[0] - b[0])
    .map(([day, v]) => {
      const list = Array.isArray(v) ? v : (v.problems || v.questions || []);
      const topic = Array.isArray(v) ? null : (v.topic || v.title || v.subtopic || null);
      return { day, topic, problems: list.map((p) => normProblem(p, topic, index, links)).filter((p) => p.slug) };
    });

  // Several plan entries can map to one LeetCode problem (e.g. "Stock Buy and Sell" on day 12
  // and "Best Time to Buy and Sell Stock (DP-35)" later). The first one in the plan auto-syncs;
  // later ones are tracked by hand so each keeps its own progress. Re-solving the problem on
  // LeetCode later still counts as a revision of the first one.
  const owner = new Set();
  for (const d of parsed) for (const p of d.problems) {
    if (!p.auto || isOffLeetCode(p.slug)) continue;
    if (!owner.has(p.slug)) { owner.add(p.slug); continue; }
    p.link = lcUrl(p.slug);
    p.slug = MANUAL_PREFIX + slugify(p.title);
  }
  return parsed;
}

export function planSlugs(plan) {
  return [...new Set(plan.flatMap((d) => d.problems.map((p) => p.slug)))].filter((s) => !isOffLeetCode(s));
}

// Merge plan entry + LeetCode metadata into what the UI shows.
export function resolveProblem(p, meta) {
  const m = meta[p.slug] || {};
  const manual = isOffLeetCode(p.slug) || !!m.notFound;
  return {
    ...p,
    title: p.title || m.title || p.slug,
    lcTitle: m.title || null,
    difficulty: p.difficulty || m.difficulty || null,
    subtopic: p.subtopic || (m.topics && m.topics[0]) || 'Uncategorised',
    id: m.id || null,
    // Problems that aren't on LeetCode (e.g. "Selection Sort") link to the plan's own URL
    // if given, otherwise a web search, and are marked by hand instead of auto-synced.
    url: manual
      ? (p.link || `https://www.google.com/search?q=${encodeURIComponent(p.title || p.slug)}`)
      : lcUrl(p.slug),
    notFound: manual,
  };
}

// ---------- spaced repetition ----------
// entry = { firstSolved, level, nextRevision, lastActivity, history: [{date, type, rating, source}], notes }
// type: 'solve' | 'revise' | 'practice'   rating: 'good' | 'struggled'

function struggledGap(level, intervals) {
  return Math.max(3, Math.round(intervals[level] / 4));
}

export function applyEvent(entry, ev, intervals = DEFAULT_INTERVALS) {
  const e = entry
    ? { ...entry, history: [...(entry.history || [])] }
    : { firstSolved: null, level: 0, nextRevision: null, lastActivity: null, history: [], notes: '' };
  const max = intervals.length - 1;
  const rating = ev.rating || 'good';

  if (ev.type === 'solve' || !e.firstSolved) {
    e.firstSolved = e.firstSolved || ev.date;
    e.level = 0;
    e.nextRevision = addDays(ev.date, rating === 'struggled' ? struggledGap(0, intervals) : intervals[0]);
    e.history.push({ date: ev.date, type: 'solve', rating, source: ev.source || 'manual' });
  } else if (ev.type === 'revise') {
    if (rating === 'struggled') {
      e.level = Math.max(0, (e.level || 0) - 1);
      e.nextRevision = addDays(ev.date, struggledGap(e.level, intervals));
    } else {
      e.level = Math.min(max, (e.level || 0) + 1);
      e.nextRevision = addDays(ev.date, intervals[e.level]);
    }
    e.history.push({ date: ev.date, type: 'revise', rating, source: ev.source || 'manual' });
  } else {
    e.history.push({ date: ev.date, type: 'practice', rating, source: ev.source || 'manual' });
  }
  e.lastActivity = ev.date > (e.lastActivity || '') ? ev.date : e.lastActivity;
  return e;
}

// Rebuild an entry from its history (used for "undo last").
export function replay(history, notes, intervals = DEFAULT_INTERVALS) {
  let e = null;
  for (const h of [...history].sort((a, b) => a.date.localeCompare(b.date))) e = applyEvent(e, h, intervals);
  if (e) e.notes = notes || '';
  return e;
}

export function statusOf(entry, today, intervals = DEFAULT_INTERVALS) {
  if (!entry || !entry.firstSolved) return 'todo';
  if (entry.nextRevision && entry.nextRevision < today) return 'overdue';
  if (entry.nextRevision && entry.nextRevision === today) return 'due';
  if ((entry.level || 0) >= intervals.length - 1) return 'mastered';
  const lastRating = entry.history?.filter((h) => h.type !== 'practice').at(-1)?.rating;
  return lastRating === 'struggled' ? 'shaky' : 'solved';
}

// ---------- aggregates ----------

export function activityByDate(progress) {
  const counts = {};
  for (const e of Object.values(progress.problems || {})) {
    for (const h of e.history || []) counts[h.date] = (counts[h.date] || 0) + 1;
  }
  return counts;
}

export function streaks(counts, today) {
  const dates = Object.keys(counts).sort();
  let longest = 0, run = 0, prev = null;
  for (const d of dates) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  let d = counts[today] ? today : addDays(today, -1);
  while (counts[d]) { current++; d = addDays(d, -1); }
  return { current, longest };
}

// The "current day" is the first plan day that still has unsolved problems —
// days are progress-based, not calendar-based, so vacations don't push you behind.
export function currentDay(plan, progress) {
  for (const d of plan) {
    if (d.problems.some((p) => !progress.problems?.[p.slug]?.firstSolved)) return d.day;
  }
  return plan.length ? plan.at(-1).day : null;
}
