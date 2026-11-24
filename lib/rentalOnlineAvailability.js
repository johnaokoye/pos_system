// Rental availability for the e-commerce site: per rentable branch, how many
// of an item are free for a customer's dates, not just today.
//
// Every agreement holding units is a booking over store-calendar days:
//   active                  checkout_date → due_date (overdue: until it's back,
//                           so it blocks every later date too)
//   pending/awaiting_issue  a Special Project hold: the project's rental dates
//                           (quotation_items.rental_start/_end); otherwise
//                           today → due_date (a held or paid checkout)
// Out-of-service units have no return date, so they block every date.
// free(start..end) = branch stock − out of service − the most units booked on
// any one day of the range. Today's figure (start = end = today) is the
// same sum as GET /rentals/availability.
const { storeToday } = require('./storeTime');

const FOREVER = '9999-12-31';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

const day = v => (v ? String(v).slice(0, 10) : null);
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// Most units booked on any single day of [start, end]: the peak is on `start`
// or on a day some booking begins.
function peakBooked(bookings, start, end) {
  const points = [start, ...bookings.map(b => b.from).filter(f => f > start && f <= end)];
  let peak = 0;
  for (const p of points) {
    const n = bookings.reduce((t, b) => t + (b.from <= p && b.to >= p ? b.qty : 0), 0);
    if (n > peak) peak = n;
  }
  return peak;
}

function freeFor(cap, bookings, start, end) {
  return Math.max(0, cap - peakBooked(bookings, start, end));
}

// First start date on/after `start` when `qty` are free for the same number
// of days — tried at `start` and the day after each booking ends. null = no
// end in sight (out of service / overdue).
function nextAvailable(cap, bookings, start, end, qty) {
  if (cap < qty) return null;
  const len = daysBetween(start, end);
  const candidates = [...new Set([start, ...bookings.filter(b => b.to >= start && b.to !== FOREVER).map(b => addDays(b.to, 1))])].sort();
  for (const c of candidates) if (freeFor(cap, bookings, c, addDays(c, len)) >= qty) return c;
  return null;
}

function parseRange(q, today) {
  const start = q.start ? String(q.start) : today;
  const end = q.end ? String(q.end) : start;
  if (!DAY_RE.test(start) || !DAY_RE.test(end)) return { error: 'start and end must be dates (YYYY-MM-DD)' };
  if (start < today) return { error: "start can't be before today" };
  if (end < start) return { error: 'end must be on or after start' };
  if (daysBetween(start, end) > MAX_DAYS) return { error: `The range can't be longer than ${MAX_DAYS} days` };
  return { start, end };
}

// productIds: limit to these rental items (accessories need not be online);
// none = every active rental item flagged for the website.
// Units free on each day of [start, end] (for the website's calendar).
function freeByDay(cap, bookings, start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(Math.max(0, cap - bookings.reduce((t, b) => t + (b.from <= d && b.to >= d ? b.qty : 0), 0)));
  }
  return out;
}

