import { isOwnerJid, isSubOwnerJid } from './system-owners.js';
import { resolveTargetForOwnerCheck } from './ownerGuard.js';

export function checkUserPermissions(m, conn, senderJid = m.sender) {
  const participants = global.groupCache?.get(m.chat)?.data?.participants
    || conn?.chats?.[m.chat]?.metadata?.participants
    || [];
  const senderAlt = m.key?.participantAlt
    || m.participantAlt
    || m.key?.remoteJidAlt
    || m.remoteJidAlt;
  const { phoneNumber } = resolveTargetForOwnerCheck(senderJid, participants, senderAlt);
  const isROwner = isOwnerJid(senderJid, conn, phoneNumber);
  const isOwner = isROwner || m.fromMe;
  const isSubOwner = isROwner ? false : isSubOwnerJid(m.sender, conn, phoneNumber);
  const isMods = isOwner || global.mods?.map((v) => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net')?.includes(m.sender);
  const isPrems = isROwner || isOwner || isMods || global.db?.data?.users?.[m.sender]?.premiumTime > 0;

  return { isROwner, isOwner, isSubOwner, isMods, isPrems };
}
