// One drawer session's report — loaded and computed here so the Drawers
// screen, the printed report and the emailed PDF (routes/email.js) all show
// the same figures.
//
// Reconciliation order: the opening float is counted out and handed back
// first (drawer_reconciliations.float_returned), then the cash left — the
// takings — is counted against cash sales and account payments less petty
// cash paid out (drawer_payouts). Foreign notes (e.g. USD) are counted in
// their own currency and valued in the base currency at the session's
// recorded rate (fx_rates, units per 1 base — same as Settings' alt
// currencies), so cash_counted is always a base-currency figure.
//
// Reconciliations saved before the float step (float_returned NULL) counted
// the float inside the cash, so for those the float stays in expected cash.

const TENDERS = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'check', label: 'Check' },
  { key: 'gift_card', label: 'Gift Card' },
  { key: 'credit', label: 'Charge Account' },
  { key: 'direct_deposit', label: 'Direct Deposit' },
  // Store credit a customer spends from their account (a credit note from a
  // return, a rental deposit credit) — no money changes hands, so there is
  // nothing to count; it's listed so the session's sales add up.
  { key: 'available_credit', label: 'Available Credit', uncounted: true },
];
const OTHER_LABELS = { cash_back: 'Cash Back', available_credit_and_cash_back: 'Available Credit + Cash Back' };

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function parseJson(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch (e) { return fallback; }
}

// The base currency and the current { CODE: rate } map from Settings.
async function currencySettings(db) {
  const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('currency', 'alt_currencies')", args: [] });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const rates = {};
  for (const c of parseJson(s.alt_currencies, [])) if (c && c.code && Number(c.rate) > 0) rates[c.code] = Number(c.rate);
  return { base: s.currency || 'USD', rates };
}

async function loadDrawerSession(db, id) {
  const { rows: [session] } = await db.execute({ sql: `
    SELECT ds.*,
      d.name as drawer_name,
      b.name as branch_name,
      e.first_name || ' ' || e.last_name as employee_name
    FROM drawer_sessions ds
    LEFT JOIN cash_drawers d ON ds.drawer_id = d.id
    LEFT JOIN branches b ON ds.branch_id = b.id
    LEFT JOIN employees e ON ds.employee_id = e.id
    WHERE ds.id = ?`, args: [id] });
  if (!session) return null;

  // Sums per-leg amounts from transaction_payments (so a split-tender sale's
  // cash portion and card portion land in separate buckets), falling back
  // to the whole transaction total for any transaction with no
  // transaction_payments rows (e.g. rentals/layaway/quotation-hold sales
  // that insert into transactions directly, bypassing POST /transactions).
  const { rows: tenders } = await db.execute({ sql: `
    SELECT payment_method,
      COUNT(DISTINCT transaction_id) as tx_count,
      COALESCE(SUM(amount), 0) as total
    FROM (
      SELECT tp.transaction_id, tp.payment_method, tp.amount
      FROM transaction_payments tp JOIN transactions t ON t.id = tp.transaction_id
      WHERE t.drawer_session_id = ?
      UNION ALL
      SELECT t.id as transaction_id, t.payment_method, t.total as amount
      FROM transactions t
      WHERE t.drawer_session_id = ? AND NOT EXISTS (SELECT 1 FROM transaction_payments tp2 WHERE tp2.transaction_id = t.id)
      UNION ALL
      -- Customer account payments received into this drawer at the POS
      -- (lib/customerPayments.js), counted with the sales by tender.
      -- Negative ids keep them distinct from transaction ids in the count.
      SELECT -ap.id as transaction_id, ap.payment_method, ap.amount
      FROM account_payments ap
      WHERE ap.drawer_session_id = ?
    )
    GROUP BY payment_method`, args: [id, id, id] });
  session.tenders = tenders;

  // The same payments listed on their own, for the drawer report.
  const { rows: accountPayments } = await db.execute({ sql: `SELECT ap.payment_number, ap.payment_method, ap.amount, ap.payment_mode, ap.created_at, c.first_name || ' ' || c.last_name AS customer_name
    FROM account_payments ap LEFT JOIN customers c ON c.id = ap.customer_id WHERE ap.drawer_session_id = ? ORDER BY ap.created_at`, args: [id] });
  session.account_payments = accountPayments;

  const { rows: payouts } = await db.execute({ sql: `SELECT p.*, e.first_name || ' ' || e.last_name AS employee_name, v.first_name || ' ' || v.last_name AS voided_by_name
    FROM drawer_payouts p LEFT JOIN employees e ON e.id = p.employee_id LEFT JOIN employees v ON v.id = p.voided_by
    WHERE p.session_id = ? ORDER BY p.created_at, p.id`, args: [id] });
  session.payouts = payouts;

  const { rows: [reconciliation] } = await db.execute({ sql: `SELECT dr.*, e.first_name || ' ' || e.last_name as reconciled_by_name FROM drawer_reconciliations dr LEFT JOIN employees e ON e.id = dr.reconciled_by WHERE dr.session_id = ?`, args: [id] });
  session.reconciliation = reconciliation || null;
  if (session.reconciliation) {
    const { rows: noteCounts } = await db.execute({ sql: `
      SELECT rnc.denomination_id, rnc.quantity, cd.value, cd.label, cd.currency, cd.sort_order
      FROM reconciliation_note_counts rnc
      JOIN currency_denominations cd ON cd.id = rnc.denomination_id
      WHERE rnc.reconciliation_id = ?
      ORDER BY cd.currency, cd.sort_order, cd.value DESC`, args: [session.reconciliation.id] });
    session.reconciliation.note_counts = noteCounts;
  }

  const cur = await currencySettings(db);
  session.currency = cur.base;
  session.report = buildReport(session, cur);
  return session;
}

