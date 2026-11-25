import {
  parsePlan, resolveProblem, applyEvent, replay, statusOf, activityByDate, streaks,
  currentDay, dateInTz, addDays, daysBetween, DEFAULT_INTERVALS, DIFFICULTIES,
} from './lib/core.js';

// ---------------------------------------------------------------- state
const S = {
  config: {}, planRaw: {}, plan: [], progress: { problems: {} }, meta: {},
  shas: {}, today: '', intervals: DEFAULT_INTERVALS,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—';
const relDays = (d) => {
  if (!d) return '';
  const n = daysBetween(S.today, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n}d` : `${-n}d ago`;
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- settings / GitHub
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('lc-settings') || '{}'); } catch {}
  if (!s.owner && location.hostname.endsWith('.github.io')) {
    s.owner = location.hostname.split('.')[0];
    s.repo = location.pathname.split('/').filter(Boolean)[0] || `${s.owner}.github.io`;
  }
  s.branch ||= 'main';
  return s;
}
let settings = loadSettings();
const canWrite = () => !!(settings.token && settings.owner && settings.repo);

const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const b64encode = (s) => { let bin = ''; new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}${path}`, {
    ...opts,
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${settings.token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) { const err = new Error(`GitHub ${res.status}`); err.status = res.status; throw err; }
  return res.status === 204 ? null : res.json();
}

async function readFile(path, fallback) {
  try {
    if (canWrite()) {
      const r = await gh(`/contents/${path}?ref=${encodeURIComponent(settings.branch)}`);
      S.shas[path] = r.sha;
      return JSON.parse(b64decode(r.content));
    }
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (e) {
    console.warn('read failed', path, e);
    return fallback;
  }
}

async function writeFile(path, data, message) {
  const body = { message, content: b64encode(JSON.stringify(data, null, 2) + '\n'), branch: settings.branch };
  if (S.shas[path]) body.sha = S.shas[path];
  const r = await gh(`/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  S.shas[path] = r.content.sha;
}

// Apply a change to progress.json: optimistic locally, then fetch-latest → apply → commit (retry on conflicts).
async function mutateProgress(fn, message) {
  fn(S.progress);
  render();
  if (!canWrite()) { toast('Not saved: add a GitHub token in Settings ⚙'); return; }
  for (let i = 0; i < 3; i++) {
    try {
      const latest = await readFile('data/progress.json', { version: 1, problems: {} });
      latest.problems ||= {};
      fn(latest);
      await writeFile('data/progress.json', latest, message);
      S.progress = latest;
      render();
      toast('Saved ✓');
      return;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) { toast(`Save failed (${e.message})`); return; }
    }
  }
  toast('Save failed after retries — reload and try again');
}

// ---------------------------------------------------------------- actions
function record(slug, rating) {
  const today = S.today;
  return mutateProgress((p) => {
    const e = p.problems[slug];
    const todays = e?.history?.find((h) => h.date === today && h.type !== 'practice');
    if (todays) {
      // Already logged today (e.g. by auto-sync) → just change the rating.
      todays.rating = rating;
      p.problems[slug] = replay(e.history, e.notes, S.intervals);
    } else {
      p.problems[slug] = applyEvent(e, { type: e?.firstSolved ? 'revise' : 'solve', date: today, rating, source: 'manual' }, S.intervals);
    }
  }, `${rating === 'struggled' ? 'struggled' : 'done'}: ${slug}`);
}

function undo(slug) {
  return mutateProgress((p) => {
    const e = p.problems[slug];
    if (!e) return;
    const hist = [...e.history]; hist.pop();
    if (hist.length) p.problems[slug] = replay(hist, e.notes, S.intervals);
    else delete p.problems[slug];
  }, `undo: ${slug}`);
}

function saveNotes(slug, notes) {
  return mutateProgress((p) => {
    if (p.problems[slug]) p.problems[slug].notes = notes;
  }, `notes: ${slug}`);
}

async function triggerSync() {
  if (!canWrite()) return toast('Add a GitHub token in Settings ⚙ to trigger syncs');
  try {
    await gh('/actions/workflows/sync.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: settings.branch }) });
    toast('Sync started — refreshing in ~60s', 4000);
    setTimeout(load, 60000);
    setTimeout(load, 120000);
  } catch (e) { toast(`Couldn't start sync (${e.message})`); }
}

async function uploadPlan(file) {
  let raw;
  try { raw = JSON.parse(await file.text()); } catch { return toast('That file is not valid JSON'); }
  const plan = parsePlan(raw, S.catalog, S.links);
  const n = plan.reduce((a, d) => a + d.problems.length, 0);
  if (!plan.length || !n) return toast('No days/problems found in that JSON');
  if (!confirm(`Replace the plan with ${plan.length} days / ${n} problems?\nYour progress is kept.`)) return;
  S.planRaw = raw; S.plan = plan; render();
  if (!canWrite()) return toast('Plan loaded for this view only — add a token in Settings to save it');
  try {
    await readFile('data/plan.json', {});
    await writeFile('data/plan.json', raw, 'plan: update');
    toast('Plan saved ✓ — difficulty/topics fill in after the next sync', 4000);
  } catch (e) { toast(`Save failed (${e.message})`); }
}

// ---------------------------------------------------------------- derived data
function derive() {
  const seen = new Map();
  const days = S.plan.map((d) => ({
    ...d,
    problems: d.problems.map((p) => {
      const r = resolveProblem(p, S.meta);
      const entry = S.progress.problems?.[p.slug];
      const item = { ...r, entry, status: statusOf(entry, S.today, S.intervals), day: d.day };
      if (!seen.has(p.slug)) seen.set(p.slug, item);
      return item;
    }),
  }));
  const unique = [...seen.values()];
  const extras = Object.entries(S.progress.problems || {})
    .filter(([slug]) => !seen.has(slug))
    .map(([slug, entry]) => ({ ...resolveProblem({ slug }, S.meta), entry, status: statusOf(entry, S.today, S.intervals) }));
  return { days, unique, extras };
}

// ---------------------------------------------------------------- render
function diffBadge(d) { return `<span class="diff ${d || 'none'}">${d || '?'}</span>`; }
const STATUS_LABEL = { todo: 'To do', solved: 'Solved', shaky: 'Shaky', due: 'Due today', overdue: 'Overdue', mastered: 'Mastered' };
function statusBadge(s) { return `<span class="status ${s}">${STATUS_LABEL[s]}</span>`; }
function actionBtns(slug, solved) {
  return `<div class="actions">
    <button class="btn sm good" data-act="good" data-slug="${esc(slug)}" title="${solved ? 'Revised it fine' : 'Mark solved'}">✓ ${solved ? 'Revised' : 'Solved'}</button>
    <button class="btn sm bad" data-act="struggled" data-slug="${esc(slug)}" title="Struggled — revise sooner">Struggled</button>
  </div>`;
}

function renderStats({ unique, extras }) {
  const total = unique.length;
  const done = unique.filter((p) => p.entry?.firstSolved).length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const byDiff = Object.fromEntries(DIFFICULTIES.map((d) => {
    const all = unique.filter((p) => p.difficulty === d);
    return [d, { total: all.length, done: all.filter((p) => p.entry?.firstSolved).length }];
  }));
  const all = [...unique, ...extras];
  const overdue = all.filter((p) => p.status === 'overdue').length;
  const dueToday = all.filter((p) => p.status === 'due').length;
  const week = all.filter((p) => p.entry?.nextRevision > S.today && p.entry.nextRevision <= addDays(S.today, 7)).length;
  const counts = activityByDate(S.progress);
  const st = streaks(counts, S.today);
  const activeDays = Object.keys(counts).length;

  const card = (label, value, sub, bar, cls = '') => `
    <div class="stat">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
      ${bar != null ? `<div class="bar"><span style="width:${bar}%" class="${bar && cls ? 'bg-' + cls.slice(2) : ''}"></span></div>` : ''}
    </div>`;

  $('#stats').innerHTML = [
    card('Solved', `${done}<small> / ${total}</small>`, `${total - done} left · ${pct(done, total)}%`, pct(done, total)),
    ...DIFFICULTIES.map((d) => card(
      `<span class="dot bg-${d.toLowerCase()}"></span>${d}`,
      `${byDiff[d].done}<small> / ${byDiff[d].total}</small>`,
      `${byDiff[d].total - byDiff[d].done} left`,
      pct(byDiff[d].done, byDiff[d].total), `c-${d.toLowerCase()}`,
    )),
    card('Revisions due', `${overdue + dueToday}`, `${overdue} overdue · ${week} next 7d`, null, overdue ? 'c-hard' : ''),
    card('Streak', `${st.current}<small> day${st.current === 1 ? '' : 's'}</small>`, `best ${st.longest} · ${activeDays} active days`),
  ].join('');
}

function renderHeatmap() {
  const counts = activityByDate(S.progress);
  const weeks = 53;
  const todayDow = new Date(S.today + 'T00:00:00Z').getUTCDay();
  const start = addDays(S.today, -todayDow - (weeks - 1) * 7); // a Sunday
  const level = (n) => (n === 0 ? 0 : n === 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 3 : 4);
  let html = `<div class="heatmap" style="grid-template-columns: 26px repeat(${weeks}, 11px)">`;
  ['', 'Mon', '', 'Wed', '', 'Fri', ''].forEach((l, i) => { html += `<span style="grid-column:1;grid-row:${i + 2};line-height:11px">${l}</span>`; });
  let lastMonth = -1, yearTotal = 0;
  for (let w = 0; w < weeks; w++) {
    for (let dow = 0; dow < 7; dow++) {
      const d = addDays(start, w * 7 + dow);
      const m = new Date(d + 'T00:00:00Z').getUTCMonth();
      if (dow === 0 && m !== lastMonth) {
        const partial = w === 0 && Number(d.slice(8)) > 7; // skip a cramped label on the first column
        if (!partial && w < weeks - 2) html += `<span class="month" style="grid-column:${w + 2}">${new Date(d + 'T00:00:00Z').toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })}</span>`;
        lastMonth = m;
      }
      const n = counts[d] || 0;
      yearTotal += n;
      const future = d > S.today;
      html += `<span class="cell${future ? ' future' : ''}${d === S.today ? ' today' : ''}" data-l="${level(n)}" style="grid-column:${w + 2};grid-row:${dow + 2}" title="${future ? '' : `${n} problem${n === 1 ? '' : 's'} · ${fmtDate(d)}`}"></span>`;
    }
  }
  html += `</div>`;
  $('#heatFoot').innerHTML = `<span>${yearTotal} solves &amp; revisions in the last year</span>
    <span class="legend">Less ${[0, 1, 2, 3, 4].map((l) => `<i style="background:var(--heat-${l})"></i>`).join('')} More</span>`;
  $('#heatmap').innerHTML = html;
  const wrap = $('#heatmap'); wrap.scrollLeft = wrap.scrollWidth;
}

function row(p, extra = '') {
  return `<div class="row">
    ${diffBadge(p.difficulty)}
    <div class="title"><a href="${p.url}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.notFound ? '<span class="tag">manual</span>' : ''} <span class="meta">${esc(p.subtopic)}</span></div>
    ${extra}
  </div>`;
}

function renderRevise({ unique, extras }) {
  const all = [...unique, ...extras].filter((p) => p.entry?.nextRevision && p.entry.nextRevision <= addDays(S.today, 7))
    .sort((a, b) => a.entry.nextRevision.localeCompare(b.entry.nextRevision));
  const groups = [
    ['Overdue', all.filter((p) => p.entry.nextRevision < S.today)],
    ['Today', all.filter((p) => p.entry.nextRevision === S.today)],
    ['Next 7 days', all.filter((p) => p.entry.nextRevision > S.today)],
  ];
  const due = groups[0][1].length + groups[1][1].length;
  $('#reviseCount').textContent = due ? `${due} due` : '';
  $('#reviseList').innerHTML = all.length
    ? groups.filter(([, l]) => l.length).map(([label, l]) => `<div class="group-label">${label}</div>` + l.map((p) =>
        row(p, p.entry.nextRevision <= S.today
          ? `<span class="meta">${relDays(p.entry.nextRevision)}</span>${actionBtns(p.slug, true)}`
          : `<span class="meta">${fmtDate(p.entry.nextRevision)}</span>`)).join('')).join('')
    : `<div class="empty">Nothing to revise this week 🎉</div>`;
}

function renderToday({ days }) {
  const cur = currentDay(S.plan, S.progress);
  const day = days.find((d) => d.day === cur);
  $('#dayBadge').textContent = S.plan.length ? `Day ${cur} / ${S.plan.at(-1).day}` : 'No plan';
  if (!day) { $('#todayList').innerHTML = `<div class="empty">Upload a plan JSON with ⤒ Plan</div>`; return; }
  const allDone = day.problems.every((p) => p.entry?.firstSolved);
  $('#todayTitle').textContent = `Day ${day.day}${day.topic ? ' · ' + day.topic : ''}`;
  $('#todayCount').textContent = `${day.problems.filter((p) => p.entry?.firstSolved).length} / ${day.problems.length} done`;
  // Solved-today problems keep a "Struggled" toggle so auto-synced solves can be rated.
  $('#todayList').innerHTML = (allDone ? `<div class="empty">Plan complete! 🎉</div>` : '') + day.problems.map((p) => {
    if (!p.entry?.firstSolved) return row(p, actionBtns(p.slug, false));
    const solvedToday = p.entry.firstSolved === S.today;
    const struggled = p.status === 'shaky';
    return row(p, `${statusBadge(p.status)}${solvedToday && !struggled
      ? `<div class="actions"><button class="btn sm bad" data-act="struggled" data-slug="${esc(p.slug)}" title="Rate today's solve as a struggle">Struggled?</button></div>` : ''}`);
  }).join('');
}

function renderTopics({ unique }) {
  const order = [], map = {};
  for (const p of unique) {
    if (!map[p.subtopic]) { map[p.subtopic] = []; order.push(p.subtopic); }
    map[p.subtopic].push(p);
  }
  $('#topics').innerHTML = order.map((t) => {
    const list = map[t];
    const done = list.filter((p) => p.entry?.firstSolved);
    const seg = DIFFICULTIES.map((d) => {
      const n = done.filter((p) => p.difficulty === d).length;
      return n ? `<span class="bg-${d.toLowerCase()}" style="width:${(n / list.length) * 100}%" title="${n} ${d}"></span>` : '';
    }).join('');
    return `<div class="topic"><div class="t-head"><span>${esc(t)}</span><span>${done.length} / ${list.length}</span></div><div class="stack">${seg}</div></div>`;
  }).join('') || `<div class="empty">No plan yet</div>`;
  const sel = $('#fTopic'), cur = sel.value;
  sel.innerHTML = `<option value="">All subtopics</option>` + order.map((t) => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

const openDays = new Set();
function renderPlan({ days }) {
  const q = $('#fSearch').value.trim().toLowerCase();
  const fd = $('#fDiff').value, fs = $('#fStatus').value, ft = $('#fTopic').value;
  const filtering = !!(q || fd || fs || ft);
  const cur = currentDay(S.plan, S.progress);
  if (!openDays.size && cur != null) openDays.add(cur);

  $('#planTable').innerHTML = days.map((d) => {
    const items = d.problems.filter((p) =>
      (!q || p.title.toLowerCase().includes(q) || p.slug.includes(q)) &&
      (!fd || p.difficulty === fd) && (!fs || p.status === fs) && (!ft || p.subtopic === ft));
    if (filtering && !items.length) return '';
    const doneN = d.problems.filter((p) => p.entry?.firstSolved).length;
    const open = filtering || openDays.has(d.day);
    return `<details class="day${d.day === cur ? ' current' : ''}${doneN === d.problems.length ? ' complete' : ''}" data-day="${d.day}" ${open ? 'open' : ''}>
      <summary><span class="d-name">Day ${d.day}</span><span class="d-topic">${esc(d.topic || [...new Set(d.problems.map((p) => p.subtopic))].join(' · '))}</span><span class="d-count">${doneN}/${d.problems.length}</span></summary>
      <div class="table-scroll"><table>
        <thead><tr><th>#</th><th>Problem</th><th>Difficulty</th><th>Subtopic</th><th>Status</th><th>Solved</th><th>Next revision</th></tr></thead>
        <tbody>${items.map((p) => `<tr class="clickable" data-slug="${esc(p.slug)}">
          <td class="muted">${p.id || ''}</td>
          <td class="t-title"><a href="${p.url}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.notFound ? '<span class="tag" title="Not on LeetCode — mark it by hand. If it is on LeetCode under another name, add a \'slug\' or \'url\' in plan.json.">manual</span>' : ''}</td>
          <td>${diffBadge(p.difficulty)}</td>
          <td class="muted">${esc(p.subtopic)}</td>
          <td>${statusBadge(p.status)}</td>
          <td class="muted">${fmtDate(p.entry?.firstSolved)}</td>
          <td class="${p.status === 'overdue' ? 'c-hard' : p.status === 'due' ? 'c-medium' : 'muted'}">${p.entry?.nextRevision ? `${fmtDate(p.entry.nextRevision)} <span class="small">(${relDays(p.entry.nextRevision)})</span>` : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </details>`;
  }).join('') || `<div class="empty">${filtering ? 'No problems match' : 'No plan yet'}</div>`;
}

function renderExtras({ extras }) {
  $('#extrasCard').hidden = !extras.length;
  $('#extras').innerHTML = extras.sort((a, b) => (b.entry.lastActivity || '').localeCompare(a.entry.lastActivity || ''))
    .map((p) => row(p, `<span class="meta">${fmtDate(p.entry.firstSolved)}</span>${statusBadge(p.status)}`)).join('');
}

function renderBanner({ unique }) {
  const msgs = [];
  const missing = unique.filter((p) => !p.difficulty && !p.notFound).length;
  const notFound = unique.filter((p) => p.notFound);
  if (!S.config.leetcodeUsername && !S.progress.lastSync) msgs.push(['', 'Auto-sync isn’t set up yet: put your LeetCode username in <code>config.json</code> (see README).']);
  if (!canWrite()) msgs.push(['', 'Read-only: add a GitHub token in Settings ⚙ to save clicks and upload plans.']);
  if (missing) msgs.push(['', `${missing} problem${missing === 1 ? '' : 's'} waiting for difficulty/topic info. It fills in on the next sync (⟳ Sync).`]);
  if (notFound.length) msgs.push(['', `${notFound.length} problems are tracked by hand (tagged <span class="tag">manual</span>): they're either not on LeetCode or a repeat of an earlier plan problem. Tick them with ✓ Solved. To link one, fix it in <code>scripts/link-overrides.json</code> and run <code>node scripts/link-plan.mjs</code>.`]);
  $('#banner').innerHTML = msgs.map(([c, m]) => `<div class="banner ${c}">${m}</div>`).join('');
  $('#banner').style.display = msgs.length ? 'flex' : 'none';
  $('#banner').style.flexDirection = 'column';
  $('#banner').style.gap = '8px';
  $('#syncInfo').textContent = S.progress.lastSync ? `synced ${new Date(S.progress.lastSync).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
}

function render() {
  S.today = dateInTz(new Date(), S.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const d = derive();
  renderBanner(d); renderStats(d); renderHeatmap(); renderRevise(d); renderToday(d); renderTopics(d); renderPlan(d); renderExtras(d);
}

function openDetail(slug) {
  const d = derive();
  const p = [...d.unique, ...d.extras].find((x) => x.slug === slug);
  if (!p) return;
  const e = p.entry;
  $('#detailBody').innerHTML = `
    <div style="display:flex;gap:8px;align-items:center">${diffBadge(p.difficulty)}${statusBadge(p.status)}</div>
    <h2 style="font-size:17px"><a href="${p.url}" target="_blank" rel="noopener">${p.id ? p.id + '. ' : ''}${esc(p.title)} ↗</a></h2>
    <div class="muted small">${esc(p.subtopic)}${p.day ? ` · Day ${p.day}` : ''}</div>
    ${e ? `<div class="small">First solved <b>${fmtDate(e.firstSolved)}</b> · next revision <b>${fmtDate(e.nextRevision)}</b> (${relDays(e.nextRevision)}) · stage ${e.level + 1}/${S.intervals.length}</div>
      <div class="hist">${[...e.history].reverse().map((h) => `<div><span>${fmtDate(h.date)} · ${h.type}${h.rating === 'struggled' ? ' <span class="c-hard">(struggled)</span>' : ''}</span><span class="muted small">${h.source}</span></div>`).join('')}</div>
      <label>Notes<textarea id="notes" placeholder="Approach, pitfalls, complexity…">${esc(e.notes || '')}</textarea></label>` : '<div class="muted small">Not solved yet.</div>'}
    <div class="dlg-actions">
      ${e ? `<button class="btn ghost" data-d="undo">Undo last</button><button class="btn ghost" data-d="notes">Save notes</button>` : ''}
      <button class="btn bad" data-d="struggled">Struggled</button>
      <button class="btn primary" data-d="good">✓ ${e ? 'Revised' : 'Solved'}</button>
      <button class="btn ghost" data-d="close">Close</button>
    </div>`;
  $('#detailBody').onclick = async (ev) => {
    const a = ev.target.closest('[data-d]')?.dataset.d;
    if (!a) return;
    if (a === 'notes') { await saveNotes(slug, $('#notes').value); return; }
    $('#detail').close();
    if (a === 'undo') undo(slug);
    if (a === 'good' || a === 'struggled') record(slug, a);
  };
  $('#detail').showModal();
}

// ---------------------------------------------------------------- wiring
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (btn) { record(btn.dataset.slug, btn.dataset.act); return; }
  const tr = ev.target.closest('tr.clickable');
  if (tr && !ev.target.closest('a')) openDetail(tr.dataset.slug);
});
$('#planTable').addEventListener('toggle', (ev) => {
  const day = Number(ev.target.dataset.day);
  if (ev.target.open) openDays.add(day); else openDays.delete(day);
}, true);
['#fSearch', '#fDiff', '#fStatus', '#fTopic'].forEach((s) => $(s).addEventListener('input', () => renderPlan(derive())));
$('#syncBtn').onclick = triggerSync;
$('#planInput').onchange = (e) => { if (e.target.files[0]) uploadPlan(e.target.files[0]); e.target.value = ''; };
$('#settingsBtn').onclick = () => {
  const f = $('#settings form');
  for (const k of ['owner', 'repo', 'branch', 'token']) f.elements[k].value = settings[k] || '';
  $('#settings').showModal();
};
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const f = $('#settings form');
  settings = Object.fromEntries(['owner', 'repo', 'branch', 'token'].map((k) => [k, f.elements[k].value.trim()]));
  settings.branch ||= 'main';
  try { localStorage.setItem('lc-settings', JSON.stringify(settings)); } catch {}
  load();
});
// Drag-and-drop a plan anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) uploadPlan(f); });
// Refresh when you come back to the tab (e.g. after solving on LeetCode).
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (load.at || 0) > 5 * 60000) load(); });

async function load() {
  load.at = Date.now();
  const [config, planRaw, progress, meta, catalog, links] = await Promise.all([
    readFile('config.json', {}), readFile('data/plan.json', {}),
    readFile('data/progress.json', { version: 1, problems: {} }), readFile('data/meta.json', {}),
    readFile('data/a2z.json', []), readFile('data/links.json', {}),
  ]);
  Object.assign(S, { config, planRaw, catalog, links, plan: parsePlan(planRaw, catalog, links), progress, meta, intervals: config.intervals || DEFAULT_INTERVALS });
  S.progress.problems ||= {};
  render();
}
load();
