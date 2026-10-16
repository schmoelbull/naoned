import { db, logEvent } from './db.js';
import { checkAvailability, bookAppointment } from './calendar.js';
import { isOpenAt } from './time.js';

export function toolDefinitions(settings) {
  const tools = [];
  if (settings.enable_booking) {
    tools.push({
      type: 'function',
      name: 'check_availability',
      description: 'Renvoie les horaires de rendez-vous libres pour une date donnée.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'Date au format AAAA-MM-JJ' } },
        required: ['date'],
      },
    }, {
      type: 'function',
      name: 'book_appointment',
      description: 'Réserve un rendez-vous. À appeler uniquement après confirmation explicite de l\'appelant.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'AAAA-MM-JJ' },
          time: { type: 'string', description: 'HH:MM (24 h), parmi les horaires renvoyés par check_availability' },
          name: { type: 'string', description: 'Nom complet du client' },
          phone: { type: 'string', description: 'Téléphone de contact' },
          email: { type: 'string', description: 'E-mail (facultatif)' },
          reason: { type: 'string', description: 'Motif du rendez-vous' },
        },
        required: ['date', 'time', 'name'],
      },
    });
  }
  if (settings.enable_messages) {
    tools.push({
      type: 'function',
      name: 'take_message',
      description: 'Enregistre un message ou une demande de rappel pour l\'équipe.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string', description: 'Numéro de rappel' },
          message: { type: 'string', description: 'Contenu du message, résumé clairement' },
          urgency: { type: 'string', enum: ['basse', 'normale', 'haute'] },
        },
        required: ['message'],
      },
    });
  }
  if (settings.enable_transfer && settings.transfer_number) {
    tools.push({
      type: 'function',
      name: 'transfer_call',
      description: 'Transfère l\'appel vers un membre de l\'équipe. Annonce le transfert AVANT d\'appeler cette fonction.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Raison du transfert' } },
        required: ['reason'],
      },
    });
  }
  tools.push({
    type: 'function',
    name: 'end_call',
    description: 'Raccroche. À appeler après avoir dit au revoir.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
  });
  return tools;
}

/**
 * Exécute un outil. Renvoie { output, action } où action ∈ { undefined, 'hangup', 'transfer' }.
 */
export async function runTool(name, args, ctx) {
  const { settings, callId, callerNumber } = ctx;
  logEvent(callId, `tool:${name}`, args);
  try {
    switch (name) {
      case 'check_availability':
        return { output: await checkAvailability(settings, args.date) };

      case 'book_appointment': {
        const res = await bookAppointment(settings, { ...args, phone: args.phone || callerNumber }, callId);
        if (res.success) logEvent(callId, 'appointment', res);
        return { output: res };
      }

      case 'take_message': {
        const info = db.prepare('INSERT INTO messages (call_id, name, phone, message, urgency) VALUES (?, ?, ?, ?, ?)')
          .run(callId, args.name || null, args.phone || callerNumber || null, args.message, args.urgency || 'normale');
        return { output: { success: true, message_id: Number(info.lastInsertRowid) } };
      }

      case 'transfer_call': {
        if (settings.transfer_only_open && !isOpenAt(settings)) {
          return { output: { error: 'Transfert impossible : l\'entreprise est fermée. Propose de prendre un message.' } };
        }
        return { output: { success: true, info: 'Transfert en cours.' }, action: 'transfer' };
      }

      case 'end_call':
        return { output: { success: true }, action: 'hangup' };

      default:
        return { output: { error: `Fonction inconnue : ${name}` } };
    }
  } catch (err) {
    console.error(`[tool ${name}]`, err);
    logEvent(callId, 'tool_error', { name, error: err.message });
    return { output: { error: 'Erreur technique, impossible de finaliser. Propose de prendre un message.' } };
  }
}
