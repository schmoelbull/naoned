// Client Google Calendar minimal via compte de service (JWT RS256), sans SDK.
import crypto from 'node:crypto';

const tokenCache = new Map();
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function parseServiceAccount(raw) {
  if (!raw) return null;
  const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!sa.client_email || !sa.private_key) throw new Error('JSON de compte de service invalide (client_email/private_key manquants)');
  return sa;
}

async function accessToken(sa) {
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const iat = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud, iat, exp: iat + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google OAuth: ${json.error_description || json.error || res.status}`);
  tokenCache.set(sa.client_email, { token: json.access_token, exp: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

async function gfetch(sa, url, options = {}) {
  const token = await accessToken(sa);
  const res = await fetch(`https://www.googleapis.com/calendar/v3${url}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${json.error?.message || 'erreur'}`);
  return json;
}

export async function freeBusy(sa, calendarId, timeMin, timeMax) {
  const json = await gfetch(sa, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: calendarId }] }),
  });
  const cal = json.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error(`Google Calendar: ${cal.errors.map((e) => e.reason).join(', ')} (le calendrier est-il partagé avec ${sa.client_email} ?)`);
  return (cal?.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function insertEvent(sa, calendarId, event) {
  return gfetch(sa, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(event) });
}

export async function deleteEvent(sa, calendarId, eventId) {
  return gfetch(sa, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
}
