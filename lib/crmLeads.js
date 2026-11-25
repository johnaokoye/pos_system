// CRM leads ↔ customers, and the website's rental request form on a lead.
//
// A lead from the website is tied to the customer it's from when that's known
// (`crm_leads.customer_id`, not "converted" — the lead stays open until won or
// lost): the signed-in customer the website sends, else the single active
// customer the lead's email or phone belongs to. `request_json` is the
// request's structured form (items, branch, dates, fulfilment) that Create
// Quote on the lead fills the quote form from.
const { db } = require('../database');

// The live customer behind an id: follows merges (merged_into_customer_id) to
// the kept record; null when there's none or it's been deactivated.
async function liveCustomer(id) {
  let c = null;
  for (let hops = 0, cid = Number(id); cid && hops < 6; hops++) {
    ({ rows: [c] } = await db.execute({ sql: 'SELECT id, customer_number, first_name, last_name, email, phone, active, merged_into_customer_id FROM customers WHERE id = ?', args: [cid] }));
    if (!c || !c.merged_into_customer_id) break;
    cid = c.merged_into_customer_id;
  }
  return c && c.active && !c.merged_into_customer_id ? c : null;
}

// Several email/phone matches = left for staff to pick (the lead view lists them).
async function leadCustomerId({ customer_id, email, phone }) {
  if (customer_id) {
    const c = await liveCustomer(customer_id);
    if (c) return c.id;
  }
  if (!email && !phone) return null;
  const { findDuplicateCustomers, isHardDuplicate } = require('../routes/customers');
  const hard = (await findDuplicateCustomers({ email, phone })).filter(isHardDuplicate);
  return hard.length === 1 ? hard[0].id : null;
}

// Reads a request back out of the notes the website has always written
// ("[Website Rental Request]", "Requested period: …", "Item: NAME (SKU: X)" +
// "Quantity: n", or numbered "1. NAME (SKU: X) × n", "… (branch #id)",
// "Fulfilment: DELIVERY … to ADDRESS, PARISH (fee to be quoted)") — for leads
// made before the website sent `request`. Products are matched by rental SKU.
async function requestFromNotes(notes) {
  const text = String(notes || '');
  if (!text.startsWith('[Website Rental Request')) return null;
  const lines = text.split('\n');
  const period = text.match(/Requested period: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
  const items = [];
  let current = null;
  for (const line of lines) {
    let m = line.match(/^(?:Item: |\d+\. )(.+?) \(SKU: ([^)]+)\)(?: × (\d+))?\s*$/);
    if (m) {
      current = { name: m[1], sku: m[2], quantity: m[3] ? Number(m[3]) : 1, branch_id: null, branch_name: null };
      items.push(current);
      continue;
    }
    if (!current) continue;
    m = line.match(/^Quantity: (\d+)/);
    if (m) { current.quantity = Number(m[1]); continue; }
    m = line.match(/^\s*(?:Preferred location|From): (.+?) \(branch #(\d+)\)/);
    if (m) { current.branch_name = m[1]; current.branch_id = Number(m[2]); }
  }
  if (!items.length) return null;
  for (const it of items) {
    const { rows: [p] } = await db.execute({ sql: 'SELECT id FROM products WHERE sku = ? AND is_rental = 1', args: [it.sku] });
    it.product_id = p ? p.id : null;
    it.accessory_ids = [];
  }
  const delivery = text.match(/Fulfilment: DELIVERY (?:from .+? )?to (.+), ([^,(]+?) \(fee to be quoted\)/);
  const message = text.match(/Customer message: ([\s\S]*)$/);
  return {
    start_date: period ? period[1] : null,
    end_date: period ? period[2] : null,
    fulfilment: delivery ? 'delivery' : 'pickup',
    delivery_address: delivery ? delivery[1] : null,
    delivery_parish: delivery ? delivery[2].trim() : null,
    message: message ? message[1].trim().slice(0, 1000) : null,
    items: items.filter(i => i.product_id),
    from_notes: true,
  };
}

// One-time startup pass (setting crm_leads_website_backfill): website leads
// from before the website linked customers / sent the request form get both,
// from their notes ("Customer account: #N" — followed through merges — else
// a single email/phone match).
async function backfillWebsiteLeads() {
  const { rows: [done] } = await db.execute("SELECT value FROM settings WHERE key = 'crm_leads_website_backfill'");
  if (done) return { skipped: true };
  const { rows } = await db.execute("SELECT id, email, phone, notes, customer_id, request_json FROM crm_leads WHERE source = 'website' AND (customer_id IS NULL OR request_json IS NULL)");
  let linked = 0, requests = 0;
  for (const l of rows) {
    let custId = l.customer_id;
    if (!custId) {
      const acct = String(l.notes || '').match(/Customer account: #(\d+)/);
      custId = await leadCustomerId({ customer_id: acct ? Number(acct[1]) : null, email: l.email, phone: l.phone });
      if (custId) linked++;
    }
    let requestJson = l.request_json;
    if (!requestJson) {
      const r = await requestFromNotes(l.notes);
      if (r && r.items.length) { requestJson = JSON.stringify(r); requests++; }
    }
    if (custId !== l.customer_id || requestJson !== l.request_json) {
      await db.execute({ sql: 'UPDATE crm_leads SET customer_id = ?, request_json = ? WHERE id = ?', args: [custId || null, requestJson || null, l.id] });
    }
  }
  await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('crm_leads_website_backfill', '1')");
  return { leads: rows.length, linked, requests };
}

module.exports = { liveCustomer, leadCustomerId, requestFromNotes, backfillWebsiteLeads };
