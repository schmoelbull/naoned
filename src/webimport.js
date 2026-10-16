// Import d'une page web dans la base de connaissances (texte brut).
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('::ffff:127.');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&euro;/g, '€')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter((l) => l.length > 1).join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title: decode(title), text };
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL http(s) uniquement');
  const { address } = await dns.lookup(url.hostname);
  if (isPrivateIp(address)) throw new Error('Adresse interne refusée');
}

export async function importUrl(rawUrl) {
  let url = new URL(rawUrl);
  let res;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (naoned knowledge importer)', Accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url); continue; }
    break;
  }
  if (!res.ok) throw new Error(`Page inaccessible (${res.status})`);
  const html = (await res.text()).slice(0, 2_000_000);
  const { title, text } = htmlToText(html);
  if (text.length < 50) throw new Error('Pas de texte exploitable sur cette page (site en JavaScript ?). Copiez le texte manuellement.');
  return { title: title || url.hostname, text: text.slice(0, 20_000), url: url.href };
}
