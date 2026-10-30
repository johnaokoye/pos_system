const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { oldestOpenLegacySql, oldestUnpaidSaleSql, earliestDate, LEGACY_BALANCE_SQL } = require('../lib/legacyInvoices');
const { resolveBlock } = require('../lib/creditBlock');
const { UNAPPLIED_SQL, unappliedTotal, oldestOwingDate } = require('../lib/customerPayments');
const { mergeCustomers, mergePreview } = require('../lib/customerMerge');
const { phoneKeys, syncPhoneKeys } = require('../lib/phoneKeys');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { getMissingRentalFields } = require('../lib/rentals');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Proof of address is often a bank statement or utility bill PDF, not just a
// photo — same size limit as the ID scan above, but images or PDF.
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
});

// Phone numbers are typed every which way ("(876) 555-1234", "876-555-1234",
// "+1 876 555 1234"), so compare digits only. Numbers of 10+ digits are
// matched on their last 10 so an optional leading country code doesn't
// hide a duplicate; anything shorter must match in full.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
const PHONE_DIGITS_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'.',''),'+',''),'/','')`;
const PHONE_MATCH_SQL = `(phone IS NOT NULL AND phone != '' AND (CASE WHEN LENGTH(${PHONE_DIGITS_SQL}) > 10 THEN SUBSTR(${PHONE_DIGITS_SQL}, -10) ELSE ${PHONE_DIGITS_SQL} END) = ?)`;

// Shared by POST / (single create), PUT /:id and POST /import (CSV bulk
// create): active customers matching the given email, phone, or full name.
// Each match carries `match_on` (['phone','email','name']). A phone or email
// match is a hard duplicate — the contact details belong to someone else, so
// the record is refused outright; a name-only match is just a warning (two
// people can share a name) that the caller may override with `force`.
//
// Phones match when any number in one field is any number in the other
// (lib/phoneKeys.js — handles several numbers per field, 7-digit local
// numbers, a leading 1, and ignores placeholders like 000-0000), via the
// indexed customer_phone_keys; the older whole-field comparison is kept as a
// fallback for a phone whose keys haven't been rebuilt yet. Emails only count
// when they look like an address.
async function findDuplicateCustomers({ email, phone, first_name, last_name }, excludeCustomerId = null) {
  const keys = phoneKeys(phone);
  // No real number (blank, partial, or a placeholder like 000-0000) → no
  // phone match at all, including the older whole-field fallback.
  const phoneNorm = keys.length ? normalizePhone(phone) : '';
  const emailRaw = String(email || '').trim().toLowerCase();
  const emailNorm = emailRaw.includes('@') ? emailRaw : '';
  const { rows } = await db.execute({
    sql: `SELECT * FROM customers WHERE active = 1 AND id != ? AND (
      (email IS NOT NULL AND email != '' AND LOWER(TRIM(email)) = ?)
      ${keys.length ? `OR id IN (SELECT customer_id FROM customer_phone_keys WHERE phone_key IN (${keys.map(() => '?').join(',')}))` : ''}
      OR ${PHONE_MATCH_SQL}
      OR (LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?)))`,
    args: [excludeCustomerId || 0, emailNorm || '\u0000', ...keys, phoneNorm.length >= 7 ? phoneNorm : '\u0000', first_name || '', last_name || ''],
  });
  return rows.map(r => {
    const match_on = [];
    const theirKeys = phoneKeys(r.phone);
    if ((phoneNorm.length >= 7 && normalizePhone(r.phone) === phoneNorm) || keys.some(k => theirKeys.includes(k))) match_on.push('phone');
    if (emailNorm && String(r.email || '').trim().toLowerCase() === emailNorm) match_on.push('email');
    if (first_name && last_name && String(r.first_name || '').toLowerCase() === String(first_name).toLowerCase()
      && String(r.last_name || '').toLowerCase() === String(last_name).toLowerCase()) match_on.push('name');
    return { ...r, match_on };
  });
}

const isHardDuplicate = m => m.match_on.includes('phone') || m.match_on.includes('email');

// 409 body for a phone/email clash — `blocking: true` tells the frontend not
// to offer "Create Anyway".
function hardDuplicateError(matches) {
  const hard = matches.filter(isHardDuplicate);
  const fields = [...new Set(hard.flatMap(m => m.match_on.filter(f => f !== 'name')))];
  const label = fields.map(f => f === 'phone' ? 'contact number' : 'email').join(' and ');
  const who = hard.map(m => `${m.first_name} ${m.last_name} (${m.customer_number})`).join(', ');
  return { error: `This ${label} is already used by ${who}`, matches: hard, blocking: true };
}

// Resolves the three rental_preapproved* columns for a customer create/
// update. Changing the flag needs customers_rental_preapprove specifically —
// customers_edit alone can't touch it (see lib/rentals.js
// assertRentalCustomerEligible, the compliance gate this flag bypasses) — so
// a request from someone without it just keeps whatever the customer
// already had, the same "silently ignore, don't 403 the whole save" pattern
// used for is_rental_customer-gated fields elsewhere in this file. Flipping
// 0->1 stamps who/when; flipping 1->0 (or the customer no longer being a
// rental customer at all) clears both, since a later re-approval should
// carry a fresh timestamp, not the old one.
//
// Granting (0->1) is further limited to customers a CSV import created
// (canGrant) — preapproval exists for migrated legacy records, so a customer
// keyed in by hand must have the full rental paperwork before they can rent.
// Revoking (1->0) is always allowed.
async function createdByImport(customerId) {
  const { rows } = await db.execute({ sql: "SELECT 1 FROM customer_import_batch_items WHERE customer_id = ? AND action = 'created' LIMIT 1", args: [customerId] });
  return rows.length > 0;
}

function resolveRentalPreapproval(req, current, isRentalCust, requested, canGrant) {
  const currentVal = current?.rental_preapproved ? 1 : 0;
  const keepCurrent = () => ({
    rental_preapproved: currentVal,
    rental_preapproved_by: current?.rental_preapproved_by ?? null,
    rental_preapproved_at: current?.rental_preapproved_at ?? null,
  });
  if (!isRentalCust) return { rental_preapproved: 0, rental_preapproved_by: null, rental_preapproved_at: null };
  if (!can(req.employee?.permissions, 'customers_rental_preapprove')) return keepCurrent();
  const newVal = requested ? 1 : 0;
  if (newVal === currentVal || (newVal && !canGrant)) return keepCurrent();
  return newVal
    ? { rental_preapproved: 1, rental_preapproved_by: req.employee?.id || null, rental_preapproved_at: new Date().toISOString() }
    : { rental_preapproved: 0, rental_preapproved_by: null, rental_preapproved_at: null };
}

// Over the credit limit: a limit is set (0 = unlimited) and the balance is
// above it.
const isOverLimit = c => (c.credit_limit || 0) > 0 && (c.account_balance || 0) - c.credit_limit > 0.005;

// Days since `oldestDate` and whether that's past the customer's terms.
function overdueFrom(oldestDate, termsDays) {
  if (!oldestDate) return { overdue: false, days_since: null };
  const daysSince = Math.floor((Date.now() - new Date(oldestDate).getTime()) / 86400000);
  return { overdue: daysSince > (termsDays || 30), days_since: daysSince };
}

// Whether a credit customer should be blocked automatically: past their
// payment terms (their oldest invoice still owing — credit sale or legacy
// invoice — is older than credit_terms_days), or over their credit limit.
// `auto` is either; a zero balance is neither.
async function creditStatus(customer) {
  const over_limit = isOverLimit(customer);
  if (!(customer.account_balance > 0)) return { auto: false, overdue: false, over_limit: false, oldest_date: null, days_since: null };
  // Open (unapplied) payments count against the oldest invoices first.
  const oldestDate = (await unappliedTotal(db, customer.id)) > 0
    ? await oldestOwingDate(db, customer.id)
    : await (async () => {
      const { rows: [oldest] } = await db.execute({ sql: `SELECT ${oldestUnpaidSaleSql('?')} as oldest_date, ${oldestOpenLegacySql('?')} as legacy_oldest_date`, args: [customer.id, customer.id] });
      return earliestDate(oldest?.oldest_date, oldest?.legacy_oldest_date);
    })();
  const { overdue, days_since } = overdueFrom(oldestDate, customer.credit_terms_days);
  return { auto: overdue || over_limit, overdue, over_limit, oldest_date: oldestDate, days_since };
}

// Writes a customer's block flag and override; the override's who/when/why
// are cleared along with it.
async function writeBlock(customerId, { blocked, override }, meta = null) {
  if (override && meta) {
    await db.execute({ sql: 'UPDATE customers SET account_blocked = ?, block_override = ?, block_override_by = ?, block_override_at = ?, block_override_reason = ? WHERE id = ?',
      args: [blocked, override, meta.by, meta.at, meta.reason, customerId] });
  } else if (override) {
    await db.execute({ sql: 'UPDATE customers SET account_blocked = ? WHERE id = ?', args: [blocked, customerId] });
  } else {
    await db.execute({ sql: 'UPDATE customers SET account_blocked = ?, block_override = NULL, block_override_by = NULL, block_override_at = NULL, block_override_reason = NULL WHERE id = ?', args: [blocked, customerId] });
  }
}

// Check if a credit customer has exceeded their payment terms and block/unblock
// accordingly — honoring a manual block/unblock (lib/creditBlock.js).
async function runCreditCheck(customerId) {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customerId] });
    if (!customer || customer.customer_type !== 'credit') return;
    const { auto } = await creditStatus(customer);
    await writeBlock(customerId, resolveBlock(auto, customer.block_override));
  } catch(e) {}
}

// Same logic as runCreditCheck above, but for a whole batch of customers in
// a bounded number of queries (1 SELECT + up to 3 UPDATEs) instead of one
// runCreditCheck() call per customer — GET / below runs this on every
// request (it's used broadly: POS customer picker, CRM, accounts, not just
// the Customers screen), so a per-customer loop here would get slower with
// every credit customer added. Only ever called with ids that already
// passed the `account_balance > 0` filter, so (unlike runCreditCheck) there's
// no "already at zero balance, unblock" branch to replicate.
async function runCreditCheckBatch(customerIds) {
  if (!customerIds.length) return;
  try {
    const placeholders = customerIds.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `SELECT c.id, c.credit_terms_days, c.credit_limit, c.account_balance, c.block_override,
              (SELECT COUNT(*) FROM account_payments ap WHERE ap.customer_id = c.id AND ap.payment_method != 'writeoff' AND ${UNAPPLIED_SQL} > 0.005) as open_payments,
              ${oldestUnpaidSaleSql('c.id')} as oldest_date,
              ${oldestOpenLegacySql('c.id')} as legacy_oldest_date
            FROM customers c WHERE c.id IN (${placeholders})`,
      args: customerIds,
    });
    const blockedIds = [], okIds = [], clearOverrideIds = [];
    for (const r of rows) {
      // A customer with open payments waiting to be applied needs the
      // per-customer calculation (lib/customerPayments.js oldestOwingDate).
      const oldestDate = Number(r.open_payments) > 0 ? await oldestOwingDate(db, r.id) : earliestDate(r.oldest_date, r.legacy_oldest_date);
      const { overdue } = overdueFrom(oldestDate, r.credit_terms_days);
      const { blocked, override } = resolveBlock(overdue || isOverLimit(r), r.block_override);
      (blocked ? blockedIds : okIds).push(r.id);
      if (r.block_override && !override) clearOverrideIds.push(r.id);
    }
    const ph = ids => ids.map(() => '?').join(',');
    if (blockedIds.length) await db.execute({ sql: `UPDATE customers SET account_blocked = 1 WHERE id IN (${ph(blockedIds)})`, args: blockedIds });
    if (okIds.length) await db.execute({ sql: `UPDATE customers SET account_blocked = 0 WHERE id IN (${ph(okIds)})`, args: okIds });
    if (clearOverrideIds.length) await db.execute({ sql: `UPDATE customers SET block_override = NULL, block_override_by = NULL, block_override_at = NULL, block_override_reason = NULL WHERE id IN (${ph(clearOverrideIds)})`, args: clearOverrideIds });
  } catch(e) {}
}

// requireAuth only — used broadly (POS customer picker, CRM, accounts),
// not just the Customers management screen itself.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { search, active, type } = req.query;
    // ?limit= (the POS customer lookup) returns just the first matches, and
    // credit-checks only those, instead of every customer on file.
    //
    // ?paged=1 (the Customers screen) returns { rows, total } — one page of
    // `limit` (default 200) starting at ?offset=, plus the total matching —
    // so the list loads a page at a time as it scrolls instead of every
    // customer on file on each keystroke.
    const paged = req.query.paged === '1';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || (paged ? 200 : 0), 0), 500);
    const offset = paged ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : 0;

    // Auto-block any overdue credit customers before returning list — on the
    // paged Customers screen, when it opens (first page, no search) rather
    // than on every keystroke.
    if (!limit || (paged && offset === 0 && !search)) {
      const { rows: overdue } = await db.execute({ sql: "SELECT id FROM customers WHERE customer_type = 'credit' AND active = 1 AND account_balance > 0", args: [] });
      await runCreditCheckBatch(overdue.map(c => c.id));
    }

    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (search) {
      sql += ` AND (first_name LIKE ? OR last_name LIKE ? OR (first_name || ' ' || last_name) LIKE ? OR business_name LIKE ? OR email LIKE ? OR phone LIKE ? OR customer_number LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s, s, s);
    }
    if (active !== undefined) { sql += ' AND active = ?'; params.push(active); }
    // Type-to-search pickers: ?ids= fetches the already-chosen customer(s)
    // of a saved form; ?rental=1 / ?credit_enabled= narrow the matches.
    if (req.query.ids) {
      const ids = String(req.query.ids).split(',').map(Number).filter(Number.isInteger).slice(0, 200);
      sql += ids.length ? ` AND id IN (${ids.map(() => '?').join(',')})` : ' AND 0';
      params.push(...ids);
    }
    if (req.query.rental === '1') sql += ' AND is_rental_customer = 1';
    if (req.query.credit_enabled === '0' || req.query.credit_enabled === '1') { sql += ' AND COALESCE(credit_enabled, 0) = ?'; params.push(Number(req.query.credit_enabled)); }
    // Customers list filter: credit / cash, or rental approved (can rent
    // today — a rental customer who's preapproved or has every required
    // document, lib/rentals.js) vs other (everyone who can't yet).
    if (type === 'credit' || type === 'cash') { sql += ' AND customer_type = ?'; params.push(type); }
    // Only customers with something owing on account (POS Receive Payment).
    if (req.query.owing) sql += ' AND account_balance > 0.005';
    // Rental approved / other is worked out per row below, so those filters
    // can't be paged in SQL — they page the filtered list instead.
    const rentalType = type === 'rental_approved' || type === 'other';
    let total = null;
    if (paged && !rentalType) {
      const { rows: [n] } = await db.execute({ sql: sql.replace('SELECT *', 'SELECT COUNT(*) AS n'), args: params });
      total = Number(n.n);
    }
    // ?owing_first=1 (POS Receive Payment search): customers with a balance
    // come first, so a common name doesn't bury the one who's paying.
    sql += ` ORDER BY ${req.query.owing_first ? 'CASE WHEN account_balance > 0.005 THEN 0 ELSE 1 END, ' : ''}last_name, first_name${paged ? ', id' : ''}`;
    if (limit && !(paged && rentalType)) { sql += ' LIMIT ? OFFSET ?'; params.push(limit, offset); }
    let { rows } = await db.execute({ sql, args: params });
    if (paged && rentalType) {
      const approved = c => !!c.is_rental_customer && (!!c.rental_preapproved || getMissingRentalFields(c).length === 0);
      rows = rows.filter(c => approved(c) === (type === 'rental_approved'));
      total = rows.length;
      rows = rows.slice(offset, offset + limit);
    }
    if (limit) {
      const owing = rows.filter(c => c.customer_type === 'credit' && c.active && c.account_balance > 0).map(c => c.id);
      if (owing.length) {
        await runCreditCheckBatch(owing);
        const { rows: fresh } = await db.execute({ sql: `SELECT id, account_blocked FROM customers WHERE id IN (${owing.map(() => '?').join(',')})`, args: owing });
        const blocked = new Map(fresh.map(r => [r.id, r.account_blocked]));
        for (const c of rows) if (blocked.has(c.id)) c.account_blocked = blocked.get(c.id);
      }
    }
    if (paged) return res.json({ rows, total });
    if (rentalType) {
      const approved = c => !!c.is_rental_customer && (!!c.rental_preapproved || getMissingRentalFields(c).length === 0);
      return res.json(rows.filter(c => approved(c) === (type === 'rental_approved')));
    }
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Duplicate finder & merge ──────────────────────────────
// Groups of active customers that share a phone number (customer_phone_keys,
// so differently-written numbers still match) or an email. Customers linked
// by either are one group. Registered before GET /:id.
async function duplicateGroups() {
  const { rows: phoneRows } = await db.execute({ sql: `SELECT k.phone_key AS key, k.customer_id AS id FROM customer_phone_keys k JOIN customers c ON c.id = k.customer_id AND c.active = 1
    WHERE k.phone_key IN (SELECT k2.phone_key FROM customer_phone_keys k2 JOIN customers c2 ON c2.id = k2.customer_id AND c2.active = 1 GROUP BY k2.phone_key HAVING COUNT(DISTINCT k2.customer_id) > 1)`, args: [] });
  const { rows: emailRows } = await db.execute({ sql: `SELECT LOWER(TRIM(email)) AS key, id FROM customers WHERE active = 1 AND email LIKE '%@%'
    AND LOWER(TRIM(email)) IN (SELECT LOWER(TRIM(email)) FROM customers WHERE active = 1 AND email LIKE '%@%' GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1)`, args: [] });
  // Union-find over customers sharing any key.
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const reasons = new Map();
  for (const [rows, kind] of [[phoneRows, 'phone'], [emailRows, 'email']]) {
    const byKey = new Map();
    for (const r of rows) (byKey.get(r.key) || byKey.set(r.key, []).get(r.key)).push(Number(r.id));
    for (const [key, ids] of byKey) {
      for (const id of ids) union(ids[0], id);
      reasons.set(`${kind}:${key}`, ids);
    }
  }
  const groups = new Map();
  for (const id of parent.keys()) { const root = find(id); (groups.get(root) || groups.set(root, []).get(root)).push(id); }
  const { rows: dismissed } = await db.execute({ sql: 'SELECT group_key FROM customer_duplicate_dismissals', args: [] });
  const dismissedKeys = new Set(dismissed.map(d => d.group_key));
  const out = [];
  for (const ids of groups.values()) {
    ids.sort((a, b) => a - b);
    const key = ids.join(',');
    if (dismissedKeys.has(key)) continue;
    const shared = [...reasons.entries()].filter(([, rIds]) => rIds.some(i => ids.includes(i))).map(([k]) => {
      const [kind, value] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      return kind === 'phone' ? `phone ${value.slice(0, 3)}-${value.slice(3, 6)}-${value.slice(6)}` : `email ${value}`;
    });
    out.push({ key, ids, shared });
  }
  return out.sort((a, b) => b.ids.length - a.ids.length || a.ids[0] - b.ids[0]);
}

