// TikGrab - works locally (node server.js) and on Vercel (api/index.js)
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'; // CHANGE via env
const SECRET = process.env.SECRET || ADMIN_PASS + '::tikgrab';

// ---------- JSON database ----------
// Local: data.json | Vercel: /tmp/data.json (temporary!) | Optional permanent: Upstash Redis (free) via env vars
const UP = process.env.UPSTASH_REDIS_REST_URL, UT = process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = process.env.VERCEL ? '/tmp/data.json' : path.join(__dirname, 'data.json');
const defaults = {
  settings: { siteName: 'TikGrab', apiUrl: 'https://www.tikwm.com/api/?hd=1&url=', apiKey: '', maintenance: false, rateLimit: 20, adTop: '', adResult: '', adMid: '', adBottom: '' },
  logs: [],
};

// ---------- MongoDB (permanent, used when MONGODB_URI is set) ----------
const MONGO = process.env.MONGODB_URI;
let mongoP = null, lastLoad = 0;
const mdb = () => {
  if (!mongoP) {
    const { MongoClient } = require('mongodb');
    mongoP = new MongoClient(MONGO, { serverSelectionTimeoutMS: 8000 }).connect().then(async (c) => {
      const d = c.db(); // database name comes from the URI (/tiktokDownloderDB)
      await d.collection('logs').createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }); // logs auto-delete after 30 days
      return d;
    }).catch((e) => { mongoP = null; throw e; });
  }
  return mongoP;
};
let db = null;
async function loadDb() {
  if (MONGO) {
    if (db && Date.now() - lastLoad < 8000) return;
    try { const doc = await (await mdb()).collection('settings').findOne({ _id: 'main' }); db = { settings: { ...defaults.settings, ...(doc && doc.settings) }, logs: [] }; lastLoad = Date.now(); }
    catch (e) { console.error('mongo load failed', e.message); db = db || structuredClone(defaults); }
    return;
  }
  if (UP) {
    try {
      const r = await fetch(UP + '/get/tikgrab', { headers: { Authorization: 'Bearer ' + UT } });
      const j = await r.json();
      db = j.result ? JSON.parse(j.result) : structuredClone(defaults);
    } catch { db = db || structuredClone(defaults); }
  } else if (!db) {
    for (const f of [FILE, path.join(__dirname, 'data.json')]) {
      try { db = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch {}
    }
    db = db || structuredClone(defaults);
  }
  db.settings = { ...defaults.settings, ...db.settings };
  db.logs = db.logs || [];
}
async function saveDb() {
  const s = JSON.stringify(db);
  try {
    if (MONGO) await (await mdb()).collection('settings').updateOne({ _id: 'main' }, { $set: { settings: db.settings } }, { upsert: true });
    else if (UP) await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(['SET', 'tikgrab', s]) });
    else fs.writeFileSync(FILE, s);
  } catch (e) { console.error('save failed', e.message); }
}

const app = express();
app.use(express.json());
app.use(async (req, res, next) => { await loadDb(); next(); });
app.use(express.static(path.join(__dirname, 'public')));

const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > db.settings.rateLimit;
};
const addLog = async (e) => {
  if (MONGO) { try { await (await mdb()).collection('logs').insertOne({ time: new Date().toISOString(), at: new Date(), ...e }); } catch (x) { console.error('log failed', x.message); } return; }
  db.logs.unshift({ time: new Date().toISOString(), ...e }); db.logs.length = Math.min(db.logs.length, 1000); await saveDb(); };

// ---------- public ----------
app.get('/api/public', (req, res) => {
  const { siteName, adTop, adResult, adMid, adBottom, maintenance } = db.settings;
  res.json({ siteName, adTop, adResult, adMid, adBottom, maintenance });
});

