// A very small web framework on top of Node's built-in http module:
// routing, JSON bodies, signed-cookie sessions and static files.
// Keeping this in-house means the server has zero npm dependencies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- signed cookie session ----------------------------------------------------
const COOKIE = 'mw_session';
const sessionKey = crypto.createHmac('sha256', config.secret).update('session-v1').digest();
const mac = (payload) => crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');

function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return {};
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return {};
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return {};
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : {};
  } catch { return {}; }
}

function writeSession(res, data) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.cookieSecure) attrs.push('Secure');
  if (!data) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${attrs.join('; ')}`);
    return;
  }
  const maxAge = config.sessionDays * 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + maxAge * 1000 }))
    .toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${mac(payload)}; Max-Age=${maxAge}; ${attrs.join('; ')}`);
}

// ---- responses ------------------------------------------------------------------
function json(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendFile(res, file, cacheControl = 'no-store') {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---- request helpers ------------------------------------------------------------
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (config.trustProxy && fwd) {
    const hops = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    const n = typeof config.trustProxy === 'number' ? config.trustProxy : 1;
    return hops[Math.max(0, hops.length - n)] || req.socket.remoteAddress;
  }
  return req.socket.remoteAddress;
}

function origin(req) {
  if (config.baseUrl) return config.baseUrl;
  const proto = config.trustProxy && req.headers['x-forwarded-proto']
    ? req.headers['x-forwarded-proto'].split(',')[0].trim() : 'http';
  return `${proto}://${req.headers.host}`;
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---- router ---------------------------------------------------------------------
class App {
  constructor() { this.routes = []; this.before = []; this.staticDirs = []; }

  use(fn) { this.before.push(fn); }

  route(method, pattern, ...handlers) {
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, rx, keys, handlers });
  }
  get(p, ...h) { this.route('GET', p, ...h); }
  post(p, ...h) { this.route('POST', p, ...h); }
  put(p, ...h) { this.route('PUT', p, ...h); }
  delete(p, ...h) { this.route('DELETE', p, ...h); }

  // Serve files under `dir` for URLs starting with one of `prefixes`.
  static(dir, prefixes) { this.staticDirs.push({ dir: path.resolve(dir), prefixes }); }

  async handle(req, res) {
    try {
      const url = new URL(req.url, 'http://local');
      req.path = decodeURIComponent(url.pathname);
      req.query = Object.fromEntries(url.searchParams);
      req.ip = clientIp(req);
      req.origin = origin(req);
      req.session = readSession(req);
      req.body = {};
      const method = req.method === 'HEAD' ? 'GET' : req.method;

      for (const fn of this.before) {
        await fn(req, res);
        if (res.writableEnded) return;
      }

      if (method === 'GET') {
        for (const s of this.staticDirs) {
          if (!s.prefixes.some((p) => req.path.startsWith(p))) continue;
          const file = path.resolve(s.dir, `.${req.path}`);
          if (!file.startsWith(s.dir + path.sep)) throw new HttpError(404, 'Not found');
          return sendFile(res, file, 'public, max-age=3600');
        }
      }

      for (const r of this.routes) {
        if (r.method !== method) continue;
        const m = r.rx.exec(req.path);
        if (!m) continue;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        if (method !== 'GET' && /json/i.test(req.headers['content-type'] || '')) {
          req.body = await readJson(req);
        }
        for (const h of r.handlers) {
          await h(req, res);
          if (res.headersSent || res.writableEnded) return;
        }
        return;
      }

      if (req.path.startsWith('/api/')) throw new HttpError(404, 'Not found');
      redirect(res, '/');
    } catch (err) {
      const status = err instanceof HttpError ? err.status
        : err instanceof URIError ? 400 : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      json(res, { error: status === 500 ? 'Server error' : err.message }, status);
    }
  }
}

module.exports = { App, HttpError, json, redirect, sendFile, writeSession };
