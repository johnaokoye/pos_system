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
// `lines` is the same fee split into the blocks actually billed ({unit,
// count, rate, amount}, per unit of quantity) — what quote/agreement
// documents show as the item's rate, so the customer sees e.g. "1 month +
// 3 days" for a 31-day rental rather than a daily rate that doesn't
// explain the fee. Empty when nothing is billable (under an hour).
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
//
// `ratePlan` ('daily' | 'weekly' | 'monthly', chosen when the rental is set
// up — rental_agreements.rate_plan / quotations.rate_plan) caps the highest
// rate tier the rental may use; null/absent means automatic (the tier the
// length earns, as above). It can only bring a rental DOWN a tier, never up:
// a monthly plan on a rental that's only long enough for the weekly tier
// bills at weekly — so a rental returned early falls back to the tier its
// actual length earns. Setup refuses a plan the planned length doesn't
// earn (see ratePlanError below).
const RATE_PLANS = ['daily', 'weekly', 'monthly'];

// Highest tier a rental of this length qualifies for. Tools get the monthly
// tier only past 28 days (the > 28 test above); equipment's monthly block is
// a full 28 days.
function earnedRatePlan(classification, totalCalendarDays) {
  if (classification === 'equipment') return totalCalendarDays >= 28 ? 'monthly' : totalCalendarDays >= 7 ? 'weekly' : 'daily';
  return totalCalendarDays > 28 ? 'monthly' : totalCalendarDays >= 7 ? 'weekly' : 'daily';
}

function effectiveRatePlan(classification, totalCalendarDays, ratePlan) {
  const earned = earnedRatePlan(classification, totalCalendarDays);
  if (!RATE_PLANS.includes(ratePlan)) return earned;
  return RATE_PLANS[Math.min(RATE_PLANS.indexOf(earned), RATE_PLANS.indexOf(ratePlan))];
}

function billedDays(startDateTime, endDateTime) {
  return Math.floor(Math.max(0, new Date(endDateTime) - new Date(startDateTime)) / 3600000) / 24;
}

// User-facing reason a chosen rate plan can't be used for a rental planned
// over [start, end] with these lines ({name, classification, weeklyRate,
// monthlyRate}), or null when it's fine. Blank = automatic, always allowed.
function ratePlanError(ratePlan, startDateTime, endDateTime, lines = []) {
  if (ratePlan == null || ratePlan === '') return null;
  if (!RATE_PLANS.includes(ratePlan)) return 'Rate must be daily, weekly or monthly';
  const days = billedDays(startDateTime, endDateTime);
  for (const l of lines) {
    const earned = earnedRatePlan(l.classification || 'tool', days);
    if (RATE_PLANS.indexOf(ratePlan) > RATE_PLANS.indexOf(earned)) {
      const need = ratePlan === 'weekly' ? 'at least 7 days' : (l.classification === 'equipment' ? 'at least 28 days' : 'more than 28 days');
      return `A ${ratePlan} rate needs a rental of ${need} — this one is ${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}. Pick a later due date or a different rate.`;
    }
    if (l.classification === 'equipment' && ratePlan === 'weekly' && !(l.weeklyRate > 0)) return `"${l.name}" has no weekly rate set — pick a different rate or set one on the item`;
    if (l.classification === 'equipment' && ratePlan === 'monthly' && !(l.monthlyRate > 0)) return `"${l.name}" has no monthly rate set — pick a different rate or set one on the item`;
  }
  return null;
}

function calculateRentalFee({ classification, dailyRate, weeklyRate, monthlyRate, hourlyRate, startDateTime, endDateTime, ratePlan }) {
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  const totalMs = Math.max(0, end - start);
  const totalHours = Math.floor(totalMs / 3600000);
  const totalCalendarDays = totalHours / 24;
  const daily = dailyRate || 0;
  const plan = effectiveRatePlan(classification, totalCalendarDays, ratePlan);

  if (classification !== 'equipment' && plan !== 'daily') {
    const weekTierDayRate = daily * 0.85;
    const perDayRate = plan === 'monthly' ? weekTierDayRate * 0.75 : weekTierDayRate;
    const fee = totalCalendarDays * perDayRate;
    return {
      fee,
      lines: [{ unit: 'day', count: totalCalendarDays, rate: perDayRate, amount: fee, tier: plan }],
      breakdown: { months: 0, weeks: 0, days: Math.floor(totalCalendarDays), hours: Math.round((totalCalendarDays - Math.floor(totalCalendarDays)) * 24 * 100) / 100 },
    };
  }

  // A tool on the daily plan for 7+ days: every day at the full daily rate.
  if (classification !== 'equipment' && totalCalendarDays >= 7) {
    const fee = totalCalendarDays * daily;
    return {
      fee,
      lines: [{ unit: 'day', count: totalCalendarDays, rate: daily, amount: fee }],
      breakdown: { months: 0, weeks: 0, days: Math.floor(totalCalendarDays), hours: Math.round((totalCalendarDays - Math.floor(totalCalendarDays)) * 24 * 100) / 100 },
    };
  }

  // Equipment on a capped plan skips the blocks above it: weekly = no
  // months, daily = no months or weeks.
  const months = plan === 'monthly' ? Math.floor(totalCalendarDays / 28) : 0;
  const remAfterMonths = totalCalendarDays - months * 28;
  const weeks = plan === 'daily' ? 0 : Math.floor(remAfterMonths / 7);
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
  const lines = [
    { unit: 'month', count: months, rate: monthlyRate || 0, amount: monthlyFee },
    { unit: 'week', count: weeks, rate: weeklyRate || 0, amount: weeklyFee },
    { unit: 'day', count: days, rate: daily, amount: dailyFee },
    { unit: 'hour', count: Math.round(hoursBilled * 100) / 100, rate: classification === 'equipment' ? hourly : daily / 24, amount: hourlyFee },
  ].filter(l => l.count > 0);
  return {
    fee,
    lines,
    breakdown: { months, weeks, days, hours: Math.round(hoursBilled * 100) / 100 },
  };
}

module.exports = { calculateRentalFee, ratePlanError, earnedRatePlan, RATE_PLANS };
