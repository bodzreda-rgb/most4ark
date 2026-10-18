// Timezone-aware date helpers. All instants are stored as UTC ISO strings;
// they are displayed/edited in the user's configured IANA timezone
// (default Africa/Cairo, DST handled by the platform tz database).

export const DEFAULT_TZ = 'Africa/Cairo';

const pad = (n) => String(n).padStart(2, '0');

function partsInZone(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return {
    y: +o.year, mo: +o.month, d: +o.day,
    h: +o.hour === 24 ? 0 : +o.hour, mi: +o.minute, s: +o.second,
  };
}

/** Offset (minutes) of `tz` from UTC at the given instant. Cairo: +120 winter / +180 summer. */
export function tzOffsetMinutes(date, tz = DEFAULT_TZ) {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** 'YYYY-MM-DDTHH:mm' wall-clock in tz  ->  UTC ISO string. */
export function zonedLocalToUtcIso(local, tz = DEFAULT_TZ) {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error('bad local datetime: ' + local);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let utc = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(utc), tz);
  if (off2 !== off) utc = guess - off2 * 60000;   // crossed a DST boundary
  return new Date(utc).toISOString();
}

/** UTC ISO -> 'YYYY-MM-DDTHH:mm' wall-clock in tz (for <input type="datetime-local">). */
export function utcIsoToZonedLocal(iso, tz = DEFAULT_TZ) {
  if (!iso) return '';
  const p = partsInZone(new Date(iso), tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** 'YYYY-MM-DD' of the instant in tz. */
export function dayKeyOf(iso, tz = DEFAULT_TZ) {
  const p = partsInZone(iso instanceof Date ? iso : new Date(iso), tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function todayKey(tz = DEFAULT_TZ) {
  return dayKeyOf(new Date(), tz);
}

/** UTC ISO of local midnight starting `dayKey` in tz. */
export function startOfDayIso(dayKey, tz = DEFAULT_TZ) {
  return zonedLocalToUtcIso(`${dayKey}T00:00`, tz);
}

export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Egyptian work week starts on Saturday. */
export function startOfWeek(dayKey, weekStart = 6) {
  const diff = (weekdayOf(dayKey) - weekStart + 7) % 7;
  return addDays(dayKey, -diff);
}

export function startOfMonth(dayKey) { return dayKey.slice(0, 7) + '-01'; }

export function daysInMonth(dayKey) {
  const [y, m] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(dayKey, n) {
  const [y, m] = dayKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`;
}

export function diffDays(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Range for a calendar view. Returns UTC ISO bounds (half-open [from, to)) and the
 * list of day keys that the view displays.
 */
export function rangeFor(view, anchor, tz = DEFAULT_TZ, rangeDays = 30) {
  let first; let last;           // inclusive day keys
  if (view === 'day') { first = anchor; last = anchor; }
  else if (view === 'week') { first = startOfWeek(anchor); last = addDays(first, 6); }
  else if (view === 'month') {
    const ms = startOfMonth(anchor);
    first = startOfWeek(ms);
    last = addDays(startOfWeek(addDays(ms, daysInMonth(ms) - 1)), 6);
  } else { first = anchor; last = addDays(anchor, rangeDays - 1); }   // 'next30'
  const days = [];
  for (let d = first; diffDays(d, last) >= 0; d = addDays(d, 1)) days.push(d);
  return {
    first, last, days,
    fromIso: startOfDayIso(first, tz),
    toIso: startOfDayIso(addDays(last, 1), tz),
  };
}

const locale = (lang) => (lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn');

export function formatDateTime(iso, tz = DEFAULT_TZ, lang = 'ar') {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(lang), {
    timeZone: tz, dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h12',
  }).format(new Date(iso));
}
export function formatDate(iso, tz = DEFAULT_TZ, lang = 'ar') {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(lang), { timeZone: tz, dateStyle: 'medium' }).format(new Date(iso));
}
export function formatTime(iso, tz = DEFAULT_TZ, lang = 'ar') {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(lang), { timeZone: tz, timeStyle: 'short', hourCycle: 'h12' }).format(new Date(iso));
}
export function formatDayKey(dayKey, lang = 'ar', opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(lang), { timeZone: 'UTC', ...opts }).format(new Date(Date.UTC(y, m - 1, d)));
}
export function formatMonth(dayKey, lang = 'ar') {
  return formatDayKey(dayKey, lang, { month: 'long', year: 'numeric' });
}
export function weekdayLabels(lang = 'ar', weekStart = 6) {
  const first = startOfWeek('2026-01-07', weekStart);
  return Array.from({ length: 7 }, (_, i) => formatDayKey(addDays(first, i), lang, { weekday: 'short' }));
}
