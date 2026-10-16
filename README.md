# Naoned – assistant téléphonique IA auto-hébergé

Standardiste IA dans l'esprit de fonio.ai, qui tourne sur **ton** VPS :

- décroche les appels 24 h/24 avec une voix naturelle (OpenAI Realtime, speech-to-speech) ;
- répond à partir de ta **base de connaissances** (FAQ, textes, import de pages web) ;
- **prend des rendez-vous** selon tes horaires (local et, en option, Google Agenda) ;
- **prend des messages** et des demandes de rappel ;
- **transfère** vers un humain si besoin (en option, uniquement aux heures d'ouverture) ;
- enregistre la **transcription**, génère un **résumé IA** et t'envoie un **e-mail** après chaque appel ;
- propose un **tableau de bord** web : statistiques, appels en direct, historique, messages, RDV et configuration.

## Architecture

```
Appelant ──SIP──► Opérateur SIP ──► Asterisk (VPS)
                                     │  ARI (HTTP/WS, 127.0.0.1:8088)
                                     │  External Media RTP G.711 µ-law (127.0.0.1)
                                     ▼
                                  Node.js (src/) ◄──WebSocket──► OpenAI Realtime
                                     │
                                     ├── SQLite (data/naoned.db)
                                     ├── Google Agenda (optionnel)
                                     ├── SMTP (notifications)
                                     └── Dashboard web (public/) derrière Nginx + HTTPS
```

L'audio est en G.711 µ-law de bout en bout (téléphone → Asterisk → OpenAI). Il n'y a aucun transcodage dans Node, ce qui garde la latence au minimum.

| Fichier | Rôle |
|---|---|
| `src/server.js` | Point d'entrée : connexion ARI, distribution des appels, serveur HTTP |
| `src/call.js` | Cycle de vie d'un appel : pont audio, session IA, outils, interruption, transfert, raccrochage |
| `src/rtp.js` | Pont RTP (réception, file de lecture cadencée à 20 ms, interruption) |
| `src/realtime.js` | Client WebSocket OpenAI Realtime |
| `src/prompt.js` | Construction des instructions (contexte, horaires, base de connaissances) |
| `src/tools.js` | Fonctions appelables par l'IA : disponibilités, RDV, message, transfert, fin d'appel |
| `src/calendar.js`, `src/google.js` | Créneaux, réservations, Google Agenda (compte de service, sans SDK) |
| `src/postcall.js`, `src/mailer.js` | Résumé IA et e-mail après l'appel |
| `src/api.js`, `src/auth.js` | API REST du dashboard, authentification |
| `public/` | Dashboard (HTML/CSS/JS, sans framework) |
| `asterisk/` | Modèles de configuration Asterisk |
| `deploy/` | Script d'installation, service systemd, Nginx |

## Prérequis

- Un VPS **Ubuntu 22.04 ou 24.04** avec accès root (2 vCPU / 2 Go de RAM suffisent pour quelques appels simultanés).
- Un **nom de domaine** pointant vers le VPS (pour le HTTPS du dashboard).
- Une **ligne SIP** (trunk) avec un numéro, par exemple OVHcloud Telecom, Telnyx, Keyyo ou Twilio Elastic SIP. Tu dois récupérer l'hôte SIP, l'identifiant et le mot de passe.
- Une **clé API OpenAI** avec accès au modèle `gpt-realtime`.

## Installation

```bash
git clone <ce dépôt> naoned && cd naoned
cp .env.example .env
nano .env        # ADMIN_PASSWORD, OPENAI_API_KEY, SIP_PROVIDER_HOST, SIP_USERNAME, SIP_PASSWORD
sudo ./deploy/install.sh assistant.mon-domaine.fr
```

Le script installe Asterisk, Node.js 22, Nginx, certbot, ufw et fail2ban. Il génère les mots de passe manquants (ARI, session, softphone), écrit la configuration Asterisk et sauvegarde l'ancienne dans `/etc/asterisk/backup-*`, puis démarre le service `naoned`.

Ensuite :

1. Ouvre `https://assistant.mon-domaine.fr` et connecte-toi avec `ADMIN_PASSWORD`.
2. Configure **Assistant**, **Connaissances**, **Horaires**, puis **Agenda** et **Notifications** (optionnels).
3. Vérifie le trunk : `sudo asterisk -rx 'pjsip show registrations'` doit afficher `Registered`.
4. **Test sans opérateur** : configure un softphone (Linphone ou Zoiper) avec l'utilisateur `6001`, le mot de passe `TEST_PHONE_PASSWORD` (dans `.env`) et l'IP du VPS comme domaine, puis compose le **100**.
5. Appelle ton numéro.

## Exploitation

```bash
journalctl -u naoned -f                  # logs de l'application
sudo asterisk -rvvv                      # console Asterisk
sudo systemctl restart naoned asterisk
npm test                                 # tests (appel simulé de bout en bout + unitaires)
```

Pour mettre à jour : `git pull` puis relance `sudo ./deploy/install.sh <domaine>`. Le script est réexécutable et conserve les secrets de `.env`.

Les données sont dans `/opt/naoned/data/naoned.db` (SQLite) et les enregistrements dans `/var/spool/asterisk/recording/`. Sauvegarde les deux.

## Points à vérifier pour ta configuration

- **Opérateur SIP** : `asterisk/pjsip.conf` couvre le cas classique d'un enregistrement par identifiant et mot de passe. Certains opérateurs exigent un autre `from_domain`, un `outbound_proxy` ou une authentification par IP. Vérifie avec leur documentation.
- **Transfert** : il compose `PJSIP/<numéro>@trunk`. Certains opérateurs refusent un appel sortant qui présente le numéro de l'appelant initial. Teste avant de mettre en production.
- **Coût OpenAI** : il est facturé à la minute audio, en entrée et en sortie. Vérifie le tarif actuel de `gpt-realtime` sur la page des prix OpenAI avant d'ouvrir la ligne. Pour réduire le coût, utilise `OPENAI_REALTIME_MODEL=gpt-realtime-mini`.
- **RGPD** : avec OpenAI, les données d'appel transitent hors UE. Mentionne-le dans ta politique de confidentialité. Si tu actives l'enregistrement, informe l'appelant dans le message d'accueil.
- **Sécurité SIP** : les scanners SIP attaquent le port 5060 dès la mise en ligne. Garde des mots de passe forts (le script les génère), fail2ban est actif, et restreins idéalement le port 5060 aux IP de ton opérateur (`ufw allow from <IP opérateur> to any port 5060 proto udp`).

## Limites actuelles

- Mono-entreprise : un seul assistant et un seul compte administrateur.
- La base de connaissances est injectée en entier dans le prompt (40 000 caractères au maximum). Il n'y a pas de recherche vectorielle.
- Le client n'est pas prévenu par SMS quand on annule un RDV depuis le dashboard.
