// Session WebSocket avec l'API OpenAI Realtime (speech-to-speech).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from './config.js';

export class RealtimeSession extends EventEmitter {
  constructor({ model = config.realtimeModel, apiKey = config.openaiKey } = {}) {
    super();
    this.model = model;
    this.apiKey = apiKey;
    this.ws = null;
    this.open = false;
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) return reject(new Error('OPENAI_API_KEY manquante'));
      this.ws = new WebSocket(`${config.realtimeUrl}?model=${encodeURIComponent(this.model)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const timeout = setTimeout(() => reject(new Error('Délai de connexion OpenAI dépassé')), 10_000);
      this.ws.once('open', () => {
        clearTimeout(timeout);
        this.open = true;
        for (const m of this.pending) this.ws.send(m);
        this.pending = [];
        resolve();
      });
      this.ws.on('message', (data) => {
        let ev;
        try { ev = JSON.parse(data); } catch { return; }
        this.emit(ev.type, ev);
        this.emit('event', ev);
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.open) reject(err);
        else this.emit('ws_error', err);
      });
      this.ws.on('close', (code, reason) => {
        this.open = false;
        this.emit('close', code, String(reason));
      });
    });
  }

  send(event) {
    const msg = JSON.stringify(event);
    if (this.open) this.ws.send(msg);
    else this.pending.push(msg);
  }

  appendAudio(ulawBuf) {
    if (this.open) this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: ulawBuf.toString('base64') }));
  }

  close() {
    this.open = false;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
