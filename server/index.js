const http = require('http');
const path = require('path');
const config = require('./config');
const { db, hashPassword } = require('./db');
const { App, HttpError, json, redirect, sendFile } = require('./http');
const auth = require('./auth');
const relay = require('./proxy');

const app = new App();
const root = path.join(__dirname, '..');

// ---- runs on every request ----------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

app.use((_req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
});
app.use(auth.loadUser);
app.use(auth.csrfGuard);

// ---- pages + static files -------------------------------------------------------
const view = (name) => path.join(root, 'views', `${name}.html`);

app.get('/healthz', (_req, res) => json(res, { ok: true }));
app.get('/login', (req, res) => (req.user ? redirect(res, '/') : sendFile(res, view('login'))));
app.get('/', (req, res) => {
  if (req.user) return sendFile(res, view('wall'));
  // Keep a shared-wall link (?wall=...) across the sign-in page.
  const shared = req.query.wall
    ? `?${new URLSearchParams({ wall: req.query.wall, ...(req.query.audio ? { audio: req.query.audio } : {}) })}`
    : '';
  redirect(res, `/login${shared}`);
});
app.get('/admin', (req, res) => {
  if (!req.user) return redirect(res, '/login');
  if (req.user.role !== 'admin') return redirect(res, '/');
  sendFile(res, view('admin'));
});
app.static(path.join(root, 'public'), ['/css/', '/js/', '/vendor/']);

auth.register(app);
relay.register(app);

// ---- helpers ------------------------------------------------------------------
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const flag = (v, d) => (v === undefined ? d : v ? 1 : 0);
function httpUrl(v) {
  try {
    const u = new URL(String(v).trim());
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

// ---- viewer API ---------------------------------------------------------------
app.get('/api/me', auth.requireAuth, (req, res) => json(res, {
  user: auth.publicUser(req.user),
  appName: config.appName,
  maxPanels: config.maxPanels,
}));

app.get('/api/channels', auth.requireAuth, (_req, res) => {
  const rows = db.prepare(
    'SELECT * FROM channels WHERE enabled = 1 ORDER BY sort_order, name COLLATE NOCASE'
  ).all();
  json(res, {
    channels: rows.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      logoUrl: c.logo_url,
      playUrl: c.proxy ? relay.relayUrl(c.id, c.url) : c.url,
    })),
  });
});

app.get('/api/layout', auth.requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM layouts WHERE user_id = ?').get(req.user.id);
  let layout = { panels: [] };
  if (row) { try { layout = JSON.parse(row.data); } catch { /* keep default */ } }
  json(res, layout);
});

