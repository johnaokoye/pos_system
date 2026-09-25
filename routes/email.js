const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { rentalQuoteSummary, attachRentalRates, attachRateBasis, rentalWindow, rateBasisLabel } = require('../lib/rentals');

// Brand palette for every email sent out (receipts, quotes, invoices,
// statements, notices): green header with a yellow accent stripe, black
// text. Red is kept only for warning figures (voided amounts, balances
// owed, damage, deadlines) where it signals a problem.
const BRAND = { green: '#007e37', yellow: '#ffd800', black: '#000000' };
const BRAND_HEADER_STYLE = `background:${BRAND.green};border-bottom:5px solid ${BRAND.yellow};padding:24px;text-align:center`;

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
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${tx.branch_name ? `<div style="color:#ffffff;font-size:13px;margin-top:4px">${tx.branch_name}</div>` : ''}
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:2px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="font-size:18px;font-weight:700;color:${BRAND.black};margin-bottom:4px">Receipt</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-bottom:16px">
        <tr><td style="padding:2px 0"><strong>Transaction #:</strong> ${tx.transaction_number}</td><td style="text-align:right;padding:2px 0"><strong>Date:</strong> ${new Date(tx.created_at).toLocaleString()}</td></tr>
        ${tx.customer_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Customer:</strong> ${tx.customer_name}</td></tr>` : ''}
        ${tx.created_by_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Created By:</strong> ${tx.created_by_name}</td></tr>` : ''}
        ${tx.employee_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Cashier:</strong> ${tx.employee_name}</td></tr>` : ''}
        <tr><td colspan="2" style="padding:2px 0"><strong>Payment:</strong> ${(tx.payment_method || '').replace('_',' ').toUpperCase()}</td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th><th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td style="padding:3px 0">Subtotal</td><td style="text-align:right">${fmt(tx.subtotal)}</td></tr>
        <tr><td style="padding:3px 0">Tax</td><td style="text-align:right">${fmt(tx.tax_amount)}</td></tr>
        ${parseFloat(tx.discount_amount) > 0 ? `<tr><td style="padding:3px 0;color:${BRAND.green}">Discount</td><td style="text-align:right;color:${BRAND.green}">-${fmt(tx.discount_amount)}</td></tr>` : ''}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">TOTAL</td><td style="font-size:16px;font-weight:700;color:${BRAND.black};text-align:right">${fmt(tx.total)}</td></tr>
        ${parseFloat(tx.change_amount) > 0 ? `<tr><td style="padding:3px 0;color:${BRAND.green}">Change</td><td style="text-align:right;color:${BRAND.green}">${fmt(tx.change_amount)}</td></tr>` : ''}
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
  return `<tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${branchLine ? `<div style="color:#ffffff;font-size:13px;margin-top:4px">${branchLine}</div>` : ''}
      ${addrLine ? `<div style="color:#ffffff;font-size:12px;margin-top:2px">${addrLine}</div>` : ''}
      ${phoneLine ? `<div style="color:#ffffff;font-size:12px">${phoneLine}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px 0">
      <div style="font-size:18px;font-weight:700;color:${BRAND.black};margin-bottom:2px">${docTitle}</div>
      <div style="font-size:13px;color:#888;margin-bottom:14px">${docNumber}</div>
    </td></tr>`;
}

// A block, not a <tr>: every caller drops these straight into a padded
// <td>, where a bare <tr> is invalid and gets hoisted out of the card.
function docRow(label, value, color) {
  return `<div style="padding:2px 0;font-size:13px;color:${color||'#444'}"><strong>${label}:</strong> ${value}</div>`;
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
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">AMOUNT VOIDED</td><td style="font-size:16px;font-weight:700;color:#dc2626;text-align:right">${fmt(tx.total)}</td></tr>
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
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">${resolutionLabel.toUpperCase()} TOTAL</td><td style="font-size:16px;font-weight:700;color:#dc2626;text-align:right">${fmt(ret.total)}</td></tr>
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
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">AMOUNT VOIDED</td><td style="font-size:16px;font-weight:700;color:#dc2626;text-align:right">${fmt(agreement.checkout_total)}</td></tr>
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

// Mirrors printReceiptLetter's rental invoice in public/index.html — item(s)
// rented pulled from the agreement (not just this transaction's line items,
// which for a settlement are duration-adjustment/deposit lines with no
// product name), plus both Issue and Return signature checkpoints whenever
// they're on file, so the emailed copy matches what printing it produces.
function daysBetweenDates(a, b) {
  const da = new Date(a), dbb = new Date(b);
  const utcA = Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate());
  const utcB = Date.UTC(dbb.getUTCFullYear(), dbb.getUTCMonth(), dbb.getUTCDate());
  return Math.round((utcB - utcA) / 86400000);
}

function rentalDurationText(checkout, dueDate, returnedAt) {
  if (!checkout || !dueDate) return '—';
  const planned = daysBetweenDates(checkout, dueDate);
  const plannedLabel = `${planned} day${planned === 1 ? '' : 's'}`;
  if (!returnedAt) return plannedLabel;
  const actual = daysBetweenDates(checkout, returnedAt);
  if (actual === planned) return `${plannedLabel} (returned on time)`;
  const diff = actual - planned;
  return `${actual} day${actual === 1 ? '' : 's'} (planned ${plannedLabel}, ${diff > 0 ? '+' : ''}${diff}d)`;
}

function buildRentalInvoiceHtml(agreement, tx, s, origin) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = tx.branch_address
    ? `${tx.branch_address}${tx.branch_city ? ', ' + tx.branch_city : ''}${tx.branch_state ? ' ' + tx.branch_state : ''}${tx.branch_zip ? ' ' + tx.branch_zip : ''}`
    : s.store_address || '';
  const storePhone = tx.branch_phone || s.store_phone || '';
  const footer = s.receipt_footer || 'Thank you for your business!';
  const absUrl = (path) => !path ? null : (/^https?:\/\//.test(path) ? path : `${origin}${path}`);
  const rentedItemsLabel = (agreement.items || []).filter(i => !i.parent_item_id).map(i => `${i.product_name} x${i.quantity}`).join(', ');
  const rentedLabel = agreement.checkout_datetime ? new Date(agreement.checkout_datetime).toLocaleString() : '—';
  const returnedLabel = agreement.returned_at ? new Date(agreement.returned_at).toLocaleString() : 'Not yet returned';
  const durationLabel = rentalDurationText(agreement.checkout_datetime, agreement.due_date, agreement.returned_at);

  const rows = (tx.items || []).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku}${i.quantity > 1 ? ` × ${i.quantity} @ ${fmt(i.unit_price)}` : ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  // Mirrors printReceiptLetter's rental breakdown in public/index.html — a
  // CHECKOUT transaction (positive DEPOSIT line, not a settlement's reversed
  // one) shows Sub-Total Amount / Sales Tax / Sales Total / Rental Deposit /
  // Grand Total, since the deposit equals Sales Total (fee + tax) under the
  // double-charge model in PATCH .../checkout in routes/rentals.js.
  let rentalBreakdown = null;
  const depositLine = (tx.items || []).find(i => i.sku === 'DEPOSIT' && i.total > 0);
  if (depositLine) {
    const serviceTotal = (tx.items || []).filter(i => ['DELIVERY', 'PICKUP', 'OPERATOR'].includes(i.sku)).reduce((sum, i) => sum + i.total, 0);
    const subTotalAmount = parseFloat((tx.subtotal - depositLine.total - serviceTotal).toFixed(2));
    rentalBreakdown = { subTotalAmount, salesTotal: parseFloat((subTotalAmount + tx.tax_amount).toFixed(2)), depositAmt: depositLine.total };
  }

  const issueSignatures = [];
  if (agreement.issue_customer_signature) issueSignatures.push(['Customer Signature', agreement.customer_name, agreement.issue_customer_signature, agreement.issued_at]);
  if (agreement.issue_security_signature) issueSignatures.push(['Security Signature', agreement.issue_security_employee_name, agreement.issue_security_signature, agreement.issue_security_confirmed_at]);
  const returnSignatures = [];
  if (agreement.return_security_signature) returnSignatures.push(['Security Signature', agreement.return_security_employee_name, agreement.return_security_signature, agreement.return_security_confirmed_at]);
  if (agreement.return_driver_signature) returnSignatures.push(['Driver Signature', agreement.return_driver_employee_name, agreement.return_driver_signature, agreement.return_driver_confirmed_at]);

  // All Issue and Return signature checkpoints in one row (up to 4 columns)
  // instead of two stacked rows — each label carries which checkpoint it
  // belongs to, so the grouping stays clear while taking a fraction of the
  // vertical space.
  const sigBlock = (issueSigs, returnSigs) => {
    const sigs = [
      ...issueSigs.map(([label, name, src, signedAt]) => [`Issued — ${label}`, name, src, signedAt]),
      ...returnSigs.map(([label, name, src, signedAt]) => [`Returned — ${label}`, name, src, signedAt]),
    ];
    if (!sigs.length) return '';
    return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>
      ${sigs.map(([label, name, src, signedAt]) => `<td style="text-align:center;padding:4px 8px">
        <img src="${absUrl(src)}" style="max-height:44px;max-width:120px;border-bottom:1px solid #333;padding-bottom:4px" />
        <div style="font-size:10px;color:#555;margin-top:4px">${label}${name ? ` — ${name}` : ''}</div>
        ${signedAt ? `<div style="font-size:9px;color:#888">${new Date(signedAt).toLocaleString()}</div>` : ''}
      </td>`).join('')}
    </tr></table>`;
  };

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rental Tax Invoice ${tx.transaction_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${agreement.branch_name ? `<div style="color:#ffffff;font-size:13px;margin-top:4px">${agreement.branch_name}</div>` : ''}
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:2px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="font-size:18px;font-weight:700;color:${BRAND.black};margin-bottom:4px">Rental Tax Invoice</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-bottom:16px">
        <tr><td style="padding:2px 0"><strong>Transaction #:</strong> ${tx.transaction_number}</td><td style="text-align:right;padding:2px 0"><strong>Date:</strong> ${new Date(tx.created_at).toLocaleString()}</td></tr>
        ${agreement.customer_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Customer:</strong> ${agreement.customer_name}</td></tr>` : ''}
        <tr><td colspan="2" style="padding:2px 0"><strong>Rental Agreement:</strong> ${agreement.agreement_number}</td></tr>
        ${tx.created_by_name || tx.employee_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Created By:</strong> ${tx.created_by_name || tx.employee_name}</td></tr>` : ''}
        ${tx.employee_name ? `<tr><td colspan="2" style="padding:2px 0"><strong>Cashier:</strong> ${tx.employee_name}</td></tr>` : ''}
        <tr><td colspan="2" style="padding:2px 0"><strong>Item(s) Rented:</strong> ${rentedItemsLabel || '—'}</td></tr>
        <tr><td style="padding:2px 0"><strong>Rented:</strong> ${rentedLabel}</td><td style="text-align:right;padding:2px 0"><strong>Returned:</strong> ${returnedLabel}</td></tr>
        <tr><td colspan="2" style="padding:2px 0"><strong>Duration:</strong> ${durationLabel}</td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb"><th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th><th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        ${rentalBreakdown ? `
        <tr><td style="padding:3px 0">Sub-Total Amount</td><td style="text-align:right">${fmt(rentalBreakdown.subTotalAmount)}</td></tr>
        <tr><td style="padding:3px 0">Sales Tax</td><td style="text-align:right">${fmt(tx.tax_amount)}</td></tr>
        <tr><td style="padding:3px 0">Sales Total</td><td style="text-align:right">${fmt(rentalBreakdown.salesTotal)}</td></tr>
        <tr><td style="padding:3px 0">Rental Deposit</td><td style="text-align:right">${fmt(rentalBreakdown.depositAmt)}</td></tr>
        ${parseFloat(tx.discount_amount) > 0 ? `<tr><td style="padding:3px 0;color:${BRAND.green}">Discount</td><td style="text-align:right;color:${BRAND.green}">-${fmt(tx.discount_amount)}</td></tr>` : ''}` : `
        <tr><td style="padding:3px 0">Subtotal</td><td style="text-align:right">${fmt(tx.subtotal)}</td></tr>
        <tr><td style="padding:3px 0">Tax</td><td style="text-align:right">${fmt(tx.tax_amount)}</td></tr>`}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">${rentalBreakdown ? 'GRAND TOTAL' : 'TOTAL'}</td><td style="font-size:16px;font-weight:700;color:${BRAND.black};text-align:right">${fmt(tx.total)}</td></tr>
        <tr><td style="padding:3px 0;color:#666">Payment</td><td style="text-align:right;color:#666">${(tx.payment_method || '').replace('_',' ').toUpperCase()}</td></tr>
      </table>
      ${sigBlock(issueSignatures, returnSignatures)}
      <div style="text-align:center;margin-top:20px;font-size:13px;color:#666;font-style:italic">${footer}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// The single comprehensive "final rental agreement" document — checkout
// through return through however the deposit was ultimately settled. Mirrors
// printRentalAgreementSummary in public/index.html section-for-section so
// the emailed copy matches what printing it produces; replaces what used to
// be three separate narrower documents (tax invoice extras aside, the
// deposit-only credit-note/refund receipts) with one.
function buildRentalSummaryHtml(agreement, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = agreement.branch_address
    ? `${agreement.branch_address}${agreement.branch_city ? ', ' + agreement.branch_city : ''}${agreement.branch_state ? ' ' + agreement.branch_state : ''}${agreement.branch_zip ? ' ' + agreement.branch_zip : ''}`
    : s.store_address || '';
  const isReturned = agreement.status === 'returned';

  const itemRows = (agreement.items || []).map(i => {
    const tag = i.parent_item_id ? (i.is_mandatory ? ' (included)' : ' (accessory)') : '';
    const rateParts = i.is_mandatory ? [] : [`${fmt(i.daily_rate)}/day`];
    if (!i.is_mandatory) {
      if (i.weekly_rate) rateParts.push(`${fmt(i.weekly_rate)}/wk`);
      if (i.monthly_rate) rateParts.push(`${fmt(i.monthly_rate)}/mo`);
    }
    // The blocks the fee is actually billed in over the rental period, when known.
    if (i.rate_basis && i.rate_basis.length) rateParts.splice(0, rateParts.length, rateBasisLabel(i.rate_basis, fmt));
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}${tag}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center;font-size:11px;color:#666">${i.is_mandatory ? 'No charge' : rateParts.join(' · ')}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(i.rental_fee)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${i.quantity_returned > 0 ? fmt(i.final_rental_fee) : '—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${i.damage_fee > 0 ? fmt(i.damage_fee) : '—'}</td>
    </tr>`;
  }).join('');

  const serviceFeesTotal = (agreement.delivery_required ? agreement.delivery_cost||0 : 0) + (agreement.pickup_required ? agreement.pickup_cost||0 : 0) + (agreement.operator_required ? agreement.operator_fee||0 : 0);
  const rentalFeeSubtotal = parseFloat(((agreement.checkout_subtotal||0) - agreement.deposit_total - serviceFeesTotal).toFixed(2));
  const checkoutRows = agreement.checkout_transaction_id ? [
    ['Rental Fee Subtotal', fmt(rentalFeeSubtotal)],
    serviceFeesTotal > 0 ? ['Delivery / Pickup / Operator Fees', fmt(serviceFeesTotal)] : null,
    ['Tax', fmt(agreement.checkout_tax_amount)],
    ['Deposit Collected', fmt(agreement.deposit_total)],
    agreement.checkout_discount_amount > 0 ? ['Discount', `-${fmt(agreement.checkout_discount_amount)}`] : null,
    ['Total Charged at Checkout', fmt(agreement.checkout_total)],
    ['Payment Method', (agreement.checkout_payment_method||'').replace('_',' ').toUpperCase()],
  ].filter(Boolean) : [];

  const durationAdjLabel = agreement.duration_adjustment_total > 0 ? 'Additional Rental Time' : agreement.duration_adjustment_total < 0 ? 'Rental Fee Credit (returned early)' : 'Duration Adjustment';
  const settlementRows = isReturned ? [
    agreement.damage_fee_total ? ['Damage Fees', fmt(agreement.damage_fee_total)] : null,
    agreement.duration_adjustment_total ? [durationAdjLabel, fmt(agreement.duration_adjustment_total)] : null,
    agreement.tax_adjustment_total ? ['Tax Adjustment', fmt(agreement.tax_adjustment_total)] : null,
    ['Less: Deposit Applied', `-${fmt(agreement.deposit_total)}`],
  ].filter(Boolean) : [];
  const balanceLabel = agreement.balance_due > 0.004 ? 'BALANCE DUE' : agreement.balance_due < -0.004 ? 'REFUND DUE' : 'SETTLED IN FULL';
  const balanceDisplay = fmt(Math.abs(agreement.balance_due));

  let dispositionLine = null;
  if (isReturned && agreement.balance_due > 0.004) {
    dispositionLine = agreement.settlement_transaction_id
      ? `Collected ${fmt(agreement.balance_due)} via ${(agreement.settlement_payment_method||'').replace('_',' ').toUpperCase()} on ${new Date(agreement.settlement_created_at).toLocaleString()}${agreement.settlement_amount_tendered > agreement.balance_due ? ` — Tendered ${fmt(agreement.settlement_amount_tendered)}, Change ${fmt(agreement.settlement_change_amount)}` : ''}.`
      : 'Balance due has not yet been collected — see POS Hold Recall.';
  } else if (isReturned && agreement.balance_due < -0.004) {
    if (agreement.credit_note_amount > 0) {
      dispositionLine = `Issued as store credit on the customer's account: ${fmt(agreement.credit_note_amount)} on ${new Date(agreement.credit_note_issued_at).toLocaleString()}${agreement.credit_note_issued_by_name ? ` by ${agreement.credit_note_issued_by_name}` : ''}.`;
    } else if (agreement.checkout_payment_method === 'credit') {
      dispositionLine = `Applied automatically to the customer's account balance: ${fmt(-agreement.settlement_total)}.`;
    } else if (['cash','bank_transfer','original_card'].includes(agreement.deposit_return_method)) {
      const methodLabels = { cash: 'Cash', bank_transfer: 'Bank Transfer', original_card: 'Refund to Original Card' };
      dispositionLine = `Refunded via ${methodLabels[agreement.deposit_return_method]} on ${new Date(agreement.deposit_return_recorded_at).toLocaleString()}${agreement.deposit_return_reference ? ` — Ref: ${agreement.deposit_return_reference}` : ''}${agreement.deposit_return_recorded_by_name ? ` (recorded by ${agreement.deposit_return_recorded_by_name})` : ''}.`;
    } else {
      dispositionLine = 'Refund due — not yet disbursed.';
    }
  }

  const issueSignatures = [];
  if (agreement.issue_customer_signature) issueSignatures.push(['Customer', agreement.customer_name, agreement.issue_customer_signature, agreement.issued_at]);
  if (agreement.issue_security_signature) issueSignatures.push(['Security (Issue)', agreement.issue_security_employee_name, agreement.issue_security_signature, agreement.issue_security_confirmed_at]);
  if (agreement.return_security_signature) issueSignatures.push(['Security (Return)', agreement.return_security_employee_name, agreement.return_security_signature, agreement.return_security_confirmed_at]);
  if (agreement.return_driver_signature) issueSignatures.push(['Driver (Return)', agreement.return_driver_employee_name, agreement.return_driver_signature, agreement.return_driver_confirmed_at]);
  const sigRow = !issueSignatures.length ? '' : `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>
    ${issueSignatures.map(([label, name, src, signedAt]) => `<td style="text-align:center;padding:4px 8px">
      <img src="${src}" style="max-height:44px;max-width:110px;border-bottom:1px solid #333;padding-bottom:4px" />
      <div style="font-size:10px;color:#555;margin-top:4px">${label}${name ? ` — ${name}` : ''}</div>
      ${signedAt ? `<div style="font-size:9px;color:#888">${new Date(signedAt).toLocaleString()}</div>` : ''}
    </td>`).join('')}
  </tr></table>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rental Agreement Summary ${agreement.agreement_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${agreement.branch_name ? `<div style="color:#ffffff;font-size:13px;margin-top:4px">${agreement.branch_name}</div>` : ''}
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:2px">${storeAddr}</div>` : ''}
      ${agreement.branch_phone || s.store_phone ? `<div style="color:#ffffff;font-size:12px">${agreement.branch_phone || s.store_phone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="font-size:18px;font-weight:700;color:${BRAND.black};margin-bottom:12px">Rental Agreement Summary</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-bottom:16px">
        <tr><td style="padding:2px 0"><strong>Agreement #:</strong> ${agreement.agreement_number}</td>${agreement.customer_name ? `<td style="text-align:right;padding:2px 0"><strong>Customer:</strong> ${agreement.customer_name}</td>` : ''}</tr>
        <tr><td style="padding:2px 0"><strong>Checked Out:</strong> ${agreement.checkout_datetime ? new Date(agreement.checkout_datetime).toLocaleString() : '—'}</td><td style="text-align:right;padding:2px 0"><strong>Due Date:</strong> ${agreement.due_date}</td></tr>
        <tr><td colspan="2" style="padding:2px 0"><strong>Returned:</strong> ${agreement.returned_at ? new Date(agreement.returned_at).toLocaleString() : 'Not yet returned'}</td></tr>
      </table>
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #e8e8e8;padding-bottom:4px;margin-bottom:6px">Items Rented</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:12px">
        <thead><tr style="background:#f9fafb"><th style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:1px solid #e8e8e8">Item</th><th style="padding:6px 8px;text-align:center;font-size:11px;color:#666;border-bottom:1px solid #e8e8e8">Qty</th><th style="padding:6px 8px;text-align:center;font-size:11px;color:#666;border-bottom:1px solid #e8e8e8">Rate</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:#666;border-bottom:1px solid #e8e8e8">Original Fee</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:#666;border-bottom:1px solid #e8e8e8">Final Fee</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:#666;border-bottom:1px solid #e8e8e8">Damage Fee</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      ${checkoutRows.length ? `<div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #e8e8e8;padding-bottom:4px;margin:16px 0 6px">Checkout Charges</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444">
        ${checkoutRows.map(([l,v]) => `<tr><td style="padding:3px 0">${l}</td><td style="text-align:right">${v}</td></tr>`).join('')}
      </table>` : ''}
      ${settlementRows.length ? `<div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #e8e8e8;padding-bottom:4px;margin:16px 0 6px">Return Settlement</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444">
        ${settlementRows.map(([l,v]) => `<tr><td style="padding:3px 0">${l}</td><td style="text-align:right">${v}</td></tr>`).join('')}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:15px;font-weight:700;color:${BRAND.black}">${balanceLabel}</td><td style="font-size:15px;font-weight:700;color:${BRAND.black};text-align:right">${balanceDisplay}</td></tr>
      </table>
      ${dispositionLine ? `<div style="margin-top:8px;padding:8px 12px;background:#f5f5f5;border-left:3px solid #555;font-size:12px;border-radius:4px">${dispositionLine}</div>` : ''}` : ''}
      ${sigRow}
      <div style="text-align:center;margin-top:20px;font-size:13px;color:#666;font-style:italic">${s.receipt_footer || 'Thank you for your business!'}</div>
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
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:${BRAND.black}">QUOTATION</div>
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
        ${parseFloat(q.discount_amount) > 0 ? `<tr><td style="padding:3px 0;color:${BRAND.green}">Discount</td><td style="text-align:right;color:${BRAND.green}">-${fmt(q.discount_amount)}</td></tr>` : ''}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">TOTAL</td><td style="font-size:16px;font-weight:700;color:${BRAND.black};text-align:right">${fmt(q.total)}</td></tr>
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

// Rate card shown under each rental line. Tools bill on the daily rate only
// (with automatic long-rental discounts); equipment has its own hourly/
// weekly/monthly tiers — see lib/rentalPricing.js.
function rentalRateCard(i) {
  if (i.rate_basis && i.rate_basis.length) return rateBasisLabel(i.rate_basis, fmt);
  const parts = i.rental_classification === 'equipment'
    ? [['Hourly', i.hourly_rate], ['Daily', i.daily_rate], ['Weekly', i.weekly_rate], ['Monthly', i.monthly_rate]]
    : [['Daily', i.daily_rate]];
  return parts.filter(([, v]) => parseFloat(v) > 0).map(([l, v]) => `${l} ${fmt(v)}`).join(' · ');
}

function rentalQuotePeriod(q) {
  const start = new Date(`${String(q.created_at).slice(0, 10)}T00:00:00Z`);
  const due = new Date(`${String(q.due_date).slice(0, 10)}T00:00:00Z`);
  const days = Math.max(1, Math.round((due - start) / 86400000));
  return { start, due, days };
}

// `print` swaps the email's fixed-width card for a full-width US Letter
// page — used by GET /quote-preview/:id (Print on the quote view).
function buildRentalQuoteHtml(q, s, { print = false } = {}) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = s.store_address || '';
  const storePhone = s.store_phone || '';
  const footer = s.receipt_footer || 'Thank you for your business!';
  const sum = rentalQuoteSummary(q);
  const period = q.due_date ? rentalQuotePeriod(q) : null;
  const cell = 'padding:6px 8px;border-bottom:1px solid #f0f0f0';
  const th = 'padding:8px;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8';
  const section = title => `<div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #e8e8e8;padding-bottom:4px;margin:18px 0 6px">${title}</div>`;
  const customerAddr = [q.customer_address, q.customer_city, q.customer_state, q.customer_zip].filter(Boolean).join(', ');

  const rows = (q.items || []).map(i => {
    const isChild = !!i.parent_item_id;
    const tag = isChild ? (i.is_mandatory ? 'Included accessory' : 'Optional accessory') : '';
    const rates = rentalRateCard(i);
    const meta = [i.sku, rates, i.condition_out ? `Condition out: ${i.condition_out}` : ''].filter(Boolean).join(' · ');
    return `
    <tr>
      <td style="${cell}${isChild ? ';padding-left:22px' : ''}">${isChild ? '↳ ' : ''}${i.product_name}${tag ? ` <span style="font-size:10px;color:${BRAND.green};font-weight:700">${tag.toUpperCase()}</span>` : ''}${meta ? `<br><span style="color:#888;font-size:11px">${meta}</span>` : ''}</td>
      <td style="${cell};text-align:center">${i.quantity}</td>
      <td style="${cell};text-align:right">${i.is_mandatory ? 'Included' : fmt(i.total)}</td>
    </tr>`;
  }).join('');

  const services = [
    q.delivery_required ? ['Delivery', q.delivery_address || (customerAddr ? `To: ${customerAddr}` : 'To the customer’s address on file'), sum.delivery] : null,
    q.pickup_required ? ['Pickup', 'Collection of the equipment from the customer at the end of the rental', sum.pickup] : null,
    q.operator_required ? ['Operator', 'Trained operator provided to run the equipment', sum.operator] : null,
  ].filter(Boolean);
  const servicesTable = services.length ? `${section('Additional Services')}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        ${services.map(([name, desc, amt]) => `<tr><td style="${cell}"><strong>${name}</strong><br><span style="color:#888;font-size:11px">${desc}</span></td><td style="${cell};text-align:right;font-weight:600">${fmt(amt)}</td></tr>`).join('')}
      </table>` : '';

  const line = (label, value, style = '') => `<tr><td style="padding:3px 0;${style}">${label}</td><td style="text-align:right;${style}">${value}</td></tr>`;
  const summaryRows = [
    line('Rental Fees (estimated)', fmt(sum.rental_fees)),
    line('Sales Tax', fmt(sum.tax)),
    q.delivery_required ? line('Delivery', fmt(sum.delivery)) : '',
    q.pickup_required ? line('Pickup', fmt(sum.pickup)) : '',
    q.operator_required ? line('Operator', fmt(sum.operator)) : '',
    sum.deposit_waived
      ? line('Refundable Deposit', 'Waived — operator provided')
      : line('Refundable Deposit', fmt(sum.deposit)),
    sum.discount > 0 ? line('Discount', `-${fmt(sum.discount)}`, `color:${BRAND.green}`) : '',
  ].join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rental Quotation ${q.quote_number}</title>
${print ? `<style>
  @page { size: letter; margin: 0.5in; }
  body { background:#fff !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .page-wrap { background:#fff !important; padding:0 !important; }
  .page { width:100% !important; max-width:7.5in; box-shadow:none !important; border-radius:0 !important; }
  tr, .keep { page-break-inside: avoid; }
</style>` : ''}
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table class="page-wrap" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table class="page" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px">
        <tr>
          <td style="vertical-align:top">
            <div style="font-size:20px;font-weight:700;color:${BRAND.black}">RENTAL QUOTATION</div>
            <div style="font-size:13px;color:#888;margin-top:2px">${q.quote_number}</div>
          </td>
          <td style="vertical-align:top;text-align:right;font-size:13px;color:#444">
            <div><strong>Date:</strong> ${new Date(q.created_at).toLocaleDateString()}</div>
            ${q.branch_name ? `<div><strong>Branch:</strong> ${q.branch_name}</div>` : ''}
            ${q.employee_name ? `<div><strong>Prepared By:</strong> ${q.employee_name}</div>` : ''}
          </td>
        </tr>
      </table>
      ${q.customer_name ? `<div style="background:#f9fafb;border:1px solid #e8e8e8;border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px">
        <strong>Customer:</strong><br>${q.customer_name}${q.customer_number ? ` (${q.customer_number})` : ''}${customerAddr ? `<br>${customerAddr}` : ''}${q.customer_phone ? `<br>${q.customer_phone}` : ''}${q.customer_email ? `<br>${q.customer_email}` : ''}
      </div>` : ''}
      ${period ? `<div style="background:#f9fafb;border:1px solid #e8e8e8;border-left:4px solid ${BRAND.green};border-radius:6px;padding:12px;font-size:13px">
        <strong>Rental Period:</strong> ${period.start.toLocaleDateString(undefined, { timeZone: 'UTC' })} – ${period.due.toLocaleDateString(undefined, { timeZone: 'UTC' })} (${period.days} day${period.days === 1 ? '' : 's'})<br>
        <strong>Return Due:</strong> ${period.due.toLocaleDateString(undefined, { timeZone: 'UTC' })}
      </div>` : ''}
      ${section('Rental Items')}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb">
          <th style="${th};text-align:left">Item</th>
          <th style="${th};text-align:center">Qty</th>
          <th style="${th};text-align:right">Est. Rental Fee</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${servicesTable}
      ${section('Quote Summary')}
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444">
        ${summaryRows}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">TOTAL DUE AT CHECKOUT</td><td style="font-size:16px;font-weight:700;color:${BRAND.black};text-align:right">${fmt(sum.total)}</td></tr>
      </table>
      <div style="margin-top:16px;padding:10px 12px;background:#f9fafb;border:1px solid #e8e8e8;border-radius:6px;font-size:12px;color:#555;line-height:1.5">
        ${sum.deposit_waived ? '' : `The refundable deposit (${fmt(sum.deposit)}) is returned when the equipment comes back on time and in the condition it went out; late return or damage charges are deducted from it.<br>`}
        Rental fees are estimated for the period shown and are finalized at checkout based on the actual checkout time and return due date.
      </div>
      ${q.notes ? `<div style="margin-top:12px;font-size:13px;color:#444"><strong>Notes:</strong> ${q.notes}</div>` : ''}
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
      e.first_name || ' ' || e.last_name as employee_name, cbe.first_name || ' ' || cbe.last_name as created_by_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city,
      b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone
      FROM transactions t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN employees cbe ON cbe.id = COALESCE(t.created_by, t.employee_id)
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

// Send the comprehensive rental agreement summary — checkout through return
// through however the deposit was settled. Mirrors GET
// /rentals/agreements/:id's joins (routes/rentals.js) so the emailed copy
// carries the same fields the in-app print view reads.
router.post('/send-rental-summary/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name,
      b.name as branch_name, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone,
      co.payment_method as checkout_payment_method, co.subtotal as checkout_subtotal, co.tax_amount as checkout_tax_amount, co.discount_amount as checkout_discount_amount, co.total as checkout_total, co.created_at as checkout_created_at,
      se.total as settlement_total, se.payment_method as settlement_payment_method, se.amount_tendered as settlement_amount_tendered, se.change_amount as settlement_change_amount, se.created_at as settlement_created_at,
      (ra.damage_fee_total + ra.duration_adjustment_total - ra.deposit_total + ra.tax_adjustment_total) as balance_due,
      ise.first_name || ' ' || ise.last_name as issue_security_employee_name,
      rse.first_name || ' ' || rse.last_name as return_security_employee_name,
      rde.first_name || ' ' || rde.last_name as return_driver_employee_name,
      cne.first_name || ' ' || cne.last_name as credit_note_issued_by_name,
      dre.first_name || ' ' || dre.last_name as deposit_return_recorded_by_name
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN transactions co ON ra.checkout_transaction_id = co.id
      LEFT JOIN transactions se ON ra.settlement_transaction_id = se.id
      LEFT JOIN employees ise ON ra.issue_security_employee_id = ise.id
      LEFT JOIN employees rse ON ra.return_security_employee_id = rse.id
      LEFT JOIN employees rde ON ra.return_driver_employee_id = rde.id
      LEFT JOIN employees cne ON ra.credit_note_issued_by = cne.id
      LEFT JOIN employees dre ON ra.deposit_return_recorded_by = dre.id
      WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Rental agreement not found' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    agreement.items = attachRateBasis(items, rentalWindow(agreement.checkout_created_at || new Date(), agreement.due_date));

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Rental Agreement Summary - ${agreement.agreement_number} from ${s.store_name || 'Our Store'}`,
        html: buildRentalSummaryHtml(agreement, s),
      });
      res.json({ success: true, message: `Rental agreement summary sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send the rental tax invoice — always the checkout transaction, same as
// printRentalInvoice() in public/index.html, so the item(s) rented and
// pricing come from a real product line rather than a settlement's
// duration-adjustment/deposit lines. Issue and Return signatures (whichever
// are on file) are pulled from the agreement itself either way.
router.post('/send-rental-invoice/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name, c.email as customer_email,
      b.name as branch_name,
      ise.first_name || ' ' || ise.last_name as issue_security_employee_name,
      rse.first_name || ' ' || rse.last_name as return_security_employee_name,
      rde.first_name || ' ' || rde.last_name as return_driver_employee_name
      FROM rental_agreements ra
      LEFT JOIN customers c ON ra.customer_id = c.id
      LEFT JOIN branches b ON ra.branch_id = b.id
      LEFT JOIN employees ise ON ra.issue_security_employee_id = ise.id
      LEFT JOIN employees rse ON ra.return_security_employee_id = rse.id
      LEFT JOIN employees rde ON ra.return_driver_employee_id = rde.id
      WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Rental agreement not found' });
    if (!agreement.checkout_transaction_id) return res.status(400).json({ error: 'This rental has not been checked out yet' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM rental_agreement_items WHERE agreement_id = ?', args: [req.params.id] });
    agreement.items = items;

    const { rows: [tx] } = await db.execute({ sql: `SELECT t.*, b.address as branch_address, b.city as branch_city, b.state as branch_state, b.zip as branch_zip, b.phone as branch_phone, e.first_name || ' ' || e.last_name as employee_name, cbe.first_name || ' ' || cbe.last_name as created_by_name
      FROM transactions t LEFT JOIN branches b ON t.branch_id = b.id LEFT JOIN employees e ON t.employee_id = e.id LEFT JOIN employees cbe ON cbe.id = COALESCE(t.created_by, t.employee_id) WHERE t.id = ?`, args: [agreement.checkout_transaction_id] });
    if (!tx) return res.status(404).json({ error: 'Checkout transaction not found' });
    const { rows: txItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [agreement.checkout_transaction_id] });
    tx.items = txItems;

    const s = await getSettings();
    const origin = `${req.protocol}://${req.get('host')}`;
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Rental Tax Invoice - ${agreement.agreement_number} from ${s.store_name || 'Our Store'}`,
        html: buildRentalInvoiceHtml(agreement, tx, s, origin),
      });
      res.json({ success: true, message: `Rental tax invoice sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function loadQuoteForDocument(id) {
  const { rows: [q] } = await db.execute({ sql: `SELECT q.*, c.first_name || ' ' || c.last_name as customer_name,
    c.customer_number, c.email as customer_email, c.phone as customer_phone,
    c.address as customer_address, c.city as customer_city, c.state as customer_state, c.zip as customer_zip,
    b.name as branch_name, e.first_name || ' ' || e.last_name as employee_name
    FROM quotations q
    LEFT JOIN customers c ON q.customer_id = c.id
    LEFT JOIN branches b ON q.branch_id = b.id
    LEFT JOIN employees e ON q.employee_id = e.id
    WHERE q.id = ?`, args: [id] });
  if (!q) return null;
  const { rows: items } = await db.execute({ sql: 'SELECT * FROM quotation_items WHERE quote_id = ? ORDER BY id', args: [id] });
  q.items = items;
  if (q.quote_type === 'rental') {
    await attachRentalRates(db, q.items);
    attachRateBasis(q.items, rentalWindow(q.created_at, q.due_date));
  }
  return q;
}

// Quotation print preview — opened directly in a browser tab (Print on the
// quote view), same shared-template pattern as work-order-preview, so the
// printed letter-size copy matches the emailed one.
router.get('/quote-preview/:id', requireAuth, async (req, res) => {
  try {
    const q = await loadQuoteForDocument(req.params.id);
    if (!q) return res.status(404).send('<p>Quotation not found</p>');
    const s = await getSettings();
    res.setHeader('Content-Type', 'text/html');
    res.send(q.quote_type === 'rental' ? buildRentalQuoteHtml(q, s, { print: true }) : buildQuoteHtml(q, s));
  } catch(e) { res.status(500).send(`<p>Error: ${e.message}</p>`); }
});

// Send quotation
router.post('/send-quote/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });

  try {
    const q = await loadQuoteForDocument(req.params.id);
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    const isRental = q.quote_type === 'rental';

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `${isRental ? 'Rental Quotation' : 'Quotation'} ${q.quote_number} from ${s.store_name || 'Our Store'}`,
        html: isRental ? buildRentalQuoteHtml(q, s) : buildQuoteHtml(q, s),
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
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:${BRAND.black}">GOODS RECEIVED NOTE</div>
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

// Shared by the approved-PO print preview and the email-it action below —
// same absolute-URL-for-the-signature reasoning as buildRentalInvoiceHtml: a
// locally-stored (non-Cloudinary) /uploads/... signature path only resolves
// against this server's own origin, which an email client can't infer on
// its own, so both callers pass the request's real origin.
function buildApprovedPoHtml(po, s, origin) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = s.store_address || '';
  const storePhone = s.store_phone || '';
  const absUrl = (path) => !path ? null : (/^https?:\/\//.test(path) ? path : (origin ? `${origin}${path}` : path));

  const rows = (po.items || []).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku || ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity_ordered}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(i.unit_cost)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Purchase Order ${po.po_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:${BRAND.black}">PURCHASE ORDER</div>
          <div style="font-size:13px;color:#888;margin-top:2px">${po.po_number}</div>
        </div>
        <div style="text-align:right;font-size:13px;color:#444">
          <div><strong>Approved:</strong> ${po.approved_at ? new Date(po.approved_at).toLocaleDateString() : '—'}</div>
          ${po.branch_name ? `<div><strong>Branch:</strong> ${po.branch_name}</div>` : ''}
          ${po.vendor_order_number ? `<div><strong>Vendor Order #:</strong> ${po.vendor_order_number}</div>` : ''}
        </div>
      </div>
      ${po.supplier_name ? `<div style="background:#f9fafb;border:1px solid #e8e8e8;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px">
        <strong>Supplier:</strong><br>${po.supplier_name}${po.supplier_contact ? `<br>${po.supplier_contact}` : ''}${po.supplier_email ? `<br>${po.supplier_email}` : ''}
      </div>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Item</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Qty</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Unit Cost</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="text-align:right;margin-top:10px;font-size:15px;font-weight:700;color:${BRAND.black}">Total: ${fmt(po.total)}</div>
      ${po.notes ? `<div style="margin-top:16px;font-size:13px;color:#444"><strong>Notes:</strong> ${po.notes}</div>` : ''}
      ${po.approval_signature ? `
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e8e8e8">
        <div style="font-size:10px;font-weight:bold;text-transform:uppercase;color:#888;margin-bottom:6px">Approved By</div>
        <img src="${absUrl(po.approval_signature)}" style="max-height:60px;max-width:220px;border-bottom:1px solid #333;padding-bottom:4px;display:block" />
        <div style="font-size:12px;color:#555;margin-top:4px">${po.approved_by_name || ''}</div>
        ${po.approved_at ? `<div style="font-size:11px;color:#888">${new Date(po.approved_at).toLocaleString()}</div>` : ''}
      </div>` : ''}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Purchase order print preview — opened directly in a browser tab (Print
// button on the PO detail view), same shared-template pattern as
// statement-preview below. Requires the PO to already be approved (the
// document's whole point is showing that signature).
router.get('/po-preview/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email,
      b.name as branch_name, ea.first_name || ' ' || ea.last_name as approved_by_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN branches b ON po.branch_id = b.id
      LEFT JOIN employees ea ON po.approved_by = ea.id
      WHERE po.id = ?`, args: [req.params.id] });
    if (!po) return res.status(404).send('<p>Purchase order not found</p>');
    if (po.status !== 'approved') return res.status(400).send('<p>This purchase order has not been approved yet</p>');
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    po.items = items;
    const s = await getSettings();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.setHeader('Content-Type', 'text/html');
    res.send(buildApprovedPoHtml(po, s, origin));
  } catch(e) { res.status(500).send(`<p>Error: ${e.message}</p>`); }
});

// Email the approved PO document (with the approver's signature) to the
// supplier or anyone else who needs it.
router.post('/send-po/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [po] } = await db.execute({ sql: `SELECT po.*, s.name as supplier_name, s.contact_name as supplier_contact, s.email as supplier_email,
      b.name as branch_name, ea.first_name || ' ' || ea.last_name as approved_by_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN branches b ON po.branch_id = b.id
      LEFT JOIN employees ea ON po.approved_by = ea.id
      WHERE po.id = ?`, args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'approved') return res.status(400).json({ error: 'This purchase order has not been approved yet' });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    po.items = items;

    const s = await getSettings();
    const origin = `${req.protocol}://${req.get('host')}`;
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Purchase Order ${po.po_number} from ${s.store_name || 'Our Store'}`,
        html: buildApprovedPoHtml(po, s, origin),
      });
      res.json({ success: true, message: `Purchase order sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
            <td style="padding:4px 8px;font-size:11px;color:${BRAND.green};border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(a.amount)}</td>
          </tr>`).join('')
      : `<tr style="background:#f9fafb"><td colspan="4" style="padding:4px 8px 4px 28px;font-size:11px;color:#aaa;border-bottom:1px solid #f0f0f0;font-style:italic">No invoice allocations</td></tr>`;
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-weight:700;font-size:13px">${p.payment_number}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-size:13px">${new Date(p.created_at).toLocaleDateString()}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-size:13px">${(p.payment_method||'cash').replace(/_/g,' ').toUpperCase()}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;font-size:13px;text-align:right;font-weight:700;color:${BRAND.green}">${fmt(p.amount)}</td>
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
    <tr><td style="${BRAND_HEADER_STYLE}">
      ${origin ? `<div style="text-align:left;margin-bottom:8px">${logoImgTag(s, origin)}</div>` : ''}
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:4px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
        <tr>
          <td style="vertical-align:top">
            <div style="font-size:20px;font-weight:700;color:${BRAND.black}">ACCOUNT STATEMENT</div>
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
          <td style="font-size:15px;font-weight:700;color:${BRAND.black};padding:4px 0">Total Payments</td>
          <td style="font-size:15px;font-weight:700;color:${BRAND.green};text-align:right;padding:4px 0">${fmt(totalPayments)}</td>
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

function buildWorkOrderReadyHtml(wo, s) {
  const storeName = s.store_name || 'My Store';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Work Order ${wo.wo_number} Ready</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    ${docHeader(storeName, wo.branch_name, s.store_address, s.store_phone, 'Ready for Pickup', `Ref: ${wo.wo_number}`)}
    <tr><td style="padding:0 24px 20px">
      ${wo.customer_name ? docRow('Customer', wo.customer_name) : ''}
      ${wo.item_label ? docRow('Item', wo.item_label) : ''}
      ${docRow('Completed', wo.completed_at ? new Date(wo.completed_at).toLocaleString() : '—')}
      ${docRow('Pickup By', wo.pickup_due_date ? new Date(wo.pickup_due_date).toLocaleDateString() : '—', '#dc2626')}
      <div style="text-align:center;margin-top:20px;font-size:14px;color:#333">Your item is ready for pickup. Please bring this reference number with you.</div>
      <div style="text-align:center;margin-top:16px;font-size:11px;color:#999">Pickup must happen by the date above.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Mirrors send-cancellation-receipt exactly — same getSettings/
// createTransporter/sendMail sequence every other doc-email route uses.
router.post('/send-work-order-ready/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [wo] } = await db.execute({ sql: `SELECT wo.*, c.first_name || ' ' || c.last_name as customer_name, b.name as branch_name
      FROM work_orders wo LEFT JOIN customers c ON wo.customer_id = c.id LEFT JOIN branches b ON wo.branch_id = b.id WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Work order not found' });

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Ready for Pickup - ${wo.wo_number} from ${s.store_name || 'Our Store'}`,
        html: buildWorkOrderReadyHtml(wo, s),
      });
      res.json({ success: true, message: `Notification sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Full work-order invoice (print / email) ────────────────────────────────
// Distinct from buildWorkOrderReadyHtml above (a short "ready for pickup"
// notice) — this is the itemized document: assessment fee, estimate, parts,
// deposit, balance due, everything a customer or cashier needs to see what's
// owed. routes/work-orders.js has its own richer GET /:id (tasks, status log,
// item sourcing) for the management UI; this only needs items, so it re-queries
// directly rather than importing that route's private helpers.
async function loadWorkOrderForInvoice(id) {
  const { rows: [wo] } = await db.execute({ sql: `SELECT wo.*, c.first_name || ' ' || c.last_name as customer_name, c.phone as customer_phone, c.email as customer_email, b.name as branch_name
    FROM work_orders wo
    LEFT JOIN customers c ON wo.customer_id = c.id
    LEFT JOIN branches b ON wo.branch_id = b.id
    WHERE wo.id = ?`, args: [id] });
  if (!wo) return null;
  const { rows: items } = await db.execute({ sql: 'SELECT * FROM work_order_items WHERE work_order_id = ? ORDER BY id', args: [id] });
  wo.items = items;
  return wo;
}

const WO_STATUS_LABELS = {
  intake: 'Intake', assessed: 'Assessed', pending_deposit: 'Pending Deposit', in_progress: 'In Progress',
  awaiting_signoff: 'Awaiting Sign-Off', awaiting_parts: 'Awaiting Parts', complete: 'Complete',
  awaiting_pickup: 'Awaiting Pickup', picked_up: 'Picked Up', cancelled: 'Cancelled', not_worth_fixing: 'Not Worth Fixing',
};

function buildWorkOrderInvoiceHtml(wo, s) {
  const storeName = s.store_name || 'My Store';
  const storeAddr = s.store_address || '';
  const storePhone = s.store_phone || '';
  const footer = s.receipt_footer || 'Thank you for your business!';

  // Same balance-due math as the frontend's viewWorkOrder()/
  // showWOFinalPaymentModal() — kept in sync manually since there's no
  // shared module between routes/ and public/index.html.
  const estimateTotal = (parseFloat(wo.estimate_labor) || 0) + (parseFloat(wo.estimate_consumables) || 0);
  const estimateTax = parseFloat((estimateTotal * (parseFloat(wo.estimate_tax_rate) || 0) / 100).toFixed(2));
  const partsTotal = (wo.items || []).reduce((sum, i) => sum + (parseFloat(i.total) || 0), 0);
  const partsTax = (wo.items || []).reduce((sum, i) => sum + (parseFloat(i.total) || 0) * (parseFloat(i.tax_rate) || 0) / 100, 0);
  // Assessment fee tax is shown as its own line but never folded into
  // Balance Due — that fee is always already paid before a WO can reach any
  // status this invoice covers (see PATCH .../assessment-paid), so it's
  // settled separately, not part of what's still outstanding.
  const assessmentTax = parseFloat(((parseFloat(wo.assessment_fee) || 0) * (parseFloat(wo.assessment_fee_tax_rate) || 0) / 100).toFixed(2));
  const balanceDue = Math.max(0, estimateTotal + partsTotal + estimateTax + partsTax - (parseFloat(wo.deposit_amount) || 0));

  const partRows = (wo.items || []).map(i => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0">${i.product_name}<br><span style="color:#888;font-size:11px">${i.sku || ''}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:center">${i.quantity}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(i.unit_price)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Work Order Tax Invoice ${wo.wo_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
      ${wo.branch_name ? `<div style="color:#ffffff;font-size:13px;margin-top:4px">${wo.branch_name}</div>` : ''}
      ${storeAddr ? `<div style="color:#ffffff;font-size:12px;margin-top:2px">${storeAddr}</div>` : ''}
      ${storePhone ? `<div style="color:#ffffff;font-size:12px">${storePhone}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:${BRAND.black}">WORK ORDER TAX INVOICE</div>
          <div style="font-size:13px;color:#888;margin-top:2px">${wo.wo_number}</div>
        </div>
        <div style="text-align:right;font-size:13px;color:#444">
          <div><strong>Status:</strong> ${WO_STATUS_LABELS[wo.status] || wo.status}${wo.is_express ? ' (Express)' : ''}</div>
          <div><strong>Opened:</strong> ${new Date(wo.created_at).toLocaleDateString()}</div>
          ${wo.pickup_due_date ? `<div><strong>Pickup Due:</strong> ${new Date(wo.pickup_due_date + 'T00:00:00').toLocaleDateString()}</div>` : ''}
        </div>
      </div>
      ${wo.customer_name ? `<div style="background:#f9fafb;border:1px solid #e8e8e8;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px">
        <strong>Customer:</strong><br>${wo.customer_name}${wo.customer_phone ? `<br>${wo.customer_phone}` : ''}${wo.customer_email ? `<br>${wo.customer_email}` : ''}
      </div>` : ''}
      <div style="font-size:13px;color:#444;margin-bottom:16px">
        <strong>Description:</strong> ${wo.description}
        ${wo.item_label ? `<br><strong>Item:</strong> ${wo.item_label}` : ''}
      </div>
      ${partRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8;border-radius:6px;font-size:13px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px;text-align:left;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Part</th>
          <th style="padding:8px;text-align:center;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Qty</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Unit Price</th>
          <th style="padding:8px;text-align:right;font-size:12px;color:#666;border-bottom:1px solid #e8e8e8">Total</th>
        </tr></thead>
        <tbody>${partRows}</tbody>
      </table>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#444;margin-top:12px">
        <tr><td style="padding:3px 0">Assessment Fee</td><td style="text-align:right">${fmt(wo.assessment_fee)}${wo.assessment_transaction_id ? ' <span style="color:${BRAND.green};font-size:11px">(paid)</span>' : ''}</td></tr>
        ${assessmentTax > 0 ? `<tr><td style="padding:3px 0;color:#888;font-size:12px">Tax on Assessment Fee</td><td style="text-align:right;color:#888;font-size:12px">${fmt(assessmentTax)}</td></tr>` : ''}
        ${wo.status !== 'intake' ? `<tr><td style="padding:3px 0">Estimate (labor + consumables)${wo.is_express ? ' — express +25%' : ''}</td><td style="text-align:right">${fmt(estimateTotal)}</td></tr>` : ''}
        ${partsTotal > 0 ? `<tr><td style="padding:3px 0">Parts</td><td style="text-align:right">${fmt(partsTotal)}</td></tr>` : ''}
        ${(estimateTax + partsTax) > 0 ? `<tr><td style="padding:3px 0;color:#888;font-size:12px">Tax (estimate + parts)</td><td style="text-align:right;color:#888;font-size:12px">${fmt(estimateTax + partsTax)}</td></tr>` : ''}
        ${parseFloat(wo.deposit_amount) > 0 ? `<tr><td style="padding:3px 0">Deposit Paid</td><td style="text-align:right">-${fmt(wo.deposit_amount)}${wo.deposit_transaction_id ? ' <span style="color:${BRAND.green};font-size:11px">(paid)</span>' : ''}</td></tr>` : ''}
        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #111;margin:8px 0"></td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:${BRAND.black}">BALANCE DUE</td><td style="font-size:16px;font-weight:700;color:${BRAND.black};text-align:right">${fmt(balanceDue)}${wo.final_transaction_id ? ' <span style="color:${BRAND.green};font-size:11px;font-weight:400">(paid)</span>' : ''}</td></tr>
      </table>
      ${wo.estimate_notes ? `<div style="margin-top:16px;font-size:13px;color:#444"><strong>Estimate Notes:</strong> ${wo.estimate_notes}</div>` : ''}
      <div style="text-align:center;margin-top:20px;font-size:13px;color:#666;font-style:italic">${footer}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Work order invoice print preview — opened directly in a browser tab
// (Print button on the WO detail view and the cashier's final-payment
// modal), same shared-template pattern as po-preview/statement-preview.
router.get('/work-order-preview/:id', requireAuth, async (req, res) => {
  try {
    const wo = await loadWorkOrderForInvoice(req.params.id);
    if (!wo) return res.status(404).send('<p>Work order not found</p>');
    const s = await getSettings();
    res.setHeader('Content-Type', 'text/html');
    res.send(buildWorkOrderInvoiceHtml(wo, s));
  } catch(e) { res.status(500).send(`<p>Error: ${e.message}</p>`); }
});

router.post('/send-work-order-invoice/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const wo = await loadWorkOrderForInvoice(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Work Order Tax Invoice ${wo.wo_number} from ${s.store_name || 'Our Store'}`,
        html: buildWorkOrderInvoiceHtml(wo, s),
      });
      res.json({ success: true, message: `Work order invoice sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Missed pickup: outreach + decision confirmation ───────────────────────
// Two distinct emails for the missed-pickup workflow (see routes/rentals.js):
// one to actually reach the customer when dispatch can't get to them, one to
// document — to the customer, in writing — what was agreed once staff has
// logged their decision. Neither expects or parses a reply; the customer's
// decision itself is recorded by staff via PATCH .../missed-pickup-confirm,
// not by anything in this email.

function buildMissedPickupContactHtml(agreement, message, s) {
  const storeName = s.store_name || 'My Store';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rental Pickup Follow-Up ${agreement.agreement_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    ${docHeader(storeName, agreement.branch_name, s.store_address, s.store_phone, 'Rental Pickup Follow-Up', `Ref: ${agreement.agreement_number}`)}
    <tr><td style="padding:0 24px 20px">
      ${agreement.customer_name ? docRow('Customer', agreement.customer_name) : ''}
      <div style="margin-top:14px;font-size:14px;color:#333;white-space:pre-wrap">${message}</div>
      <div style="text-align:center;margin-top:20px;font-size:11px;color:#999">Please get in touch with us at your earliest convenience to arrange the pickup.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

router.post('/send-missed-pickup-contact/:id', requireAuth, async (req, res) => {
  const { to, message } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name, b.name as branch_name
      FROM rental_agreements ra LEFT JOIN customers c ON ra.customer_id = c.id LEFT JOIN branches b ON ra.branch_id = b.id WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Rental agreement not found' });
    const s = await getSettings();
    const body = (message && message.trim()) || `We tried to pick up the item(s) on rental agreement ${agreement.agreement_number} as scheduled but weren't able to reach you. Please contact us so we can arrange the pickup.`;
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Rental Pickup Follow-Up - ${agreement.agreement_number} from ${s.store_name || 'Our Store'}`,
        html: buildMissedPickupContactHtml(agreement, body, s),
      });
      res.json({ success: true, message: `Follow-up email sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function buildMissedPickupConfirmationHtml(agreement, pause, s) {
  const storeName = s.store_name || 'My Store';
  const isContinue = pause.customer_confirmation === 'continue';
  const summary = isContinue
    ? `This confirms your rental (agreement ${agreement.agreement_number}) will continue. The new pickup date is <strong>${new Date(pause.due_date_after).toLocaleDateString()}</strong>.`
    : `This confirms your rental (agreement ${agreement.agreement_number}) will be closed out. Our team will follow up to finalize the return.`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Rental Confirmation ${agreement.agreement_number}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0">
<tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <tr><td style="${BRAND_HEADER_STYLE}">
      <div style="color:#fff;font-size:22px;font-weight:700">${storeName}</div>
    </td></tr>
    <tr><td style="padding:20px 24px">
      <div style="font-size:18px;font-weight:700;color:${BRAND.black};margin-bottom:2px">Rental ${isContinue ? 'Continuation' : 'Stop'} Confirmation</div>
      <div style="font-size:13px;color:#888;margin-bottom:14px">Ref: ${agreement.agreement_number}</div>
      ${agreement.customer_name ? `<div style="font-size:13px;color:#444;margin-bottom:10px"><strong>Customer:</strong> ${agreement.customer_name}</div>` : ''}
      <div style="font-size:14px;color:#333">${summary}</div>
      <div style="text-align:center;margin-top:20px;font-size:11px;color:#999">If this doesn't match what you agreed to with our team, please contact us right away.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

router.post('/send-missed-pickup-confirmation/:id', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  try {
    const { rows: [agreement] } = await db.execute({ sql: `SELECT ra.*, c.first_name || ' ' || c.last_name as customer_name, b.name as branch_name
      FROM rental_agreements ra LEFT JOIN customers c ON ra.customer_id = c.id LEFT JOIN branches b ON ra.branch_id = b.id WHERE ra.id = ?`, args: [req.params.id] });
    if (!agreement) return res.status(404).json({ error: 'Rental agreement not found' });
    const { rows: [pause] } = await db.execute({ sql: "SELECT * FROM rental_agreement_pauses WHERE agreement_id = ? AND reason = 'missed_pickup' AND customer_confirmation IS NOT NULL ORDER BY id DESC LIMIT 1", args: [req.params.id] });
    if (!pause) return res.status(400).json({ error: 'No recorded customer decision found for this agreement yet' });

    const s = await getSettings();
    try {
      const transporter = createTransporter(s);
      const fromName = s.email_from_name || s.store_name || 'POS System';
      const fromAddr = s.email_smtp_user || s.store_email || '';
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject: `Rental ${pause.customer_confirmation === 'continue' ? 'Continuation' : 'Stop'} Confirmation - ${agreement.agreement_number} from ${s.store_name || 'Our Store'}`,
        html: buildMissedPickupConfirmationHtml(agreement, pause, s),
      });
      res.json({ success: true, message: `Confirmation email sent to ${to}` });
    } catch (e) {
      res.status(500).json({ error: `Failed to send email: ${e.message}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
