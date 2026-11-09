import { stripBidiControls } from "@/lib/bidi";

const MIME_TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'Document.pdf',
  'application/zip': 'Archive.zip',
  'application/x-zip-compressed': 'Archive.zip',
  'application/gzip': 'Archive.gz',
  'application/x-rar-compressed': 'Archive.rar',
  'application/x-7z-compressed': 'Archive.7z',
  'application/msword': 'Document.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document.docx',
  'application/vnd.ms-excel': 'Spreadsheet.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet.xlsx',
  'application/vnd.ms-powerpoint': 'Presentation.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Presentation.pptx',
  'text/plain': 'Text.txt',
  'text/html': 'Document.html',
  'text/csv': 'Data.csv',
  'application/json': 'Data.json',
  'application/xml': 'Data.xml',
  'application/octet-stream': 'Attachment',
  'message/rfc822': 'Email.eml',
};

/**
 * The name the reader shows for a part that has none, from its type: the
 * original message a bounce carries reads "Email.eml". A forward sends such
 * a part under this name, so the recipient sees what the sender saw.
 */
export function unnamedAttachmentName(mimeType?: string | null): string {
  if (mimeType) {
    const label = MIME_TYPE_LABELS[mimeType.toLowerCase()];
    if (label) return label;
    const sub = mimeType.split('/')[1];
    if (sub) {
      const clean = sub.replace(/^x-/, '').replace(/^vnd\./, '');
      return `Attachment.${clean}`;
    }
  }
  return 'Attachment';
}

export function getAttachmentDisplayName(name: string | null | undefined, mimeType?: string | null): string {
  // Without directional overrides, which would show `report‮fdp.exe`
  // as `reportexe.pdf` (the download name is cleaned separately).
  if (name) return stripBidiControls(name);
  return unnamedAttachmentName(mimeType);
}
