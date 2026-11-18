// A credit customer's block (customers.account_blocked — what POS and rental
// credit sales check) is the automatic rule (runCreditCheck in
// routes/customers.js: oldest unpaid invoice older than credit_terms_days, or
// balance over the credit limit),
// adjusted by a manual decision in customers.block_override, made with the
// customers_credit_block permission from the customer form's Block box:
//
//   'block'   — blocked by hand while the account is up to date. Stays until
//               someone with the permission unticks it, payments or not.
//   'unblock' — an overdue or over-limit account let through by hand.
//               Cleared by itself once the account is up to date and within
//               its limit, so falling behind again re-blocks it as normal.
//
// Returns the block flag and the override to keep.
function resolveBlock(auto, override) {
  if (override === 'block') return { blocked: 1, override: 'block' };
  if (override === 'unblock') return auto ? { blocked: 0, override: 'unblock' } : { blocked: 0, override: null };
  return { blocked: auto ? 1 : 0, override: null };
}

// What a cashier is told when a blocked customer is put on credit.
function blockedMessage(customer) {
  if (customer.block_override === 'block') {
    return `Customer account is blocked${customer.block_override_reason ? `: ${customer.block_override_reason}` : ''}. Credit sales need it unblocked by someone with permission.`;
  }
  if ((customer.credit_limit || 0) > 0 && (customer.account_balance || 0) - customer.credit_limit > 0.005) {
    return `Customer account is blocked: the balance (${Number(customer.account_balance).toFixed(2)}) is over the credit limit (${Number(customer.credit_limit).toFixed(2)}). A payment is needed to bring it back under the limit.`;
  }
  return 'Customer account is blocked due to overdue payment. Please settle the outstanding balance first.';
}

// Refusal for a credit sale/rental of `amount` that would take the balance
// over the credit limit (0 = unlimited), or null if it fits. An account let
// through by hand ('unblock') may go over — that's what unticking the Block
// box is for.
function creditLimitError(customer, amount, what = 'This sale') {
  const limit = Number(customer.credit_limit) || 0;
  if (limit <= 0 || customer.block_override === 'unblock') return null;
  const balance = Number(customer.account_balance) || 0;
  if (balance + Number(amount) - limit <= 0.005) return null;
  const available = Math.max(0, limit - balance);
  return `${what} (${Number(amount).toFixed(2)}) would take the account over its credit limit of ${limit.toFixed(2)}. Available credit: ${available.toFixed(2)}.`;
}

const isCreditType = t => String(t || '').trim().toLowerCase() === 'credit';

// A quote for a blocked credit customer can be made, but not converted to an
// invoice (Convert → held order / rental agreement, or sold at the POS with
// quote_id) while the account is blocked — unless someone with
// customers_credit_block released that quote (quotations.credit_released_*).
// Returns { error } when it must wait, { released: true } when accounting let
// it through (a credit charge on that sale then skips the block and limit),
// or null when the customer isn't a blocked credit account.
async function quoteCreditHold(executor, quoteId) {
  const { rows: [q] } = await executor.execute({
    sql: `SELECT q.quote_number, q.customer_id, q.credit_released_at, c.first_name, c.last_name, c.customer_type, c.account_blocked,
                 c.block_override, c.block_override_reason, c.credit_limit, c.account_balance
          FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE q.id = ?`,
    args: [quoteId],
  });
  if (!q || !isCreditType(q.customer_type) || !Number(q.account_blocked)) return null;
  if (q.credit_released_at) return { released: true, customer_id: q.customer_id };
  const name = `${q.first_name || ''} ${q.last_name || ''}`.trim() || 'The customer';
  return {
    error: `${q.quote_number} can't be converted to an invoice: ${name}'s credit account is blocked. ${blockedMessage(q)} It can go ahead once the account is cleared, or when accounting releases this quote.`,
  };
}

module.exports = { resolveBlock, blockedMessage, creditLimitError, quoteCreditHold, isCreditType };
