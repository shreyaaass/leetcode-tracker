# LeetCode Tracker

A day-wise LeetCode plan tracker with spaced-repetition revisions. It runs entirely free on GitHub: **GitHub Pages** hosts the dashboard, and a **GitHub Action** syncs your accepted LeetCode submissions every 3 hours. Nothing runs on your Mac.

## How it works

```
leetcode.com ──(Action, every 3h)──► data/progress.json ◄──(dashboard clicks, GitHub API)
                                     data/meta.json      (difficulty + topic tags)
                                     data/plan.json      (your plan)
                                           │
                                           ▼
                              GitHub Pages dashboard (static)
```

- **Solve on LeetCode, and that's it.** The Action picks up the accepted submission, marks the problem solved and schedules the first revision 14 days later.
- **Revising** works the same way. An accepted submission within 3 days of the due date (or any time after it) counts as a revision. Earlier re-solves are logged as practice and show up on the heatmap.
- **Struggled?** Click *Struggled* (or *Struggled?* next to a problem solved today). The next revision moves closer and you drop back a stage.
- **Days are progress-based, not calendar-based.** The current day is the first day of the plan that still has unsolved problems, so vacations don't put you behind.

### Revision schedule

| Event | Next revision |
|---|---|
| First solve | +14 days |
| Revised fine | gap grows: 14 → 30 → 60 → 120 → 240 days |
| Struggled | back one stage, then revise again in ~¼ of that gap (min 3 days) |

Change `intervals` in `config.json` to adjust these.

## Notes (private)

Click any problem to open it. The **Notes** section accepts:
- **Text:** type, then *Add note* (or ⌘/Ctrl + Enter).
- **Images:** 🖼 Image, paste a screenshot into the text box, or drag one onto the panel. Large images are shrunk before upload.
- **Voice:** ● Record, then ■ Stop. It's saved straight away as m4a where supported (Safari, recent Chrome), otherwise webm.

Notes never go to the public tracker repo. They're stored in the private notes repo:
```
index.json                 note counts per problem (the ✎ badges)
notes/<problem>.json       the notes themselves
media/<problem>/<id>.*     images and recordings
```
Deleting a note removes the file, but it stays in that private repo's git history.

## Plan format

Drop a JSON file onto the dashboard (or click **⤒ Plan**). Keys are day numbers. All of these forms work, and you can mix them:

```json
{
  "1": ["Two Sum", "Contains Duplicate"],
  "2": [
    { "title": "Group Anagrams", "difficulty": "Medium", "subtopic": "Hashing" },
    "https://leetcode.com/problems/product-of-array-except-self/"
  ],
  "3": { "topic": "Two Pointers", "problems": ["3Sum", "trapping-rain-water"] }
}
```

**Striver's A2Z names are linked automatically.** `data/a2z.json` holds the whole sheet (390 problems, 240 of them on LeetCode). Plan names are matched against it loosely: "Insertion Sort" finds "Insertion Sorting", and "Kadane's Algorithm" finds `maximum-subarray`. Sheet problems that aren't on LeetCode link to takeUforward and are tagged **manual**, meaning you tick them yourself. A few sheet problems share one LeetCode problem (e.g. "Power Set" / "Subsets I"); only the closest-named one auto-syncs, and the rest are manual so their progress stays separate. To refresh the catalog: `node scripts/import-a2z.mjs`.

**After changing the plan, run `node scripts/link-plan.mjs`.** It resolves every name to a LeetCode problem: first from the sheet, then by trying the name as a slug, then through LeetCode search (accepted only for close matches). The results go to `data/links.json`. Hand corrections live in `scripts/link-overrides.json` (slug, or `null` for "not on LeetCode") and always win. If the same LeetCode problem appears more than once in the plan, the first appearance auto-syncs and later ones are manual. Re-solving it on LeetCode still counts as a revision of the first.

Difficulty and subtopic are optional. When they're missing, the sync fills them in from LeetCode (difficulty plus the first topic tag). A problem whose title doesn't match LeetCode gets flagged as **not found** on the dashboard; use the exact title or the URL for those.

## One-time setup (~5 minutes)

1. **Create a public GitHub repo** (e.g. `leetcode-tracker`) and push this folder to it:
   ```bash
   git init && git add . && git commit -m "init"
   ```
   ```bash
   git remote add origin https://github.com/<you>/leetcode-tracker.git && git push -u origin main
   ```
2. **Set your LeetCode username.** Put it in `config.json` → `"leetcodeUsername"`. Your LeetCode profile must be public.
   Optional: set `"trackFrom": "2027-01-01"` to ignore anything you solved before you started the plan.
3. **Enable Pages:** repo → Settings → Pages → *Deploy from a branch* → `main` / root.
   The dashboard will be at `https://<you>.github.io/leetcode-tracker/`.
4. **Allow the Action to push:** repo → Settings → Actions → General → Workflow permissions → *Read and write*.
5. **Create a private notes repo** called `leetcode-notes` (any name works; set it in ⚙ Settings).
6. **Create a token for the dashboard:** GitHub → Settings → Developer settings → Fine-grained tokens. Limit it to **both repos** (`leetcode-tracker` and `leetcode-notes`), with **Contents: Read and write** and **Actions: Read and write**. Paste it into the dashboard's ⚙ Settings. It's stored only in that browser.
7. **Add it to your Dock:** open the dashboard in Safari → File → *Add to Dock*. On iPhone: Share → *Add to Home Screen*.

Then click **⟳ Sync** once to run the first sync.

## Good to know

- LeetCode's public API returns only your **last ~20 accepted submissions**. A 3-hour sync covers that unless you solve 20+ problems between syncs. If that happens, click ⟳ Sync partway through.
- GitHub **pauses scheduled workflows after 60 days with no repo activity**. If you take a long break, re-enable it under the Actions tab.
- Without a token the dashboard is **read-only**, and clicks aren't saved. Auto-sync still works.
- Run the sync locally: `node scripts/sync.mjs`. Refresh metadata only: `node scripts/sync.mjs --meta`.
- Preview locally: `python3 -m http.server 8765`, then open http://localhost:8765.

## Files

| Path | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | Dashboard |
| `notes.js` | Private notes: storage in the notes repo, image prep, voice recording |
| `lib/core.js` | Shared logic: plan parsing, spaced repetition, stats |
| `scripts/sync.mjs` | LeetCode → progress sync |
| `.github/workflows/sync.yml` | Runs the sync every 3h, on demand, and when the plan changes |
| `config.json` | Username, timezone, revision intervals |
| `data/plan.json` | Your plan (currently a **sample**; replace it) |
| `data/progress.json` | Solve/revision history (written by the sync and the dashboard) |
| `data/meta.json` | Cached difficulty/topics from LeetCode |
| `data/a2z.json` | Striver A2Z catalog: sheet name → LeetCode slug (from `scripts/import-a2z.mjs`) |
