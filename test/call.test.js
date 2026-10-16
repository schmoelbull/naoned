// Test d'intégration : faux Asterisk (ARI + RTP) et faux OpenAI, appel complet de bout en bout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timeout');
}

// ---------- Faux OpenAI (Realtime WS + chat completions HTTP) ----------
const oaiLog = [];
const oaiHttp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    oaiLog.push({ http: req.url, body: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Le client a demandé un RDV.', caller_name: 'Jean Test', category: 'rendez_vous', action_required: false, next_step: null }) } }] }));
  });
});
const oaiWss = new WebSocketServer({ server: oaiHttp });
oaiWss.on('connection', (ws, req) => {
  assert.match(req.headers.authorization, /^Bearer sk-test/);
  let responses = 0;
  const send = (o) => ws.send(JSON.stringify(o));
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw);
    if (ev.type !== 'input_audio_buffer.append') oaiLog.push(ev);
    if (ev.type !== 'response.create') return;
    responses++;
    const rid = `resp_${responses}`;
    send({ type: 'response.created', response: { id: rid } });
    if (responses === 1) {
      // Accueil : 200 ms d'audio
      send({ type: 'response.output_audio.delta', item_id: 'item_a1', delta: Buffer.alloc(1600, 0x7f).toString('base64') });
      send({ type: 'response.output_audio_transcript.done', item_id: 'item_a1', transcript: 'Bonjour, Test SARL, Léa à l\'appareil.' });
      send({ type: 'response.done', response: { id: rid, status: 'completed', output: [{ type: 'message' }] } });
      // L'appelant parle et demande un RDV → l'IA appelle check_availability
      setTimeout(() => {
        send({ type: 'input_audio_buffer.speech_started', item_id: 'item_u1' });
        send({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_u1' });
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_u1', transcript: 'Je voudrais un rendez-vous.' });
        send({ type: 'response.created', response: { id: 'resp_fc' } });
        send({ type: 'response.done', response: { id: 'resp_fc', status: 'completed', output: [{ type: 'function_call', name: 'check_availability', call_id: 'call_1', arguments: '{"date":"2099-01-01"}' }] } });
      }, 300);
    } else if (responses === 2) {
      // Après le résultat de l'outil : au revoir + end_call
      send({ type: 'response.output_audio.delta', item_id: 'item_a2', delta: Buffer.alloc(800, 0x7f).toString('base64') });
      send({ type: 'response.output_audio_transcript.done', item_id: 'item_a2', transcript: 'Au revoir !' });
      send({ type: 'response.done', response: { id: rid, status: 'completed', output: [{ type: 'function_call', name: 'end_call', call_id: 'call_2', arguments: '{}' }] } });
    }
  });
});

// ---------- Faux Asterisk (ARI REST + WS + RTP) ----------
const ariCalls = [];
let ariWs = null;
let appRtpPort = null;
const asteriskRtp = dgram.createSocket('udp4');
let rtpReceived = 0;
asteriskRtp.on('message', (msg) => { rtpReceived += msg.length - 12; });
await new Promise((r) => asteriskRtp.bind(0, '127.0.0.1', r));
const asteriskRtpPort = asteriskRtp.address().port;

const ariHttp = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  ariCalls.push(`${req.method} ${url.pathname}`);
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/ari/bridges' && req.method === 'POST') return res.end(JSON.stringify({ id: 'bridge1' }));
  if (url.pathname === '/ari/channels/externalMedia') {
    appRtpPort = Number(url.searchParams.get('external_host').split(':')[1]);
    assert.equal(url.searchParams.get('format'), 'ulaw');
    return res.end(JSON.stringify({ id: url.searchParams.get('channelId'), name: 'UnicastRTP/127.0.0.1:1', channelvars: { UNICASTRTP_LOCAL_ADDRESS: '127.0.0.1', UNICASTRTP_LOCAL_PORT: String(asteriskRtpPort) } }));
  }
  if (req.method === 'DELETE' && url.pathname === '/ari/channels/caller1') {
    setTimeout(() => ariWs?.send(JSON.stringify({ type: 'StasisEnd', channel: { id: 'caller1' } })), 10);
  }
  res.statusCode = 204;
  res.end();
});
const ariWss = new WebSocketServer({ server: ariHttp });
ariWss.on('connection', (ws) => { ariWs = ws; });

const oaiPort = await listen(oaiHttp);
const ariPort = await listen(ariHttp);
const appPort = await listen(http.createServer()).then((p) => p); // réserve un port libre

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naoned-test-'));
Object.assign(process.env, {
  PORT: String(appPort + 1), HOST: '127.0.0.1', ADMIN_PASSWORD: 'secret', SESSION_SECRET: 'x'.repeat(32), DATA_DIR: dataDir,
  OPENAI_API_KEY: 'sk-test', OPENAI_REALTIME_URL: `ws://127.0.0.1:${oaiPort}/v1/realtime`, OPENAI_BASE_URL: `http://127.0.0.1:${oaiPort}/v1`,
  ARI_URL: `http://127.0.0.1:${ariPort}`, ARI_PASSWORD: 'p', RTP_PORT_MIN: '41000', RTP_PORT_MAX: '41050',
});
await import('../src/server.js');
const { db } = await import('../src/db.js');
const base = `http://127.0.0.1:${appPort + 1}`;

