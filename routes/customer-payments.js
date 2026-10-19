const express = require('express');
const router = express.Router();
const { requirePermission } = require('../lib/permissions');
const { accountSummary, receivePayment, applyPayment } = require('../lib/customerPayments');

// Customer account payments taken at the POS — cashiers only
// (pos_receive_payment, a standalone permission). Separate from
// /api/accounts, which needs the Accounts module cashiers don't have.
router.use(requirePermission('pos_receive_payment'));

// Balance, open invoices and payments still waiting to be applied.
router.get('/:customerId', async (req, res) => {
  try {
    const summary = await accountSummary(req.params.customerId);
    if (!summary) return res.status(404).json({ error: 'Customer not found' });
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Receive a payment: payment_mode 'open' (on account) or 'invoices' (with
// allocations [{ transaction_id | legacy_invoice_id, amount }]).
router.post('/', async (req, res) => {
  try {
    const payment = await receivePayment({ ...req.body, employee_id: req.employee?.id || null });
    res.status(201).json(payment);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Apply an open payment's unapplied amount to invoices.
router.post('/:paymentId/apply', async (req, res) => {
  try {
    const by = req.employee ? `${req.employee.first_name || ''} ${req.employee.last_name || ''}`.trim() : null;
    res.json(await applyPayment(req.params.paymentId, req.body.allocations, by));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
