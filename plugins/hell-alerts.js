import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Album, NewMessage } from 'teleproto/events';
import { connectionManager } from '../lib/funcion/connection-manager.js';
import { getGroupDataForPlugin } from '../lib/funcion/pluginHelper.js';

const CONFIG_PATH = path.resolve('database', 'hell-alerts-telegram.json');
const CHANNEL_USERNAME = 'LMEvents';
const CHANNEL_URL = 'https://t.me/LMEvents';
const ONAX_SOURCE_TITLE = 'Kata KwF Atlas';
const INFO_SOURCE_TITLE = 'INFO Lords Mobile';
const configuredWhatsAppGroupUrl = global.whatsappGroupUrl;
const WHATSAPP_GROUP_URL = typeof configuredWhatsAppGroupUrl === 'string'
  ? configuredWhatsAppGroupUrl.trim()
  : '';
const SALES_TEXT_DEFAULT = 'Disponible en la tienda.';
const TELEGRAM_RECHECK_MS = 60 * 1000;
const ONAX_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const ONAX_COMMAND_MAX_LENGTH = 500;
const ONAX_COMMAND_COOLDOWN_MS = 2500;
const ONAX_REPLY_IDLE_MS = 5000;
const ONAX_REPLY_TIMEOUT_MS = 45 * 1000;
const EVENT_TYPES = {
  solo: {
    label: 'EVENTO SOLITARIO',
    icon: '🎯',
    accent: '⚔️',
    patterns: [/#solo(?:event)?\b/i, /\bsolitario\b/i, /\bsolo\s+event\b/i]
  },
  hell: {
    label: 'INFIERNO ACTIVO',
    icon: '🔥',
    accent: '👹',
    patterns: [/#hell(?:event)?\b/i, /\binfierno\b/i, /\bhell\s+event\b/i]
  },
  daily: {
    label: 'EVENTO 24 HORAS',
    icon: '⏱️',
    accent: '🔁',
    patterns: [/#24\s*h(?:ours?)?\b/i, /\b24\s*(?:h|hours?)\b/i, /\b24\s*hour\s+event\b/i]
  }
};

if (WHATSAPP_GROUP_URL) {
  const groupUrl = new URL(WHATSAPP_GROUP_URL);
  if (groupUrl.protocol !== 'https:' || groupUrl.hostname !== 'chat.whatsapp.com') {
    throw new Error('global.whatsappGroupUrl debe ser un enlace HTTPS de chat.whatsapp.com.');
  }
} else {
  console.warn('[hell-alerts] Configura global.whatsappGroupUrl en config.js para habilitar el botón de WhatsApp.');
}

const WHATSAPP_GROUP_BUTTON = WHATSAPP_GROUP_URL ? [['Toca Acá', WHATSAPP_GROUP_URL]] : [];

function withWhatsAppGroupLink(text) {
  return WHATSAPP_GROUP_URL ? `${text}\n\n🔗 ${WHATSAPP_GROUP_URL}` : text;
}

const previousTelegramState = global.__hellAlertsTelegram;
if (previousTelegramState?.recheckTimer) clearInterval(previousTelegramState.recheckTimer);
if (previousTelegramState) {
  global.__hellAlertsTelegram = {
    status: 'restarting',
    client: null,
    channel: null,
    infoSource: null,
    infoSourceId: null,
    previousState: previousTelegramState
  };
}

if (global.__hellAlertsPoller) {
  clearInterval(global.__hellAlertsPoller);
  delete global.__hellAlertsPoller;
}

let deliveryQueue = Promise.resolve();
const onaxCommandCooldowns = new Map();

function ensureDb() {
  if (!global.db?.data) return false;
  if (!global.db.data.hell_alerts) global.db.data.hell_alerts = {};
  return true;
}

function getListenerState() {
  if (!global.__hellAlertsTelegram) {
    global.__hellAlertsTelegram = {
      status: 'not-configured',
      client: null,
      channel: null,
      infoSource: null,
      infoSourceId: null
    };
  }
  return global.__hellAlertsTelegram;
}

function normalizeJid(conn) {
  const jid = conn?.user?.jid || conn?.user?.id;
  if (!jid) return '';
  return typeof conn.decodeJid === 'function' ? conn.decodeJid(jid) : jid;
}

export function getConnectionForBot(botJid) {
  const candidates = new Set([
    global.conn,
    ...connectionManager.getAllActiveSockets()
  ].filter(Boolean));

  for (const conn of candidates) {
    if (normalizeJid(conn) !== botJid) continue;
    const readyState = conn.ws?.readyState;
    if (conn.ws?.isOpen === false || (readyState !== undefined && readyState !== 1)) continue;
    return conn;
  }
  return null;
}

function getTargetChats(source = 'telegram') {
  if (!ensureDb()) return [];
  return Object.entries(global.db.data.hell_alerts)
    .filter(([, config]) => config?.botJid && (
      source === 'info' ? config.enabled && config.infoTelegramEnabled === true
        : source === 'onax' ? config.onaxEnabled === true
          : config.enabled && config.telegramEnabled !== false
    ));
}

async function saveDb() {
  if (global.db?.data) await global.db.write();
}

function getEventType(text) {
  for (const [type, event] of Object.entries(EVENT_TYPES)) {
    if (event.patterns.some(pattern => pattern.test(text))) return type;
  }
  return null;
}

function getEventTags(text) {
  const tags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return tags.filter(tag => !Object.values(EVENT_TYPES).some(event =>
    event.patterns.some(pattern => pattern.test(tag))
  )).slice(0, 3).map(tag => tag.slice(1));
}

export function isSupportedEvent(message) {
  return Boolean(getEventType(message?.message || ''));
}

export function formatEventMessage(message) {
  const text = message.message || '';
  const type = getEventType(text);
  const event = EVENT_TYPES[type] || EVENT_TYPES.hell;
  const targets = getEventTags(text);
  return [
    `${event.accent} *${event.label}*`,
    targets.length ? `🎯 ${targets.join(' · ')}` : '📸 Mira la imagen para ver el objetivo.',
    `🛒 ${SALES_TEXT_DEFAULT}`,
    '👇 *Toca acá* para entrar al grupo.'
  ].join('\n');
}

export async function cropEventImageWatermark(photo) {
  const { width, height } = await sharp(photo).metadata();
  if (!width || !height || height < 40) return photo;
  const croppedHeight = Math.floor(height * 0.87);
  if (croppedHeight >= height) return photo;
  return sharp(photo).extract({ left: 0, top: 0, width, height: croppedHeight }).toBuffer();
}

async function downloadEventPhoto(client, message) {
  if (!message.media?.photo) return null;
  const photo = await client.downloadMedia(message, {});
  if (!Buffer.isBuffer(photo) || !photo.length) return null;
  if (photo.length > 8 * 1024 * 1024) throw new Error('La imagen del evento excede el límite de 8 MB.');
  const croppedPhoto = await cropEventImageWatermark(photo);
  if (croppedPhoto !== photo) {
    console.log(`[hell-alerts] Se recortó la marca de agua inferior de la publicación ${message.id}.`);
  }
  return croppedPhoto;
}

function getOnaxButtons(message) {
  const rows = message.replyMarkup?.rows || [];
  return rows.flatMap(row => (row.buttons || []).map(button => {
    const target = button.url || button.type?.url;
    return {
      label: String(button.text || 'Opción').trim(),
      url: typeof target === 'string' && /^https?:\/\//i.test(target) ? target : null
    };
  }));
}

export function formatOnaxMessage(message, isTelegramResponse = false) {
  const text = String(message.message || '');
  if (isTelegramResponse) return text;

  const trimmedText = text.trim();
  const buttons = getOnaxButtons(message);
  const buttonText = buttons.length
    ? `🔘 Opciones:\n${buttons.map(button => `• ${button.label}${button.url ? `: ${button.url}` : ''}`).join('\n')}`
    : '';
  const heading = `📨 *MENSAJE DE ${ONAX_SOURCE_TITLE.toLocaleUpperCase('es')}*`;
  const content = [trimmedText || 'El mensaje no contiene texto.', buttonText].filter(Boolean);
  return [
    `╭━━━〔 ${heading} 〕━━━╮`,
    ...content,
    `╰━━━━━━━━ ${ONAX_SOURCE_TITLE} ━━━━━━━━╯`
  ].join('\n\n');
}

function getOnaxMedia(message) {
  const media = message.media;
  if (!media) return null;
  if (media.photo || media.webpage?.photo) {
    return { type: 'image', mimeType: 'image/jpeg', fileName: 'telegram-photo.jpg' };
  }

  const document = media.document || media.webpage?.document;
  if (!document) return null;
  const mimeType = document.mimeType || 'application/octet-stream';
  const fileNameAttribute = document.attributes?.find(attribute =>
    attribute.className === 'DocumentAttributeFilename'
  );
  const fileName = fileNameAttribute?.fileName || 'telegram-file';
  const size = Number(document.size) || 0;

  if (mimeType.startsWith('image/')) return { type: 'image', mimeType, fileName, size };
  if (mimeType.startsWith('video/')) return { type: 'video', mimeType, fileName, size };
  if (mimeType.startsWith('audio/')) return { type: 'audio', mimeType, fileName, size };
  return { type: 'document', mimeType, fileName, size };
}

async function sendOnaxText(bot, chatId, text, urlButtons) {
  if (urlButtons.length && typeof bot.sendButton === 'function') {
    await bot.sendButton(
      chatId,
      text,
      `Telegram • ${ONAX_SOURCE_TITLE}`,
      null,
      [],
      null,
      urlButtons,
      null,
      null
    );
    return;
  }
  await bot.sendMessage(chatId, { text });
}

async function deliverOnaxMessage(client, chatId, config, message, isTelegramResponse = false) {
  const bot = getConnectionForBot(config.botJid);
  if (!bot?.user?.jid) throw new Error(`La sesión WhatsApp ${config.botJid} no está conectada.`);

  let text = formatOnaxMessage(message, isTelegramResponse);
  const buttons = getOnaxButtons(message);
  const urlButtons = buttons
    .filter(button => button.url)
    .slice(0, 3)
    .map(button => [button.label.slice(0, 20) || 'Abrir', button.url]);
  const mediaInfo = getOnaxMedia(message);
  let media = null;
  if (mediaInfo) {
    if (mediaInfo.size > ONAX_MEDIA_MAX_BYTES) {
      text += `\n\n⚠️ Se omitió el archivo: supera el límite de ${ONAX_MEDIA_MAX_BYTES / 1024 / 1024} MB.`;
    } else {
      try {
        media = await client.downloadMedia(message, {});
        if (!Buffer.isBuffer(media) || !media.length) {
          media = null;
          text += '\n\n⚠️ No se pudo descargar el archivo adjunto.';
        } else if (media.length > ONAX_MEDIA_MAX_BYTES) {
          media = null;
          text += `\n\n⚠️ Se omitió el archivo: supera el límite de ${ONAX_MEDIA_MAX_BYTES / 1024 / 1024} MB.`;
        }
      } catch (error) {
        console.error(`[onax] No se pudo descargar el archivo del mensaje ${message.id}:`, error);
        text += '\n\n⚠️ No se pudo descargar el archivo adjunto.';
      }
    }
  }

  if (media && (mediaInfo.type === 'image' || mediaInfo.type === 'video')) {
    if (urlButtons.length && typeof bot.sendButton === 'function') {
      await bot.sendButton(
        chatId,
        text,
        `Telegram • ${ONAX_SOURCE_TITLE}`,
        media,
        [],
        null,
        urlButtons,
        null,
        null
      );
      return;
    }
    await bot.sendMessage(chatId, {
      [mediaInfo.type]: media,
      mimetype: mediaInfo.mimeType,
      caption: text
    });
    if (urlButtons.length && typeof bot.sendButton === 'function') {
      await bot.sendButton(chatId, 'Enlaces de las opciones:', `Telegram • ${ONAX_SOURCE_TITLE}`, null, [], null, urlButtons, null, null);
    }
    return;
  }

  if (media && mediaInfo.type === 'audio') {
    await bot.sendMessage(chatId, {
      audio: media,
      mimetype: mediaInfo.mimeType,
      fileName: mediaInfo.fileName
    });
    await sendOnaxText(bot, chatId, text, urlButtons);
    return;
  }

  if (media) {
    await bot.sendMessage(chatId, {
      document: media,
      mimetype: mediaInfo.mimeType,
      fileName: mediaInfo.fileName,
      caption: text
    });
    if (urlButtons.length && typeof bot.sendButton === 'function') {
      await bot.sendButton(chatId, 'Enlaces de las opciones:', `Telegram • ${ONAX_SOURCE_TITLE}`, null, [], null, urlButtons, null, null);
    }
    return;
  }

  await sendOnaxText(bot, chatId, text, urlButtons);
}

function finishOnaxRequest(state, request, timedOut = false) {
  if (state.activeOnaxRequest !== request) return;
  clearTimeout(request.timeout);
  clearTimeout(request.idleTimeout);
  state.activeOnaxRequest = null;

  if (!timedOut || request.responseCount > 0) return;
  const bot = getConnectionForBot(request.botJid);
  if (!bot) {
    console.error(`[onax] No se pudo notificar el tiempo agotado en WhatsApp ${request.waChatId}: sesión desconectada.`);
    return;
  }
  bot.sendMessage(request.waChatId, {
    text: '⏳ No llegó respuesta del bot de Telegram. Puedes intentar el comando de nuevo.'
  }).catch(error => {
    console.error(`[onax] No se pudo notificar el tiempo agotado en WhatsApp ${request.waChatId}:`, error);
  });
}

async function processOnaxMessage(client, message) {
  if (!Number.isSafeInteger(Number(message?.id)) || message.out) return;
  const onaxState = getListenerState();
  if (String(message.chatId) !== onaxState.forwardChatId) return;

  const messageId = Number(message.id);
  const request = onaxState.activeOnaxRequest;
  let bridgedChatId = null;
  if (
    request &&
    Date.now() <= request.expiresAt &&
    Number(message.date || 0) * 1000 >= request.startedAt - 1000 &&
    (
      request.commandMessageId == null ||
      !message.replyTo?.replyToMsgId ||
      Number(message.replyTo.replyToMsgId) === request.commandMessageId
    ) &&
    onaxState.responseBotIds?.has(String(message.senderId || ''))
  ) {
    try {
      await deliverOnaxMessage(
        client,
        request.waChatId,
        { botJid: request.botJid },
        message,
        true
      );
      request.responseCount++;
      bridgedChatId = request.waChatId;
      const targetConfig = global.db?.data?.hell_alerts?.[request.waChatId];
      if (targetConfig?.onaxEnabled) {
        targetConfig.lastOnaxMessageId = Math.max(Number(targetConfig.lastOnaxMessageId) || 0, messageId);
        await saveDb();
      }
      clearTimeout(request.timeout);
      clearTimeout(request.idleTimeout);
      request.idleTimeout = setTimeout(() => finishOnaxRequest(onaxState, request), ONAX_REPLY_IDLE_MS);
      request.idleTimeout.unref?.();
      console.log(`[onax] Respuesta del bot de Telegram ${messageId} enviada a WhatsApp ${request.waChatId}.`);
    } catch (error) {
      console.error(`[onax] Falló el envío de la respuesta ${messageId} a WhatsApp ${request.waChatId}:`, error);
    }
  }

  for (const [chatId, config] of getTargetChats('onax')) {
    if (chatId === bridgedChatId) continue;
    if (messageId <= (Number(config.lastOnaxMessageId) || 0)) continue;

    try {
      await deliverOnaxMessage(client, chatId, config, message);
      config.lastOnaxMessageId = messageId;
      await saveDb();
      console.log(`[onax] Mensaje ${messageId} de ${ONAX_SOURCE_TITLE} enviado al grupo ${chatId}.`);
    } catch (error) {
      console.error(`[onax] Falló el envío del mensaje ${messageId} al grupo ${chatId}:`, error);
    }
  }
}

let onaxDeliveryQueue = Promise.resolve();

function enqueueOnaxMessage(client, message) {
  onaxDeliveryQueue = onaxDeliveryQueue
    .then(() => processOnaxMessage(client, message))
    .catch(error => console.error('[onax] Error procesando mensaje:', error));
  return onaxDeliveryQueue;
}

async function forwardWhatsAppCommandToTelegram(m, conn) {
  if (!m.isGroup || !String(m.chat || '').endsWith('@g.us') || m.fromMe || m.key?.fromMe) return;
  const config = global.db?.data?.hell_alerts?.[m.chat];
  if (!config?.onaxEnabled) return;

  const commandText = String(m.text || '').trim();
  if (!/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(commandText)) return;
  if (commandText.length > ONAX_COMMAND_MAX_LENGTH) {
    return m.reply(`❌ El comando supera el límite de ${ONAX_COMMAND_MAX_LENGTH} caracteres.`);
  }

  const state = getListenerState();
  if (
    state.status !== 'connected' ||
    !state.client ||
    !state.forwardChat ||
    !state.responseBotIds?.size
  ) {
    return m.reply(`❌ El puente con el bot de "${ONAX_SOURCE_TITLE}" no está disponible.`);
  }
  if (state.activeOnaxRequest) {
    return m.reply('⏳ Ya hay un comando esperando respuesta de Telegram. Intenta de nuevo cuando termine.');
  }

  const sender = String(m.sender || m.key?.participant || '');
  const cooldownKey = `${m.chat}:${sender}`;
  const lastCommandAt = onaxCommandCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastCommandAt < ONAX_COMMAND_COOLDOWN_MS) {
    return m.reply('⏳ Espera un momento antes de enviar otro comando al bot de Telegram.');
  }

  const botJid = normalizeJid(conn);
  if (!botJid) return m.reply('❌ No pude identificar la sesión de WhatsApp para recibir la respuesta.');

  const request = {
    waChatId: m.chat,
    botJid,
    commandMessageId: null,
    startedAt: Date.now(),
    expiresAt: Date.now() + ONAX_REPLY_TIMEOUT_MS,
    responseCount: 0,
    timeout: null,
    idleTimeout: null
  };
  state.activeOnaxRequest = request;
  try {
    const telegramMessage = await state.client.sendMessage(state.forwardChat, { message: commandText });
    request.commandMessageId = Number(telegramMessage.id);
    request.timeout = setTimeout(() => finishOnaxRequest(state, request, true), ONAX_REPLY_TIMEOUT_MS);
    request.timeout.unref?.();
    onaxCommandCooldowns.set(cooldownKey, Date.now());
    console.log(`[onax] Comando recibido de WhatsApp ${m.chat}; enviado a ${ONAX_SOURCE_TITLE} (mensaje Telegram ${request.commandMessageId}).`);
  } catch (error) {
    finishOnaxRequest(state, request);
    console.error(`[onax] No se pudo enviar el comando desde WhatsApp ${m.chat} a Telegram:`, error);
    return m.reply('❌ No pude enviar el comando a Telegram. Intenta de nuevo en un momento.');
  }
}

async function deliverToChat(client, chatId, config, message) {
  const bot = getConnectionForBot(config.botJid);
  if (!bot?.user?.jid) throw new Error(`La sesión WhatsApp ${config.botJid} no está conectada.`);

  const caption = formatEventMessage(message, config);
  const photo = await downloadEventPhoto(client, message);
  if (typeof bot.sendButton === 'function') {
    await bot.sendButton(
      chatId,
      caption,
      'NAX • Lords Mobile',
      photo,
      [],
      null,
      WHATSAPP_GROUP_BUTTON,
      null,
      null
    );
    return;
  }

  console.warn('[hell-alerts] Esta sesión no soporta botones interactivos; enviaré el aviso con enlace de respaldo.');
  if (photo) {
    await bot.sendMessage(chatId, {
      image: photo,
      caption: withWhatsAppGroupLink(caption)
    });
  } else {
    await bot.sendMessage(chatId, {
      text: withWhatsAppGroupLink(caption)
    });
  }
}

async function processMessage(client, message) {
  if (!Number.isSafeInteger(Number(message?.id))) return;
  if (!isSupportedEvent(message)) return;

  for (const [chatId, config] of getTargetChats()) {
    const postId = Number(message.id);
    if (postId <= (Number(config.lastPostId) || 0)) continue;

    try {
      await deliverToChat(client, chatId, config, message);
      config.lastPostId = postId;
      await saveDb();
      console.log(`[hell-alerts] Publicación ${postId} enviada al grupo ${chatId}.`);
    } catch (error) {
      console.error(`[hell-alerts] Falló el envío de la publicación ${postId} al grupo ${chatId}:`, error);
    }
  }
}

function enqueueMessage(client, message) {
  deliveryQueue = deliveryQueue
    .then(() => processMessage(client, message))
    .catch(error => console.error('[hell-alerts] Error procesando publicación:', error));
  return deliveryQueue;
}

async function catchUpMissedMessages(client, channel) {
  const targets = getTargetChats();
  if (!targets.length) return;

  const messages = await client.getMessages(channel, { limit: 50 });
  const posts = [...messages]
    .filter(message => Number.isSafeInteger(Number(message.id)))
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const message of posts) {
    const isNewForAnyGroup = targets.some(([, config]) =>
      Number(message.id) > (Number(config.lastPostId) || 0)
    );
    if (!isNewForAnyGroup) continue;
    await enqueueMessage(client, message);
  }
}

export function cleanInfoLordsMobileText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/https?:\/\/t\.me\/INFO_LordsMobile\b/i.test(line))
    .filter(line => !/^\s*#Lordsmobile\s+#Theradrebels\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatInfoLordsMobileMessage(message) {
  const text = cleanInfoLordsMobileText(message.message);
  return [
    '📣 *INFO Lords Mobile*',
    '',
    text || 'Nuevo aviso',
    '',
    '👇 *Toca acá* para unirte al grupo de WhatsApp.'
  ].join('\n');
}