after(() => setTimeout(() => process.exit(0), 50));

test('appel complet : accueil, outil, raccrochage, résumé', async () => {
  await waitFor(() => ariWs);
  ariWs.send(JSON.stringify({
    type: 'StasisStart',
    channel: { id: 'caller1', name: 'PJSIP/trunk-0001', caller: { number: '0612345678', name: '' }, dialplan: { exten: '0240000000' } },
  }));

  await waitFor(() => appRtpPort);
  // L'appelant « parle » : envoi de quelques paquets RTP vers l'app
  const pkt = Buffer.concat([Buffer.from([0x80, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]), Buffer.alloc(160, 0xff)]);
  for (let i = 0; i < 5; i++) asteriskRtp.send(pkt, appRtpPort, '127.0.0.1');

  const call = await waitFor(() => db.prepare("SELECT * FROM calls WHERE status != 'in_progress'").get(), 8000);
  assert.equal(call.status, 'completed');
  assert.equal(call.caller_number, '0612345678');
  const transcript = JSON.parse(call.transcript);
  assert.deepEqual(transcript.map((t) => t.role), ['assistant', 'user', 'assistant']);

  // Session configurée en G.711 µ-law avec les outils
  const upd = oaiLog.find((e) => e.type === 'session.update');
  assert.equal(upd.session.audio.input.format.type, 'audio/pcmu');
  assert.equal(upd.session.audio.output.format.type, 'audio/pcmu');
  assert.ok(upd.session.tools.some((t) => t.name === 'book_appointment'));
  assert.match(upd.session.instructions, /0612345678/);

  // Résultat d'outil renvoyé à l'IA
  const out = oaiLog.find((e) => e.type === 'conversation.item.create' && e.item.call_id === 'call_1');
  assert.ok(JSON.parse(out.item.output).error, 'date hors horizon → erreur attendue');

  // Audio joué vers Asterisk (accueil 1600 + au revoir 800 octets)
  assert.ok(rtpReceived >= 2400, `audio reçu par Asterisk : ${rtpReceived}`);

  // Raccrochage et nettoyage
  assert.ok(ariCalls.includes('POST /ari/channels/caller1/answer'));
  assert.ok(ariCalls.includes('DELETE /ari/channels/caller1'));
  assert.ok(ariCalls.includes('DELETE /ari/bridges/bridge1'));

  // Post-traitement : résumé
  const done = await waitFor(() => db.prepare('SELECT summary, category, caller_name FROM calls WHERE id = ?').get(call.id).summary && db.prepare('SELECT summary, category, caller_name FROM calls WHERE id = ?').get(call.id));
  assert.equal(done.category, 'rendez_vous');
  assert.equal(done.caller_name, 'Jean Test');
});

test('API : authentification, paramètres, connaissances, disponibilités', async () => {
  let r = await fetch(`${base}/api/status`);
  assert.equal(r.status, 401);

  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"bad"}' });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret"}' });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const j = (p, o = {}) => fetch(`${base}/api${p}`, { ...o, headers: { Cookie: cookie, 'Content-Type': 'application/json' } }).then(async (x) => ({ status: x.status, body: await x.json() }));

  const st = await j('/status');
  assert.equal(st.body.asterisk, true);

  let s = await j('/settings', { method: 'PUT', body: JSON.stringify({ business_name: 'Test SARL', smtp_password: 'pw', opening_hours: { mon: [['08:00', '12:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, min_notice_hours: 0 }) });
  assert.equal(s.body.business_name, 'Test SARL');
  assert.equal(s.body.has_smtp_password, true);
  assert.equal(s.body.smtp_password, undefined, 'secret jamais renvoyé');

  const bad = await j('/settings', { method: 'PUT', body: JSON.stringify({ opening_hours: { mon: [['12:00', '08:00']] } }) });
  assert.equal(bad.status, 400);

  await j('/knowledge', { method: 'POST', body: JSON.stringify({ kind: 'faq', title: 'Parking ?', content: 'Oui, gratuit.' }) });
  const prompt = await j('/prompt-preview');
  assert.match(prompt.body.instructions, /Parking \?/);
  assert.match(prompt.body.instructions, /Test SARL/);

  // Prochain lundi : 8 créneaux de 30 min entre 8h et 12h
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const date = d.toISOString().slice(0, 10);
  const av = await j(`/availability?date=${date}`);
  assert.deepEqual(av.body.available_times, ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);

  const calls = await j('/calls');
  assert.equal(calls.body.total, 1);
  const detail = await j(`/calls/${calls.body.rows[0].id}`);
  assert.ok(detail.body.events.some((e) => e.type === 'tool:end_call'));
});
