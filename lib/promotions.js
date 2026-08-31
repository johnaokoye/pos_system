// Whether a promotion is currently within its eligible window, given its
// (optional) calendar date range, its (optional) time-of-day window, and its
// recurrence pattern. Used by both routes/promotions.js endpoints
// (auto-apply and validate-code) so the two can't drift.
//
// recurrence_type 'none': start_time/end_time (if set) only refine the
// start_date and end_date boundary days — a promo from 11/27 to 11/30 with
// start_time 18:00 runs all day on the 28th/29th, and only from 18:00 onward
// on the 27th.
// 'daily'/'weekly'/'monthly'/'yearly': start_time/end_time bound every
// matching day within [start_date, end_date] (each optional/unbounded); a
// start_time later than end_time is treated as spanning midnight (e.g.
// 22:00-02:00). 'weekly' matches the day(s) of week in recurrence_days
// (falls back to start_date's own weekday if empty/unset). 'monthly'/'yearly'
// match start_date's day-of-month / month-and-day (clamped to the last day
// of a shorter month).
function _localDateStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _minutesSinceMidnight(d) {
  return d.getHours() * 60 + d.getMinutes();
}

function _parseTimeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

// start_date is stored as a plain 'YYYY-MM-DD' string — parse it as a local
// date (not UTC) so its weekday/day-of-month match what the user picked.
function _parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function _safeParseDays(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(Number).filter(n => n >= 0 && n <= 6) : [];
  } catch { return []; }
}

function _recurrenceType(promo) {
  if (promo.recurrence_type) return promo.recurrence_type;
  return promo.is_recurring ? 'daily' : 'none';
}

// Whether `now`'s calendar date matches the recurrence pattern (independent
// of the time-of-day window). Only meaningful for recurrence_type !== 'none'.
function _matchesRecurrenceDate(promo, type, now) {
  if (type === 'daily') return true;
  if (type === 'weekly') {
    const days = _safeParseDays(promo.recurrence_days);
    if (days.length) return days.includes(now.getDay());
    if (promo.start_date) return _parseLocalDate(promo.start_date).getDay() === now.getDay();
    return true;
  }
  if (type === 'monthly') {
    if (!promo.start_date) return true;
    const anchorDay = _parseLocalDate(promo.start_date).getDate();
    const lastDayOfThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() === Math.min(anchorDay, lastDayOfThisMonth);
  }
  if (type === 'yearly') {
    if (!promo.start_date) return true;
    const anchor = _parseLocalDate(promo.start_date);
    const lastDayOfThisMonth = new Date(now.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    return now.getMonth() === anchor.getMonth() && now.getDate() === Math.min(anchor.getDate(), lastDayOfThisMonth);
  }
  return true;
}

// Returns { active, reason }. reason is one of null, 'not_started', 'expired',
// 'not_recurrence_day', 'outside_daily_window' — set whenever active is false
// due to timing (the caller is expected to have already checked
// promo.active/code.active).
function promoTimingStatus(promo, now = new Date()) {
  const dateStr = _localDateStr(now);
  if (promo.start_date && dateStr < promo.start_date) return { active: false, reason: 'not_started' };
  if (promo.end_date && dateStr > promo.end_date) return { active: false, reason: 'expired' };

  const type = _recurrenceType(promo);
  const startMin = _parseTimeToMinutes(promo.start_time);
  const endMin = _parseTimeToMinutes(promo.end_time);

  if (type !== 'none') {
    if (!_matchesRecurrenceDate(promo, type, now)) return { active: false, reason: 'not_recurrence_day' };
    if (startMin == null && endMin == null) return { active: true, reason: null };
    const nowMin = _minutesSinceMidnight(now);
    const s = startMin ?? 0, e = endMin ?? 1439;
    const inWindow = s <= e ? (nowMin >= s && nowMin <= e) : (nowMin >= s || nowMin <= e);
    return { active: inWindow, reason: inWindow ? null : 'outside_daily_window' };
  }

  if (startMin != null && promo.start_date && dateStr === promo.start_date && _minutesSinceMidnight(now) < startMin) {
    return { active: false, reason: 'not_started' };
  }
  if (endMin != null && promo.end_date && dateStr === promo.end_date && _minutesSinceMidnight(now) > endMin) {
    return { active: false, reason: 'expired' };
  }
  return { active: true, reason: null };
}

// The portion of `subtotal` that qualifies for `promo`'s discount, given its
// applies_to scope, its promotion_items (products/categories) when scoped,
// and its promotion_brands inclusion/exclusion rows. `brandByProduct` maps
// cart product_id -> that product's brand (looked up by the caller since
// cart_items don't carry brand themselves). When the promo needs no
// filtering at all, returns `subtotal` unchanged rather than re-summing
// cartItems — the caller's subtotal is authoritative (cartItems may be a
// partial/empty payload when no filtering is needed to compute it from).
function computeEligibleAmount(promo, cartItems, subtotal, { items = [], brands = [], brandByProduct = {} } = {}) {
  const excludedBrands = new Set(brands.filter(b => b.excluded).map(b => (b.brand || '').toLowerCase()));
  const includedBrands = new Set(brands.filter(b => !b.excluded).map(b => (b.brand || '').toLowerCase()));
  const productIds = new Set(promo.applies_to !== 'categories' ? items.filter(i => i.item_type === 'product').map(i => i.item_id) : []);
  const categoryIds = new Set(promo.applies_to !== 'items' ? items.filter(i => i.item_type === 'category').map(i => i.item_id) : []);

  const isScoped = ['specific', 'categories', 'items', 'brands'].includes(promo.applies_to);
  if (!isScoped && excludedBrands.size === 0) return subtotal;

  return cartItems.reduce((sum, ci) => {
    const brand = (brandByProduct[ci.product_id] || '').toLowerCase();
    if (excludedBrands.has(brand)) return sum;
    if (promo.applies_to === 'brands') return includedBrands.has(brand) ? sum + ci.price * ci.quantity : sum;
    if (isScoped) return (productIds.has(ci.product_id) || categoryIds.has(ci.category_id)) ? sum + ci.price * ci.quantity : sum;
    return sum + ci.price * ci.quantity;
  }, 0);
}

// Single-product counterpart to computeEligibleAmount above, for "is this
// specific item currently covered by this promotion" checks (POS manual
// line-item discounts are blocked on an item already carrying a promotion —
// see routes/promotions.js's discount-eligibility endpoint) rather than
// "how much of a whole cart qualifies." Same targeting rules, just evaluated
// against one product instead of reduced over cart lines.
function promoAppliesToProduct(promo, product, { items = [], brands = [] } = {}) {
  const excludedBrands = new Set(brands.filter(b => b.excluded).map(b => (b.brand || '').toLowerCase()));
  const includedBrands = new Set(brands.filter(b => !b.excluded).map(b => (b.brand || '').toLowerCase()));
  const productIds = new Set(promo.applies_to !== 'categories' ? items.filter(i => i.item_type === 'product').map(i => i.item_id) : []);
  const categoryIds = new Set(promo.applies_to !== 'items' ? items.filter(i => i.item_type === 'category').map(i => i.item_id) : []);
  const isScoped = ['specific', 'categories', 'items', 'brands'].includes(promo.applies_to);
  const brand = (product.brand || '').toLowerCase();

  if (excludedBrands.has(brand)) return false;
  if (promo.applies_to === 'brands') return includedBrands.has(brand);
  if (isScoped) return productIds.has(product.id) || categoryIds.has(product.category_id);
  return true; // applies_to === 'all'
}

module.exports = { promoTimingStatus, computeEligibleAmount, promoAppliesToProduct };
