// Pont RTP G.711 µ-law entre Asterisk (External Media) et l'application.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const FRAME_BYTES = 160; // 20 ms à 8 kHz, 1 octet/échantillon
const FRAME_MS = 20;
const PT_PCMU = 0;
const usedPorts = new Set();

export function parseRtp(buf) {
  if (buf.length < 12 || (buf[0] >> 6) !== 2) return null;
  const cc = buf[0] & 0x0f;
  const hasExt = (buf[0] & 0x10) !== 0;
  const hasPadding = (buf[0] & 0x20) !== 0;
  let offset = 12 + cc * 4;
  if (hasExt) {
    if (buf.length < offset + 4) return null;
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  let end = buf.length;
  if (hasPadding) end -= buf[buf.length - 1];
  if (offset > end) return null;
  return { payloadType: buf[1] & 0x7f, seq: buf.readUInt16BE(2), payload: buf.subarray(offset, end) };
}

export function buildRtp({ seq, timestamp, ssrc, marker, payload }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0) | PT_PCMU;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

export class RtpEndpoint extends EventEmitter {
  constructor({ portMin, portMax }) {
    super();
    this.portMin = portMin;
    this.portMax = portMax;
    this.socket = null;
    this.port = null;
    this.remote = null; // { address, port }
    this.queue = []; // [{ itemId, buf }]
    this.queuedBytes = 0;
    this.played = new Map(); // itemId -> octets joués
    this.seq = crypto.randomInt(0, 0xffff);
    this.timestamp = crypto.randomInt(0, 0xffffffff);
    this.ssrc = crypto.randomInt(0, 0xffffffff);
    this.talking = false;
    this.timer = null;
  }

  async listen() {
    const span = this.portMax - this.portMin + 1;
    const start = crypto.randomInt(0, span);
    for (let i = 0; i < span; i++) {
      const port = this.portMin + ((start + i) % span);
      if (usedPorts.has(port)) continue;
      try {
        await this.#bind(port);
        usedPorts.add(port);
        this.port = port;
        return port;
      } catch { /* port occupé, on essaie le suivant */ }
    }
    throw new Error('Aucun port RTP libre');
  }

  #bind(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', reject);
      sock.bind(port, '127.0.0.1', () => {
        sock.removeListener('error', reject);
        sock.on('error', (e) => this.emit('error', e));
        sock.on('message', (msg, rinfo) => this.#onPacket(msg, rinfo));
        this.socket = sock;
        resolve();
      });
    });
  }

  setRemote(address, port) {
    if (address && port) this.remote = { address, port: Number(port) };
  }

  #onPacket(msg, rinfo) {
    if (!this.remote) this.remote = { address: rinfo.address, port: rinfo.port };
    const pkt = parseRtp(msg);
    if (pkt && pkt.payload.length) this.emit('audio', pkt.payload);
  }

  /** Ajoute de l'audio µ-law à jouer vers l'appelant. */
  enqueue(itemId, buf) {
    if (!buf.length) return;
    this.queue.push({ itemId, buf });
    this.queuedBytes += buf.length;
  }

  /** Vide la file (interruption par l'appelant). Renvoie l'item en cours et la durée jouée. */
  clear() {
    const current = this.queue[0]?.itemId;
    this.queue = [];
    this.queuedBytes = 0;
    if (!current) return null;
    return { itemId: current, playedMs: Math.floor((this.played.get(current) || 0) / 8) };
  }

  get idle() { return this.queuedBytes === 0; }

  start() {
    let next = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - next > 200) next = now; // rattrapage après un gel de la boucle
      while (next <= now) {
        this.#sendFrame();
        next += FRAME_MS;
      }
      this.timer = setTimeout(tick, Math.max(1, next - performance.now()));
    };
    tick();
  }

  #takeFrame() {
    const out = Buffer.alloc(FRAME_BYTES, 0xff); // 0xFF = silence µ-law
    let filled = 0;
    while (filled < FRAME_BYTES && this.queue.length) {
      const head = this.queue[0];
      const n = Math.min(FRAME_BYTES - filled, head.buf.length);
      head.buf.copy(out, filled, 0, n);
      this.played.set(head.itemId, (this.played.get(head.itemId) || 0) + n);
      filled += n;
      if (n === head.buf.length) this.queue.shift();
      else head.buf = head.buf.subarray(n);
    }
    this.queuedBytes -= filled;
    return filled ? out : null;
  }

  #sendFrame() {
    const payload = this.#takeFrame();
    this.timestamp = (this.timestamp + FRAME_BYTES) >>> 0;
    if (!payload) {
      if (this.talking) {
        this.talking = false;
        this.emit('drained');
      }
      return;
    }
    if (!this.remote || !this.socket) return;
    const marker = !this.talking;
    this.talking = true;
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(buildRtp({ seq: this.seq, timestamp: this.timestamp, ssrc: this.ssrc, marker, payload }),
      this.remote.port, this.remote.address);
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* déjà fermé */ }
      this.socket = null;
    }
    if (this.port) usedPorts.delete(this.port);
    this.queue = [];
    this.queuedBytes = 0;
  }
}
