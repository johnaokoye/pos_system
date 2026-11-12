// Consignment Phase 5 — end-to-end demonstration on the demo server (:3201).
// Each person acts through the API with their own login and security group.
// Month-end can't be waited for, so each physical step runs and then its
// timestamps are moved back to the step's demo date (shiftStep) — the same
// thing the automated tests do. Approvals, invoice matching and payment
// happen "today", as they would after month-end.
// Writes <tmp>/pos-consignment-demo/results.json (steps, checks, figures).
// Only ever against the demo server: it edits the demo database's dates.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@libsql/client');
const DIR = path.join(os.tmpdir(), 'pos-consignment-demo');

const BASE = 'http://localhost:3201';
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const out = { steps: [], checks: [], figures: {}, people: {} };
const db = createClient({ url: `file:${path.join(DIR, 'demo.db')}` });

const step = (date, who, what, detail = '') => { out.steps.push({ date, who, what, detail }); console.log(`[${date}] ${who}: ${what}${detail ? ` — ${detail}` : ''}`); };
const check = (name, pass, detail = '') => { out.checks.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const r2 = n => Math.round(Number(n) * 100) / 100;

class Person {
  constructor(label) { this.label = label; }
  async login(username, password) {
    const res = await fetch(`${BASE}/api/employees/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!res.ok) throw new Error(`${this.label} login: ${await res.text()}`);
    this.cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    this.me = await res.json();
    return this;
  }
  async api(method, url, body, retry = 2) {
    try { return await this.call(method, url, body); }
    catch (e) { if (retry > 0 && /SQLITE_BUSY/.test(e.message)) { await new Promise(r => setTimeout(r, 1500)); return this.api(method, url, body, retry - 1); } throw e; }
  }
  async call(method, url, body) {
    const res = await fetch(`${BASE}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) { const e = new Error(`${this.label} ${method} ${url}: ${data?.error || text}`); e.status = res.status; e.apiError = data?.error || text; throw e; }
    return data;
  }
  async refused(method, url, body) { try { await this.api(method, url, body); return null; } catch (e) { return e.apiError; } }
}

// Moves everything stamped today (this step's records and changes) to the
// step's demo date. Sessions and the month-end documents keep their real times.
const KEEP = new Set(['sessions', 'api_keys', 'consignment_reconciliations', 'consignment_reconciliation_lines', 'consignment_reconciliation_log',
  'consignment_settlements', 'consignment_settlement_lines', 'consignment_settlement_log', 'consignment_invoices', 'consignment_invoice_lines', 'sqlite_sequence']);
let today;
async function shiftStep(day, time = '15:00:00') {
  const { rows: tables } = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  let n = 0;
  for (const { name } of tables) {
    if (KEEP.has(name)) continue;
    const { rows: cols } = await db.execute(`PRAGMA table_info("${name}")`);
    for (const c of cols) {
      if (!/(_at|_on|^posting_date|^date)$/.test(c.name)) continue;
      const r = await db.execute({ sql: `UPDATE "${name}" SET "${c.name}" = CASE WHEN length("${c.name}") = 10 THEN ? ELSE ? END WHERE "${c.name}" >= ?`, args: [day, `${day} ${time}`, today] });
      n += r.rowsAffected;
    }
  }
  await new Promise(r => setTimeout(r, 1500));
  return n;
}
async function stockOf(productId) {
  const { rows } = await db.execute({ sql: 'SELECT b.name, bi.stock_qty FROM branch_inventory bi JOIN branches b ON b.id = bi.branch_id WHERE bi.product_id = ? ORDER BY b.id', args: [productId] });
  return Object.fromEntries(rows.map(r => [r.name, Number(r.stock_qty)]));
}

(async () => {
  await db.execute('PRAGMA busy_timeout = 10000');
  const { rows: [t] } = await db.execute("SELECT min(date('now'), date('now', '-5 hours')) AS d");
  today = t.d;
  const admin = await new Person('Administrator').login('admin', '123456');

  // ── Setup: branches, people with their own roles, Books' bank account ──
  const main = (await admin.api('GET', '/branches')).find(b => b.name === 'Main Store');
  const dc = await admin.api('POST', '/branches', { name: 'Distribution Centre (Warehouse)', city: 'Kingston' });
  out.figures.branches = { store: main.name, dc: dc.name };
  const groups = {
    Purchasing: { consignment: true, consignment_agreements: true, suppliers: true },
    Warehouse: { consignment: true, consignment_receive: true, consignment_grn_approve: true, transfers: true, multi_branch_access: true },
    Cashier: { pos: true, pos_request_transfer: true, customers: true, transactions: true, multi_branch_access: true },
    'Store Manager': { returns_override: true, transactions: true },
    Finance: { consignment_finance: true, payables_approve: true },
    'Accounts Payable': { payables: true },
  };
  const people = {};
  for (const [role, permissions] of Object.entries(groups)) {
    const g = await admin.api('POST', '/security-groups', { name: `Demo ${role}`, permissions });
    const username = `demo.${role.toLowerCase().replace(/\s+/g, '')}`;
    const [first, last] = { Purchasing: ['Paula', 'Purchasing'], Warehouse: ['Wayne', 'Warehouse'], Cashier: ['Carla', 'Cashier'], 'Store Manager': ['Marcus', 'Manager'], Finance: ['Fiona', 'Finance'], 'Accounts Payable': ['Andre', 'Payables'] }[role];
    const pin = String(400000 + Object.keys(people).length * 11111);
    await admin.api('POST', '/employees', { first_name: first, last_name: last, username, pin, password: 'demo-123456', must_change_password: 0, security_group_id: g.id, default_branch_id: main.id, active: 1 });
    people[role] = await new Person(`${first} (${role})`).login(username, 'demo-123456');
    people[role].pin = pin;
    out.people[role] = { name: `${first} ${last}`, username, permissions: Object.keys(permissions) };
  }
  const { Purchasing: pur, Warehouse: wh, Cashier: cash, 'Store Manager': mgr, Finance: fin, 'Accounts Payable': ap } = people;
  const key = (await admin.api('POST', '/api-keys', { name: 'RetailPOS Books (demo)', scopes: ['payables:read', 'payables:write', 'consignment:read', 'consignment:write'] })).key;
  out.figures.books_key = key;
  await fetch(`${BASE}/api/payables/bank-accounts`, { method: 'PUT', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify([{ id: 501, name: 'Operating Account', bank_name: 'NCB', last4: '4321', currency: 'USD', gl_code: '1010', active: true }]) });
  const base = (await admin.api('GET', '/settings/currency')).base;
  if (base !== 'USD') await fetch(`${BASE}/api/payables/bank-accounts`, { method: 'PUT', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify([{ id: 501, name: 'Operating Account', bank_name: 'NCB', last4: '4321', currency: base, gl_code: '1010', active: true }]) });
  await admin.api('POST', '/consignment/go-live', { confirm: 'START' });

  // Items and suppliers (Purchasing's agreements; Finance sets the treatment and approves).
  const mk = (name, sku, price, cost) => admin.api('POST', '/products', { name, sku, price, cost, tax_rate: 15, stock_qty: 0, active: 1 });
  const drill = await mk('Cordless Drill 20V', 'DEMO-DRILL', 25000, 12000);
  const bits = await mk('Drill Bit Set 30pc', 'DEMO-BITS', 5500, 2500);
  const gloves = await mk('Safety Gloves (pair)', 'DEMO-GLOVE', 1500, 600);
  const s1 = await admin.api('POST', '/suppliers', { name: 'Caribbean Power Tools Ltd', payment_terms: 'Net 30' });
  const s2 = await admin.api('POST', '/suppliers', { name: 'Island Safety Supply Co', payment_terms: 'Net 15' });
  const a1 = await pur.api('POST', '/consignment/agreements', { supplier_id: s1.id, start_date: '2026-09-01', ownership_terms: "Supplier's until sold to the customer", payment_terms: 'Net 30', shortage_responsibility: 'supplier', items: [{ product_id: drill.id, cost: 12000 }, { product_id: bits.id, cost: 2500 }], submit: true });
  const a2 = await pur.api('POST', '/consignment/agreements', { supplier_id: s2.id, start_date: '2026-09-01', ownership_terms: "Supplier's until sold to the customer", payment_terms: 'Net 15', items: [{ product_id: gloves.id, cost: 600 }], submit: true });
  for (const a of [a1, a2]) {
    await fin.api('POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard rate on the full selling price' });
    await fin.api('POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  }
  step('2026-09-01', 'Paula (Purchasing)', `Agreements ${a1.agreement_number} (${s1.name}: drill 12,000, bit set 2,500) and ${a2.agreement_number} (${s2.name}: gloves 600)`, 'submitted to Finance');
  step('2026-09-01', 'Fiona (Finance)', 'Set revenue treatment (principal) and output GCT, then approved and signed both agreements');

  // Deliveries: to the Distribution Centre and to the store.
  const receive = async (agr, branch, items, dn) => {
    const o = await pur.api('POST', '/consignment/orders', { agreement_id: agr.id, branch_id: branch.id, items });
    const g = await wh.api('POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: dn, items: o.items.map(i => ({ order_item_id: i.id, quantity: i.quantity_ordered })) });
    await wh.api('POST', `/consignment/grns/${g.id}/approve`, {});
    return { o, g };
  };
  const d1 = await receive(a1, dc, [{ product_id: drill.id, quantity: 10 }, { product_id: bits.id, quantity: 10 }], 'CPT-DN-4471');
  const d2 = await receive(a1, main, [{ product_id: drill.id, quantity: 2 }, { product_id: bits.id, quantity: 6 }], 'CPT-DN-4472');
  const d3 = await receive(a2, main, [{ product_id: gloves.id, quantity: 20 }], 'ISS-DN-118');
  step('2026-09-01', 'Wayne (Warehouse)', `Received and approved ${d1.g.grn_number} at the Distribution Centre (10 drills, 10 bit sets), ${d2.g.grn_number} at Main Store (2 drills, 6 bit sets) and ${d3.g.grn_number} at Main Store (20 gloves)`, 'stock on hand, owned by the suppliers');
  await shiftStep('2026-09-01', '13:00:00');
  const lotsAfterGrn = (await admin.api('GET', `/consignment/lots?product_id=${drill.id}&branch_id=${dc.id}`));
  check('Received stock is the supplier\'s, not Total Tools\'', lotsAfterGrn.every(l => l.owner === 'consignment' && Number(l.supplier_id) === s1.id), `${lotsAfterGrn.length} receipt(s) at the DC, owner consignment / ${s1.name}`);

  // 15 Sep — a store sale with both suppliers' goods.
  const custB = await cash.api('POST', '/customers', { first_name: 'Brian', last_name: 'Contractor', phone: '8765550101' });
  const saleB = await cash.api('POST', '/transactions', { customer_id: custB.id, items: [{ product_id: bits.id, quantity: 3 }, { product_id: gloves.id, quantity: 4 }], branch_id: main.id, employee_id: cash.me.id, payment_method: 'card' });
  step('2026-09-15', 'Carla (Cashier)', `Sale ${saleB.transaction_number} at Main Store to Brian: 3 bit sets + 4 pairs of gloves`, 'paid by card');
  await shiftStep('2026-09-15');
  const allocB = await admin.api('GET', `/consignment/allocations?transaction_id=${saleB.id}`);
  check('Each line is allocated to its own supplier', allocB.find(a => a.product_id === bits.id)?.supplier_id === s1.id && allocB.find(a => a.product_id === gloves.id)?.supplier_id === s2.id,
    allocB.map(a => `${a.product_id === bits.id ? 'bit sets' : 'gloves'} → ${a.supplier_name || a.supplier_id} @ ${a.unit_cost}`).join('; '));

  // 29 Sep — a store sale short at the store: the rest comes from the DC.
  const custA = await cash.api('POST', '/customers', { first_name: 'Alicia', last_name: 'Builder', phone: '8765550102' });
  const saleA = await cash.api('POST', '/transactions', { customer_id: custA.id, items: [{ product_id: drill.id, quantity: 4, transfer_from_branch_id: dc.id, transfer_qty: 2 }], branch_id: main.id, employee_id: cash.me.id, payment_method: 'card' });
  const tr = (await admin.api('GET', '/transfers')).find(x => x.transaction_id === saleA.id);
  step('2026-09-29', 'Carla (Cashier)', `Sale ${saleA.transaction_number} at Main Store to Alicia: 4 drills — 2 from the store, 2 to come from the Distribution Centre (collect later)`, `transfer request ${tr.transfer_number} raised; 2 drills reserved at the DC`);
  const reserved = (await admin.api('GET', `/consignment/lots?product_id=${drill.id}&branch_id=${dc.id}`)).reduce((s, l) => s + Number(l.qty_reserved || 0), 0);
  check('The DC reserves the confirmed shortfall when the request is made (A5)', reserved === 2, `${reserved} drills reserved at the DC`);
  await wh.api('PATCH', `/transfers/${tr.id}/send`, {});
  await wh.api('PATCH', `/transfers/${tr.id}/dispatch`, { driver_name: 'Devon (driver)' });
  step('2026-09-29', 'Wayne (Warehouse)', `Sent and dispatched ${tr.transfer_number} — 2 drills on the truck before month-end`);
  await shiftStep('2026-09-29');

  // 2 Oct — the drills arrive after the cut-off; the customer collects.
  const td = await admin.api('GET', `/transfers/${tr.id}`);
  await cash.api('PATCH', `/transfers/${tr.id}/receive`, { delivered_by_name: 'Devon (driver)', items: td.items.map(i => ({ item_id: i.id, quantity_received: i.quantity_requested })) }).catch(async e => {
    await wh.api('PATCH', `/transfers/${tr.id}/receive`, { delivered_by_name: 'Devon (driver)', items: td.items.map(i => ({ item_id: i.id, quantity_received: i.quantity_requested })) });
  });
  await cash.api('PATCH', `/transactions/${saleA.id}/collected`, {});
  step('2026-10-02', 'Main Store', `Received ${tr.transfer_number} (2 drills) from the driver; Alicia collected her order`, 'the 2 drills became hers on arrival');
  await shiftStep('2026-10-02');

  // ── September month-end ──
  const counted = async (rec) => {
    for (const l of rec.lines.filter(x => x.line_type === 'stock')) rec = await wh.api('PATCH', `/consignment/reconciliations/${rec.id}/lines/${l.id}`, { physical_count: l.expected_closing });
    return rec;
  };
  let recS1 = await wh.api('POST', '/consignment/reconciliations', { agreement_id: a1.id, period: '2026-09' });
  recS1 = await counted(recS1);
  const transit = recS1.lines.find(l => l.line_type === 'in_transit' && l.product_id === drill.id);
  check('Drills dispatched before month-end and received after show as In Transit at the cut-off (A6)', Number(transit?.in_transit) === 2, `in transit: ${transit?.in_transit ?? 0} drills`);
  const recS2 = await counted(await wh.api('POST', '/consignment/reconciliations', { agreement_id: a2.id, period: '2026-09' }));
  recS1 = await fin.api('POST', `/consignment/reconciliations/${recS1.id}/approve`, { signature: SIG });
  const recS2a = await fin.api('POST', `/consignment/reconciliations/${recS2.id}/approve`, { signature: SIG });
  step('Oct (month-end)', 'Wayne (Warehouse) / Fiona (Finance)', `September counts entered; Finance approved and locked ${recS1.recon_number} and ${recS2a.recon_number}`, `settlements ${recS1.settlement?.settlement_number} and ${recS2a.settlement?.settlement_number} made`);
  out.figures.sep_recon = { number: recS1.recon_number, totals: recS1.totals, lines: recS1.lines.map(l => ({ type: l.line_type, branch: l.branch_name, item: l.product_name, opening: l.opening, receipts: l.receipts, transfers_out: l.transfers_out, transfers_in: l.transfers_in, sales: l.sales, expected: l.expected_closing, counted: l.physical_count, in_transit: l.in_transit, billable_qty: l.billable_qty, billable_value: l.billable_value })) };
  const transitLot = (await admin.api('GET', `/consignment/lots?product_id=${drill.id}&branch_id=${main.id}`));
  check('The drills that arrived stayed the supplier\'s until they were the customer\'s', (await admin.api('GET', `/consignment/allocations?transaction_id=${saleA.id}`)).every(a => a.owner === 'consignment' && Number(a.supplier_id) === s1.id), `all 4 drills on ${saleA.transaction_number} allocated to ${s1.name}`);
  let stS1 = await ap.api('GET', `/consignment/settlements/${recS1.settlement.id}`);
  out.figures.sep_settlement = { number: stS1.settlement_number, subtotal: stS1.subtotal, tax: stS1.expected_tax, total: stS1.total, lines: stS1.lines.map(l => ({ item: l.product_name, qty: l.billable_qty, unit: l.unit_cost, value: l.billable_value })) };
  check('September settlement bills only what qualified in September (2 drills sold from the store, 3 bit sets)', r2(stS1.subtotal) === 24000 + 7500, `${stS1.settlement_number}: subtotal ${stS1.subtotal}, GCT ${stS1.expected_tax}, total ${stS1.total}`);

  // 10 Oct — a partial return of the locked September sale.
  const itemsB = (await cash.api('GET', `/transactions/${saleB.id}`)).items;
  const ret = await cash.api('POST', `/transactions/${saleB.id}/return`, { items: [{ transaction_item_id: itemsB.find(i => i.product_id === bits.id).id, quantity: 1 }], resolution: 'refund', refund_method: 'card', notes: 'One set not needed', goods_condition: 'good', override_pin: mgr.pin });
  step('2026-10-10', 'Carla (Cashier), Marcus (Manager) PIN', `Brian returned 1 of the 3 bit sets from ${saleB.transaction_number} (goods in good condition) — return ${ret.return_number || ''}`, 'refunded to card; the set went back on the supplier\'s receipt');
  await shiftStep('2026-10-10');
  const sepAfter = await fin.api('GET', `/consignment/reconciliations/${recS1.id}`);
  check('The locked September figures did not change (A3)', r2(sepAfter.totals.billable_value) === r2(recS1.totals.billable_value), `September billable still ${sepAfter.totals.billable_value}`);

  // ── October month-end ──
  let recO1 = await counted(await wh.api('POST', '/consignment/reconciliations', { agreement_id: a1.id, period: '2026-10' }));
  recO1 = await fin.api('POST', `/consignment/reconciliations/${recO1.id}/approve`, { signature: SIG });
  const recO2 = await counted(await wh.api('POST', '/consignment/reconciliations', { agreement_id: a2.id, period: '2026-10' }));
  const recO2a = await fin.api('POST', `/consignment/reconciliations/${recO2.id}/approve`, { signature: SIG });
  step('Nov (month-end)', 'Wayne (Warehouse) / Fiona (Finance)', `October counts entered; Finance approved ${recO1.recon_number} and ${recO2a.recon_number}`, `settlement ${recO1.settlement?.settlement_number}; ${s2.name} owed nothing for October`);
  const stO1 = await ap.api('GET', `/consignment/settlements/${recO1.settlement.id}`);
  const adj = stO1.adjustments[0];
  out.figures.oct_settlement = { number: stO1.settlement_number, subtotal: stO1.subtotal, tax: stO1.expected_tax, total: stO1.total, lines: stO1.lines.map(l => ({ item: l.product_name, qty: l.billable_qty, unit: l.unit_cost, value: l.billable_value })), adjustments: stO1.adjustments };
  check('The return is credited to the original supplier in the next settlement, referencing the original sale', adj && adj.sale_number === saleB.transaction_number && adj.product_id === bits.id && r2(adj.value) === 2500 && stO1.supplier_id === s1.id,
    adj ? `${stO1.settlement_number} (${stO1.supplier_name}): ${adj.return_number} of sale ${adj.sale_number} (${String(adj.sale_qualified_on).slice(0, 7)}) — credit ${adj.value}` : 'no adjustment');
  check('The drills that arrived in October are billed in October, at the cost on the day they arrived', stO1.lines.some(l => l.product_id === drill.id && Number(l.billable_qty) === 2 && r2(l.billable_value) === 24000), `${stO1.settlement_number}: drills 2 × 12,000`);
  check('The other supplier is not credited or charged for it', !recO2a.settlement && r2(recO2a.totals.billable_value) === 0, `${s2.name}: October billable ${recO2a.totals.billable_value}`);

  // Stock snapshot before anything financial happens.
  const before = { drill: await stockOf(drill.id), bits: await stockOf(bits.id), gloves: await stockOf(gloves.id) };
  const movesBefore = Number((await db.execute('SELECT COUNT(*) AS n FROM stock_lot_moves')).rows[0].n) + Number((await db.execute('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n);

  // ── September invoice: matched, billed once, paid through a payment request ──
  const sepInvoice = { supplier_invoice_number: 'CPT-INV-20926', invoice_date: '2026-10-05', supplier_trn: '001-234-567', tax_invoice: true,
    lines: stS1.lines.map(l => ({ product_id: l.product_id, qty: l.billable_qty, unit_cost: l.unit_cost, tax_amount: l.expected_tax })) };
  stS1 = await ap.api('POST', `/consignment/settlements/${stS1.id}/invoice`, sepInvoice);
  check('The supplier invoice matches the approved settlement line by line', stS1.invoice.status === 'matched' && stS1.invoice.lines.every(l => !l.flagged), `${sepInvoice.supplier_invoice_number}: ${stS1.invoice.lines.length} lines, no differences, total ${stS1.invoice.total}`);
  stS1 = await ap.api('POST', `/consignment/settlements/${stS1.id}/invoice/accept`, {});
  const bill = await ap.api('GET', `/payables/bills/${stS1.bill_id}`);
  step('Nov', 'Andre (A/P)', `Entered ${s1.name}'s invoice ${sepInvoice.supplier_invoice_number} against ${stS1.settlement_number}: it matched; accepted it`, `A/P bill ${bill.bill_number} for ${bill.amount} (GCT ${bill.tax_amount})`);
  const again = await ap.refused('POST', `/consignment/settlements/${stS1.id}/invoice/accept`, {});
  const dupOther = await ap.refused('POST', `/consignment/settlements/${stO1.id}/invoice`, { ...sepInvoice, lines: [] });
  const dupBill = await ap.refused('POST', '/payables/bills', { supplier_id: s1.id, vendor_invoice_number: sepInvoice.supplier_invoice_number, bill_date: '2026-10-05', amount: bill.amount, tax_amount: bill.tax_amount });
  check('The invoice can only be billed once', again && dupOther && dupBill, `accept again: "${again}"; same invoice # on October: "${dupOther}"; same invoice # as a manual bill: "${dupBill}"`);
  const bills = (await ap.api('GET', `/payables/bills?supplier_id=${s1.id}&status=all`)).filter(b => b.vendor_invoice_number === sepInvoice.supplier_invoice_number && b.status !== 'void');
  check('One A/P bill for the invoice', bills.length === 1, `${bills.length} bill(s) carry ${sepInvoice.supplier_invoice_number}`);

  const banks = await ap.api('GET', '/payables/payment-requests/bank-accounts');
  const prq = await ap.api('POST', '/payables/payment-requests', { supplier_id: s1.id, request_type: 'invoice', required_date: '2026-11-20', submit: true, lines: [{ bill_id: bill.id, amount: bill.amount }] });
  step('Nov', 'Andre (A/P)', `Raised payment request ${prq.request_number} for ${bill.bill_number}`, `${prq.amount}, requested for 20 Nov`);
  const selfApprove = await ap.refused('POST', `/payables/payment-requests/${prq.id}/approve`, { scheduled_date: '2026-11-20', signature: SIG });
  await fin.api('POST', `/payables/payment-requests/${prq.id}/approve`, { scheduled_date: '2026-11-20', signature: SIG });
  step('Nov', 'Fiona (Finance)', `Approved ${prq.request_number} and scheduled it for 20 Nov`, selfApprove ? 'A/P could not approve it themselves' : '');
  const paid = await ap.api('POST', `/payables/payment-requests/${prq.id}/pay`, { payment_date: '2026-11-20', method: 'bank_transfer', reference: 'NCB-TRF-88812', bank_account_id: banks[0]?.id });
  const billAfter = await ap.api('GET', `/payables/bills/${bill.id}`);
  step('20 Nov', 'Andre (A/P)', `Processed the payment from ${banks[0]?.name || 'the bank'} — ${paid.payment_number || 'payment'} by bank transfer NCB-TRF-88812`, `bill ${bill.bill_number} balance ${billAfter.balance}`);
  check('Paid through a payment request: approved by someone else, bill cleared', billAfter.balance === 0 && (await ap.api('GET', `/payables/payment-requests/${prq.id}`)).status === 'paid', `request ${prq.request_number} paid; bill balance ${billAfter.balance}`);

  // October: drills less the returned bit set.
  const octInvoice = { supplier_invoice_number: 'CPT-INV-21031', invoice_date: '2026-11-04', supplier_trn: '001-234-567', tax_invoice: true,
    lines: stO1.lines.map(l => ({ product_id: l.product_id, qty: l.billable_qty, unit_cost: l.unit_cost, tax_amount: l.expected_tax })) };
  let stO = await ap.api('POST', `/consignment/settlements/${stO1.id}/invoice`, octInvoice);
  stO = await ap.api('POST', `/consignment/settlements/${stO1.id}/invoice/accept`, {});
  const billO = await ap.api('GET', `/payables/bills/${stO.bill_id}`);
  step('Nov', 'Andre (A/P)', `Matched ${octInvoice.supplier_invoice_number} to ${stO.settlement_number} (2 drills, less the returned bit set) and accepted it`, `A/P bill ${billO.bill_number} for ${billO.amount} — awaiting its payment request`);

  // Stock: unchanged by everything financial; matches the physical movements.
  const after = { drill: await stockOf(drill.id), bits: await stockOf(bits.id), gloves: await stockOf(gloves.id) };
  const movesAfter = Number((await db.execute('SELECT COUNT(*) AS n FROM stock_lot_moves')).rows[0].n) + Number((await db.execute('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n);
  check('Invoices, bills and payment did not change stock', JSON.stringify(before) === JSON.stringify(after) && movesBefore === movesAfter, `${movesAfter - movesBefore} stock movements during invoicing and payment`);
  const expected = { drill: { 'Main Store': 0, [dc.name]: 8 }, bits: { 'Main Store': 4, [dc.name]: 10 }, gloves: { 'Main Store': 16 } };
  const ok = Object.entries(expected).every(([k, v]) => Object.entries(v).every(([b, q]) => after[k][b] === q));
  check('Stock on hand is what the physical movements say', ok, `drills: store ${after.drill['Main Store']}, DC ${after.drill[dc.name]}; bit sets: store ${after.bits['Main Store']}, DC ${after.bits[dc.name]}; gloves: store ${after.gloves['Main Store']}`);
  out.figures.stock = after;
  const lotCheck = await admin.api('GET', '/consignment/lot-check');
  check('Every branch\'s stock equals its dated receipts', lotCheck.mismatches.length === 0, `${lotCheck.mismatches.length} mismatches`);

  // What RetailPOS Books will post.
  const feed = await (await fetch(`${BASE}/api/consignment/postings-feed`, { headers: { 'X-API-Key': key } })).json();
  out.figures.postings = feed.map(p => ({ key: p.external_id, date: p.date, debit: p.debit_role, credit: p.credit_role, amount: p.amount, ref: p.reference, supplier: p.supplier_name, memo: p.memo }));
  const sumFor = sup => r2(feed.filter(p => p.supplier_name === sup).reduce((s, p) => s + (p.credit_role === 'obligation' ? 1 : -1) * Number(p.amount), 0));
  check('The obligation accrued per supplier equals what their settlements billed', sumFor(s1.name) === r2(stS1.subtotal + stO.subtotal) && sumFor(s2.name) === r2(recS2a.totals.billable_value),
    `${s1.name}: accrued ${sumFor(s1.name)} vs settled ${r2(stS1.subtotal + stO.subtotal)}; ${s2.name}: accrued ${sumFor(s2.name)} vs settled ${recS2a.totals.billable_value}`);
  out.figures.bills = [{ number: bill.bill_number, invoice: sepInvoice.supplier_invoice_number, amount: bill.amount, tax: bill.tax_amount, obligation: bill.obligation_amount, variance: bill.variance_amount, paid: true },
    { number: billO.bill_number, invoice: octInvoice.supplier_invoice_number, amount: billO.amount, tax: billO.tax_amount, obligation: billO.obligation_amount, variance: billO.variance_amount, paid: false }];
  out.figures.supplier2_sep = { number: recS2a.settlement?.settlement_number, total: recS2a.settlement?.total };
  out.figures.ids = { s1: s1.id, s2: s2.id, drill: drill.id, bits: bits.id, gloves: gloves.id, dc: dc.id, main: main.id, stS1: stS1.id, stO1: stO1.id, recS1: recS1.id, recO1: recO1.id };
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(out, null, 2));
  console.log(`\n${out.checks.filter(c => c.pass).length}/${out.checks.length} checks passed`);
})().catch(e => { console.error('DEMO STOPPED:', e.message); fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify({ ...out, error: e.message }, null, 2)); process.exit(1); });
