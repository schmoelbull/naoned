// Tableau de bord Naoned – SPA sans dépendance.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let settingsCache = null;
let pollTimer = null;

// ---------- Utilitaires ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Session expirée'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
  return json;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}

const fmtDate = (iso, opts = {}) => (iso ? new Date(iso).toLocaleString('fr-FR', {
  timeZone: settingsCache?.timezone, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', ...opts,
}) : '—');
const fmtDur = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const STATUS = {
  in_progress: ['En cours', 'primary'], completed: ['Terminé', 'ok'], transferred: ['Transféré', 'warn'], failed: ['Échec', 'danger'],
};
const CATEGORY = {
  rendez_vous: 'Rendez-vous', information: 'Information', message: 'Message', reclamation: 'Réclamation',
  commercial: 'Commercial', spam: 'Spam', sans_suite: 'Sans suite', autre: 'Autre',
};
const statusPill = (s) => { const [l, c] = STATUS[s] || [s, '']; return `<span class="pill ${c}">${esc(l)}</span>`; };

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

function fillForm(form, data) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(data[el.name]);
    else if (el.type !== 'password') el.value = data[el.name] ?? '';
  }
}

async function loadSettings() { settingsCache = await api('/settings'); return settingsCache; }

function settingsPage({ title, subtitle, body, after }) {
  view.innerHTML = `
    <div class="page-head"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>
    <form id="settings-form">${body}<button class="btn primary" type="submit">Enregistrer</button></form>
    ${after || ''}`;
  const form = $('#settings-form');
  fillForm(form, settingsCache);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(form.querySelector('[type=submit]'), async () => {
      settingsCache = await api('/settings', { method: 'PUT', body: formData(form) });
      fillForm(form, settingsCache);
      toast('Paramètres enregistrés');
    });
  });
  return form;
}

