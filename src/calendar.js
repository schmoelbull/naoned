import { db } from './db.js';
import * as google from './google.js';
import {
  zonedParts, zonedToUtc, weekdayOf, addDays, formatDateFr, formatFr, isDateStr, isTimeStr,
} from './time.js';

function googleConfig(settings) {
  if (!settings.google_calendar_id || !settings.google_service_account) return null;
  return { sa: google.parseServiceAccount(settings.google_service_account), calendarId: settings.google_calendar_id };
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

async function busyPeriods(settings, from, to) {
  const local = db.prepare(
    "SELECT start_utc, end_utc FROM appointments WHERE status = 'confirmed' AND end_utc > ? AND start_utc < ?",
  ).all(from.toISOString(), to.toISOString())
    .map((r) => ({ start: new Date(r.start_utc), end: new Date(r.end_utc) }));
  const g = googleConfig(settings);
  if (!g) return local;
  const remote = await google.freeBusy(g.sa, g.calendarId, from, to);
  return [...local, ...remote];
}

function candidateSlots(settings, dateStr) {
  if ((settings.closed_dates || []).includes(dateStr)) return [];
  const ranges = settings.opening_hours?.[weekdayOf(dateStr)] || [];
  const dur = settings.slot_minutes;
  const slots = [];
  for (const [open, close] of ranges) {
    const end = zonedToUtc(dateStr, close, settings.timezone);
    for (let t = zonedToUtc(dateStr, open, settings.timezone); t.getTime() + dur * 60_000 <= end.getTime();
      t = new Date(t.getTime() + dur * 60_000)) {
      slots.push({ start: t, end: new Date(t.getTime() + dur * 60_000) });
    }
  }
  return slots;
}

/** Créneaux libres pour une date locale donnée. */
export async function freeSlots(settings, dateStr) {
  const earliest = Date.now() + settings.min_notice_hours * 3_600_000;
  const slots = candidateSlots(settings, dateStr).filter((s) => s.start.getTime() >= earliest);
  if (!slots.length) return [];
  const busy = await busyPeriods(settings, slots[0].start, slots.at(-1).end);
  return slots.filter((s) => !busy.some((b) => overlaps(s.start, s.end, b.start, b.end)));
}

export async function checkAvailability(settings, dateStr) {
  const tz = settings.timezone;
  const today = zonedParts(new Date(), tz).dateStr;
  if (!isDateStr(dateStr)) return { error: 'Date invalide, format attendu AAAA-MM-JJ.' };
  if (dateStr < today) return { error: 'Cette date est déjà passée.' };
  if (dateStr > addDays(today, settings.booking_horizon_days)) {
    return { error: `Les réservations sont ouvertes jusqu'à ${settings.booking_horizon_days} jours à l'avance seulement.` };
  }
  const slots = await freeSlots(settings, dateStr);
  const result = {
    date: dateStr,
    date_label: formatDateFr(dateStr),
    available_times: slots.map((s) => zonedParts(s.start, tz).timeStr),
  };
  if (!slots.length) {
    // Proposer les prochains jours disponibles
    const next = [];
    for (let i = 1; i <= 14 && next.length < 3; i++) {
      const d = addDays(dateStr, i);
      if (d > addDays(today, settings.booking_horizon_days)) break;
      const s = await freeSlots(settings, d);
      if (s.length) next.push({ date: d, date_label: formatDateFr(d), first_times: s.slice(0, 4).map((x) => zonedParts(x.start, tz).timeStr) });
    }
    result.message = 'Aucun créneau libre ce jour-là.';
    result.next_available_days = next;
  }
  return result;
}

export async function bookAppointment(settings, { date, time, name, phone, email, reason }, callId = null) {
  if (!isDateStr(date) || !isTimeStr(time)) return { error: 'Date ou heure invalide (AAAA-MM-JJ et HH:MM).' };
  if (!name) return { error: 'Le nom du client est obligatoire.' };
  const tz = settings.timezone;
  const free = await freeSlots(settings, date);
  const slot = free.find((s) => zonedParts(s.start, tz).timeStr === time);
  if (!slot) {
    return { error: 'Ce créneau n\'est pas disponible.', available_times: free.map((s) => zonedParts(s.start, tz).timeStr) };
  }

  let googleEventId = null;
  const g = googleConfig(settings);
  if (g) {
    const ev = await google.insertEvent(g.sa, g.calendarId, {
      summary: `RDV ${name}${reason ? ` – ${reason}` : ''}`,
      description: [`Pris par l'assistant téléphonique ${settings.assistant_name}`,
        phone && `Téléphone : ${phone}`, email && `E-mail : ${email}`, reason && `Motif : ${reason}`].filter(Boolean).join('\n'),
      start: { dateTime: slot.start.toISOString(), timeZone: tz },
      end: { dateTime: slot.end.toISOString(), timeZone: tz },
    });
    googleEventId = ev.id;
  }

  const info = db.prepare(`INSERT INTO appointments (call_id, name, phone, email, reason, start_utc, end_utc, google_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(callId, name, phone || null, email || null, reason || null,
    slot.start.toISOString(), slot.end.toISOString(), googleEventId);

  return {
    success: true,
    appointment_id: Number(info.lastInsertRowid),
    confirmed_for: formatFr(slot.start, tz),
    duration_minutes: settings.slot_minutes,
  };
}

export async function cancelAppointment(settings, id) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appt) throw new Error('Rendez-vous introuvable');
  const g = googleConfig(settings);
  if (g && appt.google_event_id) {
    await google.deleteEvent(g.sa, g.calendarId, appt.google_event_id).catch((e) => {
      if (!String(e.message).includes('410')) throw e;
    });
  }
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(id);
}

export async function testGoogle(settings) {
  const g = googleConfig(settings);
  if (!g) throw new Error('Renseignez l\'identifiant du calendrier et le JSON du compte de service.');
  const now = new Date();
  const busy = await google.freeBusy(g.sa, g.calendarId, now, new Date(now.getTime() + 7 * 86_400_000));
  return { ok: true, service_account: g.sa.client_email, busy_periods_next_7_days: busy.length };
}