// `days`: also give each location `days` = units free on each day start..end.
async function onlineRentalAvailability(db, { productIds, start, end, quantity = 1, days = false }) {
  const today = storeToday();
  const ids = (productIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  const idSql = ids.length ? ` AND p.id IN (${ids.map(() => '?').join(',')})` : ' AND p.online_available = 1';
  const [{ rows: products }, { rows: branches }, { rows: stock }, { rows: oos }, { rows: bookingRows }] = await Promise.all([
    db.execute({ sql: `SELECT p.id, p.sku, p.name FROM products p WHERE p.is_rental = 1 AND p.active = 1${idSql} ORDER BY p.name`, args: ids }),
    db.execute({ sql: 'SELECT id, name, address, city, phone FROM branches WHERE COALESCE(active, 1) = 1 AND COALESCE(is_warehouse, 0) = 0 ORDER BY name', args: [] }),
    db.execute({ sql: `SELECT bi.product_id, bi.branch_id, bi.stock_qty FROM branch_inventory bi JOIN products p ON p.id = bi.product_id
                       WHERE p.is_rental = 1 AND p.active = 1 AND bi.stock_qty > 0${idSql}`, args: ids }),
    db.execute({ sql: `SELECT product_id, branch_id, COALESCE(SUM(quantity), 0) AS qty FROM rental_out_of_service
                       WHERE returned_to_service_at IS NULL GROUP BY product_id, branch_id`, args: [] }),
    db.execute({
      sql: `SELECT rai.product_id, ra.branch_id, ra.status, ra.checkout_date, ra.due_date,
              (SELECT MIN(qi.rental_start) FROM quotation_items qi WHERE qi.rental_agreement_id = ra.id) AS hold_start,
              (SELECT MAX(qi.rental_end) FROM quotation_items qi WHERE qi.rental_agreement_id = ra.id) AS hold_end,
              SUM(rai.quantity - rai.quantity_returned) AS qty
            FROM rental_agreement_items rai JOIN rental_agreements ra ON ra.id = rai.agreement_id
            WHERE ra.status IN ('active', 'pending', 'awaiting_issue')
            GROUP BY rai.product_id, ra.id HAVING SUM(rai.quantity - rai.quantity_returned) > 0`,
      args: [],
    }),
  ]);

  const key = (p, b) => `${p}:${b}`;
  const stockAt = new Map(stock.map(r => [key(r.product_id, r.branch_id), Number(r.stock_qty) || 0]));
  const oosAt = new Map(oos.map(r => [key(r.product_id, r.branch_id), Number(r.qty) || 0]));
  const bookingsAt = new Map();
  for (const r of bookingRows) {
    let from, to;
    if (r.status === 'active') {
      from = day(r.checkout_date) || today;
      to = day(r.due_date) || FOREVER;
      if (to < today) to = FOREVER; // overdue: not back yet
    } else if (r.hold_start) {
      from = day(r.hold_start);
      to = day(r.hold_end) || day(r.due_date) || FOREVER;
    } else {
      from = today;
      to = day(r.due_date) || FOREVER;
    }
    if (from < today) from = today;
    if (to < from) to = from;
    const k = key(r.product_id, r.branch_id);
    if (!bookingsAt.has(k)) bookingsAt.set(k, []);
    bookingsAt.get(k).push({ from, to, qty: Number(r.qty) || 0 });
  }

  const items = products.map(p => {
    const locs = [];
    for (const b of branches) {
      const k = key(p.id, b.id);
      const stockQty = stockAt.get(k) || 0;
      if (stockQty <= 0) continue;
      const outOfService = oosAt.get(k) || 0;
      const cap = Math.max(0, stockQty - outOfService);
      const bookings = bookingsAt.get(k) || [];
      const available = freeFor(cap, bookings, start, end);
      locs.push({
        branch_id: b.id, name: b.name, address: b.address, city: b.city, phone: b.phone,
        stock_qty: stockQty, out_of_service: outOfService,
        available_now: freeFor(cap, bookings, today, today),
        available,
        next_available: available >= quantity ? start : nextAvailable(cap, bookings, start, end, quantity),
        ...(days ? { days: freeByDay(cap, bookings, start, end) } : {}),
      });
    }
    const nexts = locs.map(l => l.next_available).filter(Boolean).sort();
    return {
      product_id: p.id, sku: p.sku, name: p.name,
      stock_qty: locs.reduce((t, l) => t + l.stock_qty, 0),
      available_now: locs.reduce((t, l) => t + l.available_now, 0),
      available: locs.reduce((t, l) => t + l.available, 0),
      next_available: nexts[0] || null,
      locations: locs,
    };
  });
  return { today, start, end, quantity, items };
}

module.exports = { onlineRentalAvailability, parseRange, peakBooked, nextAvailable, freeByDay, FOREVER };