// ---------- Vues ----------
const views = {
  async dashboard() {
    const [stats, status, live] = await Promise.all([api('/stats'), api('/status'), api('/live')]);
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
    const byDay = Object.fromEntries(stats.per_day.map((d) => [d.d, d.n]));
    const max = Math.max(1, ...days.map((d) => byDay[d] || 0));
    const check = (ok, label, hint, optional = false) => `<div class="status-item"><span>${label}</span>${ok ? '<span class="pill ok">OK</span>'
      : `<span class="pill ${optional ? '' : 'danger'}" title="${esc(hint)}">${optional ? 'Non configuré' : 'À configurer'}</span>`}</div>`;

    view.innerHTML = `
      <div class="page-head"><div><h1>Tableau de bord</h1><p class="muted">${esc(settingsCache.business_name)} · assistant ${esc(settingsCache.assistant_name)}</p></div></div>
      <div class="grid kpi">
        <div class="card"><div class="kpi-value">${stats.calls_today}</div><div class="kpi-label">Appels aujourd'hui</div></div>
        <div class="card"><div class="kpi-value">${stats.calls_7d}</div><div class="kpi-label">Appels sur 7 jours</div></div>
        <div class="card"><div class="kpi-value">${fmtDur(stats.avg_duration_7d)}</div><div class="kpi-label">Durée moyenne</div></div>
        <div class="card"><div class="kpi-value">${stats.appointments_7d}</div><div class="kpi-label">RDV pris (7 j)</div></div>
        <div class="card"><div class="kpi-value">${stats.messages_new}</div><div class="kpi-label">Messages non traités</div></div>
        <div class="card"><div class="kpi-value">${stats.action_required}</div><div class="kpi-label">Appels à traiter</div></div>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h2>Appels sur 14 jours</h2>
          <div class="bars">${days.map((d) => `<div style="height:${((byDay[d] || 0) / max) * 100}%"><span>${byDay[d] || ''}</span></div>`).join('')}</div>
          <div class="bars-labels">${days.map((d) => `<span>${d.slice(8)}</span>`).join('')}</div>
        </div>
        <div class="card"><h2>État du système</h2><div class="status-list">
          ${check(status.asterisk, 'Asterisk (téléphonie)', 'Node ne parvient pas à joindre ARI')}
          ${check(status.openai, 'OpenAI (IA vocale)', 'OPENAI_API_KEY manquante dans .env')}
          ${check(status.google, 'Google Agenda', 'Optionnel : les RDV sont sinon gérés localement', true)}
          ${check(status.smtp, 'E-mails de notification', 'Optionnel', true)}
          <div class="status-item"><span>Appels en cours</span><span class="pill">${status.active_calls} / ${status.max_concurrent_calls}</span></div>
          <div class="status-item"><span>Base de connaissances</span><span class="pill">${Math.round(status.knowledge_chars / 1000)}k / ${status.knowledge_limit / 1000}k car.</span></div>
        </div></div>
      </div>
      <div class="card" id="live-card"></div>`;
    renderLive(live);
    pollTimer = setInterval(async () => renderLive(await api('/live').catch(() => [])), 3000);
  },

  async calls() {
    view.innerHTML = `
      <div class="page-head"><div><h1>Appels</h1><p class="muted">Historique, résumés et transcriptions</p></div>
        <div class="row" style="max-width:420px">
          <input id="q" placeholder="Rechercher (numéro, nom, résumé)…">
          <select id="filter" style="max-width:150px"><option value="">Tous</option><option value="action">À traiter</option></select>
        </div></div>
      <div class="card table-wrap" id="calls-table"></div>`;
    const load = async () => {
      const { rows, total } = await api(`/calls?limit=100&q=${encodeURIComponent($('#q').value)}&filter=${$('#filter').value}`);
      $('#calls-table').innerHTML = rows.length ? `
        <table><thead><tr><th>Date</th><th>Appelant</th><th>Durée</th><th>Statut</th><th>Résumé</th></tr></thead><tbody>
        ${rows.map((c) => `<tr class="click" data-id="${c.id}">
          <td>${fmtDate(c.started_at)}</td>
          <td><b>${esc(c.caller_name || '')}</b><div class="small muted">${esc(c.caller_number || 'masqué')}</div></td>
          <td>${fmtDur(c.duration_s)}</td>
          <td>${statusPill(c.status)} ${c.action_required ? '<span class="pill warn">À traiter</span>' : ''}
            ${c.category ? `<div class="small muted">${esc(CATEGORY[c.category] || c.category)}</div>` : ''}</td>
          <td class="small">${esc((c.summary || '').slice(0, 160))}</td></tr>`).join('')}
        </tbody></table><p class="small muted">${total} appel(s)</p>` : '<div class="empty">Aucun appel pour le moment.</div>';
      $$('tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/calls/${tr.dataset.id}`; }));
    };
    let t;
    $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    $('#filter').addEventListener('change', load);
    await load();
  },

  async callDetail(id) {
    const c = await api(`/calls/${id}`);
    const t0 = new Date(c.started_at).getTime();
    view.innerHTML = `
      <div class="page-head"><div><a href="#/calls">← Appels</a>
        <h1>${esc(c.caller_name || c.caller_number || 'Numéro masqué')}</h1>
        <p class="muted">${fmtDate(c.started_at, { weekday: 'long' })} · ${fmtDur(c.duration_s)} · ${esc(c.caller_number || 'masqué')} ${statusPill(c.status)}</p></div>
        <div class="row" style="flex:0">
          <button class="btn" id="toggle-action">${c.action_required ? '✓ Marquer traité' : '⚠️ Marquer à traiter'}</button>
          <button class="btn danger" id="del">Supprimer</button></div></div>
      <div class="card"><h2>Résumé</h2><p style="white-space:pre-line">${esc(c.summary || (c.status === 'in_progress' ? 'Appel en cours…' : 'Résumé en cours de génération…'))}</p>
        ${c.error ? `<p class="error">${esc(c.error)}</p>` : ''}
        ${c.appointments.map((a) => `<p>📅 RDV le <b>${fmtDate(a.start_utc, { weekday: 'long' })}</b> – ${esc(a.name)} ${a.reason ? `(${esc(a.reason)})` : ''} ${a.status === 'cancelled' ? '<span class="pill danger">annulé</span>' : ''}</p>`).join('')}
        ${c.messages.map((m) => `<p>✉️ Message (${esc(m.urgency)}) de ${esc(m.name || '?')} ${esc(m.phone || '')} : ${esc(m.message)}</p>`).join('')}
        ${c.has_recording ? `<audio controls preload="none" src="/api/calls/${c.id}/recording" style="width:100%;margin-top:8px"></audio>` : ''}
      </div>
      <div class="card"><h2>Transcription</h2><div class="chat">
        ${c.transcript.map((m) => `<div class="bubble ${m.role}"><div class="who">${m.role === 'user' ? 'Appelant' : esc(settingsCache.assistant_name)} · ${fmtDur(Math.round(m.t / 1000))}</div>${esc(m.text)}</div>`).join('') || '<div class="empty">Aucune transcription.</div>'}
      </div></div>
      ${c.events.length ? `<div class="card"><h2>Journal technique</h2><table><tbody>
        ${c.events.map((e) => `<tr><td class="small muted">${fmtDur(Math.max(0, Math.round((new Date(e.created_at) - t0) / 1000)))}</td><td><code>${esc(e.type)}</code></td><td class="small"><code>${esc(JSON.stringify(e.data))}</code></td></tr>`).join('')}
      </tbody></table></div>` : ''}`;
    $('#toggle-action').onclick = async () => { await api(`/calls/${id}`, { method: 'PATCH', body: { action_required: !c.action_required } }); views.callDetail(id); };
    $('#del').onclick = async () => {
      if (!confirm('Supprimer cet appel, sa transcription et son enregistrement ?')) return;
      await api(`/calls/${id}`, { method: 'DELETE' });
      location.hash = '#/calls';
    };
    if (c.status === 'in_progress') pollTimer = setTimeout(() => views.callDetail(id), 4000);
  },

  async messages() {
    const rows = await api('/messages');
    view.innerHTML = `
      <div class="page-head"><div><h1>Messages</h1><p class="muted">Messages et demandes de rappel pris par l'assistant</p></div></div>
      <div class="card table-wrap">${rows.length ? `<table><thead><tr><th>Date</th><th>De</th><th>Message</th><th>Urgence</th><th></th></tr></thead><tbody>
        ${rows.map((m) => `<tr style="${m.status === 'done' ? 'opacity:.55' : ''}">
          <td class="small">${fmtDate(m.created_at)}</td>
          <td><b>${esc(m.name || '—')}</b><div class="small"><a href="tel:${esc(m.phone || '')}">${esc(m.phone || '')}</a></div></td>
          <td>${esc(m.message)} ${m.call_id ? `<div class="small"><a href="#/calls/${m.call_id}">Voir l'appel</a></div>` : ''}</td>
          <td><span class="pill ${m.urgency === 'haute' ? 'danger' : m.urgency === 'basse' ? '' : 'warn'}">${esc(m.urgency)}</span></td>
          <td><button class="btn small" data-done="${m.id}" data-status="${m.status === 'done' ? 'new' : 'done'}">${m.status === 'done' ? 'Rouvrir' : '✓ Traité'}</button>
            <button class="btn small danger" data-del="${m.id}">✕</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Aucun message.</div>'}</div>`;
    $$('[data-done]').forEach((b) => b.onclick = async () => { await api(`/messages/${b.dataset.done}`, { method: 'PATCH', body: { status: b.dataset.status } }); views.messages(); refreshBadge(); });
    $$('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Supprimer ce message ?')) { await api(`/messages/${b.dataset.del}`, { method: 'DELETE' }); views.messages(); refreshBadge(); } });
  },

  async appointments() {
    const rows = await api('/appointments');
    view.innerHTML = `
      <div class="page-head"><div><h1>Rendez-vous</h1><p class="muted">Rendez-vous à venir pris par l'assistant${settingsCache.has_google_service_account ? ' (synchronisés avec Google Agenda)' : ''}</p></div></div>
      <div class="card table-wrap">${rows.length ? `<table><thead><tr><th>Quand</th><th>Client</th><th>Motif</th><th>Statut</th><th></th></tr></thead><tbody>
        ${rows.map((a) => `<tr>
          <td><b>${fmtDate(a.start_utc, { weekday: 'short' })}</b></td>
          <td>${esc(a.name)}<div class="small"><a href="tel:${esc(a.phone || '')}">${esc(a.phone || '')}</a> ${esc(a.email || '')}</div></td>
          <td>${esc(a.reason || '—')} ${a.call_id ? `<div class="small"><a href="#/calls/${a.call_id}">Voir l'appel</a></div>` : ''}</td>
          <td>${a.status === 'confirmed' ? '<span class="pill ok">Confirmé</span>' : '<span class="pill danger">Annulé</span>'}</td>
          <td>${a.status === 'confirmed' ? `<button class="btn small danger" data-cancel="${a.id}">Annuler</button>` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Aucun rendez-vous à venir.</div>'}</div>`;
    $$('[data-cancel]').forEach((b) => b.onclick = () => {
      if (!confirm('Annuler ce rendez-vous ? Le client ne sera pas prévenu automatiquement.')) return;
      withBusy(b, async () => { await api(`/appointments/${b.dataset.cancel}/cancel`, { method: 'POST' }); views.appointments(); });
    });
  },

  async assistant() {
    const voices = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
    settingsPage({
      title: 'Assistant',
      subtitle: 'Identité, voix et comportement de votre standardiste IA',
      body: `
      <div class="card"><h2>Entreprise</h2>
        <div class="row"><label>Nom de l'entreprise<input name="business_name" required></label>
          <label>Site web<input name="business_website" placeholder="https://"></label></div>
        <label>Description de l'activité<span class="hint">Ce que vous faites, vos services, votre zone d'intervention…</span><textarea name="business_description"></textarea></label>
        <label>Adresse<input name="business_address"></label>
      </div>
      <div class="card"><h2>Voix et accueil</h2>
        <div class="row"><label>Prénom de l'assistant<input name="assistant_name" required></label>
          <label>Voix<select name="voice">${voices.map((v) => `<option>${v}</option>`).join('')}</select><span class="hint">« marin » et « cedar » sont les plus naturelles</span></label>
          <label>Vitesse<input name="voice_speed" type="number" step="0.05" min="0.25" max="1.5"></label></div>
        <label>Message d'accueil<span class="hint">Variables : {entreprise}, {assistant}</span><input name="greeting"></label>
        <label class="check"><input type="checkbox" name="multilingual"> Répondre dans la langue de l'appelant</label>
      </div>
      <div class="card"><h2>Consignes</h2>
        <label>Instructions spécifiques<span class="hint">Ex. : « Ne donne jamais de prix par téléphone », « Pour une urgence, propose le transfert »…</span><textarea name="custom_instructions" rows="6"></textarea></label>
      </div>
      <div class="card"><h2>Fonctions</h2>
        <label class="check"><input type="checkbox" name="enable_booking"> Prise de rendez-vous</label>
        <label class="check"><input type="checkbox" name="enable_messages"> Prise de messages / demandes de rappel</label>
        <label class="check"><input type="checkbox" name="enable_transfer"> Transfert vers un humain</label>
        <div class="row"><label>Numéro de transfert<input name="transfer_number" placeholder="0612345678"></label>
          <label class="check" style="margin-bottom:22px"><input type="checkbox" name="transfer_only_open"> Uniquement aux heures d'ouverture</label></div>
      </div>
      <div class="card"><h2>Avancé</h2>
        <div class="row">
          <label>Détection de fin de parole<select name="turn_detection"><option value="semantic_vad">Sémantique (plus naturel)</option><option value="server_vad">Silence (plus rapide)</option></select></label>
          <label>Réduction de bruit<select name="noise_reduction"><option value="near_field">Téléphone (proche)</option><option value="far_field">Mains-libres (loin)</option><option value="off">Désactivée</option></select></label>
          <label>Durée max d'un appel (min)<input name="max_call_minutes" type="number" min="1" max="60"></label></div>
        <label class="check"><input type="checkbox" name="record_calls"> Enregistrer les appels <span class="hint">(RGPD : l'appelant doit en être informé, par exemple dans le message d'accueil)</span></label>
      </div>`,
      after: `<div class="card" style="margin-top:16px"><div class="kb-head"><h2 style="margin:0">Aperçu des instructions envoyées à l'IA</h2><button class="btn small" id="show-prompt">Afficher</button></div><pre class="prompt hidden" id="prompt"></pre></div>`,
    });
    $('#show-prompt').onclick = async () => {
      const { instructions } = await api('/prompt-preview');
      $('#prompt').textContent = instructions;
      $('#prompt').classList.remove('hidden');
    };
  },

  async hours() {
    const days = [['mon', 'Lundi'], ['tue', 'Mardi'], ['wed', 'Mercredi'], ['thu', 'Jeudi'], ['fri', 'Vendredi'], ['sat', 'Samedi'], ['sun', 'Dimanche']];
    const h = settingsCache.opening_hours || {};
    view.innerHTML = `
      <div class="page-head"><div><h1>Horaires</h1><p class="muted">Utilisés pour informer les appelants, autoriser le transfert et proposer des rendez-vous</p></div></div>
      <form id="hours-form"><div class="card">
        <p class="small muted">Format : <code>09:00-12:00, 14:00-18:00</code>. Laisser vide = fermé.</p>
        ${days.map(([k, l]) => `<div class="hours-row"><b>${l}</b><input name="${k}" value="${esc((h[k] || []).map((r) => r.join('-')).join(', '))}" placeholder="fermé"></div>`).join('')}
      </div>
      <div class="card"><h2>Fermetures exceptionnelles</h2>
        <label>Dates (une par ligne, AAAA-MM-JJ)<textarea name="closed_dates" placeholder="2026-12-25">${esc((settingsCache.closed_dates || []).join('\n'))}</textarea></label>
        <label>Fuseau horaire<input name="timezone" value="${esc(settingsCache.timezone)}"></label>
      </div>
      <button class="btn primary" type="submit">Enregistrer</button></form>`;
    $('#hours-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      withBusy(f.querySelector('[type=submit]'), async () => {
        const opening_hours = {};
        for (const [k] of days) {
          opening_hours[k] = f[k].value.split(',').map((s) => s.trim()).filter(Boolean)
            .map((r) => r.split(/\s*[-–]\s*/).map((t) => t.replace('h', ':').padStart(5, '0')));
        }
        const closed_dates = f.closed_dates.value.split(/\s+/).filter(Boolean);
        settingsCache = await api('/settings', { method: 'PUT', body: { opening_hours, closed_dates, timezone: f.timezone.value } });
        toast('Horaires enregistrés');
        views.hours();
      });
    });
  },

  async knowledge() {
    const { rows, chars, limit } = await api('/knowledge');
    const item = (k) => `<div class="kb-item ${k.enabled ? '' : 'disabled'}" data-id="${k.id}">
      <div class="kb-head"><b>${esc(k.title || '(sans titre)')}</b><div>
        ${k.source_url ? `<a class="small" href="${esc(k.source_url)}" target="_blank" rel="noopener">source</a>` : ''}
        <button class="btn small" data-edit>Modifier</button>
        <button class="btn small" data-toggle>${k.enabled ? 'Désactiver' : 'Activer'}</button>
        <button class="btn small danger" data-del>✕</button></div></div>
      <div class="small muted" style="white-space:pre-line;margin-top:6px">${esc(k.content.slice(0, 400))}${k.content.length > 400 ? '…' : ''}</div></div>`;
    const faq = rows.filter((r) => r.kind === 'faq');
    const docs = rows.filter((r) => r.kind !== 'faq');
    view.innerHTML = `
      <div class="page-head"><div><h1>Base de connaissances</h1><p class="muted">Ce que l'assistant sait de votre entreprise</p></div></div>
      <div class="card"><div class="kb-head"><span>Taille utilisée</span><span class="small muted">${chars.toLocaleString('fr')} / ${limit.toLocaleString('fr')} caractères</span></div>
        <div class="progress" style="margin-top:8px"><div style="width:${Math.min(100, (chars / limit) * 100)}%"></div></div>
        <p class="small muted">Toute la base est donnée à l'IA à chaque appel. Restez concis : une base plus courte = réponses plus rapides et moins coûteuses.</p></div>
      <div class="grid two">
        <form class="card" id="add-faq"><h2>Ajouter une question fréquente</h2>
          <label>Question<input name="title" required placeholder="Quels sont vos tarifs ?"></label>
          <label>Réponse<textarea name="content" required></textarea></label>
          <button class="btn primary">Ajouter</button></form>
        <div>
          <form class="card" id="add-url"><h2>Importer une page web</h2>
            <label>URL<input name="url" type="url" required placeholder="https://monsite.fr/services"></label>
            <button class="btn primary">Importer</button></form>
          <form class="card" id="add-text"><h2>Ajouter un texte</h2>
            <label>Titre<input name="title" required placeholder="Tarifs 2026"></label>
            <label>Contenu<textarea name="content" required></textarea></label>
            <button class="btn primary">Ajouter</button></form>
        </div>
      </div>
      <div class="card"><h2>Questions fréquentes (${faq.length})</h2>${faq.map(item).join('') || '<div class="empty">Aucune.</div>'}</div>
      <div class="card"><h2>Documents (${docs.length})</h2>${docs.map(item).join('') || '<div class="empty">Aucun.</div>'}</div>`;

    const add = (id, kind) => $(id).addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(e.submitter, async () => {
        await api('/knowledge', { method: 'POST', body: { kind, ...formData(e.target) } });
        toast('Ajouté'); views.knowledge();
      });
    });
    add('#add-faq', 'faq');
    add('#add-text', 'text');
    $('#add-url').addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(e.submitter, async () => {
        const r = await api('/knowledge/import-url', { method: 'POST', body: formData(e.target) });
        toast(`« ${r.title} » importé (${r.chars} caractères)`); views.knowledge();
      });
    });
    $$('.kb-item').forEach((el) => {
      const id = el.dataset.id;
      const k = rows.find((r) => String(r.id) === id);
      el.querySelector('[data-del]').onclick = async () => { if (confirm('Supprimer ?')) { await api(`/knowledge/${id}`, { method: 'DELETE' }); views.knowledge(); } };
      el.querySelector('[data-toggle]').onclick = async () => { await api(`/knowledge/${id}`, { method: 'PUT', body: { enabled: !k.enabled } }); views.knowledge(); };
      el.querySelector('[data-edit]').onclick = () => {
        el.innerHTML = `<label>${k.kind === 'faq' ? 'Question' : 'Titre'}<input name="title" value="${esc(k.title)}"></label>
          <label>${k.kind === 'faq' ? 'Réponse' : 'Contenu'}<textarea name="content" rows="8">${esc(k.content)}</textarea></label>
          <button class="btn primary small" data-save>Enregistrer</button> <button class="btn small" data-cancel>Annuler</button>`;
        el.querySelector('[data-cancel]').onclick = () => views.knowledge();
        el.querySelector('[data-save]').onclick = async () => {
          await api(`/knowledge/${id}`, { method: 'PUT', body: { title: el.querySelector('[name=title]').value, content: el.querySelector('[name=content]').value } });
          toast('Enregistré'); views.knowledge();
        };
      };
    });
  },

  async calendar() {
    settingsPage({
      title: 'Agenda',
      subtitle: 'Règles de prise de rendez-vous et synchronisation Google Agenda',
      body: `
      <div class="card"><h2>Règles</h2>
        <div class="row">
          <label>Durée d'un créneau (min)<input name="slot_minutes" type="number" min="5" max="480"></label>
          <label>Délai minimum (heures)<input name="min_notice_hours" type="number" min="0" step="0.5"></label>
          <label>Réservable jusqu'à (jours)<input name="booking_horizon_days" type="number" min="1" max="365"></label></div>
        <p class="small muted">Les créneaux sont générés à partir des <a href="#/hours">horaires d'ouverture</a>.</p>
      </div>
      <div class="card"><h2>Google Agenda <span class="pill">optionnel</span></h2>
        <p class="small muted">Sans Google, les rendez-vous sont stockés uniquement dans Naoned. Avec Google, l'assistant vérifie vos indisponibilités et crée l'événement dans votre agenda.</p>
        <ol class="small muted">
          <li>Console Google Cloud → créez un projet → activez « Google Calendar API ».</li>
          <li>IAM → Comptes de service → créez un compte → Clés → « Ajouter une clé » (JSON).</li>
          <li>Dans Google Agenda → paramètres de votre agenda → « Partager avec des personnes » → ajoutez l'e-mail du compte de service avec le droit « Modifier les événements ».</li>
          <li>Copiez l'« ID de l'agenda » (section « Intégrer l'agenda ») ci-dessous.</li></ol>
        <label>ID de l'agenda<input name="google_calendar_id" placeholder="xxxx@group.calendar.google.com ou votre@gmail.com"></label>
        <label>JSON du compte de service ${settingsCache.has_google_service_account ? '<span class="pill ok">enregistré</span>' : ''}
          <span class="hint">Laisser vide pour conserver la clé actuelle</span>
          <textarea name="google_service_account" placeholder='{"type": "service_account", ...}' rows="4"></textarea></label>
        <div class="row" style="flex:0"><button type="button" class="btn" id="test-google">Tester la connexion</button>
          ${settingsCache.has_google_service_account ? '<button type="button" class="btn danger" id="clear-google">Supprimer la clé</button>' : ''}</div>
      </div>`,
      after: `<div class="card" style="margin-top:16px"><h2>Tester les disponibilités</h2>
        <div class="row"><input type="date" id="avail-date"><button class="btn" id="avail-btn" style="flex:0">Vérifier</button></div>
        <pre class="prompt hidden" id="avail-out"></pre></div>`,
    });
    $('#test-google').onclick = (e) => withBusy(e.target, async () => {
      const r = await api('/calendar/test', { method: 'POST' });
      toast(`Connexion OK (${r.service_account}) – ${r.busy_periods_next_7_days} occupation(s) sur 7 jours`);
    });
    const clr = $('#clear-google');
    if (clr) clr.onclick = async () => { settingsCache = await api('/settings', { method: 'PUT', body: { google_service_account: '__clear__' } }); views.calendar(); };
    $('#avail-date').valueAsDate = new Date();
    $('#avail-btn').onclick = (e) => withBusy(e.target, async () => {
      const r = await api(`/availability?date=${$('#avail-date').value}`);
      $('#avail-out').textContent = JSON.stringify(r, null, 2);
      $('#avail-out').classList.remove('hidden');
    });
  },

  async notifications() {
    settingsPage({
      title: 'Notifications',
      subtitle: 'Recevez le résumé de chaque appel par e-mail',
      body: `
      <div class="card"><h2>Destinataires</h2>
        <label>Adresses e-mail<span class="hint">Séparées par des virgules</span><input name="notify_emails" placeholder="vous@entreprise.fr"></label>
        <label>Envoyer<select name="notify_mode"><option value="all">Pour chaque appel</option><option value="important">Seulement RDV, messages, transferts et actions requises</option><option value="none">Jamais</option></select></label>
      </div>
      <div class="card"><h2>Serveur SMTP</h2>
        <div class="row"><label>Hôte<input name="smtp_host" placeholder="smtp.example.com"></label>
          <label>Port<input name="smtp_port" type="number"></label>
          <label class="check" style="margin-bottom:22px"><input type="checkbox" name="smtp_secure"> TLS direct (port 465)</label></div>
        <div class="row"><label>Utilisateur<input name="smtp_user" autocomplete="off"></label>
          <label>Mot de passe ${settingsCache.has_smtp_password ? '<span class="pill ok">enregistré</span>' : ''}<input name="smtp_password" type="password" autocomplete="new-password" placeholder="inchangé si vide"></label></div>
        <label>Expéditeur<input name="smtp_from" placeholder="Assistant &lt;assistant@entreprise.fr&gt;"></label>
        <button type="button" class="btn" id="test-mail">Envoyer un e-mail de test</button>
      </div>`,
    });
    $('#test-mail').onclick = (e) => withBusy(e.target, async () => { await api('/notifications/test', { method: 'POST' }); toast('E-mail de test envoyé'); });
  },
};

