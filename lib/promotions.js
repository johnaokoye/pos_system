// Whether a promotion is currently within its eligible window, given its
// (optional) calendar date range, its (optional) time-of-day window, and
// whether that window recurs daily. Used by both routes/promotions.js
// endpoints (auto-apply and validate-code) so the two can't drift.
//
// Non-recurring: start_time/end_time (if set) only refine the start_date and
// end_date boundary days — a promo from 11/27 to 11/30 with start_time 18:00
// runs all day on the 28th/29th, and only from 18:00 onward on the 27th.
// Recurring: start_time/end_time bound every day in [start_date, end_date]
// (each optional/unbounded); a start_time later than end_time is treated as
// spanning midnight (e.g. 22:00-02:00).
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

// Returns { active, reason }. reason is one of null, 'not_started', 'expired',
// 'outside_daily_window' — set whenever active is false due to timing (the
// caller is expected to have already checked promo.active/code.active).
function promoTimingStatus(promo, now = new Date()) {
  const dateStr = _localDateStr(now);
  if (promo.start_date && dateStr < promo.start_date) return { active: false, reason: 'not_started' };
  if (promo.end_date && dateStr > promo.end_date) return { active: false, reason: 'expired' };

  const startMin = _parseTimeToMinutes(promo.start_time);
  const endMin = _parseTimeToMinutes(promo.end_time);

  if (promo.is_recurring) {
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

module.exports = { promoTimingStatus };
