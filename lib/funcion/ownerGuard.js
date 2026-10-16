import { isOwnerJid, isSubOwnerJid } from './system-owners.js';

export function isProtectedOwner(jid, phoneNumber, conn) {
  if (!jid && !phoneNumber) return false;
  return Boolean(isOwnerJid(jid || phoneNumber, conn || global.conn, phoneNumber));
}

export function rolProtegido(jid, phoneNumber, conn) {
  const j = jid || phoneNumber;
  if (!j) return null;
  const c = conn || global.conn;
  if (isOwnerJid(j, c, phoneNumber)) return 'owner';
  if (isSubOwnerJid(j, c, phoneNumber)) return 'subowner';
  return null;
}

function normalizeJid(jid) {
  return String(jid || '').replace(/:[0-9]+(@)/, '$1');
}

function isPhoneJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
}

export function resolveTargetForOwnerCheck(jid, participants, altJid) {
  if (!jid) return { jid: null, phoneNumber: null };
  if (!String(jid).includes('@lid')) return { jid, phoneNumber: jid };
  const normalizedJid = normalizeJid(jid);
  const found = (participants || []).find(p =>
    [p.id, p.lid, p.phoneNumber].some(candidate => normalizeJid(candidate) === normalizedJid)
  );
  const phoneNumber = [found?.phoneNumber, found?.id, altJid].find(isPhoneJid) || null;
  return { jid, phoneNumber };
}
