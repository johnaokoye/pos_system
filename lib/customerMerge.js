const { db } = require('../database');
const { phoneKeys, syncPhoneKeys } = require('./phoneKeys');

// Tables whose customer_id simply moves to the surviving customer (none has a
// UNIQUE constraint involving customer_id). customer_import_batch_items is
// deliberately NOT here: it records which import created the duplicate, and
// reversing that import must deactivate the duplicate, not the customer it
// was merged into.
const REPOINT_TABLES = [
  'transactions', 'returns', 'account_payments', 'ar_legacy_invoices', 'quotations', 'rental_agreements',
  'layaway_plans', 'work_orders', 'shipments', 'crm_leads', 'crm_opportunities', 'crm_activities', 'customer_contacts',
];

// Single-value fields the survivor takes from the duplicate only when its own
// are blank (never overwritten).
const FILL_IF_BLANK = [
  'email', 'address', 'city', 'state', 'zip', 'tax_exemption_number', 'customer_category_id', 'business_name',
  'rental_id_type', 'rental_id_number', 'rental_id_scan_path', 'rental_address_proof_type', 'rental_address_proof_details',
  'rental_address_proof_path', 'rental_address_proof_mime', 'rental_reference_id_path',
  'rental_reference_name', 'rental_reference_phone', 'rental_reference_relationship', 'rental_reference_address',
  'rental_reference2_name', 'rental_reference2_phone', 'rental_reference2_relationship',
  'rental_reference3_name', 'rental_reference3_phone', 'rental_reference3_relationship',
];

const blank = v => v == null || String(v).trim() === '';
const fullName = c => `${c.first_name} ${c.last_name}`.trim();

