"use client";

import { useEffect, useState } from "react";
import { IS_LITE } from "@/lib/lite";
import { apiFetch } from "@/lib/browser-navigation";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Whether a WOPI document editor is configured for this deployment and which
 * file extensions it handles (#425). The answer is the same for every account,
 * so the first real one is kept for the page load and shared across consumers.
 */
export interface WopiStatus {
  enabled: boolean;
  editExtensions: string[];
  viewExtensions: string[];
  /** Formats "New file" can create from a blank template besides .txt (#1393). */
  newExtensions: string[];
}

const DISABLED: WopiStatus = { enabled: false, editExtensions: [], viewExtensions: [], newExtensions: [] };

let known: WopiStatus | null = null;
let pending: Promise<WopiStatus> | null = null;
let pendingClient: unknown = null;

function fetchWopiStatus(client: unknown): Promise<WopiStatus> {
  // The WOPI bridge is a server feature; the static build never has an editor.
  if (IS_LITE) return Promise.resolve(DISABLED);
  if (known) return Promise.resolve(known);
  // A request sent for an earlier client may be refused for lack of the sign-in
  // context this one brought, so only the same client shares it.
  if (pending && pendingClient === client) return pending;

  const request: Promise<WopiStatus> = apiFetch("/api/wopi/status")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      known = {
        enabled: !!data?.enabled,
        editExtensions: Array.isArray(data?.editExtensions) ? data.editExtensions : [],
        viewExtensions: Array.isArray(data?.viewExtensions) ? data.viewExtensions : [],
        newExtensions: Array.isArray(data?.newExtensions) ? data.newExtensions : [],
      };
      return known;
    })
    // A refusal or an outage says nothing about the editor (#1518): show no
    // editor for now and ask again on the next mount or client.
    .catch(() => DISABLED)
    .finally(() => {
      if (pending === request) pending = null;
    });
  pending = request;
  pendingClient = client;
  return request;
}

export function useWopiStatus(enabled: boolean): WopiStatus | null {
  const [status, setStatus] = useState<WopiStatus | null>(null);
  // The route needs the sign-in context cookie, which is written before the
  // store holds a connected client. `isAuthenticated` alone comes back from
  // storage on load, and a local copy's client gives way to the real one once
  // the restore wrote the cookie, so this follows the client itself (#1518).
  const client = useAuthStore((state) => (state.isAuthenticated ? state.client : null));

  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    fetchWopiStatus(client).then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, client]);

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
