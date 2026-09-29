const { db } = require('../database');

// Activity feed for the Admin > Active Sessions dashboard (routes/sessions.js).
// Every write here is fire-and-forget: a failed log insert must never break
// or slow down the request that triggered it.

const RETENTION_DAYS = 90;

// With `trust proxy` enabled (server.js), req.ip is the left-most
// X-Forwarded-For address — the real client behind Vercel / a reverse proxy.
// Strip the IPv4-mapped-IPv6 prefix Node reports for plain IPv4 clients.
function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function userAgent(req) {
  return (req.headers['user-agent'] || '').slice(0, 400);
}

function logActivity({ sessionId = null, employeeId = null, kind, method = null, path = null, status = null, detail = null, ip = null }) {
  db.execute({
    sql: `INSERT INTO session_activity (session_id, employee_id, kind, method, path, status, detail, ip_address)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [sessionId, employeeId, kind, method, path, status, detail, ip],
  }).catch(() => {});
}

// Paths that log their own, more descriptive event (login/logout/section)
// instead of a generic "action" row.
const SELF_LOGGED = [/^\/employees\/login$/, /^\/employees\/logout$/, /^\/sessions\/section$/];

// Mounted at /api after sessionAuth. Records every mutating request made by a
// logged-in employee once the response has gone out, so the logged status
// reflects what actually happened. GETs are skipped on purpose — the SPA
// fires dozens of them per screen; section views (POST /sessions/section)
// cover "what are they looking at" far more readably. Only method + path are
// stored, never the body (login, PIN checks and settings carry secrets).
function activityLogger(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.employee || !req.sessionId) return next();
  const path = req.path;
  if (SELF_LOGGED.some(re => re.test(path))) return next();
  res.on('finish', () => {
    logActivity({
      sessionId: req.sessionId,
      employeeId: req.employee.id,
      kind: 'action',
      method: req.method,
      path,
      status: res.statusCode,
      ip: clientIp(req),
    });
  });
  next();
}

// Called opportunistically from the dashboard's list endpoint rather than on
// a timer — serverless (Vercel) has no long-lived process to run one on.
async function pruneActivity() {
  try {
    await db.execute({
      sql: `DELETE FROM session_activity WHERE created_at < datetime('now', ?)`,
      args: [`-${RETENTION_DAYS} days`],
    });
  } catch (e) { /* best effort */ }
}

module.exports = { clientIp, userAgent, logActivity, activityLogger, pruneActivity };
