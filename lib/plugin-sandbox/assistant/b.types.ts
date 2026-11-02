// Area b of the assistant's host APIs: its permissions and its flags in
// api.host.features (see README.md). Pure: no imports from the app.

/** Permissions this area adds to ALL_PERMISSIONS. */
export const PERMISSIONS = [] as const;

/** Flags this area adds to api.host.features (missing on older webmails: read them as `=== true`). */
export interface AreaHostFeaturesB {
  /** api.email.getAttachmentText: the text of an attachment (PDF, Office, text, calendar and address files). */
  attachmentText?: boolean;
  /** api.email.getAttachmentImage: an image attachment, shrunk for a model. */
  attachmentImages?: boolean;
  /** api.email.getThread: every message of a conversation; api.email.getThreadCount: how many there are. */
  threads?: boolean;
  /** The reader panel (email-detail-sidebar) gets the messages ticked in the list as `listSelection`. */
  listSelection?: boolean;
}

/** What EmailReadView adds for the assistant. */
export interface EmailReadViewExtrasB {
  /**
   * false: this login can't read the message's attachments, text or
   * conversation through the host (it belongs to another connected login,
   * as in a unified view), so attachment, image and thread reads of it
   * fail; offer none. Left out when they can be read.
   */
  blobsReadable?: boolean;
}

/** What EmailReadView.attachments adds for an image the message shows inline. */
export interface AttachmentExtrasB {
  /** The Content-ID the message's HTML refers to (`<img src="cid:…">`), without angle brackets. */
  cid?: string;
  /** The alt text of that image in the HTML, when the sender wrote one. */
  alt?: string;
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

/**
 * What api.email.getAttachmentImage answers. `status`: ok (`data` holds the
 * image), tracker (1-2 px), tiny (a side under 64 px or under 128x128 in
 * area), too_big (over 20 MB, or still over 1.5 MB at 64 px), unsupported
 * (not a picture the browser can show: HEIC, TIFF, SVG, not an image),
 * failed.
 */
export interface AttachmentImageView {
  name: string;
  /** The type of `data`: image/jpeg, or image/png for a picture with see-through parts. Unless ok, the attachment's own type. */
  type: string;
  /** Size of `data` in pixels when ok; of the picture as it is (when it could be read) otherwise; else 0. */
  width: number;
  height: number;
  /** The image, base64 without a data: prefix; '' unless status is ok. */
  data: string;
  status: 'ok' | 'tiny' | 'tracker' | 'too_big' | 'unsupported' | 'failed';
  /** The alt text the message's HTML gives this inline image. */
  alt?: string;
  /** With `exif: true`: when and where a photo was taken, when the file says. */
  exif?: { taken?: string; lat?: number; lon?: number };
}

export interface AttachmentImageOptions {
  /** Longest edge in pixels, 64 to 2,576 (default 1,568). */
  maxSide?: number;
  /** Also read the photo's date and place (EXIF). Off unless the user asked for them. */
  exif?: boolean;
  /** The account the message is in (EmailSummary.accountId), for shared and group mail. */
  accountId?: string;
}

/**
 * The reader panel's `listSelection` prop (email:read): the messages ticked
 * in the list when two or more are, else null. `emails` names at most 50,
 * each with the account it is in; `total` counts every ticked message.
 */
export interface ListSelectionView {
  emails: { id: string; accountId?: string }[];
  total: number;
}
