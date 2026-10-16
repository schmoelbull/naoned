// Après l'appel : résumé IA, catégorisation, notification e-mail.
import { config } from './config.js';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { sendMail, smtpConfigured } from './mailer.js';
import { formatFr } from './time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function summarize(transcript, settings) {
  if (!transcript.length) return { summary: 'Aucun échange (l\'appelant a raccroché ou n\'a pas parlé).', category: 'sans_suite', action_required: false };
  const dialogue = transcript.map((t) => `${t.role === 'user' ? 'Appelant' : settings.assistant_name} : ${t.text}`).join('\n');
  const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: config.summaryModel,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Tu analyses la transcription d'un appel reçu par l'assistant téléphonique de « ${settings.business_name} ». Réponds en JSON : {"summary": "résumé factuel en 2 à 4 phrases, en français", "caller_name": "nom de l'appelant ou null", "category": "rendez_vous | information | message | reclamation | commercial | spam | autre", "action_required": true si l'équipe doit faire quelque chose (rappeler, traiter une demande…), "next_step": "action à faire ou null"}`,
        },
        { role: 'user', content: dialogue },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `OpenAI ${res.status}`);
  return JSON.parse(json.choices[0].message.content);
}

export async function processFinishedCall(callId) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call) return;
  const settings = getSettings();
  const transcript = JSON.parse(call.transcript || '[]');

  let analysis;
  try {
    analysis = await summarize(transcript, settings);
  } catch (err) {
    console.error(`[postcall ${callId}] résumé impossible`, err.message);
    analysis = { summary: `Résumé indisponible (${err.message}).`, category: 'autre', action_required: false };
  }
  const summary = [analysis.summary, analysis.next_step && `À faire : ${analysis.next_step}`].filter(Boolean).join('\n');
  db.prepare('UPDATE calls SET summary = ?, category = ?, action_required = ?, caller_name = COALESCE(NULLIF(caller_name, \'\'), ?) WHERE id = ?')
    .run(summary, analysis.category || 'autre', analysis.action_required ? 1 : 0, analysis.caller_name || null, callId);

  const appts = db.prepare("SELECT * FROM appointments WHERE call_id = ? AND status = 'confirmed'").all(callId);
  const msgs = db.prepare('SELECT * FROM messages WHERE call_id = ?').all(callId);
  const important = analysis.action_required || appts.length || msgs.length || call.status === 'transferred';

  if (!smtpConfigured(settings) || settings.notify_mode === 'none') return;
  if (settings.notify_mode === 'important' && !important) return;
  if (analysis.category === 'spam' && !important) return;

  const tz = settings.timezone;
  const who = analysis.caller_name || call.caller_name || call.caller_number || 'Numéro masqué';
  const tags = [appts.length && '📅 RDV', msgs.length && '✉️ Message', call.status === 'transferred' && '↪ Transféré',
    analysis.action_required && '⚠️ Action requise'].filter(Boolean).join(' · ');

  const html = `
  <div style="font-family:system-ui,sans-serif;max-width:640px;color:#1f2430">
    <h2 style="margin:0 0 4px">Appel de ${esc(who)}</h2>
    <p style="margin:0 0 16px;color:#667">${esc(formatFr(new Date(call.started_at), tz))} · ${call.duration_s ?? 0} s · ${esc(call.caller_number || 'masqué')}${tags ? ` · ${esc(tags)}` : ''}</p>
    <h3>Résumé</h3><p style="white-space:pre-line">${esc(summary)}</p>
    ${appts.map((a) => `<p>📅 <b>Rendez-vous :</b> ${esc(formatFr(new Date(a.start_utc), tz))} – ${esc(a.name)}${a.reason ? ` (${esc(a.reason)})` : ''}</p>`).join('')}
    ${msgs.map((m) => `<p>✉️ <b>Message</b> (${esc(m.urgency)}) de ${esc(m.name || '?')} – ${esc(m.phone || '')} :<br>${esc(m.message)}</p>`).join('')}
    <h3>Transcription</h3>
    ${transcript.map((t) => `<p style="margin:4px 0"><b>${t.role === 'user' ? 'Appelant' : esc(settings.assistant_name)} :</b> ${esc(t.text)}</p>`).join('') || '<p>—</p>'}
  </div>`;
  const text = `Appel de ${who} (${call.caller_number || 'masqué'})\n\n${summary}\n\n${transcript.map((t) => `${t.role === 'user' ? 'Appelant' : settings.assistant_name}: ${t.text}`).join('\n')}`;

  try {
    await sendMail(settings, { subject: `[${settings.business_name}] Appel de ${who}${tags ? ` – ${tags}` : ''}`, html, text });
  } catch (err) {
    console.error(`[postcall ${callId}] e-mail non envoyé`, err.message);
  }
}
