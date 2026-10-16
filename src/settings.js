import { db } from './db.js';

const DEFAULT_HOURS = {
  mon: [['09:00', '12:00'], ['14:00', '18:00']],
  tue: [['09:00', '12:00'], ['14:00', '18:00']],
  wed: [['09:00', '12:00'], ['14:00', '18:00']],
  thu: [['09:00', '12:00'], ['14:00', '18:00']],
  fri: [['09:00', '12:00'], ['14:00', '17:00']],
  sat: [],
  sun: [],
};

export const DEFAULTS = {
  // Entreprise
  business_name: 'Mon Entreprise',
  business_description: '',
  business_address: '',
  business_website: '',
  timezone: 'Europe/Paris',
  opening_hours: DEFAULT_HOURS,
  closed_dates: [],

  // Assistant
  assistant_name: 'Léa',
  voice: 'marin',
  voice_speed: 1.0,
  greeting: 'Bonjour, {entreprise}, {assistant} à l\'appareil, comment puis-je vous aider ?',
  custom_instructions: '',
  multilingual: true,
  turn_detection: 'semantic_vad',
  noise_reduction: 'near_field',
  max_call_minutes: 10,
  record_calls: false,

  // Fonctions
  enable_booking: true,
  enable_messages: true,
  enable_transfer: false,
  transfer_number: '',
  transfer_only_open: true,

  // Agenda
  slot_minutes: 30,
  min_notice_hours: 2,
  booking_horizon_days: 30,
  google_calendar_id: '',
  google_service_account: '',

  // Notifications
  notify_emails: '',
  notify_mode: 'all', // all | important | none
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_password: '',
  smtp_from: '',
};

const SECRET_KEYS = ['smtp_password', 'google_service_account'];

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULTS, ...stored };
}

export function getPublicSettings() {
  const s = getSettings();
  for (const k of SECRET_KEYS) {
    s[`has_${k}`] = Boolean(s[k]);
    delete s[k];
  }
  return s;
}

export function updateSettings(patch) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    // Un secret vide envoyé par le formulaire signifie « ne pas modifier »
    if (SECRET_KEYS.includes(k) && (v === '' || v == null)) continue;
    const value = v === '__clear__' ? '' : coerce(k, v);
    upsert.run(k, JSON.stringify(value));
  }
  return getSettings();
}

function coerce(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
  }
  if (typeof def === 'boolean') return value === true || value === 'true' || value === 1;
  if (typeof def === 'string') return String(value ?? '');
  return value;
}