function hasInfoImage(message) {
  const media = message.media;
  const document = media?.document || media?.webpage?.document;
  return Boolean(
    media?.photo ||
    media?.webpage?.photo ||
    document?.mimeType?.startsWith('image/')
  );
}

function getInfoMessageId(messages) {
  return Math.max(...messages.map(message => Number(message.id)));
}

function getInfoAlbumKey(message) {
  return message.groupedId == null ? null : String(message.groupedId);
}

function groupInfoMessages(messages) {
  const grouped = new Map();
  const albums = [];
  for (const message of [...messages].sort((a, b) => Number(a.id) - Number(b.id))) {
    const albumKey = getInfoAlbumKey(message);
    if (!albumKey) {
      albums.push([message]);
      continue;
    }
    const album = grouped.get(albumKey) || [];
    album.push(message);
    grouped.set(albumKey, album);
  }
  return [...albums, ...grouped.values()]
    .sort((first, second) => Number(first[0].id) - Number(second[0].id));
}

async function processInfoLordsMobileMessages(client, messages) {
  const state = getListenerState();
  const sourceMessages = messages
    .filter(message =>
      Number.isSafeInteger(Number(message?.id)) &&
      !message.out &&
      String(message.chatId) === state.infoSourceId
    )
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!sourceMessages.length) return;

  const text = cleanInfoLordsMobileText(sourceMessages.map(message => message.message).filter(Boolean).join('\n\n'));
  const imageMessages = sourceMessages.filter(hasInfoImage).slice(0, 8);
  const maxMessageId = getInfoMessageId(sourceMessages);
  const targets = getTargetChats('info');
  if (!text && !imageMessages.length) {
    let cursorUpdated = false;
    for (const [, config] of targets) {
      if (maxMessageId > (Number(config.lastInfoMessageId) || 0)) {
        config.lastInfoMessageId = maxMessageId;
        cursorUpdated = true;
      }
    }
    if (cursorUpdated) await saveDb();
    return;
  }

  for (const [chatId, config] of targets) {
    if (maxMessageId <= (Number(config.lastInfoMessageId) || 0)) continue;

    try {
      const bot = getConnectionForBot(config.botJid);
      if (!bot?.user?.jid) throw new Error(`La sesión WhatsApp ${config.botJid} no está conectada.`);

      const caption = formatInfoLordsMobileMessage({ message: text });
      const images = [];
      for (const imageMessage of imageMessages) {
        const document = imageMessage.media?.document || imageMessage.media?.webpage?.document;
        if (Number(document?.size) > 8 * 1024 * 1024) {
          throw new Error(`La imagen del mensaje ${imageMessage.id} supera el límite de 8 MB.`);
        }
        const image = await client.downloadMedia(imageMessage, {});
        if (!Buffer.isBuffer(image) || !image.length) {
          throw new Error(`No se pudo descargar la imagen del mensaje ${imageMessage.id}.`);
        }
        if (image.length > 8 * 1024 * 1024) {
          throw new Error(`La imagen del mensaje ${imageMessage.id} supera el límite de 8 MB.`);
        }
        images.push(image);
      }

      await sendInfoMessage(bot, chatId, caption, images);
      config.lastInfoMessageId = maxMessageId;
      await saveDb();
      console.log(`[telegram-info] Publicación ${maxMessageId} enviada al grupo ${chatId} con ${images.length} imagen(es).`);
    } catch (error) {
      console.error(`[telegram-info] Falló el envío de la publicación ${maxMessageId} al grupo ${chatId}:`, error);
    }
  }
}

