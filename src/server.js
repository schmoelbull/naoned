import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import './db.js';
import { Ari } from './ari.js';
import { Call, activeCalls } from './call.js';
import { apiRouter } from './api.js';

// ---------- Asterisk ----------
const ari = new Ari({ url: config.ariUrl, user: config.ariUser, password: config.ariPassword, app: config.ariApp });

ari.on('StasisStart', async (ev) => {
  const ch = ev.channel;
  if (ch.name.startsWith('UnicastRTP/') || ch.id.startsWith('naoned-media-')) return; // nos canaux audio
  if (activeCalls.size >= config.maxConcurrentCalls) {
    console.warn(`[ari] limite d'appels simultanés atteinte, appel ${ch.id} rejeté`);
    await ari.delete(`/channels/${ch.id}`, { reason_code: 17 }).catch(() => {}); // 17 = occupé
    return;
  }
  await new Call(ari, ch).start();
});

const endCall = (ev) => activeCalls.get(ev.channel?.id)?.end();
ari.on('StasisEnd', endCall);
ari.on('ChannelDestroyed', endCall);
ari.on('ChannelHangupRequest', endCall);
ari.connect();

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/api', apiRouter({ ari }));
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

const server = app.listen(config.port, config.host, () => {
  console.log(`[http] tableau de bord sur http://${config.host}:${config.port}`);
});

async function shutdown() {
  console.log('Arrêt…');
  await Promise.allSettled([...activeCalls.values()].map((c) => c.hangup()));
  ari.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
