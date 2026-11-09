import type { FileNode } from '@/lib/jmap/types';
import { fileNodeKind } from '@/lib/jmap/filenode-kind';
import { saveBlobAs, type DownloadKind, type DownloadSubject } from '@/lib/download-guard';

/*
 * Downloading folders: the server has no archive download, so the browser
 * fetches every file below the folders and packs them into one zip (jszip),
 * with the folders' own names at the top.
 */

export interface ZipEntry {
  /** Path inside the zip, e.g. "Taxes/2025/return.pdf". */
  path: string;
  node: FileNode;
}

export interface ZipPlan {
  files: ZipEntry[];
  /** Folders with nothing in them, kept so the zip has the same shape. */
  emptyFolders: string[];
  /** Bytes to fetch, for the progress. */
  totalBytes: number;
}

/** What goes into the zip of some items: files as they are, folders with everything below them. */
export function planZip(nodes: FileNode[], ids: string[]): ZipPlan {
  const byParent = new Map<string | null, FileNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  const plan: ZipPlan = { files: [], emptyFolders: [], totalBytes: 0 };
  const used = new Set<string>();
  const unique = (path: string) => {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (used.has(`${dir}${base} (${n})${ext}`)) n++;
    const next = `${dir}${base} (${n})${ext}`;
    used.add(next);
    return next;
  };
  const seen = new Set<string>();
  const add = (node: FileNode, prefix: string) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const kind = fileNodeKind(node);
    // A symlink (Stalwart 1.0) has no content to pack.
    if (kind === 'symlink') return;
    const path = unique(prefix + node.name.replace(/[\\/]/g, '_'));
    if (kind === 'directory') {
      const children = byParent.get(node.id) ?? [];
      if (children.length === 0) plan.emptyFolders.push(path);
      for (const child of children) add(child, `${path}/`);
      return;
    }
    if (!node.blobId) return;
    plan.files.push({ path, node });
    plan.totalBytes += node.size || 0;
  };
  for (const id of ids) {
    const node = nodes.find(n => n.id === id);
    if (node) add(node, '');
  }
  return plan;
}

export interface ZipProgress {
  /** 0..1 over fetching and packing. */
  progress: number;
  /** The file being fetched, while fetching. */
  current?: string;
}

/** Fetch the plan's files and pack them. Throws an AbortError when `signal` aborts. */
export async function buildZip(
  plan: ZipPlan,
  fetchFile: (node: FileNode) => Promise<Blob>,
  options: { signal?: AbortSignal; onProgress?: (p: ZipProgress) => void } = {},
): Promise<Blob> {
  const { signal, onProgress } = options;
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const abortIfAsked = () => {
    if (signal?.aborted) throw new DOMException('The download was canceled', 'AbortError');
  };
  for (const folder of plan.emptyFolders) zip.folder(folder);
  // Fetching is most of the work; packing gets the last tenth.
  let fetched = 0;
  for (const entry of plan.files) {
    abortIfAsked();
    onProgress?.({ progress: plan.totalBytes > 0 ? (fetched / plan.totalBytes) * 0.9 : 0, current: entry.path });
    zip.file(entry.path, await fetchFile(entry.node), { date: entry.node.modified ? new Date(entry.node.modified) : undefined });
    fetched += entry.node.size || 0;
  }
  abortIfAsked();
  const blob = await zip.generateAsync(
    // Photos, videos and office files are compressed already; a light level
    // keeps big folders quick.
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
    (meta) => onProgress?.({ progress: 0.9 + (meta.percent / 100) * 0.1 }),
  );
  abortIfAsked();
  return blob;
}

/** Hand a blob to the browser as a download, unless a device policy forbids it (false then). */
export function saveBlob(blob: Blob, name: string, options: { kind?: DownloadKind; subject?: DownloadSubject } = {}): boolean {
  return saveBlobAs(blob, name, { kind: options.kind ?? 'file', subject: options.subject });
}
