// Notes storage in a separate PRIVATE GitHub repo (default: <owner>/leetcode-notes).
// Nothing here touches the public tracker repo.
//
// Layout in the notes repo:
//   index.json                      { "<slug>": <note count> }        — powers the ✎ badges
//   notes/<slug>.json               { slug, notes: [ {id, type, text?, path?, mime?, sha?, size?, created} ] }
//   media/<slug>/<id>.<ext>         images and audio
// type: 'text' | 'image' | 'audio'

const safe = (slug) => slug.replace(/[^a-z0-9-]/gi, '_');

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const jsonToBase64 = (obj) => { let bin = ''; new TextEncoder().encode(JSON.stringify(obj, null, 1) + '\n').forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };
const base64ToJson = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0))));

const EXT = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function createNotesStore(getSettings) {
  const blobCache = new Map(); // path -> object URL
  let index = null;

  const cfg = () => {
    const s = getSettings();
    return { owner: s.owner, repo: s.notesRepo || 'leetcode-notes', token: s.token };
  };
  const enabled = () => { const c = cfg(); return !!(c.owner && c.repo && c.token); };

  async function api(path, opts = {}) {
    const c = cfg();
    const res = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`, {
      ...opts,
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${c.token}`, ...(opts.headers || {}) },
    });
    if (res.status === 404 && (!opts.method || opts.method === 'GET')) return null;
    if (!res.ok) { const e = new Error(`GitHub ${res.status}`); e.status = res.status; throw e; }
    return opts.raw ? res.blob() : res.json();
  }

  async function getJson(path, fallback) {
    const r = await api(path);
    return r ? { data: base64ToJson(r.content), sha: r.sha } : { data: structuredClone(fallback), sha: null };
  }

  // Read-modify-write a JSON file, retrying if someone else changed it meanwhile.
  async function updateJson(path, fallback, fn, message) {
    for (let i = 0; i < 3; i++) {
      const { data, sha } = await getJson(path, fallback);
      const next = fn(data);
      try {
        await api(path, { method: 'PUT', body: JSON.stringify({ message, content: jsonToBase64(next), ...(sha ? { sha } : {}) }) });
        return next;
      } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
    }
    throw new Error('Conflict — try again');
  }

  async function setCount(slug, n) {
    index = await updateJson('index.json', {}, (idx) => { if (n) idx[slug] = n; else delete idx[slug]; return idx; }, `index: ${slug}`);
  }

  return {
    enabled,
    counts: () => index || {},

    async loadIndex() {
      if (!enabled()) return (index = {});
      try { index = (await getJson('index.json', {})).data; } catch { index = {}; }
      return index;
    },

    async list(slug) {
      return (await getJson(`notes/${safe(slug)}.json`, { slug, notes: [] })).data.notes;
    },

    async add(slug, { text, blob }) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const note = { id, created: new Date().toISOString() };
      if (blob) {
        const mime = (blob.type || 'application/octet-stream').split(';')[0];
        const path = `media/${safe(slug)}/${id}.${EXT[mime] || 'bin'}`;
        const r = await api(path, { method: 'PUT', body: JSON.stringify({ message: `media: ${slug}`, content: await toBase64(blob) }) });
        Object.assign(note, { type: mime.startsWith('audio') ? 'audio' : 'image', path, mime, sha: r.content.sha, size: blob.size });
        blobCache.set(path, URL.createObjectURL(blob));
        if (text) note.text = text;
      } else {
        Object.assign(note, { type: 'text', text });
      }
      const doc = await updateJson(`notes/${safe(slug)}.json`, { slug, notes: [] }, (d) => { d.notes.push(note); return d; }, `note: ${slug}`);
      await setCount(slug, doc.notes.length);
      return doc.notes;
    },

    async remove(slug, id) {
      let removed = null;
      const doc = await updateJson(`notes/${safe(slug)}.json`, { slug, notes: [] }, (d) => {
        removed = d.notes.find((n) => n.id === id);
        d.notes = d.notes.filter((n) => n.id !== id);
        return d;
      }, `delete note: ${slug}`);
      if (removed?.path) {
        try {
          const meta = await api(removed.path);
          if (meta) await api(removed.path, { method: 'DELETE', body: JSON.stringify({ message: `delete media: ${slug}`, sha: meta.sha }) });
        } catch (e) { console.warn('media delete failed', e); }
      }
      await setCount(slug, doc.notes.length);
      return doc.notes;
    },

    // Object URL for an image/audio note (fetched once from the private repo, then cached).
    async mediaUrl(note) {
      if (blobCache.has(note.path)) return blobCache.get(note.path);
      const blob = await api(note.path, { headers: { Accept: 'application/vnd.github.raw' }, raw: true });
      const url = URL.createObjectURL(new Blob([blob], { type: note.mime }));
      blobCache.set(note.path, url);
      return url;
    },
  };
}

// ---------------------------------------------------------------- capture helpers

// Shrink big images (phone photos, retina screenshots) before upload.
export async function prepareImage(file, maxSide = 1800, maxBytes = 1.2e6) {
  if (file.size <= maxBytes || file.type === 'image/gif') return file;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85));
}

// Prefer mp4/AAC: it plays everywhere (Safari, Chrome, iPhone). Fall back to webm/opus.
export function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickAudioMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: (rec.mimeType || mimeType || 'audio/webm').split(';')[0] }));
    };
  });
  rec.start(1000);
  const started = Date.now();
  return { stop: () => { if (rec.state !== 'inactive') rec.stop(); return done; }, elapsed: () => Date.now() - started };
}
