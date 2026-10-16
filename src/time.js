// Utilitaires de fuseau horaire sans dépendance (Intl uniquement).

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_LABELS = {
  mon: 'lundi', tue: 'mardi', wed: 'mercredi', thu: 'jeudi', fri: 'vendredi', sat: 'samedi', sun: 'dimanche',
};

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsCache.get(tz);
}

/** Composantes de date/heure locales d'un instant dans un fuseau. */
export function zonedParts(date, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  const year = +p.year, month = +p.month, day = +p.day;
  return {
    year, month, day, hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: DAY_KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()],
    dateStr: `${p.year}-${p.month}-${p.day}`,
    timeStr: `${p.hour}:${p.minute}`,
  };
}

function offsetMs(ts, tz) {
  const p = zonedParts(new Date(ts), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** Convertit une date locale "YYYY-MM-DD" + "HH:MM" d'un fuseau en Date UTC. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMs(guess, tz);
  ts = guess - offsetMs(ts, tz); // correction autour des changements d'heure
  return new Date(ts);
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function formatFr(date, tz, opts = {}) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', ...opts,
  }).format(date);
}

export function formatDateFr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isTimeStr = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** L'entreprise est-elle ouverte à l'instant `date` ? */
export function isOpenAt(settings, date = new Date()) {
  const p = zonedParts(date, settings.timezone);
  if ((settings.closed_dates || []).includes(p.dateStr)) return false;
  const ranges = settings.opening_hours?.[p.weekday] || [];
  return ranges.some(([a, b]) => p.timeStr >= a && p.timeStr < b);
}
