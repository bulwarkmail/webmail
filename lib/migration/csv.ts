/**
 * The bulk migration list: `source_user,target_account,source_password`,
 * pasted or uploaded. Every row is checked before anything starts, and each
 * bad row is reported with its row number (the header is row 1, as in a
 * spreadsheet) and the reason.
 */

export const CSV_HEADER = ['source_user', 'target_account', 'source_password'] as const;

export const MAX_CSV_ROWS = 5000;

export interface CsvRow {
  /** Row number in the file, the header being row 1. */
  row: number;
  sourceUser: string;
  target: string;
  /** Empty when the source's admin login is to be used. */
  password: string;
}

export interface CsvProblem {
  row: number;
  reason: string;
}

/** RFC 4180 records: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsvRecords(text: string): { row: number; fields: string[] }[] {
  const records: { row: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0].trim() !== '') records.push({ row: startLine, fields });
    fields = [];
    field = '';
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\r') {
      continue;
    } else if (c === '\n') {
      endRecord();
      line++;
      startLine = line;
    } else {
      field += c;
    }
  }
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

/**
 * Rows and the problems found without asking any server: the header,
 * missing columns, duplicate targets, an empty password where the source
 * has no admin login.
 */
export function parseMigrationCsv(text: string, opts: { sourceHasAdminLogin: boolean }): { rows: CsvRow[]; problems: CsvProblem[] } {
  const records = parseCsvRecords(text);
  const problems: CsvProblem[] = [];
  const rows: CsvRow[] = [];
  if (records.length === 0) return { rows, problems: [{ row: 1, reason: 'The list is empty.' }] };
  const header = records[0].fields.map((f) => f.trim().toLowerCase());
  const columns = CSV_HEADER.map((name) => header.indexOf(name));
  const missing = CSV_HEADER.filter((_, i) => columns[i] < 0);
  if (missing.length > 0) {
    return { rows, problems: [{ row: records[0].row, reason: `The header must be ${CSV_HEADER.join(',')} (missing: ${missing.join(', ')}).` }] };
  }
  if (records.length - 1 > MAX_CSV_ROWS) {
    return { rows, problems: [{ row: records[MAX_CSV_ROWS + 1].row, reason: `At most ${MAX_CSV_ROWS} accounts per migration.` }] };
  }
  const seenTargets = new Map<string, number>();
  for (const record of records.slice(1)) {
    const value = (index: number) => (record.fields[index] ?? '');
    const missingColumns = CSV_HEADER.filter((_, i) => columns[i] >= record.fields.length);
    if (missingColumns.length > 0) {
      problems.push({ row: record.row, reason: `Missing column: ${missingColumns.join(', ')}.` });
      continue;
    }
    const sourceUser = value(columns[0]).trim();
    const target = value(columns[1]).trim();
    const password = value(columns[2]);
    if (!sourceUser) {
      problems.push({ row: record.row, reason: 'source_user is empty.' });
      continue;
    }
    if (!target) {
      problems.push({ row: record.row, reason: 'target_account is empty.' });
      continue;
    }
    const key = target.toLowerCase();
    const earlier = seenTargets.get(key);
    if (earlier !== undefined) {
      problems.push({ row: record.row, reason: `Duplicate target ${target} (also in row ${earlier}).` });
      continue;
    }
    seenTargets.set(key, record.row);
    if (!password && !opts.sourceHasAdminLogin) {
      problems.push({ row: record.row, reason: 'source_password is empty and the source has no admin login.' });
      continue;
    }
    rows.push({ row: record.row, sourceUser, target, password });
  }
  if (rows.length === 0 && problems.length === 0) problems.push({ row: records[0].row, reason: 'The list has no accounts.' });
  return { rows, problems };
}

/**
 * Adds a problem for every row whose target Stalwart doesn't know.
 * `exists` opens the account's JMAP session with the master user.
 */
export async function checkTargetsExist(
  rows: CsvRow[],
  exists: (target: string) => Promise<boolean>,
  concurrency = 8,
): Promise<CsvProblem[]> {
  const problems: CsvProblem[] = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      if (!(await exists(row.target))) problems.push({ row: row.row, reason: `Target ${row.target} does not exist on Stalwart.` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return problems.sort((a, b) => a.row - b.row);
}
