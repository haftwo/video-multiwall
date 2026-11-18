// Microsoft Entra ID (Azure AD) sign-in: OpenID Connect authorization-code
// flow with PKCE, implemented with Node built-ins only.
const crypto = require('crypto');
const config = require('./config');

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const SCOPE = 'openid profile email';

let discovery = null;
let discoveryAt = 0;
let jwks = null;

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `${url} returned ${res.status}`);
  }
  return body;
}

async function discover() {
  if (!discovery || Date.now() - discoveryAt > 24 * 60 * 60 * 1000) {
    discovery = await getJson(`${config.entra.authority}/.well-known/openid-configuration`);
    discoveryAt = Date.now();
    jwks = null;
  }
  return discovery;
}

async function signingKey(kid) {
  const d = await discover();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!jwks) jwks = (await getJson(d.jwks_uri)).keys || [];
    const jwk = jwks.find((k) => k.kid === kid);
    if (jwk) return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    jwks = null; // keys rotate: refetch once before giving up
  }
  throw new Error('ID token was signed with an unknown key');
}

// Step 1: where to send the browser, plus what to remember for the callback.
async function begin(redirectUri) {
  const d = await discover();
  const pending = { state: rand(16), nonce: rand(16), verifier: rand(32), at: Date.now() };
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.entra.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: crypto.createHash('sha256').update(pending.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.href, pending };
}

// Step 2: swap the code for an ID token and verify it. Returns its claims.
async function complete(code, pending, redirectUri) {
  const d = await discover();
  const tokens = await getJson(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.entra.clientId,
      client_secret: config.entra.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: pending.verifier,
      scope: SCOPE,
    }),
  });
  if (!tokens.id_token) throw new Error('Microsoft did not return an ID token');

  const [h, p, s] = tokens.id_token.split('.');
  if (!h || !p || !s) throw new Error('Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));

  if (header.alg !== 'RS256') throw new Error(`Unexpected token algorithm ${header.alg}`);
  const key = await signingKey(header.kid);
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!valid) throw new Error('ID token signature is invalid');

  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  // Multi-tenant authorities publish the issuer as a template.
  const issuer = String(d.issuer).replace('{tenantid}', claims.tid || '');
  if (claims.iss !== issuer) throw new Error('ID token issuer mismatch');
  if (claims.aud !== config.entra.clientId) throw new Error('ID token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp < now - skew) throw new Error('ID token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + skew) throw new Error('ID token is not yet valid');
  if (claims.nonce !== pending.nonce) throw new Error('ID token nonce mismatch');
  return claims;
}

module.exports = { begin, complete };
