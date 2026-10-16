// Client ARI (Asterisk REST Interface) minimal : REST + WebSocket d'événements.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class Ari extends EventEmitter {
  constructor({ url, user, password, app }) {
    super();
    this.url = url;
    this.app = app;
    this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    this.connected = false;
    this.ws = null;
    this.retry = 1000;
    this.stopped = false;
  }

  async request(method, path, params = {}, body) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const url = `${this.url}/ari${path}${qs.size ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`ARI ${method} ${path} → ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  get(p, q) { return this.request('GET', p, q); }
  post(p, q, b) { return this.request('POST', p, q, b); }
  delete(p, q) { return this.request('DELETE', p, q); }

  connect() {
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/ari/events?app=${encodeURIComponent(this.app)}&subscribeAll=false`;
    this.ws = new WebSocket(wsUrl, { headers: { Authorization: this.auth } });

    this.ws.on('open', () => {
      this.connected = true;
      this.retry = 1000;
      console.log(`[ari] connecté à ${this.url} (app « ${this.app} »)`);
      this.emit('connected');
    });
    this.ws.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(data); } catch { return; }
      this.emit(ev.type, ev);
      this.emit('event', ev);
    });
    this.ws.on('close', () => this.#reconnect());
    this.ws.on('error', (err) => {
      if (this.connected || this.retry === 1000) console.error(`[ari] ${err.message}`);
    });
  }

  #reconnect() {
    const was = this.connected;
    this.connected = false;
    if (was) this.emit('disconnected');
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 30_000);
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}
