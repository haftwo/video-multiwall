const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch {
  console.error(`Cannot write to the data folder (${dataDir}).`);
  console.error('On Unraid run:  chown -R 99:100 /mnt/user/appdata/multiwall');
  process.exit(1);
}

// Session secret: use SESSION_SECRET if given, otherwise generate once and
// keep it in the data volume so logins survive container restarts.
function loadSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, 'session.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const baseUrl = (env.BASE_URL || '').replace(/\/+$/, '');
const https = baseUrl.startsWith('https://');

const entra = {
  tenantId: env.ENTRA_TENANT_ID || '',
  clientId: env.ENTRA_CLIENT_ID || '',
  clientSecret: env.ENTRA_CLIENT_SECRET || '',
  adminEmails: list(env.ENTRA_ADMIN_EMAILS),
  allowedDomains: list(env.ENTRA_ALLOWED_DOMAINS),
  autoProvision: bool(env.ENTRA_AUTO_PROVISION, true),
};
entra.enabled = Boolean(entra.tenantId && entra.clientId && entra.clientSecret);
// Override only for sovereign clouds (e.g. https://login.microsoftonline.us/<tenant>/v2.0).
entra.authority = (env.ENTRA_AUTHORITY ||
  `https://login.microsoftonline.com/${entra.tenantId}/v2.0`).replace(/\/+$/, '');

module.exports = {
  appName: env.APP_NAME || 'MultiWall',
  port: parseInt(env.PORT || '8080', 10),
  dataDir,
  baseUrl,
  secret: loadSecret(),
  cookieSecure: bool(env.COOKIE_SECURE, https),
  trustProxy: env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== ''
    ? (/^\d+$/.test(env.TRUST_PROXY) ? parseInt(env.TRUST_PROXY, 10) : bool(env.TRUST_PROXY, false))
    : (https ? 1 : false),
  sessionDays: parseInt(env.SESSION_DAYS || '7', 10),
  localLogin: bool(env.LOCAL_LOGIN_ENABLED, true),
  adminUsername: (env.ADMIN_USERNAME || 'admin').toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  maxPanels: Math.min(36, Math.max(1, parseInt(env.MAX_PANELS || '16', 10))),
  seedDemoChannels: bool(env.SEED_DEMO_CHANNELS, true),
  entra,
};
