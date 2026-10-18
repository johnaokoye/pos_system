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

module.exports = { resolveBlock, blockedMessage, creditLimitError };
