// Single source of truth for rental pricing math — used identically at
// checkout (estimating the fee for checkout -> due date) and at return
// (computing the actual fee for checkout -> real return time). Never
// duplicate this arithmetic elsewhere.
//
// Billing model (confirmed with the business):
// - Duration is decomposed greedily into calendar months (28+ days),
//   then calendar weeks (7+ days), then whole calendar days, then a
//   sub-day remainder — each full block billed at its own configured
//   rate ("mixed blocks + proration", e.g. 10 days = 1 week + 3 days).
// - The sub-day remainder is where TOOLS and EQUIPMENT diverge:
//   - EQUIPMENT bills on an 8-hour work day. A remainder of <= 8 hours
//     is billed at the hourly rate; a remainder of > 8 hours means a
//     full extra work day was effectively used, so it rolls over into
//     one more whole day at the daily rate instead.
//   - TOOLS bill on a 24-hour day with no rollover cap: the remainder
//     is simply prorated continuously as (hours / 24) * dailyRate.
// - TOOLS additionally get volume-discount tiers based on TOTAL rental
//   length, confirmed with the business: renting 7-28 days blends the
//   WHOLE rental down to 85% of the daily rate per day (not just the days
//   past day 6); renting more than 28 days blends the whole rental down to
//   75% of that already-discounted rate per day. This ignores the catalog
//   weekly_rate/monthly_rate columns entirely for tools — both tiers are
//   always derived from the daily rate. Equipment is unaffected and keeps
//   using its configured weekly/monthly rate columns via the block
//   decomposition below.
//
// Elapsed time is rounded DOWN to the last fully-completed hour before any
// of the above runs — billing never happens at minute/second granularity,
// and a partial hour in progress isn't charged until it's actually
// completed. Returning or cancelling within the first hour is free.
//
// `fee` is returned UNROUNDED (full floating-point precision) — rounding to
// cents happens exactly once, after the caller multiplies by quantity (see
// lib/rentals.js's feeFor). Rounding here first and letting the caller
// multiply the already-rounded per-unit fee by qty would compound: e.g. a
// per-unit fee of 84.9915 rounds to 84.99, and ×3 gives 254.97, a cent off
// the correct 254.9745 -> 254.97... — for rates where the discrepancy tips
// the other way, that cent goes the other direction, so the two rounding
// orders don't just differ in edge cases, they can silently disagree by a
// cent (or more, for larger quantities) on real invoices.
function calculateRentalFee({ classification, dailyRate, weeklyRate, monthlyRate, hourlyRate, startDateTime, endDateTime }) {
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  const totalMs = Math.max(0, end - start);
  const totalHours = Math.floor(totalMs / 3600000);
  const totalCalendarDays = totalHours / 24;
  const daily = dailyRate || 0;

  if (classification !== 'equipment' && totalCalendarDays >= 7) {
    const weekTierDayRate = daily * 0.85;
    const perDayRate = totalCalendarDays > 28 ? weekTierDayRate * 0.75 : weekTierDayRate;
    const fee = totalCalendarDays * perDayRate;
    return {
      fee,
      breakdown: { months: 0, weeks: 0, days: Math.floor(totalCalendarDays), hours: Math.round((totalCalendarDays - Math.floor(totalCalendarDays)) * 24 * 100) / 100 },
    };
  }

  const months = Math.floor(totalCalendarDays / 28);
  const remAfterMonths = totalCalendarDays - months * 28;
  const weeks = Math.floor(remAfterMonths / 7);
  const remAfterWeeks = remAfterMonths - weeks * 7;
  let days = Math.floor(remAfterWeeks);
  let remainderHours = (remAfterWeeks - days) * 24;

  const hourly = hourlyRate || 0;
  let hoursBilled = 0;

  if (classification === 'equipment') {
    if (remainderHours > 8) {
      days += 1;
      remainderHours = 0;
    } else {
      hoursBilled = remainderHours;
    }
  } else {
    hoursBilled = remainderHours; // tools: no cap, straight proration below
  }

  const monthlyFee = months * (monthlyRate || 0);
  const weeklyFee = weeks * (weeklyRate || 0);
  const dailyFee = days * daily;
  const hourlyFee = classification === 'equipment' ? hoursBilled * hourly : hoursBilled * (daily / 24);

  const fee = monthlyFee + weeklyFee + dailyFee + hourlyFee;
  return {
    fee,
    breakdown: { months, weeks, days, hours: Math.round(hoursBilled * 100) / 100 },
  };
}

module.exports = { calculateRentalFee };
