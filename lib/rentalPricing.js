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
//
// Elapsed time is rounded DOWN to the last fully-completed hour before any
// of the above runs — billing never happens at minute/second granularity,
// and a partial hour in progress isn't charged until it's actually
// completed. Returning or cancelling within the first hour is free.
function calculateRentalFee({ classification, dailyRate, weeklyRate, monthlyRate, hourlyRate, startDateTime, endDateTime }) {
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  const totalMs = Math.max(0, end - start);
  const totalHours = Math.floor(totalMs / 3600000);
  const totalCalendarDays = totalHours / 24;

  const months = Math.floor(totalCalendarDays / 28);
  const remAfterMonths = totalCalendarDays - months * 28;
  const weeks = Math.floor(remAfterMonths / 7);
  const remAfterWeeks = remAfterMonths - weeks * 7;
  let days = Math.floor(remAfterWeeks);
  let remainderHours = (remAfterWeeks - days) * 24;

  const daily = dailyRate || 0;
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
    fee: Math.round(fee * 100) / 100,
    breakdown: { months, weeks, days, hours: Math.round(hoursBilled * 100) / 100 },
  };
}

module.exports = { calculateRentalFee };
