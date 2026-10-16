import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'naoned.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('faq', 'text', 'url')),
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      TEXT NOT NULL,
  caller_number   TEXT,
  caller_name     TEXT,
  called_number   TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_s      INTEGER,
  status          TEXT NOT NULL DEFAULT 'in_progress',
  transcript      TEXT NOT NULL DEFAULT '[]',
  summary         TEXT,
  category        TEXT,
  action_required INTEGER NOT NULL DEFAULT 0,
  recording       TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls (started_at DESC);

CREATE TABLE IF NOT EXISTS call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_events_call ON call_events (call_id);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  name       TEXT,
  phone      TEXT,
  message    TEXT NOT NULL,
  urgency    TEXT NOT NULL DEFAULT 'normale',
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id         INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  reason          TEXT,
  start_utc       TEXT NOT NULL,
  end_utc         TEXT NOT NULL,
  google_event_id TEXT,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments (start_utc);
`);

export const nowIso = () => new Date().toISOString();

export function logEvent(callId, type, data = {}) {
  db.prepare('INSERT INTO call_events (call_id, type, data) VALUES (?, ?, ?)')
    .run(callId, type, JSON.stringify(data));
}