app.post('/api/fetch', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const url = String(req.body.url || '').trim();
  if (db.settings.maintenance) return res.status(503).json({ error: 'Site maintenance par hai, thori dair baad try karein.' });
  if (limited(ip)) return res.status(429).json({ error: 'Bohat zyada requests. Aik minute baad try karein.' });
  if (!/^https?:\/\/([\w-]+\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(url))
    return res.status(400).json({ error: 'Sahi TikTok link paste karein.' });
  try {
    const headers = db.settings.apiKey ? { 'x-api-key': db.settings.apiKey } : {};
    const r = await fetch(db.settings.apiUrl + encodeURIComponent(url), { headers });
    const j = await r.json();
    const d = j.data;
    if (!d || j.code !== 0) throw new Error(j.msg || 'Video nahi mila');
    const base = new URL(db.settings.apiUrl).origin, abs = (p) => (/^https?:/.test(p) ? p : base + p);
    const items = [];
    if (d.hdplay) items.push({ label: 'HD Video', note: 'No watermark', type: 'video', url: abs(d.hdplay), ext: 'mp4' });
    if (d.play) items.push({ label: 'Video', note: 'No watermark', type: 'video', url: abs(d.play), ext: 'mp4' });
    if (d.wmplay) items.push({ label: 'Video', note: 'With watermark', type: 'video', url: abs(d.wmplay), ext: 'mp4' });
    if (d.music) items.push({ label: 'Audio', note: 'MP3', type: 'audio', url: abs(d.music), ext: 'mp3' });
    (d.images || []).forEach((u, i) => items.push({ label: 'Photo ' + (i + 1), note: 'Slideshow image', type: 'image', url: u, ext: 'jpg' }));
    await addLog({ ip, url, status: 'ok', title: d.title });
    res.json({ title: d.title, author: d.author?.nickname, cover: d.cover, duration: d.duration, items });
  } catch (e) {
    await addLog({ ip, url, status: 'error', error: e.message });
    res.status(502).json({ error: 'Video fetch nahi ho saki: ' + e.message });
  }
});

app.get('/api/dl', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname)) throw 0;
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.tiktok.com/' } });
    if (!r.ok) throw 0;
    const name = String(req.query.name || 'tiktok').replace(/[^\w.-]/g, '_');
    if (!req.query.inline) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    const len = r.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);
    Readable.fromWeb(r.body).pipe(res);
  } catch { res.status(400).send('Download failed'); }
});

// ---------- admin (stateless signed tokens, safe for serverless) ----------
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const makeToken = () => { const exp = Date.now() + 12 * 3600e3; return exp + '.' + sign(String(exp)); };
const validToken = (t) => { const [exp, sig] = String(t).split('.'); return exp && sig && +exp > Date.now() && sig === sign(exp); };
app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) return res.json({ token: makeToken() });
  res.status(401).json({ error: 'Galat username ya password' });
});
const auth = (req, res, next) => validToken((req.headers.authorization || '').replace('Bearer ', '')) ? next() : res.status(401).json({ error: 'Login required' });

app.get('/admin/settings', auth, (req, res) => res.json(db.settings));
app.put('/admin/settings', auth, async (req, res) => { db.settings = { ...db.settings, ...req.body }; await saveDb(); lastLoad = Date.now(); res.json(db.settings); });
app.get('/admin/export', auth, async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="data.json"');
  res.json(MONGO ? { settings: db.settings, logs: await mlogs(5000) } : db);
});
const mlogs = async (n) => (await (await mdb()).collection('logs').find({}, { projection: { _id: 0, at: 0 } }).sort({ _id: -1 }).limit(n).toArray());
app.get('/admin/logs', auth, async (req, res) => res.json(MONGO ? await mlogs(300) : db.logs.slice(0, 300)));
app.delete('/admin/logs', auth, async (req, res) => { if (MONGO) await (await mdb()).collection('logs').deleteMany({}); else { db.logs = []; await saveDb(); } res.json({ ok: 1 }); });
app.get('/admin/stats', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (MONGO) {
    const c = (await mdb()).collection('logs');
    const [total, t, errors, users] = await Promise.all([c.countDocuments(), c.countDocuments({ time: { $regex: '^' + today } }), c.countDocuments({ status: 'error' }), c.distinct('ip')]);
    return res.json({ total, today: t, errors, users: users.length });
  }
  res.json({
    total: db.logs.length,
    today: db.logs.filter((l) => l.time.startsWith(today)).length,
    errors: db.logs.filter((l) => l.status === 'error').length,
    users: new Set(db.logs.map((l) => l.ip)).size,
  });
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log('TikGrab running on http://localhost:' + PORT));
