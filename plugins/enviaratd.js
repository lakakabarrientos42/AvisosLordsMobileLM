const INVISIBLE_TEXT = '\u200B';
const GHOST_TAG_PREFIX = '\u200E'.repeat(850);

const MEDIA_FIELDS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  documentMessage: 'document',
};

const handler = async (m, { conn, text }) => {
  if (!conn?.user?.jid) return m.reply('❌ El bot no tiene una sesión activa.');

  const quoted = m.quoted;
  const currentMessageHasMedia = Boolean((m.msg || m).mimetype);
  const mediaCandidate = quoted || (currentMessageHasMedia ? m : null);
  const mediaMessage = mediaCandidate?.msg || mediaCandidate;
  const mediaType = mediaCandidate?.mtype || m.mtype;
  const mediaField = mediaType ? MEDIA_FIELDS[mediaType] : null;
  const mediaSource = mediaField ? mediaCandidate : null;
  const messageText = String(text || '').trim()
    || String(quoted?.text || quoted?.caption || quoted?.body || '').trim();

  if (!messageText && !mediaField) {
    return m.reply('✍️ Escribe un mensaje o responde a una foto, video, audio, sticker o documento.');
  }

  if (mediaCandidate && !mediaField && mediaMessage?.mimetype) {
    return m.reply('❌ Ese tipo de archivo no es compatible con este comando.');
  }

  let media;
  if (mediaField) {
    try {
      media = await mediaSource.download();
    } catch (error) {
      console.error('[enviaratd] Error descargando el archivo citado:', error);
      return m.reply('❌ No se pudo descargar el archivo para enviarlo.');
    }
  }

  let groups;
  let participatingGroups;
  try {
    participatingGroups = await conn.groupFetchAllParticipating();
    groups = Object.keys(participatingGroups || {}).filter(jid => jid.endsWith('@g.us'));
  } catch (error) {
    console.error('[enviaratd] Error obteniendo los grupos del bot:', error);
    return m.reply('❌ No se pudieron obtener los grupos del bot para enviar el mensaje.');
  }

  if (!groups.length) return m.reply('❌ El bot no está en ningún grupo.');

  let baseContent;
  if (mediaField) {
    baseContent = { [mediaField]: media };

    if (['image', 'video', 'document'].includes(mediaField)) {
      baseContent.caption = messageText || INVISIBLE_TEXT;
    } else if (mediaField === 'audio') {
      baseContent.mimetype = mediaMessage?.mimetype || 'audio/mpeg';
      if (mediaMessage?.ptt) baseContent.ptt = true;
    }
    if (mediaField === 'document') {
      baseContent.mimetype = mediaMessage?.mimetype || 'application/octet-stream';
      baseContent.fileName = mediaMessage?.fileName || 'archivo';
    }
  } else {
    baseContent = { text: messageText };
  }

  const failedGroups = [];
  for (const groupJid of groups) {
    try {
      const participants = participatingGroups[groupJid]?.participants || [];
      const mentions = [...new Set(participants
        .map(participant => participant?.phoneNumber || participant?.id || participant?.jid)
        .filter(jid => typeof jid === 'string' && jid.includes('@')))];
      const ghostTag = mentions.length
        ? `${GHOST_TAG_PREFIX}${mentions.map(jid => ` @${jid.split('@')[0]}`).join('')}`
        : '';
      const content = { ...baseContent };

      if (content.caption && ghostTag) content.caption += ghostTag;
      if (content.text && ghostTag) content.text += ghostTag;
      if (mentions.length && mediaField !== 'audio' && mediaField !== 'sticker') {
        content.mentions = mentions;
      }

      await conn.sendMessage(groupJid, content);

      if (mediaField === 'audio' || mediaField === 'sticker') {
        await conn.sendMessage(groupJid, {
          text: `${messageText || INVISIBLE_TEXT}${ghostTag}`,
          mentions
        });
      }
    } catch (error) {
      console.error(`[enviaratd] Error enviando al grupo ${groupJid}:`, error);
      failedGroups.push(groupJid);
    }
  }

  const delivered = groups.length - failedGroups.length;
  const summary = `✅ Mensaje enviado a ${delivered} de ${groups.length} grupos.`;
  if (failedGroups.length) {
    const failedList = failedGroups.slice(0, 5).join(', ');
    const more = failedGroups.length > 5 ? ` y ${failedGroups.length - 5} más` : '';
    return m.reply(`${summary}\n⚠️ No se pudo enviar a: ${failedList}${more}`);
  }
  await m.reply(summary);
};

handler.help = ['enviaratd <mensaje>', 'eviaratd <mensaje>'];
handler.tags = ['tools'];
handler.command = /^(?:enviaratd|eviaratd)$/i;
handler.group = true;
handler.admin = true;

export default handler;
