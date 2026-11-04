/**
 * Names and paths on the computer's side of Files on this computer.
 *
 * A name in Files can be one the disk can't hold. Windows refuses `< > : " / \ | ? *`, control
 * characters, a trailing dot or space, and the device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9,
 * with any extension). Such a name gets a local one: the forbidden characters become their
 * fullwidth forms, and a trailing dot or space or a device name gets `_`. Two names in one folder
 * that differ only in case can't both be on a case-insensitive disk (Windows, macOS by default):
 * the second gets ` (2)`. The engine keeps both names in its record, so the local name never
 * reads as a rename, and the name in Files never changes for the disk's sake.
 *
 * Paths are relative to a root, `/` between parts, as main takes them.
 */

export interface DiskNaming {
  /** The disk takes only what Windows takes (Windows itself; any disk the drive is on). */
  windowsNames: boolean;
  /** Two names differing only in case are one name on this disk. */
  caseInsensitive: boolean;
}

export function namingFor(platform: 'win32' | 'darwin' | 'linux' | string): DiskNaming {
  if (platform === 'win32') return { windowsNames: true, caseInsensitive: true };
  if (platform === 'darwin') return { windowsNames: false, caseInsensitive: true };
  return { windowsNames: false, caseInsensitive: false };
}

const FULLWIDTH: Record<string, string> = {
  '<': '＜',
  '>': '＞',
  ':': '：',
  '"': '＂',
  '/': '／',
  '\\': '＼',
  '|': '｜',
  '?': '？',
  '*': '＊',
};

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function stemOf(name: string): string {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The name as the disk can hold it. The same name back when it already can. */
export function diskName(name: string, naming: DiskNaming): string {
  let out = name;
  if (naming.windowsNames) {
    out = [...out].map((ch) => {
      if (FULLWIDTH[ch]) return FULLWIDTH[ch];
      const code = ch.codePointAt(0) ?? 0;
      // Control characters: the Control Pictures block keeps them visible and distinct.
      if (code < 0x20) return String.fromCodePoint(0x2400 + code);
      return ch;
    }).join('');
    if (/[. ]$/.test(out)) out = `${out}_`;
    const stem = stemOf(out);
    if (RESERVED.test(stem.trimEnd())) out = `${stem}_${out.slice(stem.length)}`;
  } else {
    out = out.replace(/\//g, FULLWIDTH['/']).replace(/\0/g, '␀');
  }
  return out;
}

/** Whether the disk would refuse this name as it is. */
export function needsDiskName(name: string, naming: DiskNaming): boolean {
  return diskName(name, naming) !== name;
}

/** The key two names on this disk share when they are the same name. */
export function nameKey(name: string, naming: DiskNaming): string {
  return naming.caseInsensitive ? name.normalize('NFC').toLocaleLowerCase('en-US') : name.normalize('NFC');
}

export function pathKey(path: string, naming: DiskNaming): string {
  return path.split('/').map((part) => nameKey(part, naming)).join('/');
}

/** "report.pdf" with n = 2: "report (2).pdf". A dot at the start is a hidden name, not an extension. */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

/**
 * A free local name for `wanted` in a folder whose other names are `taken` (as nameKey gives
 * them): the disk's form of it, numbered when that's already there.
 */
export function freeLocalName(wanted: string, taken: ReadonlySet<string>, naming: DiskNaming): string {
  const base = diskName(wanted, naming);
  if (!taken.has(nameKey(base, naming))) return base;
  for (let n = 2; ; n += 1) {
    const candidate = numberedName(base, n);
    if (!taken.has(nameKey(candidate, naming))) return candidate;
  }
}

/**
 * The name the copy that lost a conflict is kept under, next to the other:
 * "report (conflict, Laptop, 2026-11-04 15.30).pdf".
 */
export function conflictName(name: string, device: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const label = `conflict, ${device.replace(/[<>:"/\\|?*]/g, '').trim() || 'this computer'}, ${stamp}`;
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${label})${name.slice(dot)}`;
  return `${name} (${label})`;
}

/**
 * Files the computer makes for itself in any folder: Explorer's and Finder's folder settings and
 * thumbnails, Office's owner files while a document is open, macOS's resource forks on other
 * disks. They never go up; the same names coming down from Files are written like any other.
 */
export function isSystemFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'desktop.ini' || lower === 'thumbs.db' || lower === '.ds_store' || name.startsWith('~$') || name.startsWith('._');
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function depthOf(path: string): number {
  return path ? path.split('/').length : 0;
}

/** Whether `path` is `folder` or inside it. */
export function isUnderPath(path: string, folder: string, naming?: DiskNaming): boolean {
  if (folder === '') return true;
  const a = naming ? pathKey(path, naming) : path;
  const b = naming ? pathKey(folder, naming) : folder;
  return a === b || a.startsWith(`${b}/`);
}