async function sendInfoMessage(bot, chatId, caption, images, quoted) {
  const firstImage = images[0] || null;
  if (typeof bot.sendButton === 'function') {
    await bot.sendButton(
      chatId,
      caption,
      'NAX • INFO Lords Mobile',
      firstImage,
      [],
      null,
      WHATSAPP_GROUP_BUTTON,
      quoted || null,
      null
    );
  } else if (firstImage) {
    await bot.sendMessage(chatId, {
      image: firstImage,
      caption: withWhatsAppGroupLink(caption)
    }, quoted ? { quoted } : undefined);
  } else {
    await bot.sendMessage(chatId, {
      text: withWhatsAppGroupLink(caption)
    }, quoted ? { quoted } : undefined);
  }

  for (const image of images.slice(1)) {
    await bot.sendMessage(chatId, { image });
  }
}

let infoDeliveryQueue = Promise.resolve();

function enqueueInfoLordsMobileMessages(client, messages) {
  infoDeliveryQueue = infoDeliveryQueue
    .then(() => processInfoLordsMobileMessages(client, messages))
    .catch(error => console.error('[telegram-info] Error procesando publicación:', error));
  return infoDeliveryQueue;
}

function enqueueInfoLordsMobileAlbum(client, album) {
  return enqueueInfoLordsMobileMessages(client, album.messages);
}

