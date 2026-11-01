// Dates and times on the store clock — Settings → Store Time Zone
// (`store_timezone`, default America/Jamaica, no DST) — for emails, PDFs and
// anything else the server formats, whatever zone the server itself runs in.
//
// Database timestamps are UTC: CURRENT_TIMESTAMP text with no zone marker
// ("2026-11-01 21:31:08") or ISO with "Z". `new Date()` on the zone-less form
// reads it as server-local time, so always parse through toDate(). A bare
// "YYYY-MM-DD" is a calendar date and is shown as that day, never shifted.

const DEFAULT_TZ = 'America/Jamaica';
const TTL_MS = 60 * 1000;
let cachedTz = DEFAULT_TZ;
let loadedAt = 0;
let loading = null;

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// Re-reads the setting at most once a minute. Await it before formatting
// (the email routes do, via middleware); the sync getters below also kick
// off a background refresh so other callers pick up a changed setting.
async function refreshStoreTz(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return cachedTz;
  if (!loading) {
    loading = (async () => {
      try {
        const { db } = require('../database');
        const { rows } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'store_timezone'", args: [] });
        const tz = String(rows[0]?.value || '').trim();
        cachedTz = tz && validTz(tz) ? tz : DEFAULT_TZ;
      } catch (e) { /* keep the last good zone */ }
      loadedAt = Date.now();
      loading = null;
      return cachedTz;
    })();
  }
  return loading;
}

function storeTz() {
  if (Date.now() - loadedAt >= TTL_MS) refreshStoreTz().catch(() => {});
  return cachedTz;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Any timestamp value → Date (UTC for zone-less database text).
function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v || '').trim();
  if (!s) return new Date(NaN);
  if (DATE_ONLY.test(s)) return new Date(`${s}T00:00:00Z`);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

const isDateOnly = v => typeof v === 'string' && DATE_ONLY.test(v.trim());

// fmtDate(v) → "11/1/2026"; pass Intl options to change the look.
function fmtDate(v, opts = {}) {
  if (v == null || v === '') return '';
  const d = toDate(v);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { ...opts, timeZone: isDateOnly(v) ? 'UTC' : storeTz() });
}

// fmtDateTime(v) → "11/1/2026, 4:31:08 PM"; a bare date shows just the date.
function fmtDateTime(v, opts = {}) {
  if (v == null || v === '') return '';
  if (isDateOnly(v)) return fmtDate(v, opts.month ? { year: opts.year, month: opts.month, day: opts.day } : {});
  const d = toDate(v);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { ...opts, timeZone: storeTz() });
}

// The store-clock calendar day ("YYYY-MM-DD") of a timestamp; a bare date
// comes back as-is. Use this instead of String(created_at).slice(0, 10),
// which is the UTC day (a 9 PM Jamaica sale would land on the next day).
function storeDay(v) {
  if (v == null || v === '') return '';
  if (isDateOnly(v)) return v.trim();
  const d = toDate(v);
  return isNaN(d) ? String(v).slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone: storeTz() });
}

// Today's store-clock date as "YYYY-MM-DD".
function storeToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: storeTz() });
}

module.exports = { DEFAULT_TZ, refreshStoreTz, storeTz, toDate, fmtDate, fmtDateTime, storeDay, storeToday };