// What merging `source` into `target` would move — shown before confirming.
async function mergePreview(sourceId) {
  const counts = {};
  for (const table of REPOINT_TABLES) {
    const { rows: [r] } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE customer_id = ?`, args: [sourceId] });
    if (Number(r.n)) counts[table] = Number(r.n);
  }
  return counts;
}

// Folds a duplicate customer (source) into the one being kept (target):
// every sale, rental, payment, quote, layaway, work order, shipment, CRM
// record, legacy invoice and contact person moves to the target; balance,
// loyalty points and total spent are added together; details the target is
// missing are filled from the source (a second phone number is kept
// alongside the first, a different email goes into the notes); rental,
// tax-exempt and credit standing carry over if either had them. The source
// is retired — deactivated and tagged merged_into_customer_id, with its
// balance zeroed so it isn't counted twice — not deleted, so anything that
// still names it keeps resolving. One write transaction: all or nothing.
async function mergeCustomers(sourceId, targetId, employeeId = null) {
  const { rows: [source] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [sourceId] });
  const { rows: [target] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [targetId] });
  if (!source) throw new Error('Customer to merge not found');
  if (!target) throw new Error('Customer to keep not found');
  if (source.id === target.id) throw new Error('Cannot merge a customer into itself');
  if (source.merged_into_customer_id) throw new Error(`${fullName(source)} has already been merged into another customer`);
  if (target.merged_into_customer_id || !target.active) throw new Error(`${fullName(target)} isn't an active customer — keep a different one`);

  const updates = {};
  for (const f of FILL_IF_BLANK) if (blank(target[f]) && !blank(source[f])) updates[f] = source[f];
  // Cards are one per customer — the survivor takes the source's if it has none.
  if (!target.discount_card_type_id && source.discount_card_type_id) Object.assign(updates, { discount_card_type_id: source.discount_card_type_id, discount_card_number: source.discount_card_number });
  if (!target.cash_back_card_type_id && source.cash_back_card_type_id) Object.assign(updates, { cash_back_card_type_id: source.cash_back_card_type_id, cash_back_card_number: source.cash_back_card_number });
  // Keep both phone numbers unless the source's is already one of the target's.
  const targetKeys = phoneKeys(target.phone);
  if (blank(target.phone)) updates.phone = source.phone;
  else if (!blank(source.phone) && phoneKeys(source.phone).some(k => !targetKeys.includes(k))) updates.phone = `${target.phone} / ${source.phone}`;
  if (source.is_rental_customer) updates.is_rental_customer = 1;
  if (source.rental_preapproved && !target.rental_preapproved) Object.assign(updates, { rental_preapproved: 1, rental_preapproved_by: source.rental_preapproved_by, rental_preapproved_at: source.rental_preapproved_at });
  if (source.tax_exempt) updates.tax_exempt = 1;
  if (source.customer_type === 'credit' && target.customer_type !== 'credit') {
    Object.assign(updates, { customer_type: 'credit', credit_enabled: 1, credit_limit: source.credit_limit || 0, credit_terms_days: source.credit_terms_days || 30 });
  } else if (source.customer_type === 'credit') {
    updates.credit_limit = Math.max(target.credit_limit || 0, source.credit_limit || 0);
  }
  const noteLines = [`Merged in ${source.customer_number} (${fullName(source)}) on ${new Date().toISOString().slice(0, 10)}.`];
  if (!blank(source.email) && !blank(target.email) && String(source.email).trim().toLowerCase() !== String(target.email).trim().toLowerCase()) noteLines.push(`Other email: ${source.email}`);
  if (!blank(source.notes)) noteLines.push(source.notes);
  updates.notes = [target.notes, noteLines.join(' ')].filter(v => !blank(v)).join('\n');

  const tx = await db.transaction('write');
  let committed = false;
  try {
    for (const table of REPOINT_TABLES) {
      await tx.execute({ sql: `UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`, args: [targetId, sourceId] });
    }
    // WooCommerce customer link — keep the target's if it already has one.
    const { rows: [wooTarget] } = await tx.execute({ sql: "SELECT id FROM woo_sync_map WHERE entity_type = 'customer' AND local_id = ?", args: [targetId] });
    await tx.execute({ sql: wooTarget ? "DELETE FROM woo_sync_map WHERE entity_type = 'customer' AND local_id = ?" : "UPDATE woo_sync_map SET local_id = ? WHERE entity_type = 'customer' AND local_id = ?", args: wooTarget ? [sourceId] : [targetId, sourceId] });
    await tx.execute({ sql: 'DELETE FROM customer_phone_keys WHERE customer_id = ?', args: [sourceId] });

    const cols = Object.keys(updates);
    await tx.execute({
      sql: `UPDATE customers SET ${cols.map(c => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}account_balance = account_balance + ?, loyalty_points = COALESCE(loyalty_points, 0) + ?, total_spent = COALESCE(total_spent, 0) + ? WHERE id = ?`,
      args: [...cols.map(c => updates[c]), source.account_balance || 0, source.loyalty_points || 0, source.total_spent || 0, targetId],
    });
    await tx.execute({
      sql: `UPDATE customers SET active = 0, merged_into_customer_id = ?, merged_at = CURRENT_TIMESTAMP, merged_by = ?, account_balance = 0, loyalty_points = 0,
            discount_card_number = CASE WHEN ? THEN NULL ELSE discount_card_number END, cash_back_card_number = CASE WHEN ? THEN NULL ELSE cash_back_card_number END WHERE id = ?`,
      args: [targetId, employeeId, 'discount_card_number' in updates ? 1 : 0, 'cash_back_card_number' in updates ? 1 : 0, sourceId],
    });
    await tx.commit();
    committed = true;
  } catch (e) {
    // Never roll back after a commit — that throws and crashes the process.
    if (!committed) await tx.rollback();
    throw e;
  }

  const { rows: [merged] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [targetId] });
  await syncPhoneKeys(db, targetId, merged.phone);
  try { await require('../routes/customers').runCreditCheck(targetId); } catch (e) {}
  return merged;
}

module.exports = { mergeCustomers, mergePreview, REPOINT_TABLES };