function buildReport(session, { base, rates: currentRates }) {
  const rec = session.reconciliation;
  // A credit/debit terminal settles as one lump "Card" batch — both compare
  // against the one card_counted figure.
  const byKey = {};
  for (const t of session.tenders || []) {
    const key = (t.payment_method === 'credit_card' || t.payment_method === 'debit_card') ? 'card' : t.payment_method;
    byKey[key] = byKey[key] || { tx_count: 0, total: 0 };
    byKey[key].tx_count += Number(t.tx_count) || 0;
    byKey[key].total += Number(t.total) || 0;
  }

  const openingFloat = round2(session.opening_float);
  const legacy = !!rec && rec.float_returned == null;
  const activePayouts = (session.payouts || []).filter(p => !p.voided_at);
  const payoutsTotal = round2(activePayouts.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const cashSales = round2(byKey.cash?.total);
  const cashExpected = round2(cashSales - payoutsTotal + (legacy ? openingFloat : 0));

  const row = (key, label, uncounted) => {
    const t = byKey[key] || { tx_count: 0, total: 0 };
    const sales = round2(t.total);
    const expected = key === 'cash' ? cashExpected : sales;
    const counted = rec && !uncounted ? round2(rec[`${key}_counted`]) : null;
    return { key, label, tx_count: t.tx_count, sales, expected, counted, variance: counted == null ? null : round2(counted - expected), uncounted: !!uncounted };
  };
  const tenders = TENDERS.map(t => row(t.key, t.label, t.uncounted));
  // Any other tender recorded on the session is listed (not counted) so
  // the sales column always adds up.
  for (const key of Object.keys(byKey)) {
    if (!TENDERS.some(t => t.key === key)) tenders.push(row(key, OTHER_LABELS[key] || key.replace(/_/g, ' '), true));
  }

  const floatReturned = rec && !legacy ? round2(rec.float_returned) : null;
  const floatRow = {
    opening: openingFloat,
    returned: floatReturned,
    variance: floatReturned == null ? null : round2(floatReturned - openingFloat),
    included_in_cash: legacy,
  };

  // Denomination breakdown, one block per currency, foreign currencies
  // valued in base at the rate saved with the reconciliation.
  const savedRates = parseJson(rec?.fx_rates, null);
  const rates = savedRates || currentRates;
  const groups = {};
  for (const nc of rec?.note_counts || []) {
    const g = groups[nc.currency] = groups[nc.currency] || { currency: nc.currency, rate: nc.currency === base ? 1 : (Number(rates[nc.currency]) || null), lines: [], total: 0 };
    const amount = round2(nc.quantity * nc.value);
    g.lines.push({ label: nc.label, value: nc.value, quantity: nc.quantity, amount });
    g.total = round2(g.total + amount);
  }
  const denominations = Object.values(groups)
    .sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)))
    .map(g => ({ ...g, base_equivalent: g.rate ? round2(g.total / g.rate) : null }));

  return {
    base_currency: base,
    legacy,
    float: floatRow,
    cash_sales: cashSales,
    payouts_total: payoutsTotal,
    payouts_count: activePayouts.length,
    tenders,
    denominations,
    rates,
  };
}

module.exports = { loadDrawerSession, currencySettings, round2 };
