import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k, d = '') => (process.env[k] ?? d).trim();
const int = (k, d) => Number.parseInt(env(k, String(d)), 10);

export const config = {
  root,
  port: int('PORT', 3000),
  host: env('HOST', '127.0.0.1'),
  adminPassword: env('ADMIN_PASSWORD'),
  sessionSecret: env('SESSION_SECRET') || crypto.randomBytes(32).toString('hex'),
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  dataDir: path.resolve(root, env('DATA_DIR', './data')),

  openaiKey: env('OPENAI_API_KEY'),
  realtimeModel: env('OPENAI_REALTIME_MODEL', 'gpt-realtime'),
  realtimeUrl: env('OPENAI_REALTIME_URL', 'wss://api.openai.com/v1/realtime'),
  openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  summaryModel: env('OPENAI_SUMMARY_MODEL', 'gpt-4o-mini'),
  transcribeModel: env('OPENAI_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe'),

  ariUrl: env('ARI_URL', 'http://127.0.0.1:8088').replace(/\/$/, ''),
  ariUser: env('ARI_USER', 'naoned'),
  ariPassword: env('ARI_PASSWORD'),
  ariApp: env('ARI_APP', 'naoned'),
  rtpPortMin: int('RTP_PORT_MIN', 30000),
  rtpPortMax: int('RTP_PORT_MAX', 30999),
  maxConcurrentCalls: int('MAX_CONCURRENT_CALLS', 5),
  recordingDir: env('RECORDING_DIR', '/var/spool/asterisk/recording'),
};

if (!config.adminPassword) {
  console.warn('[config] ADMIN_PASSWORD est vide : le tableau de bord refusera toute connexion.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[config] SESSION_SECRET absent : les sessions seront perdues à chaque redémarrage.');
}
