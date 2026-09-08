const { db } = require('../database');

async function getSetting(key, fallback) {
  const { rows: [row] } = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return row?.value ?? fallback;
}

module.exports = { getSetting };
