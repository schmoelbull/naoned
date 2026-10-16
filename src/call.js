// Orchestration d'un appel : canal Asterisk <-> RTP <-> OpenAI Realtime.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, nowIso, logEvent } from './db.js';
import { getSettings } from './settings.js';
import { RtpEndpoint } from './rtp.js';
import { RealtimeSession } from './realtime.js';
import { buildInstructions, renderTemplate } from './prompt.js';
import { toolDefinitions, runTool } from './tools.js';
import { processFinishedCall } from './postcall.js';

export const activeCalls = new Map(); // channelId -> Call

export class Call {
  constructor(ari, channel) {
    this.ari = ari;
    this.channel = channel;
    this.channelId = channel.id;
    this.callerNumber = channel.caller?.number || '';
    this.callerName = channel.caller?.name || '';
    this.calledNumber = channel.dialplan?.exten || '';
    this.settings = getSettings();
    this.startedAt = new Date();
    this.transcript = []; // { role, text, t }
    this.userTimes = new Map(); // itemId -> t (ms depuis le début)
    this.callId = null;
    this.bridge = null;
    this.media = null;
    this.rtp = null;
    this.ai = null;
    this.responseActive = false;
    this.pendingAction = null; // 'hangup' | 'transfer'
    this.finalStatus = 'completed';
    this.ended = false;
    this.timers = [];
    this.recordingName = null;
  }

  elapsed() { return Date.now() - this.startedAt.getTime(); }