// Find Duplicates screen: one page of groups with each customer's details and
// activity, plus a suggested customer to keep — the one with the most history,
// preferring a rental-approved record, then the oldest.
router.get('/duplicates', requirePermission('customers_merge'), async (req, res) => {
  try {
    const all = await duplicateGroups();
    const pageSize = 25;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    const ids = slice.flatMap(g => g.ids);
    const byId = new Map();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const { rows } = await db.execute({ sql: `SELECT c.*,
          (SELECT COUNT(*) FROM transactions t WHERE t.customer_id = c.id) AS sales_count,
          (SELECT MAX(created_at) FROM transactions t WHERE t.customer_id = c.id) AS last_sale_at,
          (SELECT COUNT(*) FROM rental_agreements r WHERE r.customer_id = c.id) AS rentals_count,
          (SELECT COUNT(*) FROM ar_legacy_invoices li WHERE li.customer_id = c.id) AS legacy_invoice_count,
          EXISTS (SELECT 1 FROM customer_import_batch_items b WHERE b.customer_id = c.id AND b.action = 'created') AS from_import
        FROM customers c WHERE c.id IN (${ph})`, args: ids });
      for (const r of rows) byId.set(Number(r.id), r);
    }
    const approved = c => !!c.is_rental_customer && (!!c.rental_preapproved || getMissingRentalFields(c).length === 0);
    const score = c => (approved(c) ? 100000 : 0) + (Number(c.sales_count) + Number(c.rentals_count) + Number(c.legacy_invoice_count)) * 100 + (c.account_balance ? 50 : 0) - Number(c.id) / 1e7;
    const groups = slice.map(g => {
      const customers = g.ids.map(id => byId.get(id)).filter(Boolean).map(c => ({
        id: c.id, customer_number: c.customer_number, name: `${c.first_name} ${c.last_name}`.trim(), customer_kind: c.customer_kind,
        phone: c.phone, email: c.email, address: [c.address, c.city, c.state].filter(Boolean).join(', '),
        customer_type: c.customer_type, account_balance: c.account_balance || 0, loyalty_points: c.loyalty_points || 0,
        rental_approved: approved(c), is_rental_customer: !!c.is_rental_customer, created_at: c.created_at, from_import: !!c.from_import,
        sales_count: Number(c.sales_count), rentals_count: Number(c.rentals_count), legacy_invoice_count: Number(c.legacy_invoice_count), last_sale_at: c.last_sale_at,
        _score: score(c),
      }));
      const keep = customers.reduce((best, c) => (!best || c._score > best._score ? c : best), null);
      customers.forEach(c => delete c._score);
      return { key: g.key, shared: g.shared, suggested_keep_id: keep?.id || null, customers };
    });
    res.json({ total_groups: all.length, total_customers: all.reduce((n, g) => n + g.ids.length, 0), page, page_size: pageSize, groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// What merging these customers would move onto the kept one, per customer.
router.get('/merge-preview', requirePermission('customers_merge'), async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
    const out = {};
    for (const id of ids) out[id] = await mergePreview(id);
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Merge one or more duplicates into the customer being kept.
router.post('/merge', requirePermission('customers_merge'), async (req, res) => {
  try {
    const keepId = parseInt(req.body.keep_id);
    const mergeIds = (Array.isArray(req.body.merge_ids) ? req.body.merge_ids : []).map(Number).filter(id => id && id !== keepId);
    if (!keepId || !mergeIds.length) return res.status(400).json({ error: 'Choose the customer to keep and at least one to merge into it' });
    let kept;
    for (const id of mergeIds) kept = await mergeCustomers(id, keepId, req.employee?.id || null);
    res.json({ kept, merged: mergeIds.length });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// "Not duplicates" — hide this exact group from the finder.
router.post('/duplicates/dismiss', requirePermission('customers_merge'), async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).sort((a, b) => a - b);
    if (ids.length < 2) return res.status(400).json({ error: 'A group needs at least two customers' });
    await db.execute({ sql: 'INSERT OR IGNORE INTO customer_duplicate_dismissals (group_key, dismissed_by) VALUES (?, ?)', args: [ids.join(','), req.employee?.id || null] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV import/export ─────────────────────────────────────
// Registered before GET /:id so "export"/"template" aren't swallowed as a
// customer id (same ordering as routes/products.js's /export routes).
// customer_type is compared as lowercase 'cash'/'credit' throughout, but the
// CSV export writes 'Cash'/'Credit' — so a re-imported export (or any
// caller) could store a capitalized value that those checks miss.
function normalizeCustomerType(t) {
  return String(t || '').trim().toLowerCase() === 'credit' ? 'credit' : 'cash';
}

// Opening or closing a credit account, or changing its limit or terms, needs
// customers_credit ("Manage Credit Limits") — customers_add/_edit alone
// can't. Without it a new customer is always Cash, and an edit keeps the
// customer's type/limit/terms (a field the caller left out counts as
// unchanged; a cash customer's hidden limit/terms are ignored). Returns
// { type, terms, limit } to save, or { error }.
const CREDIT_PERMISSION_ERROR = 'Changing a customer between Cash and Credit, or a credit limit or terms, needs the Manage Credit Limits permission';
function resolveCreditFields(req, body, existing) {
  const wanted = {
    type: normalizeCustomerType(body.customer_type),
    terms: parseInt(body.credit_terms_days) || 30,
    limit: parseFloat(body.credit_limit) || 0,
  };
  if (req.apiKey || can(req.employee?.permissions, 'customers_credit')) return wanted;
  if (!existing) {
    if (wanted.type === 'credit') return { error: `Opening a credit account needs the Manage Credit Limits permission — save the customer as Cash and ask someone who has it to switch them to Credit` };
    return { type: 'cash', terms: 30, limit: 0 };
  }
  const cur = { type: normalizeCustomerType(existing.customer_type), terms: existing.credit_terms_days || 30, limit: existing.credit_limit || 0 };
  if (body.customer_type !== undefined && wanted.type !== cur.type) return { error: CREDIT_PERMISSION_ERROR };
  if (cur.type === 'credit') {
    if (body.credit_limit !== undefined && Math.abs(wanted.limit - cur.limit) > 0.005) return { error: CREDIT_PERMISSION_ERROR };
    if (body.credit_terms_days !== undefined && wanted.terms !== cur.terms) return { error: CREDIT_PERMISSION_ERROR };
  }
  return cur;
}

const CSV_COLUMNS = ['first_name','last_name','email','phone','address','city','state','zip','customer_type','credit_terms_days','credit_limit','tax_exempt','tax_exemption_number','customer_category_name','notes'];

// Text-only rental compliance fields (see lib/rentals.js RENTAL_REQUIREMENTS)
// — a migrated rental customer still needs the ID scan, proof-of-address
// scan, and reference-1 ID scan uploaded one-at-a-time per customer (POST
// /:id/id-scan, /:id/address-proof, /:id/reference-id below) since a CSV
// row can't carry a file, but everything else can be bulk-loaded here.
// rental_preapproved lets a bulk-migrated row bypass the missing-field gate
// (lib/rentals.js assertRentalCustomerEligible) despite everything a legacy
// export can't carry — see POST /import below, which only honors it for the
// employee running the import if they hold customers_rental_preapprove.
const RENTAL_CSV_COLUMNS = ['is_rental_customer','rental_id_type','rental_id_number','rental_address_proof_type',
  'rental_reference_name','rental_reference_phone','rental_reference_relationship','rental_reference_address',
  'rental_reference2_name','rental_reference2_phone','rental_reference2_relationship',
  'rental_reference3_name','rental_reference3_phone','rental_reference3_relationship','rental_preapproved'];
// Business customers (customer_kind 'business'): the business name stands in
// for first/last name, and up to three contact persons ride along as
// contact1_* … contact3_* (customer_contacts).
const CONTACT_CSV_SLOTS = 3;
const BUSINESS_CSV_COLUMNS = ['customer_kind', 'business_name'];
for (let n = 1; n <= CONTACT_CSV_SLOTS; n++) BUSINESS_CSV_COLUMNS.push(`contact${n}_name`, `contact${n}_job_title`, `contact${n}_phone`, `contact${n}_email`);
CSV_COLUMNS.push(...BUSINESS_CSV_COLUMNS, ...RENTAL_CSV_COLUMNS);

const contactsFromCsvRow = row => Array.from({ length: CONTACT_CSV_SLOTS }, (_, i) => ({
  name: row[`contact${i + 1}_name`], job_title: row[`contact${i + 1}_job_title`],
  phone: row[`contact${i + 1}_phone`], email: row[`contact${i + 1}_email`],
}));

// "Business"/"Company"/… → business, "Individual"/"Person"/blank → individual,
// anything else → null (a row error). A row with a business name but no
// first/last name and no type given is taken as a business.
function csvCustomerKind(row) {
  const v = String(row.customer_kind ?? '').trim().toLowerCase();
  if (['business', 'company', 'corporate', 'organization', 'organisation', 'b'].includes(v)) return 'business';
  if (['individual', 'person', 'personal', 'i'].includes(v)) return 'individual';
  if (v) return null;
  return String(row.business_name || '').trim() && !(String(row.first_name || '').trim() && String(row.last_name || '').trim()) ? 'business' : 'individual';
}

function escapeCsv(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

// Accepts the same truthy spellings a spreadsheet is likely to contain.
function csvBool(v) {
  return ['1', 'true', 'yes', 'y'].includes(String(v ?? '').trim().toLowerCase());
}

// GET CSV template for bulk import
router.get('/export/template', requirePermission('customers_import'), (req, res) => {
  const examples = [
    { first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com', phone: '555-0100', address: '123 Main St', city: 'Ocho Rios', state: 'St. Ann', zip: '',
      customer_type: 'cash', credit_terms_days: '30', credit_limit: '0', tax_exempt: '0', customer_category_name: 'Individual', notes: 'Prefers email contact',
      customer_kind: 'individual',
      is_rental_customer: '1', rental_id_type: 'drivers_license', rental_id_number: 'D1234567', rental_address_proof_type: 'utility_bill',
      rental_reference_name: 'John Smith', rental_reference_phone: '555-0101', rental_reference_relationship: 'Brother', rental_reference_address: '456 Oak St',
      rental_reference2_name: 'Mary Jones', rental_reference2_phone: '555-0102', rental_reference2_relationship: 'Friend',
      rental_reference3_name: 'Bob White', rental_reference3_phone: '555-0103', rental_reference3_relationship: 'Coworker', rental_preapproved: '0' },
    { customer_kind: 'business', business_name: 'Acme Hardware Ltd', email: 'accounts@acme.example.com', phone: '555-0200', address: '12 Harbour Rd', city: 'Kingston', state: 'Kingston',
      customer_type: 'credit', credit_terms_days: '30', credit_limit: '500000', tax_exempt: '0',
      contact1_name: 'Mark Reid', contact1_job_title: 'Director', contact1_phone: '555-0201', contact1_email: 'mark@acme.example.com',
      contact2_name: 'Sue Hall', contact2_job_title: 'Procurement Officer', contact2_phone: '555-0202',
      contact3_name: 'Kim Lowe', contact3_job_title: 'Accountant', contact3_email: 'kim@acme.example.com' },
  ];
  const csv = [CSV_COLUMNS.join(','), ...examples.map(ex => CSV_COLUMNS.map(h => escapeCsv(ex[h] ?? '')).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="customer_import_template.csv"');
  res.send(csv);
});

// GET export active customers as CSV — same column shape as the import
// template/POST /import, so an export can be edited and re-imported.
router.get('/export', requirePermission('customers_export'), async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `SELECT c.*, cc.name as customer_category_name FROM customers c
        LEFT JOIN customer_categories cc ON c.customer_category_id = cc.id
        WHERE c.active = 1 ORDER BY c.first_name, c.last_name`,
      args: [],
    });
    const { rows: contacts } = await db.execute({ sql: 'SELECT cc.* FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id WHERE c.active = 1 ORDER BY cc.customer_id, cc.sort_order, cc.id', args: [] });
    const contactsBy = new Map();
    for (const ct of contacts) (contactsBy.get(ct.customer_id) || contactsBy.set(ct.customer_id, []).get(ct.customer_id)).push(ct);
    const csvRows = [CSV_COLUMNS.join(',')];
    for (const c of rows) {
      const row = { ...c };
      (contactsBy.get(c.id) || []).slice(0, CONTACT_CSV_SLOTS).forEach((ct, i) => {
        Object.assign(row, { [`contact${i + 1}_name`]: ct.name, [`contact${i + 1}_job_title`]: ct.job_title, [`contact${i + 1}_phone`]: ct.phone, [`contact${i + 1}_email`]: ct.email });
      });
      // A business's name lives in business_name; first_name just mirrors it.
      if (c.customer_kind === 'business') { row.first_name = ''; row.last_name = ''; }
      csvRows.push(CSV_COLUMNS.map(h => escapeCsv(row[h])).join(','));
    }
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="customers_export_${timestamp}.csv"`);
    res.send(csvRows.join('\r\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET export a customer balances report as CSV — filterable by type (retail
// vs. rental, via is_rental_customer), with AR balance, outstanding credit
// note total, and account status. Unlike GET /export above (a re-importable
// dump of every editable field), this is report-shaped and derives its two
// money columns from the one account_balance field: a positive balance is
// what the customer owes (AR), a negative balance is store credit the
// business owes them (issued via a return's "credit note" resolution or a
// rental deposit credit note — see routes/transactions.js POST /:id/return
// and routes/rentals.js POST /agreements/:id/credit-note, both of which
// only ever move this same field). Includes inactive/blocked customers
// (unlike other exports) since status is one of the requested columns.
router.get('/export/balances', requirePermission('customers_export_balances'), async (req, res) => {
  try {
    const { type } = req.query; // 'retail' | 'rental' | omitted for both
    let sql = `SELECT c.customer_number, c.first_name, c.last_name, c.email, c.phone,
      c.is_rental_customer, c.customer_type, c.active, c.account_blocked,
      MAX(c.account_balance, 0) as ar_balance,
      MAX(-c.account_balance, 0) as credit_note_total
      FROM customers c WHERE 1=1`;
    const args = [];
    if (type === 'retail') sql += ' AND c.is_rental_customer = 0';
    else if (type === 'rental') sql += ' AND c.is_rental_customer = 1';
    sql += ' ORDER BY c.last_name, c.first_name';

    const { rows } = await db.execute({ sql, args });
    const headers = ['customer_number','first_name','last_name','email','phone','type','customer_type','ar_balance','credit_note_total','status'];
    const csvRows = [headers.join(',')];
    for (const c of rows) {
      const status = !c.active ? 'Inactive' : c.account_blocked ? 'Blocked' : 'Active';
      const row = {
        ...c,
        type: c.is_rental_customer ? 'Rental' : 'Retail',
        customer_type: c.customer_type === 'credit' ? 'Credit' : 'Cash',
        status,
      };
      csvRows.push(headers.map(h => escapeCsv(row[h])).join(','));
    }
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="customer_balances_${type || 'all'}_${timestamp}.csv"`);
    res.send(csvRows.join('\r\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET rental customers whose compliance record is incomplete — the same
// requirements lib/rentals.js's assertRentalCustomerEligible enforces before
// a new rental can be created, surfaced here as a reviewable list instead of
// a per-rental error. Meant for cleaning up customers bulk-imported from a
// previous system (see POST /import above) that are flagged as rental
// customers but are missing the ID/reference/document fields a legacy export
// wouldn't have carried. Registered before GET /:id so "rental-incomplete"
// isn't swallowed as a customer id (same reasoning as the /export routes).
router.get('/rental-incomplete', requirePermission('customers_missing_rental_info'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM customers WHERE is_rental_customer = 1 AND active = 1 ORDER BY last_name, first_name', args: [] });
    const results = rows
      .map(c => ({ c, missing: getMissingRentalFields(c) }))
      .filter(r => r.missing.length)
      .map(({ c, missing }) => ({
        id: c.id, customer_number: c.customer_number, first_name: c.first_name, last_name: c.last_name,
        email: c.email, phone: c.phone,
        rental_preapproved: !!c.rental_preapproved,
        missing: missing.map(m => m.label),
      }));
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Discount card fields (name/percent/active) come from a LEFT JOIN so the
// POS can decide whether to auto-apply it (discount_card_type_active must
// also be true — deactivating a type retires it for every customer holding
// it without editing each customer record).
// Cash-back fields (points_threshold/reward_amount/redemption gates) join in
// the same way, so POS can compute eligibility client-side without a second
// round trip — see availableCashBack() in public/index.html.
// Customer category fields join the same way too — a category's
// discount_percent auto-applies at checkout exactly like a discount card
// (see setCartCustomer() in public/index.html), just without a card number,
// and only when no discount card is present (a card is a more deliberate,
// specific assignment and wins if both exist on the same customer).
const CUSTOMER_WITH_CARD_SELECT = `SELECT c.*, dct.name as discount_card_type_name, dct.discount_percent as discount_card_percent, dct.active as discount_card_type_active,
  cbct.name as cash_back_card_type_name, cbct.points_threshold as cash_back_points_threshold, cbct.reward_amount as cash_back_reward_amount,
  cbct.min_redeem_amount as cash_back_min_redeem_amount, cbct.min_redeem_days as cash_back_min_redeem_days, cbct.active as cash_back_card_type_active,
  cc.name as customer_category_name, cc.discount_percent as customer_category_discount_percent, cc.active as customer_category_active,
  rpe.first_name || ' ' || rpe.last_name as rental_preapproved_by_name,
  EXISTS (SELECT 1 FROM customer_import_batch_items cibi WHERE cibi.customer_id = c.id AND cibi.action = 'created') as created_by_import
  FROM customers c LEFT JOIN discount_card_types dct ON c.discount_card_type_id = dct.id
  LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id = cbct.id
  LEFT JOIN customer_categories cc ON c.customer_category_id = cc.id
  LEFT JOIN employees rpe ON c.rental_preapproved_by = rpe.id WHERE c.id = ?`;

// Individual vs business. A business's name is stored in business_name and
// mirrored into first_name (last_name '') so everywhere that prints
// first_name + last_name shows it. Returns { kind, business_name,
// first_name, last_name } or { error }. Only used when the request says which
// kind it is — older callers (imports, API clients) keep sending first/last.
function resolveCustomerNames(body) {
  if (body.customer_kind === 'business') {
    const name = String(body.business_name || '').trim();
    if (!name) return { error: 'Business name is required' };
    return { kind: 'business', business_name: name, first_name: name, last_name: '' };
  }
  const first = String(body.first_name || '').trim(), last = String(body.last_name || '').trim();
  if (!first || !last) return { error: 'First and last name required' };
  return { kind: 'individual', business_name: null, first_name: first, last_name: last };
}

// Replaces a customer's contact people with `contacts` ([{ name, job_title,
// phone, email }]) — rows with nothing filled in are dropped; a row with
// details but no name is refused.
function cleanContacts(contacts) {
  const rows = (Array.isArray(contacts) ? contacts : []).map(c => ({
    name: String(c?.name || '').trim(), job_title: String(c?.job_title || '').trim() || null,
    phone: String(c?.phone || '').trim() || null, email: String(c?.email || '').trim() || null,
  })).filter(c => c.name || c.job_title || c.phone || c.email);
  const unnamed = rows.find(c => !c.name);
  if (unnamed) return { error: 'Each contact person needs a name' };
  return { rows };
}

async function saveContacts(customerId, rows) {
  await db.execute({ sql: 'DELETE FROM customer_contacts WHERE customer_id = ?', args: [customerId] });
  for (const [i, c] of rows.entries()) {
    await db.execute({ sql: 'INSERT INTO customer_contacts (customer_id, name, job_title, phone, email, sort_order) VALUES (?,?,?,?,?,?)', args: [customerId, c.name, c.job_title, c.phone, c.email, i] });
  }
}

// The Block box's state for the customer form: the automatic overdue
// position plus any manual decision and who made it.
async function creditBlockInfo(customer) {
  if (!customer || customer.customer_type !== 'credit') return null;
  const status = await creditStatus(customer);
  let override_by_name = null;
  if (customer.block_override_by) {
    const { rows: [e] } = await db.execute({ sql: 'SELECT first_name, last_name FROM employees WHERE id = ?', args: [customer.block_override_by] });
    if (e) override_by_name = `${e.first_name} ${e.last_name}`;
  }
  return { ...status, terms_days: customer.credit_terms_days || 30, credit_limit: customer.credit_limit || 0, balance: customer.account_balance || 0, blocked: !!customer.account_blocked,
    override: customer.block_override || null, override_by_name, override_at: customer.block_override_at || null, reason: customer.block_override_reason || null };
}

// Tick/untick the Block box. Ticking an up-to-date account blocks it by hand
// until someone unticks it; unticking an overdue one lets it through until
// it's up to date again (lib/creditBlock.js). A reason is required either way.
router.patch('/:id/credit-block', requirePermission('customers_credit_block'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to block or unblock an account' });
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (customer.customer_type !== 'credit') return res.status(400).json({ error: 'Only credit customers can be blocked' });
    const { auto } = await creditStatus(customer);
    const wantBlocked = !!req.body.blocked;
    // Blocking an account the automatic rule already blocks (overdue or over
    // limit) just leaves that in place; unblocking an up-to-date one just
    // removes a manual block.
    const override = wantBlocked ? (auto ? null : 'block') : (auto ? 'unblock' : null);
    await writeBlock(customer.id, resolveBlock(auto, override), override ? { by: req.employee?.id || null, at: new Date().toISOString(), reason } : null);
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customer.id] });
    res.json({ ...row, credit_block: await creditBlockInfo(row) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    await runCreditCheck(req.params.id);
    const { rows: [updated] } = await db.execute({ sql: CUSTOMER_WITH_CARD_SELECT, args: [req.params.id] });
    const { rows: transactions } = await db.execute({ sql: 'SELECT * FROM transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', args: [req.params.id] });
    const { rows: contacts } = await db.execute({ sql: 'SELECT id, name, job_title, phone, email FROM customer_contacts WHERE customer_id = ? ORDER BY sort_order, id', args: [req.params.id] });
    res.json({ ...updated, recent_transactions: transactions, contacts, credit_block: await creditBlockInfo(updated) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let sql = 'SELECT * FROM transactions WHERE customer_id = ?';
    const args = [req.params.id];
    if (start) { sql += ' AND date(created_at) >= ?'; args.push(start); }
    if (end) { sql += ' AND date(created_at) <= ?'; args.push(end); }
    sql += ' ORDER BY created_at DESC';
    const { rows: transactions } = await db.execute({ sql, args });
    res.json(transactions);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// The customer's History window (and its Print) — payments on account and
// old-system invoices for this one customer. Gated like /:id/transactions
// above rather than behind /accounts, so anyone who can open a customer sees
// their whole history, not just staff with the Accounts module.
router.get('/:id/payments', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let sql = 'SELECT id, payment_number, created_at, amount, payment_method, notes FROM account_payments WHERE customer_id = ?';
    const args = [req.params.id];
    if (start) { sql += ' AND date(created_at) >= ?'; args.push(start); }
    if (end) { sql += ' AND date(created_at) <= ?'; args.push(end); }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/legacy-invoices', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let sql = `SELECT li.id, li.invoice_number, li.invoice_date, li.due_date, li.amount, li.memo, li.status, ${LEGACY_BALANCE_SQL} as balance_due FROM ar_legacy_invoices li WHERE li.customer_id = ?`;
    const args = [req.params.id];
    if (start) { sql += ' AND date(li.invoice_date) >= ?'; args.push(start); }
    if (end) { sql += ' AND date(li.invoice_date) <= ?'; args.push(end); }
    sql += ' ORDER BY li.invoice_date DESC';
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Validates a customer's discount card fields before insert/update: the card
// type (if given) must exist, and the card number (if given) can't already
// belong to another customer — one active card per customer, enforced here
// since SQLite's ALTER TABLE ADD COLUMN can't add a UNIQUE constraint after
// the fact. Returns an error string, or null if everything checks out.
async function validateDiscountCard(discount_card_type_id, discount_card_number, excludeCustomerId) {
  if (!discount_card_type_id) return null;
  const { rows: [type] } = await db.execute({ sql: 'SELECT id FROM discount_card_types WHERE id = ?', args: [discount_card_type_id] });
  if (!type) return 'Selected discount card type does not exist';
  if (discount_card_number) {
    const { rows: [dupe] } = await db.execute({
      sql: `SELECT id FROM customers WHERE discount_card_number = ? ${excludeCustomerId ? 'AND id != ?' : ''}`,
      args: excludeCustomerId ? [discount_card_number, excludeCustomerId] : [discount_card_number],
    });
    if (dupe) return `Card number ${discount_card_number} is already assigned to another customer`;
  }
  return null;
}

// Same shape/reasoning as validateDiscountCard() above.
async function validateCashBackCard(cash_back_card_type_id, cash_back_card_number, excludeCustomerId) {
  if (!cash_back_card_type_id) return null;
  const { rows: [type] } = await db.execute({ sql: 'SELECT id FROM cash_back_card_types WHERE id = ?', args: [cash_back_card_type_id] });
  if (!type) return 'Selected cash back card type does not exist';
  if (cash_back_card_number) {
    const { rows: [dupe] } = await db.execute({
      sql: `SELECT id FROM customers WHERE cash_back_card_number = ? ${excludeCustomerId ? 'AND id != ?' : ''}`,
      args: excludeCustomerId ? [cash_back_card_number, excludeCustomerId] : [cash_back_card_number],
    });
    if (dupe) return `Card number ${cash_back_card_number} is already assigned to another customer`;
  }
  return null;
}

router.post('/', requirePermission('customers_add'), async (req, res) => {
  const {
    email, phone, address, city, state, zip, notes, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number,
    is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type,
    rental_reference_name, rental_reference_phone, rental_reference_relationship, rental_reference_address,
    rental_reference2_name, rental_reference2_phone, rental_reference2_relationship,
    rental_reference3_name, rental_reference3_phone, rental_reference3_relationship,
    rental_preapproved,
    discount_card_type_id, discount_card_number,
    cash_back_card_type_id, cash_back_card_number,
    customer_category_id,
  } = req.body;
  let { first_name, last_name } = req.body;
  const hasKind = 'customer_kind' in req.body;
  const names = hasKind ? resolveCustomerNames(req.body) : null;
  if (names?.error) return res.status(400).json({ error: names.error });
  if (names) ({ first_name, last_name } = names);
  const contactSet = 'contacts' in req.body ? cleanContacts(req.body.contacts) : null;
  if (contactSet?.error) return res.status(400).json({ error: contactSet.error });
  if (!first_name || (!last_name && names?.kind !== 'business')) return res.status(400).json({ error: 'First and last name required' });
  try {
    // Guard against creating a duplicate customer record: match on email,
    // phone, or full name against active customers.
    // Phone/email clashes are always refused; `force` only overrides a
    // name-only match.
    const matches = await findDuplicateCustomers({ email, phone, first_name, last_name });
    if (matches.some(isHardDuplicate)) return res.status(409).json(hardDuplicateError(matches));
    if (matches.length && !req.body.force) return res.status(409).json({ error: 'Possible duplicate customer', matches });
    const cardError = await validateDiscountCard(discount_card_type_id, discount_card_number, null);
    if (cardError) return res.status(400).json({ error: cardError });
    const cashBackCardError = await validateCashBackCard(cash_back_card_type_id, cash_back_card_number, null);
    if (cashBackCardError) return res.status(400).json({ error: cashBackCardError });
    const credit = resolveCreditFields(req, req.body, null);
    if (credit.error) return res.status(403).json({ error: credit.error });
    const customer_number = await nextNumber(db, 'customers', 'customer_number', 'CUST-', 4);
    const { type, terms, limit } = credit;
    const creditEnabled = type === 'credit' ? 1 : 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const isRentalCust = is_rental_customer ? 1 : 0;
    // Never preapproved on manual create — see resolveRentalPreapproval.
    const preapproval = resolveRentalPreapproval(req, null, isRentalCust, !!rental_preapproved, false);
    const result = await db.execute({ sql: `INSERT INTO customers
      (customer_number,first_name,last_name,email,phone,address,city,state,zip,notes,customer_type,credit_terms_days,credit_limit,credit_enabled,tax_exempt,tax_exemption_number,
       is_rental_customer,rental_id_type,rental_id_number,rental_address_proof_type,
       rental_reference_name,rental_reference_phone,rental_reference_relationship,rental_reference_address,
       rental_reference2_name,rental_reference2_phone,rental_reference2_relationship,
       rental_reference3_name,rental_reference3_phone,rental_reference3_relationship,
       rental_preapproved,rental_preapproved_by,rental_preapproved_at,
       discount_card_type_id,discount_card_number,cash_back_card_type_id,cash_back_card_number,customer_category_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [customer_number, first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null,
        isRentalCust, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null,
        isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null, isRentalCust ? (rental_reference_address||null) : null,
        isRentalCust ? (rental_reference2_name||null) : null, isRentalCust ? (rental_reference2_phone||null) : null, isRentalCust ? (rental_reference2_relationship||null) : null,
        isRentalCust ? (rental_reference3_name||null) : null, isRentalCust ? (rental_reference3_phone||null) : null, isRentalCust ? (rental_reference3_relationship||null) : null,
        preapproval.rental_preapproved, preapproval.rental_preapproved_by, preapproval.rental_preapproved_at,
        discount_card_type_id || null, discount_card_type_id ? (discount_card_number || null) : null,
        cash_back_card_type_id || null, cash_back_card_type_id ? (cash_back_card_number || null) : null,
        customer_category_id || null] });
    const newId = Number(result.lastInsertRowid);
    await syncPhoneKeys(db, newId, phone);
    if (names) await db.execute({ sql: 'UPDATE customers SET customer_kind = ?, business_name = ? WHERE id = ?', args: [names.kind, names.business_name, newId] });
    if (contactSet) await saveContacts(newId, contactSet.rows);
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [newId] });
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('customers_edit'), async (req, res) => {
  const {
    email, phone, address, city, state, zip, notes, active, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number,
    is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type,
    rental_reference_name, rental_reference_phone, rental_reference_relationship, rental_reference_address,
    rental_reference2_name, rental_reference2_phone, rental_reference2_relationship,
    rental_reference3_name, rental_reference3_phone, rental_reference3_relationship,
    rental_preapproved,
    discount_card_type_id, discount_card_number,
    cash_back_card_type_id, cash_back_card_number,
    customer_category_id,
  } = req.body;
  // Kind/business name and contacts only change when the caller sends them
  // (PUT otherwise overwrites every column, and older callers don't know them).
  let { first_name, last_name } = req.body;
  const names = 'customer_kind' in req.body ? resolveCustomerNames(req.body) : null;
  if (names?.error) return res.status(400).json({ error: names.error });
  if (names) ({ first_name, last_name } = names);
  const contactSet = 'contacts' in req.body ? cleanContacts(req.body.contacts) : null;
  if (contactSet?.error) return res.status(400).json({ error: contactSet.error });
  try {
    const cardError = await validateDiscountCard(discount_card_type_id, discount_card_number, req.params.id);
    if (cardError) return res.status(400).json({ error: cardError });
    const cashBackCardError = await validateCashBackCard(cash_back_card_type_id, cash_back_card_number, req.params.id);
    if (cashBackCardError) return res.status(400).json({ error: cashBackCardError });
    const { rows: [existing] } = await db.execute({ sql: 'SELECT phone, email, rental_preapproved, rental_preapproved_by, rental_preapproved_at, customer_type, credit_terms_days, credit_limit FROM customers WHERE id = ?', args: [req.params.id] });
    if (!existing) return res.status(404).json({ error: 'Customer not found' });
    const credit = resolveCreditFields(req, req.body, existing);
    if (credit.error) return res.status(403).json({ error: credit.error });
    // Changing a customer's phone/email to one another active customer
    // already uses is refused, same as on create. Only checked when the value
    // actually changes, so records that already shared a number before this
    // rule existed can still be edited.
    if (existing) {
      const phoneChanged = normalizePhone(phone) !== normalizePhone(existing.phone);
      const emailChanged = String(email || '').trim().toLowerCase() !== String(existing.email || '').trim().toLowerCase();
      if (phoneChanged || emailChanged) {
        const clashes = (await findDuplicateCustomers({ phone: phoneChanged ? phone : null, email: emailChanged ? email : null }, req.params.id)).filter(isHardDuplicate);
        if (clashes.length) return res.status(409).json(hardDuplicateError(clashes));
      }
    }
    const { type, terms, limit } = credit;
    const creditEnabled = type === 'credit' ? 1 : 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const isRentalCust = is_rental_customer ? 1 : 0;
    const preapproval = resolveRentalPreapproval(req, existing, isRentalCust, !!rental_preapproved, await createdByImport(req.params.id));
    await db.execute({ sql: `UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,notes=?,active=?,customer_type=?,credit_terms_days=?,credit_limit=?,credit_enabled=?,tax_exempt=?,tax_exemption_number=?,
      is_rental_customer=?,rental_id_type=?,rental_id_number=?,rental_address_proof_type=?,
      rental_reference_name=?,rental_reference_phone=?,rental_reference_relationship=?,rental_reference_address=?,
      rental_reference2_name=?,rental_reference2_phone=?,rental_reference2_relationship=?,
      rental_reference3_name=?,rental_reference3_phone=?,rental_reference3_relationship=?,
      rental_preapproved=?,rental_preapproved_by=?,rental_preapproved_at=?,
      discount_card_type_id=?,discount_card_number=?,cash_back_card_type_id=?,cash_back_card_number=?,customer_category_id=? WHERE id=?`,
      args: [first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, active??1, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null,
        isRentalCust, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null,
        isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null, isRentalCust ? (rental_reference_address||null) : null,
        isRentalCust ? (rental_reference2_name||null) : null, isRentalCust ? (rental_reference2_phone||null) : null, isRentalCust ? (rental_reference2_relationship||null) : null,
        isRentalCust ? (rental_reference3_name||null) : null, isRentalCust ? (rental_reference3_phone||null) : null, isRentalCust ? (rental_reference3_relationship||null) : null,
        preapproval.rental_preapproved, preapproval.rental_preapproved_by, preapproval.rental_preapproved_at,
        discount_card_type_id || null, discount_card_type_id ? (discount_card_number || null) : null,
        cash_back_card_type_id || null, cash_back_card_type_id ? (cash_back_card_number || null) : null,
        customer_category_id || null, req.params.id] });
    if (names) await db.execute({ sql: 'UPDATE customers SET customer_kind = ?, business_name = ? WHERE id = ?', args: [names.kind, names.business_name, req.params.id] });
    await syncPhoneKeys(db, req.params.id, phone);
    if (contactSet) await saveContacts(req.params.id, contactSet.rows);
    if (type === 'cash') {
      await writeBlock(req.params.id, { blocked: 0, override: null });
    } else {
      await runCreditCheck(req.params.id);
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('customers_delete'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE customers SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST import customers from CSV rows.
// `batch_id` (from POST /customer-imports) is optional — when present, every
// row's outcome is logged to customer_import_batch_items so the batch can
// later be reviewed (routes/customer-imports.js GET /:id) or reversed
// (POST /:id/reverse). Every row runs through the same duplicate check as
// POST / (email/phone/full name against active customers): by default a
// match skips the row instead of creating it — pass `duplicate_mode:
// 'force'` to create rows whose only match is by name (phone/email
// matches are always skipped).
router.post('/import', requirePermission('customers_import'), async (req, res) => {
  try {
    const { rows, batch_id, duplicate_mode } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
    const force = duplicate_mode === 'force';

    const { rows: catRows } = await db.execute({ sql: 'SELECT id, name FROM customer_categories', args: [] });
    const catMap = Object.fromEntries(catRows.map(c => [c.name.toLowerCase(), c.id]));
    // Only an employee holding customers_rental_preapprove can actually set
    // the flag through an import — same restriction as PUT /:id (see
    // resolveRentalPreapproval above). Checked once for the whole batch
    // rather than per row since the requester doesn't change mid-import; a
    // row that asks for it without the permission just imports as an
    // ordinary (non-preapproved) rental customer instead of failing.
    const canPreapprove = can(req.employee?.permissions, 'customers_rental_preapprove');
    // Same rule as a single create: without Manage Credit Limits, rows marked
    // Credit come in as Cash (counted and reported back) rather than failing.
    const canCredit = !!req.apiKey || can(req.employee?.permissions, 'customers_credit');
    let importedAsCash = 0;

    let created = 0, skipped = 0;
    const errors = [];
    const duplicates = [];
    const logItem = async (rowLabel, customer_id, action, duplicate_of_customer_id, error_message) => {
      if (!batch_id) return;
      await db.execute({
        sql: 'INSERT INTO customer_import_batch_items (batch_id, customer_id, row_label, action, duplicate_of_customer_id, error_message) VALUES (?,?,?,?,?,?)',
        args: [batch_id, customer_id || null, rowLabel || '', action, duplicate_of_customer_id || null, error_message || null],
      });
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const { email, phone, address, city, state, zip, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number, customer_category_name, notes,
        is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type,
        rental_reference_name, rental_reference_phone, rental_reference_relationship, rental_reference_address,
        rental_reference2_name, rental_reference2_phone, rental_reference2_relationship,
        rental_reference3_name, rental_reference3_phone, rental_reference3_relationship, rental_preapproved } = row;
      const kind = csvCustomerKind(row);
      const names = kind === 'business'
        ? resolveCustomerNames({ customer_kind: 'business', business_name: String(row.business_name || '').trim() || `${row.first_name || ''} ${row.last_name || ''}`.trim() })
        : kind === 'individual' ? resolveCustomerNames({ first_name: row.first_name, last_name: row.last_name }) : null;
      const contactSet = cleanContacts(contactsFromCsvRow(row));
      const rowLabel = (names && !names.error ? `${names.first_name} ${names.last_name}`.trim() : `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.business_name) || email || phone || `row ${rowNum}`;
      const rowError = !names ? `customer type must be Individual or Business — got "${row.customer_kind}"`
        : names.error ? (kind === 'business' ? 'a business name is required' : 'first and last name are required (or a business name for a business)')
        : contactSet.error ? contactSet.error.toLowerCase().replace(/^each/, 'each') : null;
      if (rowError) {
        const msg = `Row ${rowNum}: ${rowError}`;
        errors.push(msg);
        await logItem(rowLabel, null, 'error', null, msg);
        continue;
      }
      const { first_name, last_name } = names;
      try {
        {
          // 'force' only overrides name-only matches — a row whose phone or
          // email is already in use is always skipped.
          const matches = await findDuplicateCustomers({ email, phone, first_name, last_name });
          if (matches.some(isHardDuplicate) || (matches.length && !force)) {
            skipped++;
            duplicates.push({ row: rowLabel, matches: matches.map(m => ({ id: m.id, customer_number: m.customer_number, name: `${m.first_name} ${m.last_name}` })) });
            await logItem(rowLabel, null, 'skipped_duplicate', matches[0].id, null);
            continue;
          }
        }
        const category_id = customer_category_name ? (catMap[customer_category_name.toLowerCase()] ?? null) : null;
        const asCash = !canCredit && normalizeCustomerType(customer_type) === 'credit';
        const type = asCash ? 'cash' : normalizeCustomerType(customer_type);
        const customer_number = await nextNumber(db, 'customers', 'customer_number', 'CUST-', 4);
        // Rental fields only get stored when the row actually flags the
        // customer as a rental customer — same as POST / (single create).
        const isRentalCust = csvBool(is_rental_customer);
        const isPreapproved = isRentalCust && canPreapprove && csvBool(rental_preapproved);
        const result = await db.execute({
          sql: `INSERT INTO customers (customer_number,first_name,last_name,email,phone,address,city,state,zip,customer_type,credit_terms_days,credit_limit,credit_enabled,tax_exempt,tax_exemption_number,customer_category_id,notes,
                is_rental_customer,rental_id_type,rental_id_number,rental_address_proof_type,
                rental_reference_name,rental_reference_phone,rental_reference_relationship,rental_reference_address,
                rental_reference2_name,rental_reference2_phone,rental_reference2_relationship,
                rental_reference3_name,rental_reference3_phone,rental_reference3_relationship,
                rental_preapproved,rental_preapproved_by,rental_preapproved_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [customer_number, first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, type, parseInt(credit_terms_days)||30, canCredit ? (parseFloat(credit_limit)||0) : 0, type === 'credit' ? 1 : 0, tax_exempt ? 1 : 0, tax_exemption_number||null, category_id, notes||null,
            isRentalCust ? 1 : 0, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null,
            isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null, isRentalCust ? (rental_reference_address||null) : null,
            isRentalCust ? (rental_reference2_name||null) : null, isRentalCust ? (rental_reference2_phone||null) : null, isRentalCust ? (rental_reference2_relationship||null) : null,
            isRentalCust ? (rental_reference3_name||null) : null, isRentalCust ? (rental_reference3_phone||null) : null, isRentalCust ? (rental_reference3_relationship||null) : null,
            isPreapproved ? 1 : 0, isPreapproved ? (req.employee?.id || null) : null, isPreapproved ? new Date().toISOString() : null],
        });
        const newId = Number(result.lastInsertRowid);
        // Keys first, so a later row in the same file with this number is
        // caught as a duplicate too.
        await syncPhoneKeys(db, newId, phone);
        await db.execute({ sql: 'UPDATE customers SET customer_kind = ?, business_name = ? WHERE id = ?', args: [names.kind, names.business_name, newId] });
        if (contactSet.rows.length) await saveContacts(newId, contactSet.rows);
        created++;
        if (asCash) importedAsCash++;
        await logItem(rowLabel, newId, 'created', null, null);
      } catch (e) {
        errors.push(`Row ${rowNum} (${rowLabel}): ${e.message}`);
        await logItem(rowLabel, null, 'error', null, e.message);
      }
    }

    res.json({ created, skipped, errors, duplicates, total: rows.length, imported_as_cash: importedAsCash });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload rental customer's ID scan — same Cloudinary-or-local fallback
// pattern as product images (see routes/products.js POST /:id/image).
router.post('/:id/id-scan', requirePermission('customers_edit'), upload.single('id_scan'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_id_scan_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_id_scan_path) {
      if (existing.rental_id_scan_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_id_scan_path);
      } else {
        const old = path.join(__dirname, '..', existing.rental_id_scan_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-ids',
      public_id: `customer-${req.params.id}`,
      overwrite: true,
      resource_type: 'image',
    });

    let scanPath;
    if (result) {
      scanPath = result.secure_url;
    } else {
      // Cloudinary not configured — save locally
      const dir = path.join(__dirname, '../uploads/customer-ids');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      scanPath = `/uploads/customer-ids/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_id_scan_path = ? WHERE id = ?', args: [scanPath, req.params.id] });
    res.json({ rental_id_scan_path: scanPath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE rental customer's ID scan
router.delete('/:id/id-scan', requirePermission('customers_edit'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_id_scan_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_id_scan_path) {
      if (customer.rental_id_scan_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_id_scan_path);
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_id_scan_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_id_scan_path = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload a photo ID for reference 1 (the "main" reference — the one
// with an address on file) — same Cloudinary-or-local pattern and image-only
// restriction as the customer's own ID scan above.
router.post('/:id/reference-id', requirePermission('customers_edit'), upload.single('reference_id'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_reference_id_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_reference_id_path) {
      if (existing.rental_reference_id_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_reference_id_path);
      } else {
        const old = path.join(__dirname, '..', existing.rental_reference_id_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-reference-ids',
      public_id: `customer-${req.params.id}`,
      overwrite: true,
      resource_type: 'image',
    });

    let scanPath;
    if (result) {
      scanPath = result.secure_url;
    } else {
      const dir = path.join(__dirname, '../uploads/customer-reference-ids');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      scanPath = `/uploads/customer-reference-ids/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_reference_id_path = ? WHERE id = ?', args: [scanPath, req.params.id] });
    res.json({ rental_reference_id_path: scanPath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE reference 1's photo ID
router.delete('/:id/reference-id', requirePermission('customers_edit'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_reference_id_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_reference_id_path) {
      if (customer.rental_reference_id_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_reference_id_path);
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_reference_id_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_reference_id_path = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload rental customer's proof-of-address document — same
// Cloudinary-or-local fallback pattern as the ID scan above, but accepts a
// PDF too (bank statements/utility bills are usually PDFs, not photos), so
// resource_type is 'auto' at upload time and destroy needs the stored mime
// to know whether Cloudinary filed it as 'image' or 'raw'.
router.post('/:id/address-proof', requirePermission('customers_edit'), uploadDoc.single('address_proof'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded, or file type not allowed (images and PDF only)' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_address_proof_path, rental_address_proof_mime FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_address_proof_path) {
      if (existing.rental_address_proof_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_address_proof_path, /^image\//.test(existing.rental_address_proof_mime || '') ? 'image' : 'raw');
      } else {
        const old = path.join(__dirname, '..', existing.rental_address_proof_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-address-proofs',
      public_id: `customer-${req.params.id}-${Date.now()}`,
      resource_type: 'auto',
    });

    let docPath;
    if (result) {
      docPath = result.secure_url;
    } else {
      const dir = path.join(__dirname, '../uploads/customer-address-proofs');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      docPath = `/uploads/customer-address-proofs/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_address_proof_path = ?, rental_address_proof_mime = ? WHERE id = ?', args: [docPath, req.file.mimetype, req.params.id] });
    res.json({ rental_address_proof_path: docPath, rental_address_proof_mime: req.file.mimetype });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE rental customer's proof-of-address document
router.delete('/:id/address-proof', requirePermission('customers_edit'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_address_proof_path, rental_address_proof_mime FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_address_proof_path) {
      if (customer.rental_address_proof_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_address_proof_path, /^image\//.test(customer.rental_address_proof_mime || '') ? 'image' : 'raw');
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_address_proof_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_address_proof_path = NULL, rental_address_proof_mime = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.runCreditCheck = runCreditCheck;
module.exports.findDuplicateCustomers = findDuplicateCustomers;
module.exports.isHardDuplicate = isHardDuplicate;
module.exports.hardDuplicateError = hardDuplicateError;
