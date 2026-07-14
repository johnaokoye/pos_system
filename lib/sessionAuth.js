const crypto = require('crypto');
const { db } = require('../database');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, sliding (extended on each authenticated request)
const COOKIE_NAME = 'pos_session';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function createSession(employeeId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.execute({
    sql: 'INSERT INTO sessions (token_hash, employee_id, expires_at) VALUES (?, ?, ?)',
    args: [hashToken(raw), employeeId, expiresAt],
  });
  return raw;
}

async function destroySession(rawToken) {
  if (!rawToken) return;
  await db.execute({
    sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?",
    args: [hashToken(rawToken)],
  });
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, rawToken) {
  // req.secure reflects the actual connection (with `trust proxy` enabled in
  // server.js, this correctly reads X-Forwarded-Proto from a TLS-terminating
  // reverse proxy too) — NOT just NODE_ENV. A self-hosted Docker deploy
  // reached over plain HTTP must NOT get a Secure cookie, or the browser
  // silently drops it and every authenticated request after login 401s.
  const secure = req.secure ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Same shape as routes/employees.js's POST /login response, so req.employee
// can eventually replace req.body.employee_id trust throughout the routes.
async function loadEmployee(employeeId) {
  const { rows: [emp] } = await db.execute({
    sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.security_group_id, e.default_branch_id,
      sg.name as security_group_name, sg.permissions, b.name as default_branch_name
      FROM employees e
      LEFT JOIN security_groups sg ON e.security_group_id = sg.id
      LEFT JOIN branches b ON e.default_branch_id = b.id
      WHERE e.id = ? AND e.active = 1`,
    args: [employeeId],
  });
  if (!emp) return null;
  emp.permissions = emp.permissions ? JSON.parse(emp.permissions) : {};
  return emp;
}

// Mounted globally at /api, right after apiKeyAuth. Never rejects on its
// own — an absent or invalid cookie just leaves req.employee undefined and
// calls next(); the actual enforcement is requireAuth()/requirePermission()
// applied per-route (see lib/permissions.js). This is what makes a phased
// rollout possible: mounting this middleware changes nothing until routes
// opt in.
async function sessionAuth(req, res, next) {
  if (req.apiKey) return next(); // API key already authenticated this request — it wins

  const raw = readCookie(req);
  if (!raw) return next();

  try {
    const { rows: [session] } = await db.execute({
      sql: "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')",
      args: [hashToken(raw)],
    });
    if (!session) {
      clearSessionCookie(res);
      return next();
    }

    const emp = await loadEmployee(session.employee_id);
    if (!emp) {
      clearSessionCookie(res);
      return next();
    }
    req.employee = emp;

    // Sliding expiry + last-seen touch — non-blocking, don't delay the request
    const newExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.execute({
      sql: "UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?",
      args: [newExpiry, session.id],
    }).catch(() => {});
  } catch (e) {
    // Fail open on infra errors here (matches apiKeyAuth's keyless pass-through
    // philosophy) — downstream requireAuth/requirePermission will 401/403
    // correctly since req.employee stays unset.
  }
  next();
}

module.exports = { sessionAuth, createSession, destroySession, setSessionCookie, clearSessionCookie, hashToken, loadEmployee, readCookie };
