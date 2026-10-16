import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { db } from './db.js';
import { getSettings, getPublicSettings, updateSettings } from './settings.js';
import { buildInstructions, knowledgeText, KNOWLEDGE_CHAR_LIMIT } from './prompt.js';
import { checkAvailability, cancelAppointment, testGoogle } from './calendar.js';
import { sendMail, smtpConfigured } from './mailer.js';
import { importUrl } from './webimport.js';
import { activeCalls } from './call.js';
import { requireAuth, login, logout, isAuthenticated } from './auth.js';
import { isTimeStr, isDateStr } from './time.js';

const wrap = (fn) => (req, res) => (async () => fn(req, res))().catch((err) => {
  console.error(`[api] ${req.method} ${req.path}`, err.message);
  res.status(err.status || 400).json({ error: err.message });
});
const httpError = (status, message) => Object.assign(new Error(message), { status });

export function apiRouter({ ari }) {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));

  r.post('/login', login);
  r.post('/logout', logout);
  r.get('/me', (req, res) => res.json({ authenticated: isAuthenticated(req) }));
  r.use(requireAuth);

  // ---------- Statut & statistiques ----------
  r.get('/status', (req, res) => {
    const s = getSettings();
    res.json({
      asterisk: ari.connected,
      openai: Boolean(config.openaiKey),
      smtp: smtpConfigured(s),
      google: Boolean(s.google_calendar_id && s.google_service_account),
      active_calls: activeCalls.size,
      max_concurrent_calls: config.maxConcurrentCalls,
      knowledge_chars: knowledgeText().length,
      knowledge_limit: KNOWLEDGE_CHAR_LIMIT,
    });
  });

  r.get('/stats', (req, res) => {
    const since = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
    const q = (sql, ...p) => db.prepare(sql).get(...p);
    res.json({
      calls_today: q("SELECT COUNT(*) n FROM calls WHERE started_at >= ?", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()).n,
      calls_7d: q('SELECT COUNT(*) n FROM calls WHERE started_at >= ?', since(7)).n,
      avg_duration_7d: Math.round(q('SELECT AVG(duration_s) a FROM calls WHERE started_at >= ? AND duration_s IS NOT NULL', since(7)).a || 0),
      appointments_7d: q("SELECT COUNT(*) n FROM appointments WHERE created_at >= ? AND status = 'confirmed'", since(7)).n,
      messages_new: q("SELECT COUNT(*) n FROM messages WHERE status = 'new'").n,
      action_required: q('SELECT COUNT(*) n FROM calls WHERE action_required = 1').n,
      per_day: db.prepare(`SELECT substr(started_at, 1, 10) d, COUNT(*) n FROM calls WHERE started_at >= ?
        GROUP BY d ORDER BY d`).all(since(14)),
    });
  });

  r.get('/live', (req, res) => res.json([...activeCalls.values()].map((c) => c.snapshot())));

  // ---------- Paramètres ----------
  r.get('/settings', (req, res) => res.json(getPublicSettings()));
  r.put('/settings', wrap((req, res) => {
    const body = req.body || {};
    if (body.opening_hours) validateHours(body.opening_hours);
    if (body.closed_dates && (!Array.isArray(body.closed_dates) || !body.closed_dates.every(isDateStr))) {
      throw new Error('Dates de fermeture invalides (AAAA-MM-JJ)');
    }
    if (body.google_service_account && body.google_service_account !== '__clear__') {
      const sa = JSON.parse(body.google_service_account);
      if (!sa.client_email || !sa.private_key) throw new Error('JSON de compte de service invalide');
    }
    if (body.timezone) new Intl.DateTimeFormat('fr', { timeZone: body.timezone });
    updateSettings(body);
    res.json(getPublicSettings());
  }));
  r.get('/prompt-preview', (req, res) => res.json({ instructions: buildInstructions(getSettings(), { callerNumber: '+33600000000' }) }));

  // ---------- Appels ----------
  r.get('/calls', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const search = `%${req.query.q || ''}%`;
    const filter = req.query.filter === 'action' ? 'AND action_required = 1' : '';
    const rows = db.prepare(`SELECT id, caller_number, caller_name, started_at, duration_s, status, summary, category, action_required
      FROM calls WHERE (caller_number LIKE ? OR caller_name LIKE ? OR summary LIKE ?) ${filter}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(search, search, search, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n FROM calls WHERE (caller_number LIKE ? OR caller_name LIKE ? OR summary LIKE ?) ${filter}`)
      .get(search, search, search).n;
    res.json({ rows, total });
  });

  r.get('/calls/:id', wrap((req, res) => {
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
    if (!call) throw httpError(404, 'Appel introuvable');
    call.transcript = JSON.parse(call.transcript || '[]');
    call.events = db.prepare('SELECT type, data, created_at FROM call_events WHERE call_id = ? ORDER BY id').all(call.id)
      .map((e) => ({ ...e, data: JSON.parse(e.data) }));
    call.appointments = db.prepare('SELECT * FROM appointments WHERE call_id = ?').all(call.id);
    call.messages = db.prepare('SELECT * FROM messages WHERE call_id = ?').all(call.id);
    call.has_recording = Boolean(call.recording && fs.existsSync(recordingPath(call.recording)));
    res.json(call);
  }));

  r.patch('/calls/:id', wrap((req, res) => {
    db.prepare('UPDATE calls SET action_required = ? WHERE id = ?').run(req.body.action_required ? 1 : 0, req.params.id);
    res.json({ ok: true });
  }));

  r.get('/calls/:id/recording', wrap((req, res) => {
    const call = db.prepare('SELECT recording FROM calls WHERE id = ?').get(req.params.id);
    const file = call?.recording && recordingPath(call.recording);
    if (!file || !fs.existsSync(file)) throw httpError(404, 'Enregistrement introuvable');
    res.sendFile(file);
  }));

  r.delete('/calls/:id', wrap((req, res) => {
    const call = db.prepare('SELECT recording FROM calls WHERE id = ?').get(req.params.id);
    if (call?.recording) fs.rmSync(recordingPath(call.recording), { force: true });
    db.prepare('DELETE FROM calls WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  }));

  // ---------- Base de connaissances ----------
  r.get('/knowledge', (req, res) => {
    res.json({
      rows: db.prepare('SELECT * FROM knowledge ORDER BY kind, id DESC').all(),
      chars: knowledgeText().length,
      limit: KNOWLEDGE_CHAR_LIMIT,
    });
  });
  r.post('/knowledge', wrap((req, res) => {
    const { kind = 'faq', title = '', content = '', source_url = null } = req.body;
    if (!['faq', 'text', 'url'].includes(kind)) throw new Error('Type invalide');
    if (!String(content).trim()) throw new Error('Contenu vide');
    const info = db.prepare('INSERT INTO knowledge (kind, title, content, source_url) VALUES (?, ?, ?, ?)')
      .run(kind, String(title), String(content), source_url);
    res.json({ id: Number(info.lastInsertRowid) });
  }));
  r.put('/knowledge/:id', wrap((req, res) => {
    const { title, content, enabled } = req.body;
    db.prepare(`UPDATE knowledge SET title = COALESCE(?, title), content = COALESCE(?, content),
      enabled = COALESCE(?, enabled), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(title ?? null, content ?? null, enabled === undefined ? null : (enabled ? 1 : 0), req.params.id);
    res.json({ ok: true });
  }));
  r.delete('/knowledge/:id', (req, res) => {
    db.prepare('DELETE FROM knowledge WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  r.post('/knowledge/import-url', wrap(async (req, res) => {
    const page = await importUrl(String(req.body.url || ''));
    const info = db.prepare("INSERT INTO knowledge (kind, title, content, source_url) VALUES ('url', ?, ?, ?)")
      .run(page.title, page.text, page.url);
    res.json({ id: Number(info.lastInsertRowid), title: page.title, chars: page.text.length });
  }));

  // ---------- Messages ----------
  r.get('/messages', (req, res) => {
    res.json(db.prepare(`SELECT m.*, c.started_at AS call_started_at FROM messages m
      LEFT JOIN calls c ON c.id = m.call_id ORDER BY m.status = 'done', m.created_at DESC LIMIT 500`).all());
  });
  r.patch('/messages/:id', wrap((req, res) => {
    const status = req.body.status === 'done' ? 'done' : 'new';
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, req.params.id);
    res.json({ ok: true });
  }));
  r.delete('/messages/:id', (req, res) => {
    db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------- Rendez-vous ----------
  r.get('/appointments', (req, res) => {
    const from = req.query.past ? '0000' : new Date(Date.now() - 86_400_000).toISOString();
    res.json(db.prepare('SELECT * FROM appointments WHERE start_utc >= ? ORDER BY start_utc LIMIT 500').all(from));
  });
  r.post('/appointments/:id/cancel', wrap(async (req, res) => {
    await cancelAppointment(getSettings(), Number(req.params.id));
    res.json({ ok: true });
  }));
  r.get('/availability', wrap(async (req, res) => res.json(await checkAvailability(getSettings(), String(req.query.date)))));
  r.post('/calendar/test', wrap(async (req, res) => res.json(await testGoogle(getSettings()))));

  // ---------- Notifications ----------
  r.post('/notifications/test', wrap(async (req, res) => {
    const s = getSettings();
    await sendMail(s, {
      subject: `[${s.business_name}] E-mail de test`,
      text: 'Les notifications de votre assistant téléphonique fonctionnent.',
      html: '<p>Les notifications de votre assistant téléphonique fonctionnent. ✅</p>',
    });
    res.json({ ok: true });
  }));

  return r;
}

function recordingPath(name) {
  return path.join(config.recordingDir, `${path.basename(name)}.wav`);
}

function validateHours(hours) {
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const ranges = hours[day] ?? [];
    if (!Array.isArray(ranges)) throw new Error(`Horaires invalides pour ${day}`);
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !isTimeStr(r[0]) || !isTimeStr(r[1]) || r[0] >= r[1]) {
        throw new Error(`Plage horaire invalide pour ${day} : ${JSON.stringify(r)}`);
      }
    }
  }
}
