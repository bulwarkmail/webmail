// Area b of the assistant's host APIs: its permissions and its flags in
// api.host.features (see README.md). Pure: no imports from the app.

/** Permissions this area adds to ALL_PERMISSIONS. */
export const PERMISSIONS = [] as const;

/** Flags this area adds to api.host.features (missing on older webmails: read them as `=== true`). */
export interface AreaHostFeaturesB {
  /** api.email.getAttachmentText: the text of an attachment (PDF, Office, text, calendar and address files). */
  attachmentText?: boolean;
}

/**
 * What api.email.getAttachmentText answers. `status`: ok (`text` holds the
 * text), too_big (over 20 MB, or an Office file that unpacks to more than
 * 50 MB), unsupported (images, archives, legacy .doc/.xls/.ppt), no_text
 * (a scanned PDF, an empty file), encrypted, failed.
 */
export interface AttachmentTextView {
  name: string;
  type: string;
  /** Size of the attachment in bytes. */
  size: number;
  format: 'text' | 'csv' | 'html' | 'ics' | 'vcf' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'other';
  status: 'ok' | 'too_big' | 'unsupported' | 'no_text' | 'encrypted' | 'failed';
  /** The text, '' unless status is ok. */
  text: string;
  /** True when the text was cut at maxChars, or a PDF or spreadsheet had more than was read. */
  truncated: boolean;
  /** PDFs: the number of pages in the file (at most 50 are read). */
  pages?: number;
  /** Spreadsheets: the names of the sheets read (at most 5, 2,000 rows each). */
  sheets?: string[];
}

export interface AttachmentTextOptions {
  /** Longest text returned, 1 to 100,000 characters (default 20,000). */
  maxChars?: number;
  /** The account the message is in (EmailSummary.accountId), for shared and group mail. */
  accountId?: string;
}
