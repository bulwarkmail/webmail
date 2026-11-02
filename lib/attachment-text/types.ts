// Shapes and limits of the text extraction for attachments and files.
// Pure: no imports from the app, so the plugin host and Files can share it.

/** What kind of file the text came from. */
export type TextFormat =
  | 'text' | 'csv' | 'html' | 'ics' | 'vcf' | 'pdf'
  | 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'other';

/**
 * ok: `text` holds the text. too_big: over the size limit, not read.
 * unsupported: a format without a reader (images, legacy .doc/.xls/.ppt,
 * archives). no_text: nothing to read, e.g. a scanned PDF. encrypted:
 * protected by a password. failed: the file is damaged or reading broke.
 */
export type TextStatus = 'ok' | 'too_big' | 'unsupported' | 'no_text' | 'encrypted' | 'failed';

export interface ExtractedText {
  format: TextFormat;
  status: TextStatus;
  /** The text, '' unless status is ok. */
  text: string;
  /** True when the text was cut at maxChars, or a PDF or sheet had more than was read. */
  truncated: boolean;
  /** PDFs: the number of pages in the file. */
  pages?: number;
  /** Spreadsheets: the names of the sheets read. */
  sheets?: string[];
}

export interface ExtractOptions {
  /** File name; its extension picks the format first. */
  name?: string;
  /** Media type, used when the name says nothing. */
  type?: string;
  /** Longest text returned (default DEFAULT_TEXT_CHARS, at most MAX_TEXT_CHARS). */
  maxChars?: number;
}

/** Text returned when the caller doesn't ask for a length. */
export const DEFAULT_TEXT_CHARS = 20_000;
/** Longest text one read returns. */
export const MAX_TEXT_CHARS = 100_000;
/** Largest file read for its text. */
export const MAX_TEXT_SOURCE_BYTES = 20 * 1024 * 1024;
/** Pages of a PDF read at most. */
export const MAX_PDF_PAGES = 50;
/** Fewer characters per page than this on average: the PDF has no text layer. */
export const MIN_PDF_CHARS_PER_PAGE = 20;
/** Sheets of a spreadsheet read at most. */
export const MAX_SHEETS = 5;
/** Rows per sheet read at most. */
export const MAX_SHEET_ROWS = 2_000;
/** Bytes an Office file may unpack to, all entries read together (zip bombs). */
export const MAX_INFLATED_BYTES = 50 * 1024 * 1024;