app.put('/api/layout', auth.requireAuth, (req, res) => {
  if (!Array.isArray(req.body.panels)) bad('panels must be an array');
  const panels = req.body.panels.slice(0, config.maxPanels).map((p) => ({
    channelId: Number.isInteger(p?.channelId) ? p.channelId : null,
    muted: p?.muted !== false,
    volume: Math.min(1, Math.max(0, Number.isFinite(p?.volume) ? p.volume : 1)),
  }));
  db.prepare(`
    INSERT INTO layouts (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify({ panels }));
  json(res, { ok: true });
});

// ---- admin: channels ----------------------------------------------------------
const channelOut = (c) => ({
  id: c.id, name: c.name, url: c.url, category: c.category, logoUrl: c.logo_url,
  enabled: !!c.enabled, proxy: !!c.proxy, sortOrder: c.sort_order,
});
const getChannel = (id) => db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id));

function channelIn(body, existing) {
  const name = body.name !== undefined ? str(body.name, 80) : existing?.name;
  if (!name) bad('Name is required');
  const url = body.url !== undefined ? httpUrl(body.url) : existing?.url;
  if (!url) bad('Stream URL must be a valid http(s) URL');
  let logo = existing?.logo_url ?? '';
  if (body.logoUrl !== undefined) {
    logo = str(body.logoUrl, 500) ? httpUrl(body.logoUrl) : '';
    if (logo === null) bad('Logo URL must be a valid http(s) URL');
  }
  return {
    name, url, logo,
    category: body.category !== undefined ? str(body.category, 40) : existing?.category ?? '',
    enabled: flag(body.enabled, existing?.enabled ?? 1),
    proxy: flag(body.proxy, existing?.proxy ?? 0),
    sort: Number.isInteger(body.sortOrder) ? body.sortOrder : existing?.sort_order ?? 0,
  };
}

app.get('/api/admin/channels', auth.requireAdmin, (_req, res) => json(res, {
  channels: db.prepare('SELECT * FROM channels ORDER BY sort_order, name COLLATE NOCASE')
    .all().map(channelOut),
}));

app.post('/api/admin/channels', auth.requireAdmin, (req, res) => {
  const c = channelIn(req.body);
  const info = db.prepare(
    'INSERT INTO channels (name, url, category, logo_url, enabled, proxy, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(c.name, c.url, c.category, c.logo, c.enabled, c.proxy, c.sort);
  json(res, { channel: channelOut(getChannel(info.lastInsertRowid)) }, 201);
});

app.put('/api/admin/channels/:id', auth.requireAdmin, (req, res) => {
  const existing = getChannel(req.params.id);
  if (!existing) throw new HttpError(404, 'Channel not found');
  const c = channelIn(req.body, existing);
  db.prepare(
    'UPDATE channels SET name = ?, url = ?, category = ?, logo_url = ?, enabled = ?, proxy = ?, sort_order = ? WHERE id = ?'
  ).run(c.name, c.url, c.category, c.logo, c.enabled, c.proxy, c.sort, existing.id);
  json(res, { channel: channelOut(getChannel(existing.id)) });
});

app.delete('/api/admin/channels/:id', auth.requireAdmin, (req, res) => {
  db.prepare('DELETE FROM channels WHERE id = ?').run(Number(req.params.id));
  json(res, { ok: true });
});

// ---- admin: users -------------------------------------------------------------
const userOut = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name, email: u.email,
  role: u.role, provider: u.provider, enabled: !!u.enabled,
  linked: u.provider === 'entra' ? !!u.external_id : undefined,
  createdAt: u.created_at, lastLogin: u.last_login,
});
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));

app.get('/api/admin/users', auth.requireAdmin, (_req, res) => json(res, {
  users: db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(userOut),
  sso: {
    enabled: config.entra.enabled,
    autoProvision: config.entra.autoProvision,
    allowedDomains: config.entra.allowedDomains,
    adminEmails: config.entra.adminEmails,
    redirectUri: config.baseUrl ? `${config.baseUrl}/auth/microsoft/callback` : null,
  },
}));

app.post('/api/admin/users', auth.requireAdmin, (req, res) => {
  const b = req.body;
  const provider = b.provider === 'entra' ? 'entra' : 'local';
  const role = b.role === 'admin' ? 'admin' : 'user';
  const email = str(b.email, 200).toLowerCase();
  const username = (provider === 'entra' ? email : str(b.username, 60)).toLowerCase();
  const password = String(b.password || '');

  if (provider === 'entra' && !/^[^@\s]+@[^@\s]+$/.test(email)) {
    bad('A Microsoft user needs a valid email address');
  }
  if (!username) bad('Username is required');
  if (provider === 'local' && password.length < 8) bad('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(username)) {
    bad('That username is already in use');
  }
  const info = db.prepare(
    'INSERT INTO users (username, display_name, email, password_hash, role, provider) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, str(b.displayName, 80), email,
    provider === 'local' ? hashPassword(password) : null, role, provider);
  json(res, { user: userOut(getUser(info.lastInsertRowid)) }, 201);
});

app.put('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  const b = req.body;

  const role = b.role === undefined ? u.role : b.role === 'admin' ? 'admin' : 'user';
  const enabled = flag(b.enabled, u.enabled);
  if (u.id === req.user.id && (role !== 'admin' || !enabled)) {
    bad('You cannot demote or disable your own account');
  }
  let hash = u.password_hash;
  if (b.password !== undefined && b.password !== '') {
    if (u.provider !== 'local') bad('Microsoft users have no local password');
    if (String(b.password).length < 8) bad('Password must be at least 8 characters');
    hash = hashPassword(String(b.password));
  }
  db.prepare('UPDATE users SET display_name = ?, role = ?, enabled = ?, password_hash = ? WHERE id = ?')
    .run(b.displayName !== undefined ? str(b.displayName, 80) : u.display_name, role, enabled, hash, u.id);
  json(res, { user: userOut(getUser(u.id)) });
});

app.delete('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) bad('You cannot delete your own account');
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
  json(res, { ok: true });
});

// ---- start --------------------------------------------------------------------
const server = http.createServer((req, res) => app.handle(req, res));
server.listen(config.port, () => {
  console.log(`${config.appName} listening on port ${config.port}`);
  console.log(` Local sign-in:     ${config.localLogin ? 'on' : 'off'}`);
  console.log(` Microsoft sign-in: ${config.entra.enabled ? 'on' : 'off (set ENTRA_* variables to enable)'}`);
  if (config.entra.enabled && !config.baseUrl) {
    console.warn(' WARNING: BASE_URL is not set, so the Microsoft redirect URI is guessed from each request.');
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
    server.closeAllConnections(); // do not wait on long-lived stream relays
  });
}
