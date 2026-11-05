// Assigning customers to salespeople in bulk (Customers → Assign Salespeople).
// Every change, including one from the customer form, is logged by batch so a
// batch can be reviewed and undone.
const { db } = require('../database');

const CHUNK = 400;
const chunks = arr => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));
const LIST_CAP = 200;
const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const fullName = c => `${c.first_name || ''} ${c.last_name || ''}`.trim();

// Filters shared by the list on screen, "all matching" and the export.
function customerFilterWhere(filter = {}) {
  let where = 'active = 1';
  const args = [];
  const search = String(filter.search || '').trim();
  if (search) {
    where += ` AND (first_name LIKE ? OR last_name LIKE ? OR (first_name || ' ' || last_name) LIKE ? OR business_name LIKE ? OR email LIKE ? OR phone LIKE ? OR customer_number LIKE ?)`;
    args.push(...Array(7).fill(`%${search}%`));
  }
  if (filter.type === 'credit' || filter.type === 'cash') { where += ' AND customer_type = ?'; args.push(filter.type); }
  if (filter.category_id) { where += ' AND customer_category_id = ?'; args.push(Number(filter.category_id)); }
  if (filter.salesperson_id === 'none') where += ' AND salesperson_id IS NULL';
  else if (filter.salesperson_id) { where += ' AND salesperson_id = ?'; args.push(Number(filter.salesperson_id)); }
  return { where, args };
}

async function activeSalespeople() {
  const { rows } = await db.execute("SELECT id, first_name, last_name FROM employees WHERE active = 1 AND is_salesperson = 1");
  return rows;
}

// salesperson_id on a list or filter request: 'none' removes the assignment.
async function chosenSalesperson(value) {
  if (value === 'none') return null;
  const id = Number(value);
  if (!id || !(await activeSalespeople()).some(s => s.id === id)) throw Object.assign(new Error('Choose an active Salesperson, or None'), { status: 400 });
  return id;
}

// Spreadsheet rows ({ line, customer, salesperson }) → targets and problems.
// Customer is matched on number, then on a name only one active customer has.
// A blank Salesperson leaves that customer alone; "None" removes the assignment.
async function targetsFromRows(rows) {
  const people = await activeSalespeople();
  const personByName = new Map();
  for (const p of people) {
    const k = norm(fullName(p));
    personByName.set(k, personByName.has(k) ? 'ambiguous' : p.id);
  }
  const { rows: customers } = await db.execute("SELECT id, customer_number, first_name, last_name, business_name FROM customers WHERE active = 1");
  const byNumber = new Map(), byName = new Map();
  const addName = (k, id) => { if (!k) return; if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(id); };
  for (const c of customers) {
    if (c.customer_number) byNumber.set(norm(c.customer_number), c.id);
    addName(norm(fullName(c)), c.id);
    addName(norm(c.business_name), c.id);
  }

  const unmatched = [];
  const wanted = new Map();
  let blank = 0;
  for (const r of rows) {
    const line = r.line, ref = String(r.customer ?? '').trim(), sp = norm(r.salesperson);
    if (!ref && !sp) continue;
    if (!sp) { blank += 1; continue; }
    const key = norm(ref);
    let customerId = byNumber.get(key);
    if (!customerId) {
      const named = byName.get(key);
      if (!ref) { unmatched.push({ line, ref: '(blank)', reason: 'No customer on this row' }); continue; }
      if (!named) { unmatched.push({ line, ref, reason: 'No active customer has this number or name' }); continue; }
      if (named.size > 1) { unmatched.push({ line, ref, reason: `${named.size} customers have this name, so use the customer number` }); continue; }
      customerId = [...named][0];
    }
    let salespersonId;
    if (sp === 'none') salespersonId = null;
    else {
      salespersonId = personByName.get(sp);
      if (salespersonId === 'ambiguous') { unmatched.push({ line, ref, reason: `More than one Salesperson is called ${String(r.salesperson).trim()}` }); continue; }
      if (!salespersonId) { unmatched.push({ line, ref, reason: `${String(r.salesperson).trim()} isn't an active Salesperson` }); continue; }
    }
    const earlier = wanted.get(customerId);
    if (earlier && earlier.salespersonId !== salespersonId) {
      earlier.conflict = true;
      unmatched.push({ line, ref, reason: 'This customer is on another row with a different salesperson, so neither row was used' });
      continue;
    }
    wanted.set(customerId, { salespersonId, conflict: earlier?.conflict || false });
  }
  const targets = [];
  for (const [id, w] of wanted) if (!w.conflict) targets.push({ id, salespersonId: w.salespersonId });
  return { targets, unmatched, blank };
}

