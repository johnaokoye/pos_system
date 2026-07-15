// Gap-proof sequential document number generator (TXN-000123, RA-000045, ...).
// COUNT(*)+1 — used everywhere this replaces — breaks the moment any row in
// the table is ever deleted: the count under-reports how many numbers have
// actually been issued, so the "next" number collides with a still-existing
// row further up the sequence. This reads the highest number actually
// issued instead, which stays correct regardless of gaps from deletions.
async function nextNumber(executor, table, column, prefix, padLength = 6) {
  const { rows: [row] } = await executor.execute({
    sql: `SELECT MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)) as m FROM ${table} WHERE ${column} LIKE ?`,
    args: [prefix.length + 1, `${prefix}%`],
  });
  const next = (Number(row.m) || 0) + 1;
  return `${prefix}${String(next).padStart(padLength, '0')}`;
}

module.exports = { nextNumber };
