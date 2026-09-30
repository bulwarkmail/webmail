/**
 * FileNode naming rules a server publishes in its filenode capability
 * (`forbiddenNameChars`, `forbiddenNodeNames`; Stalwart 0.16.6+). A name that
 * breaks them is refused ("Name contains a forbidden character." / "Name is
 * reserved and cannot be used."), which used to surface only after an upload
 * had started and then aborted the rest of the batch.
 */
export interface FileNameRules {
  forbiddenChars: string;
  forbiddenNames: string[];
}

export type FileNameProblem = { kind: 'chars'; chars: string } | { kind: 'reserved' };

export function fileNameRulesFrom(capability: unknown): FileNameRules | null {
  if (!capability || typeof capability !== 'object') return null;
  const cap = capability as { forbiddenNameChars?: unknown; forbiddenNodeNames?: unknown };
  const forbiddenChars = typeof cap.forbiddenNameChars === 'string' ? cap.forbiddenNameChars : '';
  const forbiddenNames = Array.isArray(cap.forbiddenNodeNames)
    ? cap.forbiddenNodeNames.filter((n): n is string => typeof n === 'string')
    : [];
  if (!forbiddenChars && forbiddenNames.length === 0) return null;
  return { forbiddenChars, forbiddenNames };
}

export function fileNameProblem(name: string, rules: FileNameRules | null): FileNameProblem | null {
  if (!rules) return null;
  const bad = [...new Set([...name].filter(c => rules.forbiddenChars.includes(c)))];
  if (bad.length) return { kind: 'chars', chars: bad.join(' ') };
  // Matched against the whole name, ignoring case: "CON" is reserved, "CON.txt" is not.
  if (rules.forbiddenNames.some(n => n.toLowerCase() === name.toLowerCase())) return { kind: 'reserved' };
  return null;
}

/**
 * A variant of `name` the server accepts: forbidden characters become "_",
 * a reserved name gets "_" appended. Used for uploads, where the name comes
 * from the local file system and cannot be asked for again.
 */
export function acceptedFileName(name: string, rules: FileNameRules | null): string {
  if (!rules) return name;
  let out = [...name].map(c => (rules.forbiddenChars.includes(c) ? '_' : c)).join('');
  if (rules.forbiddenNames.some(n => n.toLowerCase() === out.toLowerCase())) out = `${out}_`;
  return out;
}
