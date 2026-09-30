"use client";

import { useEffect, useState } from "react";
import { IS_LITE } from "@/lib/lite";

/**
 * Whether a WOPI document editor is configured for this deployment and which
 * file extensions it handles (#425). Fetched once per page load and shared
 * across consumers via a module-level promise.
 */
export interface WopiStatus {
  enabled: boolean;
  editExtensions: string[];
  viewExtensions: string[];
}

const DISABLED: WopiStatus = { enabled: false, editExtensions: [], viewExtensions: [] };

let statusPromise: Promise<WopiStatus> | null = null;

function fetchWopiStatus(): Promise<WopiStatus> {
  // The WOPI bridge is a server feature; the static build never has an editor.
  if (IS_LITE) return Promise.resolve(DISABLED);
  if (!statusPromise) {
    statusPromise = fetch("/api/wopi/status")
      .then((res) => (res.ok ? res.json() : DISABLED))
      .then((data) => ({
        enabled: !!data?.enabled,
        editExtensions: Array.isArray(data?.editExtensions) ? data.editExtensions : [],
        viewExtensions: Array.isArray(data?.viewExtensions) ? data.viewExtensions : [],
      }))
      .catch(() => {
        statusPromise = null; // allow a retry on the next mount
        return DISABLED;
      });
  }
  return statusPromise;
}

export function useWopiStatus(enabled: boolean): WopiStatus | null {
  const [status, setStatus] = useState<WopiStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchWopiStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return status;
}

/** Lowercased extension of a file name, without the dot. */
export function fileExtension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() || "" : "";
}

/** Whether the configured editor can open (edit or view) a file of this name. */
export function canWopiOpen(status: WopiStatus | null, name?: string | null): boolean {
  if (!status?.enabled || !name) return false;
  const ext = fileExtension(name);
  return !!ext && (status.editExtensions.includes(ext) || status.viewExtensions.includes(ext));
}
