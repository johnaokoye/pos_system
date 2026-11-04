// Store-clock date helpers: database timestamps are UTC, the screen shows settings.store_timezone.
Object.assign(App, {
  // SQLite's datetime('now') / CURRENT_TIMESTAMP are UTC but carry no zone
  // marker ("2026-09-29 14:05:00"); new Date() would read that as local time.
  _utcDate(d) {
    if (!d) return null;
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : String(d).replace(' ', 'T') + 'Z');
  },

  // A UTC database timestamp shown on the store's clock (Settings → Store
  // Time Zone, default America/Jamaica — no DST), whatever time zone the
  // device itself is set to.
  _storeTz() {
    const tz = (this.settings?.store_timezone || '').trim() || 'America/Jamaica';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'America/Jamaica'; }
  },
  // Any timestamp value → Date: Date objects and epoch ms as-is, strings via
  // _utcDate (zone-less database text is UTC).
  _toDate(d) {
    if (d instanceof Date) return d;
    if (typeof d === 'number') return new Date(d);
    return this._utcDate(d) || new Date(NaN);
  },
  // The store-clock calendar day ("YYYY-MM-DD") of a timestamp.
  _storeDay(d) {
    const dt = this._toDate(d);
    return isNaN(dt) ? '' : dt.toLocaleDateString('en-CA', { timeZone: this._storeTz() });
  },
  // A store-clock "YYYY-MM-DDTHH:MM" (a datetime-local input) → UTC in the
  // database's own format ("YYYY-MM-DD HH:MM:SS"), whatever the device zone.
  _storeLocalToUtc(v) {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: this._storeTz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return new Date(guess - (asIfUtc - guess)).toISOString().slice(0, 19).replace('T', ' ');
  },
  _storeTime(d) {
    const dt = d instanceof Date ? d : this._utcDate(d);
    return dt && !isNaN(dt) ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: this._storeTz() }) : '';
  },
  _storeDateTime(d) {
    const dt = d instanceof Date ? d : this._utcDate(d);
    return dt && !isNaN(dt) ? dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: this._storeTz() }) : '';
  },

  _timeAgo(d) {
    const dt = this._utcDate(d);
    if (!dt) return '-';
    const sec = Math.max(0, Math.round((Date.now() - dt.getTime()) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m ago`;
    return this.fmtDateTime(dt);
  },

});
