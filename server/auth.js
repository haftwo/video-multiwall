const config = require('./config');
const { db, hashPassword, verifyPassword } = require('./db');
const { HttpError, json, redirect, writeSession } = require('./http');
const entra = require('./entra');

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name || u.username,
  email: u.email,
  role: u.role,
  provider: u.provider,
});

// ---- middleware -------------------------------------------------------------
function loadUser(req, res) {
  req.user = null;
  if (req.session.uid) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND enabled = 1').get(req.session.uid);
    if (u) req.user = u;
    else writeSession(res, null); // deleted or disabled: revoke immediately
  }
}

// State-changing requests must carry a custom header. Browsers will not send
// it cross-site without a CORS preflight, which this server never approves.
function csrfGuard(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-requested-with'] !== 'multiwall') {
    throw new HttpError(403, 'Missing X-Requested-With header');
  }
}

function requireAuth(req) {
  if (!req.user) throw new HttpError(401, 'Not signed in');
}
function requireAdmin(req) {
  requireAuth(req);
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admin only');
}

function signIn(res, user) {
  writeSession(res, { uid: user.id });
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
}

// ---- brute-force limiter (in memory, per IP) --------------------------------
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
function tooMany(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) { attempts.delete(ip); return false; }
  return a.count >= MAX_FAILS;
}
function recordFail(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count += 1;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now - a.first > WINDOW_MS) attempts.delete(ip);
}, 60 * 1000).unref();

// ---- routes -----------------------------------------------------------------
function register(app) {
  app.get('/api/auth/config', (_req, res) => json(res, {
    appName: config.appName,
    version: config.version,
    localLogin: config.localLogin,
    microsoft: config.entra.enabled,
  }));

  app.post('/api/auth/login', (req, res) => {
    if (!config.localLogin) throw new HttpError(403, 'Local sign-in is disabled');
    if (tooMany(req.ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');

    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare(
      "SELECT * FROM users WHERE username = ? AND provider = 'local' AND enabled = 1"
    ).get(username);

    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFail(req.ip);
      throw new HttpError(401, 'Incorrect username or password');
    }
    attempts.delete(req.ip);
    signIn(res, user);
    json(res, { user: publicUser(user) });
  });

  app.post('/api/auth/logout', (_req, res) => {
    writeSession(res, null);
    json(res, { ok: true });
  });

  app.post('/api/auth/password', requireAuth, (req, res) => {
    if (req.user.provider !== 'local') throw new HttpError(400, 'Your password is managed by Microsoft');
    const current = String(req.body.current || '');
    const next = String(req.body.next || '');
    if (!verifyPassword(current, req.user.password_hash)) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    json(res, { ok: true });
  });

  // ---- Microsoft Entra ID single sign-on ------------------------------------
  const callbackUrl = (req) => `${req.origin}/auth/microsoft/callback`;
  const fail = (res, msg) => redirect(res, `/login?error=${encodeURIComponent(msg)}`);

  app.get('/auth/microsoft', async (req, res) => {
    if (!config.entra.enabled) return fail(res, 'Microsoft sign-in is not configured');
    try {
      const { url, pending } = await entra.begin(callbackUrl(req));
      writeSession(res, { oauth: pending });
      redirect(res, url);
    } catch (err) {
      console.error('[entra] could not start sign-in:', err.message);
      fail(res, 'Could not reach Microsoft sign-in');
    }
  });

  app.get('/auth/microsoft/callback', async (req, res) => {
    if (!config.entra.enabled) return fail(res, 'Microsoft sign-in is not configured');
    const pending = req.session.oauth;
    writeSession(res, null);

    if (req.query.error) {
      return fail(res, String(req.query.error_description || req.query.error).slice(0, 200));
    }
    if (!pending || !req.query.code || req.query.state !== pending.state ||
        Date.now() - pending.at > 10 * 60 * 1000) {
      return fail(res, 'Sign-in expired or was interrupted. Please try again.');
    }

    let claims;
    try {
      claims = await entra.complete(String(req.query.code), pending, callbackUrl(req));
    } catch (err) {
      console.error('[entra] sign-in failed:', err.message);
      return fail(res, 'Microsoft sign-in failed. Check the server log for details.');
    }

    const oid = claims.oid || claims.sub;
    const email = String(claims.email || claims.preferred_username || '').toLowerCase();
    const name = String(claims.name || email).slice(0, 80);
    if (!oid || !email) return fail(res, 'Microsoft did not return an account identity');

    const domain = email.split('@')[1] || '';
    if (config.entra.allowedDomains.length && !config.entra.allowedDomains.includes(domain)) {
      return fail(res, 'Your email domain is not allowed to sign in');
    }

    let user = db.prepare(
      "SELECT * FROM users WHERE provider = 'entra' AND external_id = ?"
    ).get(oid);

    if (!user) {
      // Pre-approved by an admin (added by email, not yet linked)?
      const pre = db.prepare(
        "SELECT * FROM users WHERE provider = 'entra' AND external_id IS NULL AND lower(email) = ?"
      ).get(email);
      if (pre) {
        db.prepare('UPDATE users SET external_id = ? WHERE id = ?').run(oid, pre.id);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(pre.id);
      }
    }

    const shouldBeAdmin = config.entra.adminEmails.includes(email);
    if (!user) {
      if (!config.entra.autoProvision && !shouldBeAdmin) {
        return fail(res, 'Your account has not been approved. Ask an administrator for access.');
      }
      const taken = db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(email);
      const info = db.prepare(
        "INSERT INTO users (username, display_name, email, role, provider, external_id) VALUES (?, ?, ?, ?, 'entra', ?)"
      ).run(taken ? `${email}#entra` : email, name, email, shouldBeAdmin ? 'admin' : 'user', oid);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else {
      if (!user.enabled) return fail(res, 'Your account has been disabled');
      db.prepare('UPDATE users SET display_name = ?, email = ?, role = ? WHERE id = ?')
        .run(name, email, shouldBeAdmin ? 'admin' : user.role, user.id);
    }

    signIn(res, user);
    redirect(res, '/');
  });
}

module.exports = { register, loadUser, csrfGuard, requireAuth, requireAdmin, publicUser };