async function catchUpInfoLordsMobileMessages(client, sourceChat) {
  const targets = getTargetChats('info');
  if (!targets.length) return;

  const messages = await client.getMessages(sourceChat, { limit: 50 });
  const posts = [...messages]
    .filter(message => Number.isSafeInteger(Number(message.id)) && !message.out)
    .sort((first, second) => Number(first.id) - Number(second.id));
  for (const album of groupInfoMessages(posts)) {
    const isNewForAnyGroup = targets.some(([, config]) =>
      getInfoMessageId(album) > (Number(config.lastInfoMessageId) || 0)
    );
    if (isNewForAnyGroup) await enqueueInfoLordsMobileMessages(client, album);
  }
}

async function catchUpOnaxMessages(client, sourceChat) {
  const targets = getTargetChats('onax');
  if (!targets.length) return;

  const messages = await client.getMessages(sourceChat, { limit: 50 });
  const posts = [...messages]
    .filter(message => Number.isSafeInteger(Number(message.id)) && !message.out)
    .sort((first, second) => Number(first.id) - Number(second.id));
  for (const message of posts) {
    const isNewForAnyGroup = targets.some(([, config]) =>
      Number(message.id) > (Number(config.lastOnaxMessageId) || 0)
    );
    if (!isNewForAnyGroup) continue;
    await enqueueOnaxMessage(client, message);
  }
}

