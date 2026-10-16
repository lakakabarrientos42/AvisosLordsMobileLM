const OFFICE_MIME_TYPES = new Map([
  ['.csv', 'text/csv'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsb', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
  ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
]);

function getDocumentFileName(document) {
  const filename = document.attributes?.find(attribute =>
    attribute.className === 'DocumentAttributeFilename' ||
    attribute._ === 'documentAttributeFilename' ||
    attribute.constructor?.className === 'DocumentAttributeFilename'
  )?.fileName;
  const safeName = typeof filename === 'string'
    ? filename.replace(/[\\/\0]/g, '_').trim()
    : '';
  return safeName || 'telegram-file';
}

export function getTelegramMediaInfo(message) {
  const media = message?.media;
  if (!media) return null;
  if (media.photo || media.webpage?.photo) {
    return { type: 'image', mimeType: 'image/jpeg', fileName: 'telegram-photo.jpg' };
  }

  const document = media.document || media.webpage?.document;
  if (!document) return null;

  const fileName = getDocumentFileName(document);
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  const telegramMimeType = typeof document.mimeType === 'string' ? document.mimeType.trim().toLowerCase() : '';
  const mimeType = OFFICE_MIME_TYPES.get(extension) ||
    (telegramMimeType && telegramMimeType !== 'application/octet-stream'
      ? telegramMimeType
      : 'application/octet-stream');
  const size = Number(document.size) || 0;

  if (mimeType.startsWith('image/')) return { type: 'image', mimeType, fileName, size };
  if (mimeType.startsWith('video/')) return { type: 'video', mimeType, fileName, size };
  if (mimeType.startsWith('audio/')) return { type: 'audio', mimeType, fileName, size };
  return { type: 'document', mimeType, fileName, size };
}
