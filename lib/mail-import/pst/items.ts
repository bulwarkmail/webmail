import { itemKind, pstFolders, readPstMessage, type PstFolderRef } from "./extract";
import { buildMime } from "./mime";
import type { SkipReason } from "../sources";

/** One PST item as the worker hands it over: a message's MIME, or why it was skipped. */
export type PstItem =
  | {
      kind: "message";
      index: number;
      folder: string[];
      mime: Uint8Array;
      keywords: Record<string, true>;
      receivedAt?: string;
      label: string;
      embeddedSkipped: number;
      folderRole?: string;
    }
  | { kind: "skipped"; index: number; reason: SkipReason; label?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PstWalk {
  /** Items in the folders that are read (an estimate: Outlook keeps the count). */
  total: number;
  items: Generator<PstItem>;
}

function utcDate(date: Date | undefined): string | undefined {
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function walkPst(pst: any, options: { skipBefore: number; skipAlso?: Set<number>; maxMessageBytes: number; boundarySeed?: string }): PstWalk {
  const folders: PstFolderRef[] = [...pstFolders(pst)];
  const total = folders.reduce((n, f) => n + (Number(f.folder.contentCount) || 0), 0);

  function* items(): Generator<PstItem> {
    let index = 0;
    for (const ref of folders) {
      if (!(Number(ref.folder.contentCount) > 0)) continue;
      const count = Number(ref.folder.contentCount) || 0;
      let read = 0;
      for (;;) {
        let child: any;
        try {
          child = ref.folder.getNextChild();
        } catch {
          // A broken item ends this folder's list in pst-extractor: count what is
          // left of the folder as unreadable and go on with the next folder.
          for (let left = count - read; left > 0; left--) {
            const i = index++;
            yield i < options.skipBefore || options.skipAlso?.has(i)
              ? { kind: "skipped", index: i, reason: "resumed" }
              : { kind: "skipped", index: i, reason: "unreadable" };
          }
          break;
        }
        if (!child) break;
        read++;
        const i = index++;
        if (i < options.skipBefore || options.skipAlso?.has(i)) {
          yield { kind: "skipped", index: i, reason: "resumed" };
          continue;
        }
        const kind = itemKind(String(child.messageClass || ""));
        const label = String(child.subject || "");
        if (kind !== "mail") {
          yield { kind: "skipped", index: i, reason: kind, label };
          continue;
        }
        let mime: Uint8Array;
        let message;
        try {
          message = readPstMessage(child, options.maxMessageBytes);
          if (message.tooLarge) {
            yield { kind: "skipped", index: i, reason: "too_large", label };
            continue;
          }
          mime = buildMime(message.mail, { boundarySeed: options.boundarySeed });
        } catch {
          yield { kind: "skipped", index: i, reason: "other", label };
          continue;
        }
        if (mime.length > options.maxMessageBytes) {
          yield { kind: "skipped", index: i, reason: "too_large", label };
          continue;
        }
        yield {
          kind: "message",
          index: i,
          folder: ref.path,
          mime,
          keywords: message.keywords,
          receivedAt: utcDate(message.receivedAt),
          label,
          embeddedSkipped: message.embedded,
          folderRole: ref.topRole,
        };
      }
    }
  }
  return { total, items: items() };
}