// What a request would do, from its customer_ids, filter or rows.
async function buildPlan(body) {
  let targets, unmatched = [], blank = 0;
  if (Array.isArray(body.rows)) {
    ({ targets, unmatched, blank } = await targetsFromRows(body.rows));
  } else {
    const salespersonId = await chosenSalesperson(body.salesperson_id);
    let ids;
    if (body.filter) {
      const { where, args } = customerFilterWhere(body.filter);
      ids = (await db.execute({ sql: `SELECT id FROM customers WHERE ${where}`, args })).rows.map(r => r.id);
    } else if (Array.isArray(body.customer_ids) && body.customer_ids.length) {
      ids = [...new Set(body.customer_ids.map(Number).filter(Number.isInteger))];
    } else {
      throw Object.assign(new Error('Choose at least one customer'), { status: 400 });
    }
    targets = ids.map(id => ({ id, salespersonId }));
  }

  const customers = new Map();
  for (const part of chunks(targets.map(t => t.id))) {
    const { rows } = await db.execute({ sql: `SELECT id, customer_number, first_name, last_name, salesperson_id FROM customers WHERE active = 1 AND id IN (${part.map(() => '?').join(',')})`, args: part });
    for (const c of rows) customers.set(c.id, c);
  }
  const { rows: staff } = await db.execute('SELECT id, first_name, last_name FROM employees');
  const nameOf = new Map(staff.map(e => [e.id, fullName(e)]));
  const plan = { assign: [], move: [], remove: [], kept: [], unchanged: 0 };
  for (const t of targets) {
    const c = customers.get(t.id);
    if (!c) continue;
    const from = c.salesperson_id ?? null, to = t.salespersonId;
    if (from === to) { plan.unchanged += 1; continue; }
    const entry = { customer_id: c.id, number: c.customer_number, name: fullName(c), from, to, from_name: nameOf.get(from) || null, to_name: nameOf.get(to) || null };
    if (to === null) plan.remove.push(entry);
    else if (from === null) plan.assign.push(entry);
    else if (body.replace) plan.move.push(entry);
    else plan.kept.push(entry);
  }
  return { plan, unmatched, blank };
}

const planSummary = ({ plan, unmatched, blank }) => ({
  assign: plan.assign.length, move: plan.move.length, remove: plan.remove.length, kept: plan.kept.length, unchanged: plan.unchanged,
  blank, unmatched_count: unmatched.length, changes: plan.assign.length + plan.move.length + plan.remove.length,
  lists: { assign: plan.assign.slice(0, LIST_CAP), move: plan.move.slice(0, LIST_CAP), remove: plan.remove.slice(0, LIST_CAP), kept: plan.kept.slice(0, LIST_CAP) },
  unmatched: unmatched.slice(0, LIST_CAP),
});

async function writeChanges(source, fileName, employeeId, changes) {
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const r = await tx.execute({ sql: 'INSERT INTO customer_salesperson_batches (source, file_name, employee_id, change_count) VALUES (?,?,?,?)', args: [source, fileName || null, employeeId || null, changes.length] });
    const batchId = Number(r.lastInsertRowid);
    for (const part of chunks(changes)) {
      await tx.batch([
        { sql: `INSERT INTO customer_salesperson_changes (batch_id, customer_id, old_salesperson_id, new_salesperson_id) VALUES ${part.map(() => '(?,?,?,?)').join(',')}`, args: part.flatMap(c => [batchId, c.customer_id, c.from, c.to]) },
        ...part.map(c => ({ sql: 'UPDATE customers SET salesperson_id = ? WHERE id = ?', args: [c.to, c.customer_id] })),
      ]);
    }
    await tx.commit();
    committed = true;
    return batchId;
  } catch (e) {
    if (!committed) await tx.rollback();
    throw e;
  }
}

async function applyPlan(body, employeeId) {
  const built = await buildPlan(body);
  const changes = [...built.plan.assign, ...built.plan.move, ...built.plan.remove];
  // The list can move between the review and the confirm.
  if (body.expected_changes != null && Number(body.expected_changes) !== changes.length) {
    throw Object.assign(new Error('The customers changed since you reviewed this. Review it again.'), { status: 409 });
  }
  if (!changes.length) throw Object.assign(new Error('There is nothing to change'), { status: 400 });
  const batchId = await writeChanges(Array.isArray(body.rows) ? 'file' : 'list', body.file_name, employeeId, changes);
  return { batch_id: batchId, changes: changes.length, ...planSummary(built) };
}

// A single change from the customer form.
async function setCustomerSalesperson(customerId, from, to, employeeId) {
  return writeChanges('form', null, employeeId, [{ customer_id: Number(customerId), from, to }]);
}

// Puts a batch's customers back, except any that have been changed again since.
async function undoBatch(batchId, employeeId) {
  const { rows: [batch] } = await db.execute({ sql: 'SELECT * FROM customer_salesperson_batches WHERE id = ?', args: [batchId] });
  if (!batch) throw Object.assign(new Error('Not found'), { status: 404 });
  if (batch.undone_at) throw Object.assign(new Error('This batch has already been undone'), { status: 400 });
  const { rows } = await db.execute({ sql: `SELECT ch.customer_id, ch.old_salesperson_id, c.salesperson_id AS current FROM customer_salesperson_changes ch JOIN customers c ON c.id = ch.customer_id WHERE ch.batch_id = ? AND COALESCE(c.salesperson_id, 0) = COALESCE(ch.new_salesperson_id, 0)`, args: [batchId] });
  const tx = await db.transaction('write');
  let committed = false;
  try {
    for (const part of chunks(rows)) await tx.batch(part.map(r => ({ sql: 'UPDATE customers SET salesperson_id = ? WHERE id = ?', args: [r.old_salesperson_id, r.customer_id] })));
    await tx.execute({ sql: 'UPDATE customer_salesperson_batches SET undone_at = CURRENT_TIMESTAMP, undone_by = ? WHERE id = ?', args: [employeeId || null, batchId] });
    await tx.commit();
    committed = true;
  } catch (e) {
    if (!committed) await tx.rollback();
    throw e;
  }
  return { restored: rows.length, skipped: Number(batch.change_count) - rows.length };
}

module.exports = { customerFilterWhere, buildPlan, planSummary, applyPlan, setCustomerSalesperson, undoBatch };