async function findOnaxResponseBots(client, sourceChat) {
  const messages = await client.getMessages(sourceChat, { limit: 50 });
  const bots = new Map();
  for (const message of messages) {
    if (message.out || !message.senderId) continue;
    const sender = await message.getSender();
    if (sender?.bot) {
      bots.set(String(sender.id), sender.username || String(sender.id));
    }
  }
  return bots;
}

async function startTelegramListener() {
  const state = getListenerState();
  if (state.startPromise) return state.startPromise;

  state.startPromise = (async () => {
    if (state.previousState) {
      const previousState = state.previousState;
      await previousState.startPromise;
      if (previousState.client) await previousState.client.destroy();
      delete state.previousState;
    }

    if (!fs.existsSync(CONFIG_PATH)) {
      state.status = 'not-configured';
      console.warn(`[hell-alerts] Falta ${CONFIG_PATH}. Ejecuta "npm run setup:telegram-hell" en una terminal local.`);
      return;
    }

    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (!Number.isSafeInteger(config.apiId) || !config.apiHash || !config.session) {
        throw new Error('El archivo de sesión no contiene API ID, API Hash y String Session válidos.');
      }

      state.status = 'connecting';
      const client = new TelegramClient(
        new StringSession(config.session),
        config.apiId,
        config.apiHash,
        { connectionRetries: 5 }
      );
      state.client = client;
      await client.connect();
      if (!await client.isUserAuthorized()) {
        throw new Error('La sesión no está autorizada. Ejecuta de nuevo "npm run setup:telegram-hell".');
      }

      try {
        await client.updateStatus(true);
        state.accountOnline = true;
      } catch (error) {
        state.accountOnline = false;
        console.error('[hell-alerts] No se pudo marcar la cuenta de Telegram como en línea:', error);
      }

      const channel = await client.getEntity(CHANNEL_USERNAME);
      state.channel = channel;
      state.status = 'connected';

      client.addEventHandler(
        event => enqueueMessage(client, event.message),
        new NewMessage({ chats: [CHANNEL_USERNAME] })
      );

      await catchUpMissedMessages(client, channel);
      try {
        const matchingInfoDialogs = (await client.getDialogs({ limit: 1000 }))
          .filter(dialog =>
            (dialog.isGroup || dialog.isChannel) &&
            dialog.title?.trim().toLocaleLowerCase('es') === INFO_SOURCE_TITLE.toLocaleLowerCase('es')
          );
        if (matchingInfoDialogs.length !== 1) {
          throw new Error(
            `Se esperaba encontrar un solo grupo o canal llamado "${INFO_SOURCE_TITLE}", ` +
            `pero se encontraron ${matchingInfoDialogs.length}.`
          );
        }

        const infoDialog = matchingInfoDialogs[0];
        state.infoSource = infoDialog.entity;
        state.infoSourceId = String(infoDialog.id);
        client.addEventHandler(
          event => {
            if (!getInfoAlbumKey(event.message)) {
              enqueueInfoLordsMobileMessages(client, [event.message]);
            }
          },
          new NewMessage({ chats: [state.infoSourceId], incoming: true })
        );
        client.addEventHandler(
          event => enqueueInfoLordsMobileAlbum(client, event),
          new Album({ chats: [state.infoSourceId] })
        );
        await catchUpInfoLordsMobileMessages(client, state.infoSource);
      } catch (error) {
        state.infoSource = null;
        state.infoSourceId = null;
        console.error(`[telegram-info] No se pudo iniciar el lector de "${INFO_SOURCE_TITLE}":`, error);
      }

      try {
        const matchingDialogs = (await client.getDialogs({ limit: 1000 }))
          .filter(dialog => dialog.isGroup && dialog.title?.trim().toLocaleLowerCase('es') === ONAX_SOURCE_TITLE.toLocaleLowerCase('es'));
        if (matchingDialogs.length !== 1) {
          throw new Error(`Se esperaba encontrar un solo grupo de Telegram llamado "${ONAX_SOURCE_TITLE}", pero se encontraron ${matchingDialogs.length}.`);
        }

        const forwardChat = matchingDialogs[0];
        state.forwardChat = forwardChat.entity;
        state.forwardChatId = String(forwardChat.id);
        state.forwardChatTitle = forwardChat.title;
        const responseBots = await findOnaxResponseBots(client, state.forwardChat);
        state.responseBotIds = new Set(responseBots.keys());
        state.responseBotNames = [...responseBots.values()];
        if (responseBots.size !== 1) {
          console.warn(
            `[onax] Se encontraron ${responseBots.size} bots que respondieron recientemente en ${ONAX_SOURCE_TITLE}; ` +
            'el puente de comandos requiere un único bot de respuesta identificable.'
          );
        }
        client.addEventHandler(
          event => enqueueOnaxMessage(client, event.message),
          new NewMessage({ chats: [state.forwardChatId], incoming: true })
        );
        await catchUpOnaxMessages(client, state.forwardChat);
      } catch (error) {
        state.forwardChat = null;
        state.forwardChatId = null;
        state.forwardChatTitle = null;
        state.responseBotIds = new Set();
        state.responseBotNames = [];
        console.error(`[onax] No se pudo iniciar el lector de "${ONAX_SOURCE_TITLE}"; los avisos de @${CHANNEL_USERNAME} siguen activos:`, error);
      }

      state.recheckTimer = setInterval(() => {
        client.updateStatus(true).then(() => {
          state.accountOnline = true;
        }).catch(error => {
          state.accountOnline = false;
          console.error('[hell-alerts] No se pudo renovar el estado en línea de Telegram:', error);
        });
        catchUpMissedMessages(client, channel).catch(error => {
          console.error('[hell-alerts] No se pudieron recuperar publicaciones recientes:', error);
        });
        if (state.forwardChat) {
          catchUpOnaxMessages(client, state.forwardChat).catch(error => {
            console.error(`[onax] No se pudieron recuperar mensajes recientes de ${ONAX_SOURCE_TITLE}:`, error);
          });
        }
        if (state.infoSource) {
          catchUpInfoLordsMobileMessages(client, state.infoSource).catch(error => {
            console.error(`[telegram-info] No se pudieron recuperar mensajes recientes de ${INFO_SOURCE_TITLE}:`, error);
          });
        }
      }, TELEGRAM_RECHECK_MS);
      state.recheckTimer.unref?.();
      console.log(
        `[hell-alerts] Sesión MTProto conectada${state.accountOnline ? ' y en línea' : ''}; escuchando ` +
        `@${CHANNEL_USERNAME}${state.infoSource ? `, ${INFO_SOURCE_TITLE}` : ''}` +
        `${state.forwardChat ? ` y ${ONAX_SOURCE_TITLE}` : ''}.`
      );
    } catch (error) {
      state.status = 'error';
      console.error('[hell-alerts] No se pudo iniciar el listener de Telegram:', error);
    }
  })();

  return state.startPromise;
}