  async start() {
    const info = db.prepare(`INSERT INTO calls (channel_id, caller_number, caller_name, called_number, started_at)
      VALUES (?, ?, ?, ?, ?)`).run(this.channelId, this.callerNumber, this.callerName, this.calledNumber, nowIso());
    this.callId = Number(info.lastInsertRowid);
    activeCalls.set(this.channelId, this);
    console.log(`[call ${this.callId}] appel entrant de ${this.callerNumber || 'inconnu'}`);

    try {
      // 1. Connexion OpenAI en parallèle de la préparation Asterisk (gain de latence)
      this.ai = new RealtimeSession();
      const aiReady = this.ai.connect();
      aiReady.catch(() => {}); // évite un rejet non géré si une étape Asterisk échoue avant

      await this.ari.post(`/channels/${this.channelId}/answer`);

      // 2. Pont audio : bridge + canal External Media vers notre socket RTP
      this.rtp = new RtpEndpoint({ portMin: config.rtpPortMin, portMax: config.rtpPortMax });
      const port = await this.rtp.listen();
      this.bridge = await this.ari.post('/bridges', { type: 'mixing', name: `naoned-${this.callId}` });
      this.media = await this.ari.post('/channels/externalMedia', {
        app: config.ariApp,
        channelId: `naoned-media-${crypto.randomUUID()}`,
        external_host: `127.0.0.1:${port}`,
        format: 'ulaw',
        encapsulation: 'rtp',
        transport: 'udp',
        direction: 'both',
      });
      const vars = this.media.channelvars || {};
      this.rtp.setRemote(vars.UNICASTRTP_LOCAL_ADDRESS, vars.UNICASTRTP_LOCAL_PORT);
      if (this.ended) return this.#teardownMedia(); // l'appelant a raccroché pendant l'établissement
      await this.ari.post(`/bridges/${this.bridge.id}/addChannel`, { channel: `${this.channelId},${this.media.id}` });

      if (this.settings.record_calls) {
        this.recordingName = `naoned-${this.callId}`;
        await this.ari.post(`/bridges/${this.bridge.id}/record`, {
          name: this.recordingName, format: 'wav', ifExists: 'overwrite', beep: false,
        }).catch((e) => { console.error(`[call ${this.callId}] enregistrement impossible`, e.message); this.recordingName = null; });
      }

      await aiReady;
      if (this.ended) return this.#teardownMedia();
      this.#wireAi();
      this.#configureSession();
      this.rtp.on('audio', (payload) => this.ai.appendAudio(payload));
      this.rtp.on('drained', () => this.#maybeRunPendingAction());
      this.rtp.start();

      // 3. Message d'accueil
      const greeting = renderTemplate(this.settings.greeting, this.settings);
      this.ai.send({
        type: 'response.create',
        response: { instructions: `Commence l'appel en disant exactement, sans rien ajouter : « ${greeting} »` },
      });

      // 4. Durée maximale
      const maxMs = Math.max(1, this.settings.max_call_minutes) * 60_000;
      this.timers.push(setTimeout(() => this.#onMaxDuration(), maxMs));
    } catch (err) {
      console.error(`[call ${this.callId}] échec d'initialisation`, err);
      this.finalStatus = 'failed';
      this.error = err.message;
      await this.ari.delete(`/channels/${this.channelId}`).catch(() => {});
      await this.end();
    }
  }

  #configureSession() {
    const s = this.settings;
    this.ai.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: config.realtimeModel,
        output_modalities: ['audio'],
        instructions: buildInstructions(s, { callerNumber: this.callerNumber }),
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: config.transcribeModel },
            noise_reduction: s.noise_reduction === 'off' ? null : { type: s.noise_reduction },
            turn_detection: s.turn_detection === 'server_vad'
              ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true }
              : { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: s.voice,
            speed: Math.min(1.5, Math.max(0.25, Number(s.voice_speed) || 1)),
          },
        },
        tools: toolDefinitions(s),
        tool_choice: 'auto',
      },
    });
  }

  #wireAi() {
    const ai = this.ai;

    ai.on('response.output_audio.delta', (ev) => {
      if (this.ended) return;
      this.rtp.enqueue(ev.item_id, Buffer.from(ev.delta, 'base64'));
    });

    ai.on('input_audio_buffer.speech_started', () => {
      // L'appelant coupe la parole : on arrête immédiatement la lecture
      const cut = this.rtp.clear();
      if (cut) {
        ai.send({ type: 'conversation.item.truncate', item_id: cut.itemId, content_index: 0, audio_end_ms: cut.playedMs });
      }
    });

    ai.on('input_audio_buffer.speech_stopped', (ev) => {
      if (ev.item_id) this.userTimes.set(ev.item_id, this.elapsed());
    });

    ai.on('conversation.item.input_audio_transcription.completed', (ev) => {
      const text = ev.transcript?.trim();
      if (!text) return;
      this.#addTranscript('user', text, this.userTimes.get(ev.item_id) ?? this.elapsed());
    });

    ai.on('response.output_audio_transcript.done', (ev) => {
      const text = ev.transcript?.trim();
      if (text) this.#addTranscript('assistant', text, this.elapsed());
    });

    ai.on('response.created', () => { this.responseActive = true; });

    ai.on('response.done', (ev) => {
      this.responseActive = false;
      const resp = ev.response || {};
      if (resp.status === 'failed') {
        console.error(`[call ${this.callId}] réponse en échec`, JSON.stringify(resp.status_details));
        logEvent(this.callId, 'ai_error', resp.status_details || {});
      }
      const calls = (resp.output || []).filter((o) => o.type === 'function_call');
      if (calls.length) this.#handleFunctionCalls(calls);
      else this.#maybeRunPendingAction();
    });

    ai.on('error', (ev) => {
      console.error(`[call ${this.callId}] erreur OpenAI`, ev.error?.message || ev);
      logEvent(this.callId, 'ai_error', ev.error || {});
    });

    ai.on('close', () => {
      if (!this.ended) {
        console.warn(`[call ${this.callId}] connexion OpenAI fermée`);
        this.finalStatus = 'failed';
        this.error = 'Connexion OpenAI interrompue';
        this.hangup();
      }
    });
  }

  async #handleFunctionCalls(calls) {
    const ctx = { settings: this.settings, callId: this.callId, callerNumber: this.callerNumber };
    let action = null;
    for (const fc of calls) {
      let args = {};
      try { args = JSON.parse(fc.arguments || '{}'); } catch { /* arguments invalides */ }
      const res = await runTool(fc.name, args, ctx);
      if (res.action) action = res.action;
      this.ai.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify(res.output) },
      });
    }
    if (this.ended) return;
    if (action) {
      this.pendingAction = action;
      this.#maybeRunPendingAction();
    } else {
      this.ai.send({ type: 'response.create' });
    }
  }

  #maybeRunPendingAction() {
    if (!this.pendingAction || this.responseActive || !this.rtp?.idle || this.ended) return;
    const action = this.pendingAction;
    this.pendingAction = null;
    // Petit délai pour laisser la dernière syllabe arriver jusqu'à l'appelant
    this.timers.push(setTimeout(() => (action === 'transfer' ? this.transfer() : this.hangup()), 600));
  }

  #onMaxDuration() {
    if (this.ended) return;
    logEvent(this.callId, 'max_duration', {});
    this.ai.send({
      type: 'response.create',
      response: { instructions: 'La durée maximale de l\'appel est atteinte. Excuse-toi brièvement, propose de rappeler ou de laisser un message une prochaine fois, et dis au revoir.' },
    });
    this.pendingAction = 'hangup';
    this.timers.push(setTimeout(() => this.hangup(), 20_000)); // filet de sécurité
  }

  #addTranscript(role, text, t) {
    this.transcript.push({ role, text, t });
    this.transcript.sort((a, b) => a.t - b.t);
    db.prepare('UPDATE calls SET transcript = ? WHERE id = ?').run(JSON.stringify(this.transcript), this.callId);
  }

  async transfer() {
    if (this.ended) return;
    const target = this.settings.transfer_number.replace(/[^\d+*#]/g, '');
    logEvent(this.callId, 'transfer', { to: target });
    console.log(`[call ${this.callId}] transfert vers ${target}`);
    this.finalStatus = 'transferred';
    try {
      await this.ari.post(`/channels/${this.channelId}/variable`, { variable: 'NAONED_TRANSFER_TO', value: target });
      await this.#teardownMedia();
      await this.ari.post(`/channels/${this.channelId}/continue`, { context: 'naoned-transfer', extension: 's', priority: 1 });
    } catch (err) {
      console.error(`[call ${this.callId}] transfert impossible`, err.message);
      this.error = `Transfert impossible : ${err.message}`;
      await this.ari.delete(`/channels/${this.channelId}`).catch(() => {});
    }
    await this.end();
  }

  async hangup() {
    if (this.ended) return;
    await this.ari.delete(`/channels/${this.channelId}`).catch(() => {});
    await this.end();
  }

  async #teardownMedia() {
    this.rtp?.close();
    this.ai?.removeAllListeners('close');
    this.ai?.close();
    if (this.media) await this.ari.delete(`/channels/${this.media.id}`).catch(() => {});
    if (this.bridge) await this.ari.delete(`/bridges/${this.bridge.id}`).catch(() => {});
    this.media = null;
    this.bridge = null;
  }

  /** Nettoyage final, idempotent. Appelé à la fin de l'appel quel qu'en soit le motif. */
  async end() {
    if (this.ended) return;
    this.ended = true;
    this.timers.forEach(clearTimeout);
    activeCalls.delete(this.channelId);
    await this.#teardownMedia();

    const ended = new Date();
    const duration = Math.round((ended - this.startedAt) / 1000);
    db.prepare(`UPDATE calls SET ended_at = ?, duration_s = ?, status = ?, transcript = ?, recording = ?, error = ?
      WHERE id = ?`).run(ended.toISOString(), duration, this.finalStatus, JSON.stringify(this.transcript),
      this.recordingName, this.error || null, this.callId);
    console.log(`[call ${this.callId}] terminé (${duration}s, ${this.finalStatus})`);

    processFinishedCall(this.callId).catch((e) => console.error(`[call ${this.callId}] post-traitement`, e));
  }

  /** Vue « en direct » pour le tableau de bord. */
  snapshot() {
    return {
      call_id: this.callId,
      caller_number: this.callerNumber,
      started_at: this.startedAt.toISOString(),
      duration_s: Math.round(this.elapsed() / 1000),
      transcript: this.transcript,
    };
  }
}
