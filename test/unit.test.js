import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRtp, buildRtp, RtpEndpoint } from '../src/rtp.js';
import { zonedToUtc, zonedParts, isOpenAt } from '../src/time.js';
import { htmlToText } from '../src/webimport.js';

test('RTP : construction / analyse', () => {
  const payload = Buffer.alloc(160, 0x55);
  const pkt = buildRtp({ seq: 65535, timestamp: 4294967295, ssrc: 42, marker: true, payload });
  const p = parseRtp(pkt);
  assert.equal(p.payloadType, 0);
  assert.equal(p.seq, 65535);
  assert.deepEqual(p.payload, payload);
  assert.equal(parseRtp(Buffer.alloc(5)), null);
});

test('RTP : file de lecture et interruption', () => {
  const ep = new RtpEndpoint({ portMin: 1, portMax: 1 });
  ep.enqueue('a', Buffer.alloc(400, 1));
  assert.equal(ep.idle, false);
  const cut = ep.clear();
  assert.deepEqual(cut, { itemId: 'a', playedMs: 0 });
  assert.equal(ep.idle, true);
});

test('Fuseau Europe/Paris, y compris changement d\'heure', () => {
  assert.equal(zonedToUtc('2026-01-15', '09:00', 'Europe/Paris').toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-07-15', '09:00', 'Europe/Paris').toISOString(), '2026-07-15T07:00:00.000Z');
  assert.equal(zonedToUtc('2026-03-29', '10:00', 'Europe/Paris').toISOString(), '2026-03-29T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-10-25', '10:00', 'Europe/Paris').toISOString(), '2026-10-25T09:00:00.000Z');
  assert.equal(zonedParts(new Date('2026-10-16T12:00:00Z'), 'Europe/Paris').weekday, 'fri');
});

test('Heures d\'ouverture', () => {
  const s = { timezone: 'Europe/Paris', closed_dates: ['2026-12-25'], opening_hours: { fri: [['09:00', '12:00']], thu: [['09:00', '12:00']] } };
  assert.equal(isOpenAt(s, new Date('2026-10-16T08:30:00Z')), true); // ven. 10h30 Paris
  assert.equal(isOpenAt(s, new Date('2026-10-16T11:00:00Z')), false); // ven. 13h
  assert.equal(isOpenAt(s, new Date('2026-12-25T09:00:00Z')), false); // fermeture exceptionnelle
});

test('Import web : HTML → texte', () => {
  const { title, text } = htmlToText('<html><title>Garage &amp; Co</title><script>x()</script><h1>Tarifs</h1><p>Vidange : 89&nbsp;&euro;</p></html>');
  assert.equal(title, 'Garage & Co');
  assert.match(text, /Tarifs\nVidange : 89 €/);
  assert.doesNotMatch(text, /x\(\)/);
});