if (!getListenerState().startPromise) {
  startTelegramListener().catch(error => {
    console.error('[hell-alerts] Error inicializando Telegram:', error);
  });
}

const handler = async (m, { conn, command, args }) => {
  if (!ensureDb()) return m.reply('❌ La base de datos todavía no está lista. Intenta de nuevo en un momento.');
  if (!m.isGroup) return m.reply('❌ Este comando solo funciona dentro del grupo donde se publicarán los avisos.');

  let groupData;
  try {
    groupData = await getGroupDataForPlugin(conn, m.chat, m.sender);
  } catch (error) {
    console.error('[hell-alerts] No se pudo verificar el administrador del grupo:', error);
    return m.reply('❌ No pude verificar los permisos de administrador. Intenta de nuevo.');
  }
  if (!groupData.isAdmin) return m.reply('❌ Solo los administradores del grupo pueden configurar estos avisos.');

  const chats = global.db.data.hell_alerts;
  const chatConfig = chats[m.chat] || {
    enabled: false,
    includeSales: true,
    salesText: SALES_TEXT_DEFAULT,
    lastPostId: 0,
    source: CHANNEL_URL
  };
  chats[m.chat] = chatConfig;
  const cmd = command.toLowerCase();

  if (cmd === 'hells') {
    const setting = (args[0] || '').toLowerCase();
    if (setting === 'on' || setting === 'enable') {
      const state = getListenerState();
      const telegramReady = state.status === 'connected' && state.client && state.channel;
      if (!telegramReady) {
        return m.reply('❌ Telegram no está conectado. Configura la sesión con `npm run setup:telegram-hell` y reinicia NAX.');
      }
      if (!state.infoSource) {
        return m.reply(
          `❌ No encuentro el grupo "${INFO_SOURCE_TITLE}". Asegúrate de que la cuenta de Telegram del bot ` +
          'se haya unido al grupo y reinicia NAX.'
        );
      }

      try {
        const botJid = normalizeJid(conn);
        if (!botJid) return m.reply('❌ No pude identificar la sesión de WhatsApp que debe publicar en este grupo.');

        const [newestEvents, newestInfo] = await Promise.all([
          state.client.getMessages(state.channel, { limit: 1 }),
          state.client.getMessages(state.infoSource, { limit: 1 })
        ]);

        chatConfig.botJid = botJid;
        chatConfig.source = CHANNEL_URL;
        chatConfig.includeSales = true;
        chatConfig.salesText = SALES_TEXT_DEFAULT;
        chatConfig.lastPostId = Number(newestEvents[0]?.id) || 0;
        chatConfig.lastInfoMessageId = Number(newestInfo[0]?.id) || 0;
        chatConfig.telegramEnabled = true;
        chatConfig.infoTelegramEnabled = true;
        delete chatConfig.discordEnabled;
        delete chatConfig.lastDiscordMessageId;
        chatConfig.enabled = true;
        await saveDb();
      } catch (error) {
        console.error('[hell-alerts] No se pudieron activar las fuentes de Telegram:', error);
        return m.reply('❌ No pude guardar la configuración de avisos; intenta de nuevo.');
      }
      return m.reply(`✅ Avisos activados para @LMEvents y ${INFO_SOURCE_TITLE}.`);
    }

    if (setting === 'off' || setting === 'disable') {
      chatConfig.enabled = false;
      await saveDb();
      return m.reply('✅ Avisos de eventos desactivados en este grupo.');
    }
    return m.reply('Uso: .hells on | .hells off');
  }

  if (cmd === 'onax') {
    const setting = (args[0] || 'on').toLowerCase();
    if (setting === 'on' || setting === 'enable') {
      const state = getListenerState();
      if (state.status !== 'connected' || !state.client || !state.forwardChat) {
        return m.reply(`❌ Telegram no está conectado al grupo "${ONAX_SOURCE_TITLE}".`);
      }
      if (state.responseBotIds?.size !== 1) {
        return m.reply('❌ No pude identificar un único bot de respuesta en Telegram; no activé el puente de comandos.');
      }

      const botJid = normalizeJid(conn);
      if (!botJid) return m.reply('❌ No pude identificar la sesión de WhatsApp que debe reenviar los mensajes.');

      try {
        const newest = await state.client.getMessages(state.forwardChat, { limit: 1 });
        chatConfig.botJid = botJid;
        chatConfig.lastOnaxMessageId = Number(newest[0]?.id) || 0;
        chatConfig.onaxEnabled = true;
        await saveDb();
      } catch (error) {
        console.error(`[onax] No se pudo activar el reenvío para el grupo WhatsApp ${m.chat}:`, error);
        return m.reply('❌ No pude preparar el reenvío. Revisa los registros del bot e intenta de nuevo.');
      }
      return m.reply(
        `✅ Reenvío de "${ONAX_SOURCE_TITLE}" activado en este grupo. ` +
        'Llegarán los mensajes nuevos, fotos, videos, archivos y opciones. Los botones de enlace serán clicables; ' +
        'los botones internos de Telegram aparecerán como texto, sin ejecutar su acción. Usa .onax off para detenerlo.'
      );
    }

    if (setting === 'off' || setting === 'disable') {
      chatConfig.onaxEnabled = false;
      await saveDb();
      return m.reply(`✅ Reenvío de "${ONAX_SOURCE_TITLE}" desactivado en este grupo.`);
    }
    return m.reply('Uso: .onax | .onax off');
  }

  if (cmd === 'helltest') {
    try {
      const state = getListenerState();
      if (state.status !== 'connected' || !state.client || !state.channel) {
        return m.reply('❌ Telegram no está conectado; no puedo generar las tres vistas de prueba.');
      }

      const botJid = normalizeJid(conn);
      if (!botJid) return m.reply('❌ No pude identificar la sesión de WhatsApp para enviar la prueba.');

      const recentMessages = [...await state.client.getMessages(state.channel, { limit: 50 })]
        .sort((first, second) => Number(second.id) - Number(first.id));
      const eventExamples = {
        solo: '#Solo',
        hell: '#Hell',
        daily: '#24h'
      };
      const previewResults = [];

      for (const [type, exampleTag] of Object.entries(eventExamples)) {
        let sample = recentMessages.find(message =>
          getEventType(message.message || '') === type
        );
        let photo = null;

        for (const message of recentMessages) {
          if (getEventType(message.message || '') !== type || !message.media?.photo) continue;
          try {
            photo = await downloadEventPhoto(state.client, message);
            if (photo) {
              sample = message;
              break;
            }
          } catch (error) {
            console.error(`[hell-alerts] No se pudo preparar la imagen de prueba (${type}):`, error);
          }
        }

        const hasRealSample = Boolean(sample);
        const preview = sample || {
          message: exampleTag,
          date: Math.floor(Date.now() / 1000),
          id: null
        };
        const caption = formatEventMessage(preview);
        const testCaption = hasRealSample
          ? caption
          : `${caption}\n\nℹ️ Vista de diseño: no encontré una publicación reciente de este tipo.`;

        try {
          if (typeof conn.sendButton === 'function') {
            await conn.sendButton(
              m.chat,
              testCaption,
              `NAX • ${EVENT_TYPES[type].label} • PRUEBA`,
              photo,
              [],
              null,
              WHATSAPP_GROUP_BUTTON,
              previewResults.length === 0 ? m : null,
              null
            );
          } else if (photo) {
            await conn.sendMessage(m.chat, {
              image: photo,
              caption: withWhatsAppGroupLink(testCaption)
            }, { quoted: previewResults.length === 0 ? m : undefined });
          } else {
            await conn.sendMessage(m.chat, {
              text: withWhatsAppGroupLink(testCaption)
            }, { quoted: previewResults.length === 0 ? m : undefined });
          }
          previewResults.push({ type, hasImage: Boolean(photo), hasRealSample });
        } catch (error) {
          console.error(`[hell-alerts] No se pudo enviar la vista de prueba (${type}):`, error);
          previewResults.push({ type, error });
        }
      }

      const imageCount = previewResults.filter(result => result.hasImage).length;
      const sampleCount = previewResults.filter(result => result.hasRealSample).length;
      const failedTypes = previewResults.filter(result => result.error).map(result => EVENT_TYPES[result.type].label);
      if (failedTypes.length === previewResults.length) {
        return m.reply('❌ No pude enviar ninguna vista previa. Revisa los registros del bot e intenta de nuevo.');
      }
      return m.reply(
        `✅ Envié ${previewResults.length - failedTypes.length} de 3 vistas: Solitario, Infierno y 24h. ` +
        `${imageCount} con imagen y ${sampleCount} basadas en avisos recientes.` +
        `${failedTypes.length ? ` No se pudieron enviar: ${failedTypes.join(', ')}.` : ''} ` +
        'La prueba no altera el registro de avisos.'
      );
    } catch (error) {
      console.error(`[hell-alerts] Falló la prueba de envío al grupo ${m.chat}:`, error);
      return m.reply('❌ No se pudo enviar la prueba a este grupo.');
    }
  }

  if (cmd === 'infotest') {
    const state = getListenerState();
    if (state.status !== 'connected' || !state.client || !state.infoSource) {
      return m.reply(
        `❌ Telegram no está conectado a "${INFO_SOURCE_TITLE}". ` +
        'Confirma que la cuenta de Telegram de NAX esté unida al grupo y reinicia el bot.'
      );
    }

    try {
      const recentMessages = [...await state.client.getMessages(state.infoSource, { limit: 100 })]
        .filter(message => Number.isSafeInteger(Number(message.id)) && !message.out)
        .sort((first, second) => Number(second.id) - Number(first.id));
      const latestMessage = recentMessages.find(message =>
        cleanInfoLordsMobileText(message.message) || hasInfoImage(message)
      );
      if (!latestMessage) {
        return m.reply(`❌ No encontré publicaciones recientes en "${INFO_SOURCE_TITLE}" para probar.`);
      }

      const latestAlbumId = getInfoAlbumKey(latestMessage);
      const sampleMessages = latestAlbumId
        ? recentMessages.filter(message => getInfoAlbumKey(message) === latestAlbumId)
        : [latestMessage];
      const text = cleanInfoLordsMobileText(
        sampleMessages
          .sort((first, second) => Number(first.id) - Number(second.id))
          .map(message => message.message)
          .filter(Boolean)
          .join('\n\n')
      );
      const imageMessages = sampleMessages.filter(hasInfoImage).slice(0, 8);
      const images = [];
      for (const imageMessage of imageMessages) {
        const document = imageMessage.media?.document || imageMessage.media?.webpage?.document;
        if (Number(document?.size) > 8 * 1024 * 1024) {
          throw new Error(`La imagen ${images.length + 1} supera el límite de 8 MB.`);
        }
        const image = await state.client.downloadMedia(imageMessage, {});
        if (!Buffer.isBuffer(image) || !image.length) {
          throw new Error(`No se pudo descargar la imagen ${images.length + 1} de la publicación.`);
        }
        if (image.length > 8 * 1024 * 1024) {
          throw new Error(`La imagen ${images.length + 1} supera el límite de 8 MB.`);
        }
        images.push(image);
      }

      const botJid = normalizeJid(conn);
      const bot = botJid ? getConnectionForBot(botJid) : null;
      if (!bot) return m.reply('❌ No pude encontrar una sesión de WhatsApp conectada para enviar la prueba.');

      await sendInfoMessage(
        bot,
        m.chat,
        formatInfoLordsMobileMessage({ message: text }),
        images,
        m
      );
      return m.reply(
        `✅ Prueba enviada con ${images.length} imagen(es) de la última publicación de ${INFO_SOURCE_TITLE}. ` +
        'El botón *Toca acá* debe abrir tu grupo de WhatsApp. La prueba no modifica el registro de avisos.'
      );
    } catch (error) {
      console.error(`[telegram-info] Falló la prueba de envío al grupo ${m.chat}:`, error);
      return m.reply('❌ No pude enviar la prueba. Revisa los registros del bot e intenta de nuevo.');
    }
  }

  if (cmd === 'listhell') {
    const state = getListenerState();
    return m.reply([
      `Avisos de eventos: ${chatConfig.enabled ? '✅ Activados' : '❌ Desactivados'}`,
      `Listener Telegram: ${state.status}`,
      `Avisos ${INFO_SOURCE_TITLE}: ${state.infoSource ? (chatConfig.enabled && chatConfig.infoTelegramEnabled ? '✅ Conectados' : '⏸️ Conectado, desactivado') : '❌ No conectado'}`,
      `Reenvío ${ONAX_SOURCE_TITLE}: ${chatConfig.onaxEnabled ? '✅ Activado' : '❌ Desactivado'}`,
      `Puente de comandos: ${chatConfig.onaxEnabled && getListenerState().responseBotIds?.size === 1 ? '✅ Disponible' : '❌ No disponible'}`,
      `Fuentes de este grupo: ${[
        chatConfig.enabled && chatConfig.telegramEnabled !== false && '@LMEvents',
        chatConfig.enabled && chatConfig.infoTelegramEnabled && INFO_SOURCE_TITLE,
        chatConfig.onaxEnabled && ONAX_SOURCE_TITLE
      ].filter(Boolean).join(' y ') || 'ninguna'}`,
      `Fuente: ${chatConfig.source || CHANNEL_URL}`,
      `Última publicación procesada: ${chatConfig.lastPostId || 'ninguna'}`,
      `Texto de tienda: ${chatConfig.salesText || SALES_TEXT_DEFAULT}`
    ].join('\n'));
  }

  return m.reply('Comandos: .hells on|off (Solitario, Infierno y 24h), .onax [off], .listhell, .helltest, .infotest');
};

handler.help = ['hells on|off', 'onax [off]', 'listhell', 'helltest', 'infotest'];
handler.tags = ['tools'];
handler.command = /^(hells|onax|listhell|helltest|infotest)$/i;
handler.group = true;
handler.admin = true;
handler.all = async (m, { conn }) => {
  await forwardWhatsAppCommandToTelegram(m, conn);
};

export default handler;
