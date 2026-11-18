// Sign-in log: every successful and failed sign-in (password or Microsoft)
// and every sign-out, kept for LOGIN_LOG_DAYS days (default 90).
const config = require('./config');
const { db } = require('./db');

const insert = db.prepare(`
  INSERT INTO login_events (user_id, username, display_name, provider, outcome, detail, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const prune = db.prepare("DELETE FROM login_events WHERE created_at < datetime('now', ?)");

let lastPrune = 0;

function cleanIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '').slice(0, 64);
}

// outcome: 'success' | 'failed' | 'signout'
function logLogin(req, { user = null, username = '', provider = 'local', outcome, detail = '' }) {
  try {
    insert.run(
      user ? user.id : null,
      String(user ? user.username : username).slice(0, 200),
      String(user ? user.display_name || '' : '').slice(0, 80),
      provider,
      outcome,
      String(detail).slice(0, 300),
      cleanIp(req.ip),
      String(req.headers['user-agent'] || '').slice(0, 400),
    );
    if (Date.now() - lastPrune > 60 * 60 * 1000) {
      lastPrune = Date.now();
      prune.run(`-${config.loginLogDays} days`);
    }
  } catch (err) {
    console.error('[audit] could not record sign-in event:', err.message);
  }
}

const OUTCOMES = new Set(['success', 'failed', 'signout']);

// Newest first. `before` is an event id for paging.
function listLogins({ outcome = '', search = '', before = 0, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (OUTCOMES.has(outcome)) { where.push('outcome = ?'); args.push(outcome); }
  if (search) {
    where.push('(username LIKE ? OR display_name LIKE ? OR ip LIKE ?)');
    const like = `%${String(search).slice(0, 100).replace(/[%_]/g, (m) => `\\${m}`)}%`;
    args.push(like, like, like);
  }
  if (before > 0) { where.push('id < ?'); args.push(before); }
  const sql = `SELECT * FROM login_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")).all(...args, Math.min(1000, Math.max(1, limit)));
}

function summary() {
  return db.prepare(`
    SELECT
      SUM(outcome = 'success' AND created_at >= datetime('now', '-1 day')) AS success24h,
      SUM(outcome = 'failed'  AND created_at >= datetime('now', '-1 day')) AS failed24h,
      COUNT(DISTINCT CASE WHEN outcome = 'success' AND created_at >= datetime('now', '-30 days') THEN user_id END) AS users30d,
      COUNT(*) AS total
    FROM login_events
  `).get();
}

module.exports = { logLogin, listLogins, summary };