function renderLive(live) {
  const el = $('#live-card');
  if (!el) return;
  el.innerHTML = `<h2>${live.length ? '<span class="live-dot"></span>' : ''}Appels en direct</h2>${live.length ? live.map((c) => `
    <div class="kb-item"><div class="kb-head"><b>${esc(c.caller_number || 'Numéro masqué')}</b><span class="pill primary">${fmtDur(c.duration_s)}</span></div>
      <div class="chat" style="margin-top:8px">${c.transcript.slice(-6).map((m) => `<div class="bubble ${m.role}">${esc(m.text)}</div>`).join('') || '<span class="small muted">…</span>'}</div>
      <a class="small" href="#/calls/${c.call_id}">Ouvrir</a></div>`).join('') : '<div class="empty">Aucun appel en cours.</div>'}`;
}

async function refreshBadge() {
  try {
    const { messages_new } = await api('/stats');
    const b = $('#badge-msg');
    b.textContent = messages_new;
    b.classList.toggle('hidden', !messages_new);
  } catch { /* ignore */ }
}

// ---------- Routeur ----------
async function route() {
  clearInterval(pollTimer); clearTimeout(pollTimer);
  const [, name = '', id] = location.hash.replace(/^#/, '').split('/');
  const key = name === '' ? 'dashboard' : (name === 'calls' && id ? 'callDetail' : name);
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (key === 'callDetail' ? 'calls' : key)));
  const fn = views[key] || views.dashboard;
  view.innerHTML = '<div class="empty">Chargement…</div>';
  try {
    if (!settingsCache) await loadSettings();
    await fn(id);
  } catch (e) {
    view.innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

async function start() {
  const { authenticated } = await api('/me');
  if (!authenticated) return showLogin();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadSettings();
  refreshBadge();
  setInterval(refreshBadge, 30_000);
  route();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); location.reload(); };
window.addEventListener('hashchange', route);
start();
