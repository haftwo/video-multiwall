// Optional HLS relay.
//
// Browsers can only play a cross-origin HLS stream if the origin sends CORS
// headers, and they refuse http:// streams on an https:// page. Channels with
// "Relay through this server" switched on are fetched by this server instead
// and handed to the browser from our own origin.
//
// Every relayed URL carries an HMAC signature, so the relay can only be used
// for a channel's own playlist and the URLs found inside it. It is not an
// open proxy.
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('./config');
const { db } = require('./db');
const { HttpError } = require('./http');
const { requireAuth } = require('./auth');

const key = crypto.createHmac('sha256', config.secret).update('hls-relay-v1').digest();
const sign = (channelId, url) =>
  crypto.createHmac('sha256', key).update(`${channelId}\n${url}`).digest('base64url').slice(0, 32);

function relayUrl(channelId, url) {
  return `/hls/${channelId}/r?u=${Buffer.from(url, 'utf8').toString('base64url')}&s=${sign(channelId, url)}`;
}

function rewritePlaylist(text, baseUrl, channelId) {
  const abs = (ref) => {
    try {
      const u = new URL(ref, baseUrl);
      return /^https?:$/.test(u.protocol) ? relayUrl(channelId, u.href) : ref;
    } catch { return ref; }
  };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, parts...
      return line.replace(/URI="([^"]+)"/g, (_m, ref) => `URI="${abs(ref)}"`);
    }
    return abs(t);
  }).join('\n');
}

function register(app) {
  app.get('/hls/:channelId/r', requireAuth, async (req, res) => {
    const channelId = parseInt(req.params.channelId, 10);
    const target = Buffer.from(String(req.query.u || ''), 'base64url').toString('utf8');

    const expected = Buffer.from(sign(channelId, target));
    const given = Buffer.from(String(req.query.s || ''));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      throw new HttpError(403, 'Bad signature');
    }
    const channel = db.prepare(
      'SELECT id FROM channels WHERE id = ? AND enabled = 1 AND proxy = 1'
    ).get(channelId);
    if (!channel) throw new HttpError(404, 'Channel not found');

    let url;
    try { url = new URL(target); } catch { throw new HttpError(400, 'Bad URL'); }
    if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'Bad URL');

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let upstream;
    try {
      const headers = { 'user-agent': 'Mozilla/5.0 (MultiPlayer 2000 HLS relay)' };
      if (req.headers.range) headers.range = req.headers.range;
      upstream = await fetch(url, { headers, signal: abort.signal, redirect: 'follow' });
    } catch (err) {
      if (abort.signal.aborted) return res.destroy();
      console.warn(`[relay] channel ${channelId}: ${err.cause?.code || err.message}`);
      throw new HttpError(502, 'Upstream unreachable');
    }

    const type = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || url.href;
    const isPlaylist = /mpegurl/i.test(type) || /\.m3u8?$/i.test(new URL(finalUrl).pathname);

    if (isPlaylist && upstream.ok) {
      const body = await upstream.text();
      const out = body.trimStart().startsWith('#EXTM3U')
        ? rewritePlaylist(body, finalUrl, channelId) : body;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(out),
        'Cache-Control': 'no-store',
      });
      return res.end(out);
    }

    // fetch() transparently decompresses, so upstream lengths are only
    // trustworthy when the body was not content-encoded.
    const out = { 'Cache-Control': 'no-store' };
    const pass = ['content-type', 'accept-ranges'];
    if (!upstream.headers.get('content-encoding')) pass.push('content-length', 'content-range');
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  });
}

module.exports = { register, relayUrl };
