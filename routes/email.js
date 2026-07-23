const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

async function getSettings() {
  const { rows } = await db.execute({ sql: 'SELECT * FROM settings', args: [] });
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s;
}

function createTransporter(s) {
  if (!s.email_smtp_host) throw new Error('Email SMTP not configured. Please set up email in Settings.');
  return nodemailer.createTransport({
    host: s.email_smtp_host,
    port: parseInt(s.email_smtp_port || 587),
    secure: s.email_smtp_secure === 'true',
    auth: s.email_smtp_user ? { user: s.email_smtp_user, pass: s.email_smtp_pass || '' } : undefined,
  });
}

function fmt(n) {
  return '$' + parseFloat(n || 0).toFixed(2);
}

// Statement is the only document built here that's also used for actual
// printing (routes/email.js's statement-preview endpoint, opened directly in
// a browser tab), so it needs an absolute logo URL either way — a relative
// /uploads/... path won't resolve in an email client, and origin isn't
// reliably known once the HTML leaves this request. `origin` is derived by
// each caller from its own req (`${req.protocol}://${req.get('host')}`).
function logoImgTag(s, origin, maxHeight = 40) {
  if (!s.company_logo_url) return '';
  const src = /^https?:\/\//.test(s.company_logo_url) ? s.company_logo_url : `${origin}${s.company_logo_url}`;
  const alt = (s.store_name || 'Logo').replace(/"/g, '&quot;');
  return `<img src="${src}" alt="${alt}" style="display:block;max-height:${maxHeight}px;max-width:200px;object-fit:contain;margin-bottom:8px">`;
}

function buildReceiptHtml(tx, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = tx.branch_address
    ? `${tx.branch_address}${tx.branch_city ? ', ' + tx.branch_city : ''}${tx.branch_state ? ' ' + tx.branch_state : ''}${tx.branch_zip ? ' ' + tx.branch_zip : ''}`
    : s.store_address || '';
  const storePhone = tx.branch_phone || s.store_phone || '';
  const footer = s.receipt_footer || 'Thank you for your business!';

  const rows = (tx.items || []).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku}${i.quantity > 1 ? ` × ${i.quantity} @ ${fmt(i.unit_price)}` : ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Receipt ${tx.transaction_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="background:#1a56db;padding:24px;text-align:center">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${tx.branch_name ? `<div style="color:#bcd4ff;font-size:13px;margin-top:4px">${tx.branch_name}</div>` : ''}
      ${storeAddr ? `<div style="color:#bcd4ff;font-size:12px;margin-top:2px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#bcd4ff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:4px">Receipt</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-bottom:16px">
        <tr><td style="padding:2px 0"><strong>Transaction #:</strong> ${tx.transaction_number}</td><td style="text-align:right;padding:2px 0"><strong>Date:</strong> ${new Date(tx.created_at).toLocaleString()}</td></tr>
        ${tx.customer_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Customer:</strong> ${tx.customer_name}</td></tr>` : ''}
        <tr><td colspan="2" style="padding:2px 0"><strong>Payment:</strong> ${(tx.payment_method || '').replace('_',' ').toUpperCase()}</td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th><th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td style="padding:3px 0">Subtotal</td><td style="text-align:right">${fmt(tx.subtotal)}</td></tr>
        <tr><td style="padding:3px 0">Tax</td><td style="text-align:right">${fmt(tx.tax_amount)}</td></tr>
        ${parseFloat(tx.discount_amount) > 0 ? `<tr><td style="padding:3px 0;color:#16a34a">Discount</td><td style="text-align:right;color:#16a34a">-${fmt(tx.discount_amount)}</td></tr>` : ''}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#111">TOTAL</td><td style="font-size:16px;font-weight:700;color:#111;text-align:right">${fmt(tx.total)}</td></tr>
        ${parseFloat(tx.change_amount) > 0 ? `<tr><td style="padding:3px 0;color:#16a34a">Change</td><td style="text-align:right;color:#16a34a">${fmt(tx.change_amount)}</td></tr>` : ''}
      </table>
      <div style="text-align:center;margin-top:20px;font-size:13px;color:#666;font-style:italic">${footer}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Shared header block for the three "negative money event" receipts below —
// same store-branding shape as buildReceiptHtml, but a red/orange header
// instead of blue so it reads as distinct from a sales receipt at a glance.
function docHeader(storeName, branchLine, addrLine, phoneLine, docTitle, docNumber) {
  return `<tr><td style="background:#dc2626;padding:24px;text-align:center">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${branchLine ? `<div style="color:#fecaca;font-size:13px;margin-top:4px">${branchLine}</div>` : ''}
      ${addrLine ? `<div style="color:#fecaca;font-size:12px;margin-top:2px">${addrLine}</div>` : ''}
      ${phoneLine ? `<div style="color:#fecaca;font-size:12px">${phoneLine}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px 0">
      <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:2px">${docTitle}</div>
      <div style="font-size:13px;color:#888;margin-bottom:14px">${docNumber}</div>
    </td></tr>`;
}

function docRow(label, value, color) {
  return `<tr><td style="padding:2px 24px;font-size:13px;color:${color||'#444'}"><strong>${label}:</strong> ${value}</td></tr>`;
}

function buildVoidReceiptHtml(tx, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = tx.branch_address
    ? `${tx.branch_address}${tx.branch_city ? ', ' + tx.branch_city : ''}${tx.branch_state ? ' ' + tx.branch_state : ''}${tx.branch_zip ? ' ' + tx.branch_zip : ''}`
    : s.store_address || '';
  const rows = (tx.items || []).filter(i => i.product_id).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku}${i.quantity > 1 ? ` × ${i.quantity} @ ${fmt(i.unit_price)}` : ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Void Receipt ${tx.transaction_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    ${docHeader(storeName, tx.branch_name, storeAddr, tx.branch_phone || s.store_phone, 'Void Receipt', `Ref: ${tx.transaction_number}`)}
    <tr><td style="padding:0 24px 20px">
      ${docRow('Voided', new Date(tx.voided_at).toLocaleString())}
      ${tx.customer_name ? docRow('Customer', tx.customer_name) : ''}
      ${docRow('Original Payment Method', (tx.payment_method || '').replace('_',' ').toUpperCase())}
      ${tx.voided_by_name ? docRow('Authorized By', tx.voided_by_name) : ''}
      ${tx.void_reason ? docRow('Reason', tx.void_reason) : ''}
      <div style="height:12px"></div>
      ${rows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th><th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#111">AMOUNT VOIDED</td><td style="font-size:16px;font-weight:700;color:#dc2626;text-align:right">${fmt(tx.total)}</td></tr>
      </table>
      <div style="text-align:center;margin-top:20px;font-size:12px;color:#999">This document confirms transaction ${tx.transaction_number} was voided and no charge stands.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function buildReturnReceiptHtml(ret, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = ret.branch_address
    ? `${ret.branch_address}${ret.branch_city ? ', ' + ret.branch_city : ''}${ret.branch_state ? ' ' + ret.branch_state : ''}${ret.branch_zip ? ' ' + ret.branch_zip : ''}`
    : s.store_address || '';
  const resolutionLabel = { refund: 'Refund', credit_note: 'Credit Note', replacement: 'Replacement / Exchange' }[ret.resolution] || ret.resolution;
  const rows = (ret.items || []).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku}${i.quantity > 1 ? ` × ${i.quantity} @ ${fmt(i.unit_price)}` : ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Return Receipt ${ret.return_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    ${docHeader(storeName, ret.branch_name, storeAddr, ret.branch_phone || s.store_phone, 'Return Receipt', `Ref: ${ret.return_number}`)}
    <tr><td style="padding:0 24px 20px">
      ${docRow('Date', new Date(ret.created_at).toLocaleString())}
      ${ret.original_transaction_number ? docRow('Original Transaction', ret.original_transaction_number) : ''}
      ${ret.customer_name ? docRow('Customer', ret.customer_name) : ''}
      ${docRow('Resolution', resolutionLabel)}
      ${ret.employee_name ? docRow('Processed By', ret.employee_name) : ''}
      ${ret.notes ? docRow('Reason', ret.notes) : ''}
      <div style="height:12px"></div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item Returned</th><th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td style="padding:3px 0">Subtotal</td><td style="text-align:right">${fmt(ret.subtotal)}</td></tr>
        <tr><td style="padding:3px 0">Tax</td><td style="text-align:right">${fmt(ret.tax_amount)}</td></tr>
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#111">${resolutionLabel.toUpperCase()} TOTAL</td><td style="font-size:16px;font-weight:700;color:#dc2626;text-align:right">${fmt(ret.total)}</td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function buildCancellationReceiptHtml(agreement, s) {
  const storeName = s.store_name || 'My Store';
  const wasBilled = agreement.checkout_transaction_number != null;
  const items = (agreement.items || []).filter(i => !i.parent_item_id);
  const rows = items.map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku} × ${i.quantity}</span></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rental Cancellation ${agreement.agreement_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    ${docHeader(storeName, agreement.branch_name, s.store_address, s.store_phone, 'Rental Cancellation Receipt', `Ref: ${agreement.agreement_number}`)}
    <tr><td style="padding:0 24px 20px">
      ${docRow('Cancelled', agreement.cancelled_at ? new Date(agreement.cancelled_at).toLocaleString() : '—')}
      ${agreement.customer_name ? docRow('Customer', agreement.customer_name) : ''}
      ${agreement.cancelled_by_name ? docRow('Cancelled By', agreement.cancelled_by_name) : ''}
      ${agreement.cancellation_reason ? docRow('Reason', agreement.cancellation_reason) : ''}
      <div style="height:12px"></div>
      ${rows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        ${wasBilled ? `
        <tr><td style="padding:3px 0">Original Charge (${(agreement.checkout_payment_method||'').replace('_',' ').toUpperCase()})</td><td style="text-align:right">${fmt(agreement.checkout_total)}</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#111">AMOUNT VOIDED</td><td style="font-size:16px;font-weight:700;color:#dc2626;text-align:right">${fmt(agreement.checkout_total)}</td></tr>
        ` : `<tr><td style="font-size:13px;color:#666" colspan="2">This rental was on hold — no payment had been collected, so nothing was charged or refunded.</td></tr>`}
      </table>
      <div style="text-align:center;margin-top:20px;font-size:12px;color:#999">This document confirms rental agreement ${agreement.agreement_number} was cancelled${wasBilled ? ' and the original charge was voided' : ''}.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function buildQuoteHtml(q, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = s.store_address || '';
  const storePhone = s.store_phone || '';
  const footer = s.receipt_footer || 'Thank you for your business!';

  const rows = (q.items || []).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku || ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(i.unit_price)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Quotation ${q.quote_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="background:#1a56db;padding:24px;text-align:center">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#bcd4ff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#bcd4ff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:#111">QUOTATION</div>
          <div style="font-size:13px;color:#888;margin-top:2px">${q.quote_number}</div>
        </div>
        <div style="text-align:right;font-size:13px;color:#444">
          <div><strong>Date:</strong> ${new Date(q.created_at).toLocaleDateString()}</div>
          ${q.valid_until ? `<div><strong>Valid Until:</strong> ${new Date(q.valid_until + 'T00:00:00').toLocaleDateString()}</div>` : ''}
          ${q.branch_name ? `<div><strong>Branch:</strong> ${q.branch_name}</div>` : ''}
        </div>
      </div>
      ${q.customer_name ? `<div style="background:#f9fafb;border:1px solid #e8e8e8;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px">
        <strong>Bill To:</strong><br>${q.customer_name}${q.customer_phone ? `<br>${q.customer_phone}` : ''}${q.customer_email ? `<br>${q.customer_email}` : ''}
      </div>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Qty</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Unit Price</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td style="padding:3px 0">Subtotal</td><td style="text-align:right">${fmt(q.subtotal)}</td></tr>
        <tr><td style="padding:3px 0">Tax</td><td style="text-align:right">${fmt(q.tax_amount)}</td></tr>
        ${parseFloat(q.discount_amount) > 0 ? `<tr><td style="padding:3px 0;color:#16a34a">Discount</td><td style="text-align:right;color:#16a34a">-${fmt(q.discount_amount)}</td></tr>` : ''}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#111">TOTAL</td><td style="font-size:16px;font-weight:700;color:#111;text-align:right">${fmt(q.total)}</td></tr>
      </table>
      ${q.notes ? `<div style="margin-top:16px;font-size:13px;color:#444"><strong>Notes:</strong> ${q.notes}</div>` : ''}
      <div style="text-align:center;margin-top:20px;font-size:13px;color:#666;font-style:italic">${footer}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Send transaction receipt
router.post('/send-receipt/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });

  try {
    const { rows: [tx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city,
      b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN branches b ON t.branch_id = b.id
      WHERE t.id = ?`, args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
    tx.items = items;

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Receipt - ${tx.transaction_number} from ${s.store_name || 'Our Store'}`,
        html: buildReceiptHtml(tx, s),
      });
      res.json({ success: true, message: `Receipt sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send a void receipt for a voided transaction
router.post('/send-void-receipt/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [tx] } = await db.execute({ sql: `SELECT t.*, c.first_name || ' ' || c.last_name as customer_name,
      ve.first_name || ' ' || ve.last_name as voided_by_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city,
      b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN branches b ON t.branch_id = b.id
      LEFT JOIN employees ve ON t.voided_by = ve.id
      WHERE t.id = ?`, args: [req.params.id] });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'voided') return res.status(400).json({ error: 'Transaction is not voided' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [req.params.id] });
    tx.items = items;

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Void Receipt - ${tx.transaction_number} from ${s.store_name || 'Our Store'}`,
        html: buildVoidReceiptHtml(tx, s),
      });
      res.json({ success: true, message: `Void receipt sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send a return receipt
router.post('/send-return-receipt/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [ret] } = await db.execute({ sql: `SELECT r.*, t.transaction_number as original_transaction_number,
      c.first_name || ' ' || c.last_name as customer_name,
      e.first_name || ' ' || e.last_name as employee_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone
      FROM returns r
      LEFT JOIN transactions t ON r.original_transaction_id = t.id
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN employees e ON r.employee_id = e.id
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE r.id = ?`, args: [req.params.id] });
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ?', args: [req.params.id] });
    ret.items = items;

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Return Receipt - ${ret.return_number} from ${s.store_name || 'Our Store'}`,
        html: buildReturnReceiptHtml(ret, s),
      });
      res.json({ success: true, message: `Return receipt sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send a rental cancellation receipt
router.post('/send-cancellation-receipt/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      b.name as branch_name,
      ce.first_name || ' ' || ce.last_name as cancelled_by_name,
      co.transaction_number as checkout_transaction_number, co.payment_method as checkout_payment_method, co.total as checkout_total
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees ce ON ra.cancelled_by = ce.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Rental agreement not found' });
    if (agreement.status !== 'cancelled') return res.status(400).json({ error: 'Rental agreement is not cancelled' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    agreement.items = items;

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Rental Cancellation - ${agreement.agreement_number} from ${s.store_name || 'Our Store'}`,
        html: buildCancellationReceiptHtml(agreement, s),
      });
      res.json({ success: true, message: `Cancellation receipt sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send quotation
router.post('/send-quote/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });

  try {
    const { rows: [q] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name,
      c.email as customer_email, c.phone as customer_phone,
      b.name as branch_name
      FROM quotations q
      LEFT JOIN customers c ON q.customer_id = c.id
      LEFT JOIN branches b ON q.branch_id = b.id
      WHERE q.id = ?`, args: [req.params.id] });
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ?', args: [req.params.id] });
    q.items = items;

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Quotation ${q.quote_number} from ${s.store_name || 'Our Store'}`,
        html: buildQuoteHtml(q, s),
      });

      // Auto-mark as sent if still in draft
      if (q.status === 'draft') {
        await db.execute({ sql: "UPDATE quotations SET status = 'sent' WHERE id = ?", args: [q.id] });
      }

      res.json({ success: true, message: `Quotation sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function buildGrnHtml(po, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = s.store_address || '';
  const storePhone = s.store_phone || '';

  const rows = (po.items || []).map(i => {
    const damaged = i.quantity_damaged || 0;
    const good = (i.quantity_received || 0) - damaged;
    return `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku || ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity_ordered}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity_received || 0}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center;${damaged > 0 ? 'color:#dc2626;font-weight:600' : ''}">${damaged}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center;font-weight:600">${good}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Goods Received Note ${po.po_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="background:#1a56db;padding:24px;text-align:center">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#bcd4ff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#bcd4ff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:#111">GOODS RECEIVED NOTE</div>
          <div style="font-size:13px;color:#888;margin-top:2px">${po.po_number}</div>
        </div>
        <div style="text-align:right;font-size:13px;color:#444">
          <div><strong>Date:</strong> ${new Date().toLocaleDateString()}</div>
          ${po.branch_name ? `<div><strong>Branch:</strong> ${po.branch_name}</div>` : ''}
        </div>
      </div>
      ${po.supplier_name ? `<div style="background:#f9fafb;border:1px solid #e8e8e8;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px">
        <strong>Supplier:</strong><br>${po.supplier_name}${po.supplier_contact ? `<br>${po.supplier_contact}` : ''}${po.supplier_email ? `<br>${po.supplier_email}` : ''}
      </div>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Ordered</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Received</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Damaged</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Good</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${po.notes ? `<div style="margin-top:16px;font-size:13px;color:#444"><strong>Notes:</strong> ${po.notes}</div>` : ''}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Send goods received note
router.post('/send-grn/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });

  try {
    const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email,
      b.name as branch_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN branches b ON po.branch_id = b.id
      WHERE po.id = ?`, args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'received' && po.status !== 'partial') return res.status(400).json({ error: 'No items have been received on this order yet' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    po.items = items;

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Goods Received Note - ${po.po_number} from ${s.store_name || 'Our Store'}`,
        html: buildGrnHtml(po, s),
      });

      await db.execute({ sql: 'UPDATE purchase_orders SET grn_sent_at = CURRENT_TIMESTAMP WHERE id = ?', args: [po.id] });

      res.json({ success: true, message: `Goods received note sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function buildStatementHtml(data, s, origin) {
  const { customer, payments, period } = data;
  const storeName = s.store_name || 'My Store';
  const storeAddr = s.store_address || '';
  const storePhone = s.store_phone || '';
  const customerName = `${customer.first_name} ${customer.last_name}`;
  const totalPayments = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
  const periodText = (period.start || period.end)
    ? `${period.start ? new Date(period.start + 'T00:00:00').toLocaleDateString() : 'Beginning'} – ${period.end ? new Date(period.end + 'T00:00:00').toLocaleDateString() : 'Today'}`
    : 'All Time';

  const paymentRows = payments.map(p => {
    const allocRows = p.allocations && p.allocations.length
      ? p.allocations.map(a => `
          <tr style="background:#f9fafb">
            <td style="padding:4px 8px 4px 28px;font-size:11px;color:#555;border-bottom:1px solid #f0f0f0">↳ ${a.transaction_number}</td>
            <td style="padding:4px 8px;font-size:11px;color:#555;border-bottom:1px solid #f0f0f0">${new Date(a.invoice_date).toLocaleDateString()}</td>
            <td style="padding:4px 8px;font-size:11px;color:#555;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(a.invoice_total)}</td>
            <td style="padding:4px 8px;font-size:11px;color:#16a34a;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(a.amount)}</td>
          </tr>`).join('')
      : `<tr style="background:#f9fafb"><td colspan="4" style="padding:4px 8px 4px 28px;font-size:11px;color:#aaa;border-bottom:1px solid #f0f0f0;font-style:italic">No invoice allocations</td></tr>`;
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-weight:700;font-size:13px">${p.payment_number}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-size:13px">${new Date(p.created_at).toLocaleDateString()}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-size:13px">${(p.payment_method||'cash').replace(/_/g,' ').toUpperCase()}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-size:13px;text-align:right;font-weight:700;color:#16a34a">${fmt(p.amount)}</td>
      </tr>${allocRows}`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Account Statement – ${customerName}</title>
<style>@media print{body{background:#fff!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="background:#1a56db;padding:24px;text-align:center">
      ${origin ? `<div style="text-align:left;margin-bottom:8px">${logoImgTag(s, origin)}</div>` : ''}
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#bcd4ff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#bcd4ff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
        <tr>
          <td style="vertical-align:top">
            <div style="font-size:20px;font-weight:700;color:#111">ACCOUNT STATEMENT</div>
            <div style="font-size:13px;color:#888;margin-top:2px">Period: ${periodText}</div>
          </td>
          <td style="text-align:right;vertical-align:top;font-size:13px;color:#444">
            <div style="font-weight:700">${customerName}</div>
            <div style="color:#888">${customer.customer_number || ''}</div>
            ${customer.email ? `<div style="color:#888">${customer.email}</div>` : ''}
            ${customer.phone ? `<div style="color:#888">${customer.phone}</div>` : ''}
          </td>
        </tr>
      </table>
      ${payments.length ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px;margin-bottom:16px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Payment #</th>
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Date</th>
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Method</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Amount</th>
        </tr></thead>
        <tbody>${paymentRows}</tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444">
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:4px 0"></td></tr>
        <tr>
          <td style="font-size:15px;font-weight:700;color:#111;padding:4px 0">Total Payments</td>
          <td style="font-size:15px;font-weight:700;color:#16a34a;text-align:right;padding:4px 0">${fmt(totalPayments)}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#555;padding:2px 0">Outstanding Balance</td>
          <td style="font-size:13px;font-weight:600;color:${parseFloat(customer.account_balance||0)>0?'#dc2626':'#111'};text-align:right;padding:2px 0">${fmt(customer.account_balance||0)}</td>
        </tr>
      </table>` : '<div style="text-align:center;padding:24px;color:#888;font-style:italic">No payments found for this period.</div>'}
      <div style="text-align:center;margin-top:24px;font-size:11px;color:#aaa">Generated ${new Date().toLocaleString()}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// Statement HTML preview (opens in new window for printing)
router.get('/statement-preview/:customer_id', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.customer_id] });
    if (!customer) return res.status(404).send('<p>Customer not found</p>');
    let sql = `SELECT p.*, e.first_name || ' ' || e.last_name as employee_name FROM account_payments p LEFT JOIN employees e ON p.employee_id = e.id WHERE p.customer_id = ?`;
    const params = [req.params.customer_id];
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end)   { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY p.created_at ASC';
    const { rows: payments } = await db.execute({ sql, args: params });
    for (const p of payments) {
      const { rows: allocs } = await db.execute({ sql: `SELECT pa.*, t.transaction_number, t.total as invoice_total, t.created_at as invoice_date FROM payment_allocations pa LEFT JOIN transactions t ON pa.transaction_id = t.id WHERE pa.payment_id = ? ORDER BY t.created_at ASC`, args: [p.id] });
      p.allocations = allocs;
    }
    const s = await getSettings();
    const origin = `${req.protocol}://${req.get('host')}`;
    const html = buildStatementHtml({ customer, payments, period: { start: start||null, end: end||null } }, s, origin);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) { res.status(500).send(`<p>Error: ${e.message}</p>`); }
});

// Email an account statement
router.post('/send-statement/:customer_id', requireAuth, async (req, res) => {
  const { to, start, end } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.customer_id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    let sql = `SELECT p.*, e.first_name || ' ' || e.last_name as employee_name FROM account_payments p LEFT JOIN employees e ON p.employee_id = e.id WHERE p.customer_id = ?`;
    const params = [req.params.customer_id];
    if (start) { sql += ' AND date(p.created_at) >= ?'; params.push(start); }
    if (end)   { sql += ' AND date(p.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY p.created_at ASC';
    const { rows: payments } = await db.execute({ sql, args: params });
    for (const p of payments) {
      const { rows: allocs } = await db.execute({ sql: `SELECT pa.*, t.transaction_number, t.total as invoice_total, t.created_at as invoice_date FROM payment_allocations pa LEFT JOIN transactions t ON pa.transaction_id = t.id WHERE pa.payment_id = ? ORDER BY t.created_at ASC`, args: [p.id] });
      p.allocations = allocs;
    }
    const s = await getSettings();
    const origin = `${req.protocol}://${req.get('host')}`;
    const html = buildStatementHtml({ customer, payments, period: { start: start||null, end: end||null } }, s, origin);
    const customerName = `${customer.first_name} ${customer.last_name}`;
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Account Statement – ${customerName} | ${s.store_name || 'Our Store'}`,
        html,
      });
      res.json({ success: true, message: `Statement sent to ${to}` });
    } catch(e) { res.status(500).json({ error: `Failed to send email: ${e.message}` }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Test SMTP connection
router.post('/test', requirePermission('settings'), async (req, res) => {
  try {
    const s = await getSettings();
    const host = req.body.host || s.email_smtp_host;
    const port = parseInt(req.body.port || s.email_smtp_port || 587);
    const user = req.body.user || s.email_smtp_user;
    const pass = req.body.pass !== undefined ? req.body.pass : (s.email_smtp_pass || '');
    const secure = req.body.secure !== undefined ? req.body.secure === true || req.body.secure === 'true' : s.email_smtp_secure === 'true';

    if (!host) return res.status(400).json({ error: 'SMTP host is required' });

    try {
      const transporter = nodemailer.createTransport({
        host, port, secure,
        auth: user ? { user, pass } : undefined,
      });
      await transporter.verify();
      res.json({ success: true, message: 'SMTP connection successful' });
    } catch (e) {
      res.status(500).json({ error: `SMTP connection failed: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
