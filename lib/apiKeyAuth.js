const crypto = require('crypto');
const { db } = require('../database');

// Routes that API keys are allowed to access, mapped to required scope.
// Method null = any non-GET method.
const SCOPE_RULES = [
  { method: 'GET',  prefix: '/api/products',     scope: 'products:read'   },
  { method: null,   prefix: '/api/products',     scope: 'products:write'  },
  { method: 'GET',  prefix: '/api/categories',   scope: 'products:read'   },
  { method: 'GET',  prefix: '/api/customers',    scope: 'customers:read'  },
  { method: null,   prefix: '/api/customers',    scope: 'customers:write' },
  { method: 'GET',  prefix: '/api/transactions', scope: 'orders:read'     },
  { method: null,   prefix: '/api/transactions', scope: 'orders:write'    },
];

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function requiredScope(method, path) {
  for (const rule of SCOPE_RULES) {
    if (!path.startsWith(rule.prefix)) continue;
    if (rule.method === null && method === 'GET') continue;
    if (rule.method !== null && rule.method !== method) continue;
    return rule.scope;
  }
  return null; // no scope rule → only '*' keys may access
}

async function apiKeyAuth(req, res, next) {
  const header = req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!header) return next(); // no key → browser frontend, pass through

  const hash = hashKey(header);

  let keyRow;
  try {
    const { rows } = await db.execute({
      sql: 'SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1',
      args: [hash],
    });
    keyRow = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Auth check failed' });
  }

  if (!keyRow) return res.status(401).json({ error: 'Invalid or revoked API key' });

  const scopes = JSON.parse(keyRow.scopes || '[]');
  const needed = requiredScope(req.method, req.originalUrl.split('?')[0]);

  if (needed && !scopes.includes('*') && !scopes.includes(needed)) {
    return res.status(403).json({ error: `API key missing scope: ${needed}` });
  }
  if (!needed && !scopes.includes('*')) {
    return res.status(403).json({ error: 'API key does not have access to this endpoint' });
  }

  // Update last_used_at asynchronously — don't block the request
  db.execute({
    sql: "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
    args: [keyRow.id],
  }).catch(() => {});

  req.apiKey = { id: keyRow.id, name: keyRow.name, scopes };
  next();
}

module.exports = { apiKeyAuth, hashKey };
