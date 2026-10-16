import { addAdminToCache, removeAdminFromCache, updateGroupAdmins } from './pluginHelper.js';

const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 100;
const requestDelay = new Map();
const actionDeduplicator = new Map();

export async function getGroupMetadata(conn, chatId, groupCache, senderJid) {
  try {
    const cached = groupCache.get(chatId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }

    const lastRequest = requestDelay.get(chatId) || 0;
    const timeSince = Date.now() - lastRequest;
    if (timeSince < 1000) {
      await new Promise(resolve => setTimeout(resolve, 1000 - timeSince));
    }
    requestDelay.set(chatId, Date.now());

    const metadata = conn.chats?.[chatId]?.metadata || await conn.groupMetadata(chatId).catch(_ => null);

    if (metadata) {
      const participants = (metadata.participants || []).map(p => ({
        id: p.id || p.jid,
        admin: p.admin
      }));

      await updateGroupAdmins(chatId, participants, conn);

      const decodedSender = conn.decodeJid(senderJid);
      const botJid = conn.decodeJid(conn.user.jid);

      const userGroup = participants.find(u => conn.decodeJid(u.id) === decodedSender) || {};
      const botGroup = participants.find(u => conn.decodeJid(u.id) === botJid) || {};

      const groupData = {
        groupMetadata: metadata,
        participants,
        userGroup,
        botGroup,
        isAdmin: userGroup?.admin === 'admin' || userGroup?.admin === 'superadmin',
        isRAdmin: userGroup?.admin === 'superadmin',
        isBotAdmin: !!botGroup?.admin
      };

      if (groupCache.size >= MAX_CACHE_SIZE) {
        const firstKey = groupCache.keys().next().value;
        groupCache.delete(firstKey);
      }

      groupCache.set(chatId, {
        data: groupData,
        timestamp: Date.now()
      });

      return groupData;
    }

    return {
      groupMetadata: {},
      participants: [],
      userGroup: {},
      botGroup: {},
      isAdmin: false,
      isRAdmin: false,
      isBotAdmin: false
    };
  } catch {
    return {
      groupMetadata: {},
      participants: [],
      userGroup: {},
      botGroup: {},
      isAdmin: false,
      isRAdmin: false,
      isBotAdmin: false
    };
  }
}

export async function handlePromoteDemote(conn, id, chat, participantsList, action, authorJid) {
  try {
    let text = '';

    if (action === 'promote' || action === 'daradmin' || action === 'darpoder') {
      text = chat.sPromote || '🌙 *¡Promoción!* ✨\n\n👑 @tag ha promovido a @user como administrador/a del grupo.\n\n*¡Felicidades!* 🎉';
    } else if (action === 'demote' || action === 'quitaradmin' || action === 'quitarpoder') {
      text = chat.sDemote || '🌙 *Cambio de rol* 👫\n\n📉 @tag ha removido a @user como administrador/a del grupo.';
    }

    if (!text || participantsList.length === 0) return;

    const userJid = participantsList[0].phoneNumber || participantsList[0].id || '';
    if (!userJid || !authorJid) return;

    text = text
      .replace(/@user/g, '@' + userJid.split('@')[0])
      .replace(/@tag/g, '@' + authorJid.split('@')[0]);

    if (chat.detect && !chat.isBanned) {
      await conn.sendMessage(id, {
        text,
        mentions: [userJid, authorJid]
      });
    }
  } catch {}
}

export async function handleParticipantsUpdate(
  conn,
  id,
  participants,
  action,
  globalLoadDatabase,
  globalConfig,
  globalDb,
  opts,
  groupCache
) {
  try {
    if (!conn?.user?.jid) return;
    if (opts.self) return;
    if (globalDb.data == null) await globalLoadDatabase();

    const chat = globalDb.data.chats[id] = globalConfig(id);
    const normalizedAction = action === 'leave' ? 'remove' : action;

    let participantsList = [];
    if (Array.isArray(participants)) {
      participantsList = participants.map(p =>
        typeof p === 'string'
          ? { id: p, phoneNumber: p }
          : p
      );
    } else if (typeof participants === 'string') {
      participantsList = [{ id: participants, phoneNumber: participants }];
    }

    const participantIds = participantsList
      .map(p => p.id || p.phoneNumber || '')
      .filter(Boolean)
      .sort()
      .join(',');

    const deduplicateKey = `${id}_${normalizedAction}_${participantIds}`;

    if (actionDeduplicator.has(deduplicateKey)) return;
    actionDeduplicator.set(deduplicateKey, true);
    setTimeout(() => actionDeduplicator.delete(deduplicateKey), 5000);

    if (normalizedAction === 'promote' || normalizedAction === 'demote' || 
               normalizedAction === 'daradmin' || normalizedAction === 'quitaradmin' || 
               normalizedAction === 'darpoder' || normalizedAction === 'quitarpoder') {

      let authorJid = conn.user?.jid;

      for (const participant of participantsList) {
        const userJid = participant.id || participant.phoneNumber;
        if (!userJid) continue;

        const userId = userJid.replace(/[^0-9]/g, '');

        if (normalizedAction === 'promote' || normalizedAction === 'daradmin' || normalizedAction === 'darpoder') {
          addAdminToCache(id, userId);
        } else if (normalizedAction === 'demote' || normalizedAction === 'quitaradmin' || normalizedAction === 'quitarpoder') {
          removeAdminFromCache(id, userId);
        }
      }

      await handlePromoteDemote(
        conn,
        id,
        chat,
        participantsList,
        normalizedAction,
        authorJid
      );
    }
  } catch {}
}