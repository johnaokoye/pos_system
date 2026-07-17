const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { calcCommission } = require('./commissions');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

router.use(requirePermission('crm'));

// ── Dashboard ──────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const { rows: leadsByStatus } = await db.execute({ sql: `SELECT status, COUNT(*) as count, COALESCE(SUM(estimated_value),0) as value FROM crm_leads GROUP BY status`, args: [] });
    const { rows: oppsByStage } = await db.execute({ sql: `SELECT stage, COUNT(*) as count, COALESCE(SUM(value),0) as value FROM crm_opportunities WHERE stage NOT IN ('closed_won','closed_lost') GROUP BY stage`, args: [] });
    const { rows: [pipelineTotal] } = await db.execute({ sql: `SELECT COALESCE(SUM(value),0) as total FROM crm_opportunities WHERE stage NOT IN ('closed_won','closed_lost')`, args: [] });
    const { rows: [wonThisMonth] } = await db.execute({ sql: `SELECT COUNT(*) as count, COALESCE(SUM(value),0) as value FROM crm_opportunities WHERE stage = 'closed_won' AND strftime('%Y-%m', won_at) = strftime('%Y-%m', 'now')`, args: [] });
    const { rows: upcomingActivities } = await db.execute({ sql: `SELECT a.*, e.first_name || ' ' || e.last_name as employee_name, l.first_name || ' ' || l.last_name as lead_name, l.company as lead_company, c.first_name || ' ' || c.last_name as customer_name FROM crm_activities a LEFT JOIN employees e ON a.employee_id = e.id LEFT JOIN crm_leads l ON a.lead_id = l.id LEFT JOIN customers c ON a.customer_id = c.id WHERE a.completed = 0 AND a.due_date >= datetime('now') ORDER BY a.due_date ASC LIMIT 10`, args: [] });
    const { rows: [overdueActivities] } = await db.execute({ sql: `SELECT COUNT(*) as count FROM crm_activities WHERE completed = 0 AND due_date < datetime('now')`, args: [] });
    const { rows: recentLeads } = await db.execute({ sql: `SELECT l.*, e.first_name || ' ' || e.last_name as assigned_name FROM crm_leads l LEFT JOIN employees e ON l.assigned_to = e.id ORDER BY l.created_at DESC LIMIT 5`, args: [] });
    const { rows: [totalLeads] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM crm_leads', args: [] });
    const { rows: [wonLeads] } = await db.execute({ sql: "SELECT COUNT(*) as c FROM crm_leads WHERE status = 'won'", args: [] });
    const conversionRate = Number(totalLeads.c) > 0 ? Math.round((Number(wonLeads.c) / Number(totalLeads.c)) * 100) : 0;
    res.json({ leadsByStatus, oppsByStage, pipelineTotal, wonThisMonth, upcomingActivities, overdueActivities, recentLeads, conversionRate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Leads ──────────────────────────────────────────────────
router.get('/leads', async (req, res) => {
  try {
    const { status, assigned_to, search, limit = 200 } = req.query;
    let sql = `SELECT l.*, e.first_name || ' ' || e.last_name as assigned_name, c.customer_number, c.first_name || ' ' || c.last_name as customer_name, (SELECT COUNT(*) FROM crm_activities WHERE lead_id = l.id AND completed = 0) as open_activities, (SELECT COUNT(*) FROM crm_opportunities WHERE lead_id = l.id) as opportunities FROM crm_leads l LEFT JOIN employees e ON l.assigned_to = e.id LEFT JOIN customers c ON l.customer_id = c.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND l.status = ?'; params.push(status); }
    if (assigned_to) { sql += ' AND l.assigned_to = ?'; params.push(assigned_to); }
    if (search) {
      sql += ' AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    sql += ' ORDER BY l.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const { rows: [lead] } = await db.execute({ sql: `SELECT l.*, e.first_name || ' ' || e.last_name as assigned_name, c.customer_number, c.first_name || ' ' || c.last_name as customer_name FROM crm_leads l LEFT JOIN employees e ON l.assigned_to = e.id LEFT JOIN customers c ON l.customer_id = c.id WHERE l.id = ?`, args: [req.params.id] });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const { rows: activities } = await db.execute({ sql: `SELECT a.*, e.first_name || ' ' || e.last_name as employee_name FROM crm_activities a LEFT JOIN employees e ON a.employee_id = e.id WHERE a.lead_id = ? ORDER BY a.due_date DESC, a.created_at DESC`, args: [lead.id] });
    const { rows: opportunities } = await db.execute({ sql: `SELECT o.*, e.first_name || ' ' || e.last_name as employee_name FROM crm_opportunities o LEFT JOIN employees e ON o.employee_id = e.id WHERE o.lead_id = ? ORDER BY o.created_at DESC`, args: [lead.id] });
    lead.activities = activities;
    lead.opportunities = opportunities;
    res.json(lead);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/leads', async (req, res) => {
  const { first_name, last_name, company, email, phone, source, status, estimated_value, assigned_to, notes } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
  try {
    const lead_number = await nextNumber(db, 'crm_leads', 'lead_number', 'LEAD-', 5);
    const result = await db.execute({ sql: `INSERT INTO crm_leads (lead_number,first_name,last_name,company,email,phone,source,status,estimated_value,assigned_to,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, args: [lead_number, first_name, last_name, company||null, email||null, phone||null, source||'other', status||'new', parseFloat(estimated_value||0), assigned_to||null, notes||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_leads WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/leads/:id', async (req, res) => {
  try {
    const { rows: [lead] } = await db.execute({ sql: 'SELECT * FROM crm_leads WHERE id = ?', args: [req.params.id] });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const { first_name, last_name, company, email, phone, source, status, estimated_value, assigned_to, notes } = req.body;
    await db.execute({ sql: `UPDATE crm_leads SET first_name=?,last_name=?,company=?,email=?,phone=?,source=?,status=?,estimated_value=?,assigned_to=?,notes=?,updated_at=datetime('now') WHERE id=?`, args: [first_name||lead.first_name, last_name||lead.last_name, company||null, email||null, phone||null, source||lead.source, status||lead.status, parseFloat(estimated_value||0), assigned_to||null, notes||null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_leads WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/leads/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new','contacted','qualified','proposal','negotiation','won','lost'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await db.execute({ sql: "UPDATE crm_leads SET status=?,updated_at=datetime('now') WHERE id=?", args: [status, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_leads WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/leads/:id/convert', async (req, res) => {
  try {
    const { rows: [lead] } = await db.execute({ sql: 'SELECT * FROM crm_leads WHERE id = ?', args: [req.params.id] });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (lead.customer_id) return res.status(400).json({ error: 'Already converted to customer' });

    const convTx = await db.transaction('write');
    let committed = false;
    try {
      const customer_number = await nextNumber(convTx, 'customers', 'customer_number', 'CUST-', 4);
      const result = await convTx.execute({ sql: `INSERT INTO customers (customer_number,first_name,last_name,email,phone,notes) VALUES (?,?,?,?,?,?)`, args: [customer_number, lead.first_name, lead.last_name, lead.email, lead.phone, lead.notes] });
      const custId = Number(result.lastInsertRowid);
      await convTx.execute({ sql: "UPDATE crm_leads SET customer_id=?,status='won',updated_at=datetime('now') WHERE id=?", args: [custId, lead.id] });
      await convTx.commit();
      committed = true;
      const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [custId] });
      res.json({ customer, message: 'Lead converted to customer' });
    } catch(e) {
      // Once committed, the customer is saved — rolling back a closed transaction
      // throws and would crash the process (unhandled rejection), so only
      // roll back if the commit itself never happened.
      if (!committed) await convTx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/leads/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM crm_activities WHERE lead_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM crm_opportunities WHERE lead_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM crm_leads WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Opportunities ──────────────────────────────────────────
router.get('/opportunities', async (req, res) => {
  try {
    const { stage, employee_id, lead_id } = req.query;
    let sql = `SELECT o.*, e.first_name || ' ' || e.last_name as employee_name, l.first_name || ' ' || l.last_name as lead_name, l.company as lead_company, c.first_name || ' ' || c.last_name as customer_name, q.quote_number FROM crm_opportunities o LEFT JOIN employees e ON o.employee_id = e.id LEFT JOIN crm_leads l ON o.lead_id = l.id LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN quotations q ON o.quote_id = q.id WHERE 1=1`;
    const params = [];
    if (stage) { sql += ' AND o.stage = ?'; params.push(stage); }
    if (employee_id) { sql += ' AND o.employee_id = ?'; params.push(employee_id); }
    if (lead_id) { sql += ' AND o.lead_id = ?'; params.push(lead_id); }
    sql += ' ORDER BY o.created_at DESC';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/opportunities/:id', async (req, res) => {
  try {
    const { rows: [opp] } = await db.execute({ sql: `SELECT o.*, e.first_name || ' ' || e.last_name as employee_name, l.first_name || ' ' || l.last_name as lead_name, l.company as lead_company, c.first_name || ' ' || c.last_name as customer_name, q.quote_number FROM crm_opportunities o LEFT JOIN employees e ON o.employee_id = e.id LEFT JOIN crm_leads l ON o.lead_id = l.id LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN quotations q ON o.quote_id = q.id WHERE o.id = ?`, args: [req.params.id] });
    if (!opp) return res.status(404).json({ error: 'Not found' });
    const { rows: activities } = await db.execute({ sql: `SELECT a.*, e.first_name || ' ' || e.last_name as employee_name FROM crm_activities a LEFT JOIN employees e ON a.employee_id = e.id WHERE a.opportunity_id = ? ORDER BY a.due_date DESC`, args: [opp.id] });
    opp.activities = activities;
    res.json(opp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/opportunities', async (req, res) => {
  const { title, lead_id, customer_id, employee_id, stage, probability, value, expected_close, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const opp_number = await nextNumber(db, 'crm_opportunities', 'opp_number', 'OPP-', 5);
    const result = await db.execute({ sql: `INSERT INTO crm_opportunities (opp_number,title,lead_id,customer_id,employee_id,stage,probability,value,expected_close,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [opp_number, title, lead_id||null, customer_id||null, employee_id||null, stage||'qualification', parseInt(probability||50), parseFloat(value||0), expected_close||null, notes||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_opportunities WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/opportunities/:id', async (req, res) => {
  try {
    const { rows: [opp] } = await db.execute({ sql: 'SELECT * FROM crm_opportunities WHERE id = ?', args: [req.params.id] });
    if (!opp) return res.status(404).json({ error: 'Not found' });
    const { title, lead_id, customer_id, employee_id, stage, probability, value, expected_close, notes, lost_reason } = req.body;
    const isWon = stage === 'closed_won' && opp.stage !== 'closed_won';
    await db.execute({ sql: `UPDATE crm_opportunities SET title=?,lead_id=?,customer_id=?,employee_id=?,stage=?,probability=?,value=?,expected_close=?,notes=?,lost_reason=?,won=?,won_at=?,updated_at=datetime('now') WHERE id=?`, args: [title||opp.title, lead_id||null, customer_id||null, employee_id||null, stage||opp.stage, parseInt(probability||opp.probability), parseFloat(value||opp.value), expected_close||null, notes||null, lost_reason||null, isWon ? 1 : (stage === 'closed_won' ? opp.won : 0), isWon ? new Date().toISOString() : opp.won_at, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_opportunities WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/opportunities/:id/stage', async (req, res) => {
  try {
    const { stage, lost_reason } = req.body;
    const valid = ['qualification','proposal','negotiation','closed_won','closed_lost'];
    if (!valid.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    const { rows: [opp] } = await db.execute({ sql: 'SELECT * FROM crm_opportunities WHERE id = ?', args: [req.params.id] });
    if (!opp) return res.status(404).json({ error: 'Not found' });
    const isWon = stage === 'closed_won';
    await db.execute({ sql: `UPDATE crm_opportunities SET stage=?,won=?,won_at=?,lost_reason=?,updated_at=datetime('now') WHERE id=?`, args: [stage, isWon ? 1 : 0, isWon ? new Date().toISOString() : null, lost_reason||null, req.params.id] });
    if (isWon && opp.lead_id) {
      await db.execute({ sql: "UPDATE crm_leads SET status='won',updated_at=datetime('now') WHERE id=?", args: [opp.lead_id] });
    }
    if (stage === 'closed_lost' && opp.lead_id) {
      await db.execute({ sql: "UPDATE crm_leads SET status='lost',updated_at=datetime('now') WHERE id=?", args: [opp.lead_id] });
    }
    // Auto-calculate commission on won deal
    if (isWon && opp.employee_id && opp.value > 0) {
      try { await calcCommission(opp.employee_id, opp.value, 'opportunity', opp.id, opp.opp_number); } catch(e) {}
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_opportunities WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/opportunities/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM crm_activities WHERE opportunity_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM crm_opportunities WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Activities ─────────────────────────────────────────────
router.get('/activities', async (req, res) => {
  try {
    const { completed, employee_id, lead_id, opportunity_id, overdue } = req.query;
    let sql = `SELECT a.*, e.first_name || ' ' || e.last_name as employee_name, l.first_name || ' ' || l.last_name as lead_name, l.company as lead_company, o.title as opp_title, c.first_name || ' ' || c.last_name as customer_name FROM crm_activities a LEFT JOIN employees e ON a.employee_id = e.id LEFT JOIN crm_leads l ON a.lead_id = l.id LEFT JOIN crm_opportunities o ON a.opportunity_id = o.id LEFT JOIN customers c ON a.customer_id = c.id WHERE 1=1`;
    const params = [];
    if (completed !== undefined) { sql += ' AND a.completed = ?'; params.push(completed === 'true' ? 1 : 0); }
    if (employee_id) { sql += ' AND a.employee_id = ?'; params.push(employee_id); }
    if (lead_id) { sql += ' AND a.lead_id = ?'; params.push(lead_id); }
    if (opportunity_id) { sql += ' AND a.opportunity_id = ?'; params.push(opportunity_id); }
    if (overdue === 'true') { sql += " AND a.completed = 0 AND a.due_date < datetime('now')"; }
    sql += ' ORDER BY a.completed ASC, a.due_date ASC, a.created_at DESC LIMIT 200';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/activities', async (req, res) => {
  const { lead_id, opportunity_id, customer_id, employee_id, type, subject, description, due_date } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject required' });
  try {
    const result = await db.execute({ sql: `INSERT INTO crm_activities (lead_id,opportunity_id,customer_id,employee_id,type,subject,description,due_date) VALUES (?,?,?,?,?,?,?,?)`, args: [lead_id||null, opportunity_id||null, customer_id||null, employee_id||null, type||'task', subject, description||null, due_date||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_activities WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/activities/:id', async (req, res) => {
  try {
    const { rows: [act] } = await db.execute({ sql: 'SELECT * FROM crm_activities WHERE id = ?', args: [req.params.id] });
    if (!act) return res.status(404).json({ error: 'Not found' });
    const { type, subject, description, due_date, outcome, employee_id } = req.body;
    await db.execute({ sql: 'UPDATE crm_activities SET type=?,subject=?,description=?,due_date=?,outcome=?,employee_id=? WHERE id=?', args: [type||act.type, subject||act.subject, description||null, due_date||null, outcome||null, employee_id||null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_activities WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/activities/:id/complete', async (req, res) => {
  try {
    const { outcome } = req.body;
    await db.execute({ sql: "UPDATE crm_activities SET completed=1,completed_at=datetime('now'),outcome=? WHERE id=?", args: [outcome||null, req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_activities WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/activities/:id/reopen', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE crm_activities SET completed=0,completed_at=NULL WHERE id=?', args: [req.params.id] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM crm_activities WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/activities/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM crm_activities WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
