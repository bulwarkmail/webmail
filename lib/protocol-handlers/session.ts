import { isStandaloneDisplayMode } from "@/lib/standalone-display";
import type { ParsedMailto } from "./mailto";
import type { ParsedWebcal } from "./webcal";
import { matchSurface } from "@/lib/deep-links";

const MAILTO_KEY = "bulwark:pending-mailto";
const WEBCAL_KEY = "bulwark:pending-webcal";
const PROTOCOL_CHANNEL = "bulwark:protocol-handlers";
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAILTO_REQUEST = "mailto-request";
const MAILTO_CANDIDATE = "mailto-candidate";
const MAILTO_ACK = "mailto-ack";
const OPEN_MAILTO_IN_CLIENT = "open-mailto-in-client";
const MAILTO_CLIENT_READY = "mailto-client-ready";
const MAILTO_CLIENT_GONE = "mailto-client-gone";
const PENDING_MAILTO_EVENT = "bulwark:pending-mailto";
const PENDING_WEBCAL_EVENT = "bulwark:pending-webcal";

type PendingValue<T> = T & { createdAt: number };
type PendingMailtoRequest = { type: typeof MAILTO_REQUEST; id: string; value: ParsedMailto; clientId?: string };
type PendingMailtoCandidate = { type: typeof MAILTO_CANDIDATE; id: string; clientId: string; priority: number };
type PendingMailtoAck = { type: typeof MAILTO_ACK; id: string };
type OpenMailtoInClientRequest = {
  type: typeof OPEN_MAILTO_IN_CLIENT;
  id: string;
  value: ParsedMailto;
  clientId?: string;
};
type ProtocolClientInfo = {
  path: string;
  standalone: boolean;
  clientId?: string;
  focusNotificationTitle?: string;
  focusNotificationBody?: string;
};

function savePending<T>(key: string, value: T) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...value, createdAt: Date.now() }));
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
}

function consumePending<T>(key: string, validate: (value: unknown) => value is T): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as PendingValue<unknown>;
    if (typeof parsed.createdAt !== "number" || Date.now() - parsed.createdAt > PENDING_TTL_MS) {
      return null;
    }
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasPending<T>(key: string, validate: (value: unknown) => value is T): boolean {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return false;

    const parsed = JSON.parse(raw) as PendingValue<unknown>;
    if (typeof parsed.createdAt !== "number" || Date.now() - parsed.createdAt > PENDING_TTL_MS) {
      sessionStorage.removeItem(key);
      return false;
    }
    return validate(parsed);
  } catch {
    return false;
  }
}

function isParsedMailto(value: unknown): value is ParsedMailto {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ParsedMailto>;
  return Array.isArray(candidate.to)
    && Array.isArray(candidate.cc)
    && Array.isArray(candidate.bcc)
    && typeof candidate.subject === "string"
    && typeof candidate.body === "string";
}

function isPendingMailtoRequest(value: unknown): value is PendingMailtoRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingMailtoRequest>;
  return candidate.type === MAILTO_REQUEST
    && typeof candidate.id === "string"
    && isParsedMailto(candidate.value)
    && (candidate.clientId === undefined || typeof candidate.clientId === "string");
}

function isPendingMailtoAck(value: unknown, id: string): value is PendingMailtoAck {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingMailtoAck>;
  return candidate.type === MAILTO_ACK && candidate.id === id;
}

function isPendingMailtoCandidate(value: unknown, id: string): value is PendingMailtoCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingMailtoCandidate>;
  return candidate.type === MAILTO_CANDIDATE
    && candidate.id === id
    && typeof candidate.clientId === "string"
    && typeof candidate.priority === "number";
}

function isOpenMailtoInClientRequest(value: unknown): value is OpenMailtoInClientRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OpenMailtoInClientRequest>;
  return candidate.type === OPEN_MAILTO_IN_CLIENT
    && typeof candidate.id === "string"
    && isParsedMailto(candidate.value)
    && (candidate.clientId === undefined || typeof candidate.clientId === "string");
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const BROWSER_CLIENT_ID = createRequestId();

function getMailtoClientPriority(info: ProtocolClientInfo): number {
  // The mail client's URL is a permalink now (#733), so "the mail section" is
  // "/" plus every "/mail/..." deep link - not just the bare root.
  const isMailSection = !info.path || matchSurface(info.path)?.surface === "mail";
  if (info.standalone && isMailSection) return 0;
  if (isMailSection) return 1;
  if (info.standalone) return 2;
  return 3;
}

function getDefaultProtocolClientInfo(): ProtocolClientInfo {
  return { path: window.location.pathname, standalone: isStandaloneDisplayMode(), clientId: BROWSER_CLIENT_ID };
}

async function requestMailtoViaServiceWorker(value: ParsedMailto, timeoutMs: number): Promise<boolean> {
  if (typeof navigator === "undefined"
    || !("serviceWorker" in navigator)
    || typeof MessageChannel === "undefined") {
    return false;
  }

  try {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => globalThis.setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!registration) return false;

    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (!worker) return false;

    return await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = globalThis.setTimeout(() => {
        channel.port1.close();
        resolve(false);
      }, timeoutMs);

      channel.port1.onmessage = (event) => {
        globalThis.clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data?.delivered === true);
      };

      worker.postMessage({
        type: OPEN_MAILTO_IN_CLIENT,
        id: createRequestId(),
        value,
      } satisfies OpenMailtoInClientRequest, [channel.port2]);
    });
  } catch {
    return false;
  }
}

function notifyServiceWorker(
  type: typeof MAILTO_CLIENT_READY | typeof MAILTO_CLIENT_GONE,
  info?: ProtocolClientInfo,
) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  navigator.serviceWorker.ready
    .then((registration) => {
      const worker = navigator.serviceWorker.controller ?? registration.active;
      worker?.postMessage({ type, ...info });
    })
    .catch(() => {
      // Service worker registration is optional for local/dev environments.
    });
}

function isParsedWebcal(value: unknown): value is ParsedWebcal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ParsedWebcal>;
  return typeof candidate.originalUrl === "string"
    && typeof candidate.subscriptionUrl === "string"
    && typeof candidate.suggestedName === "string";
}

export function savePendingMailto(value: ParsedMailto) {
  savePending(MAILTO_KEY, value);
}

export function consumePendingMailto(): ParsedMailto | null {
  return consumePending(MAILTO_KEY, isParsedMailto);
}

export function notifyPendingMailto() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PENDING_MAILTO_EVENT));
  }
}

export function subscribeToPendingMailto(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PENDING_MAILTO_EVENT, callback);
  return () => window.removeEventListener(PENDING_MAILTO_EVENT, callback);
}

async function requestMailtoViaBroadcastChannel(value: ParsedMailto, timeoutMs: number): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") {
    return false;
  }

  return new Promise((resolve) => {
    const id = createRequestId();
    const channel = new BroadcastChannel(PROTOCOL_CHANNEL);
    const candidates: PendingMailtoCandidate[] = [];
    let selected = false;
    let selectionTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const candidateWindowMs = Math.min(75, Math.max(25, Math.floor(timeoutMs / 3)));
    const timeout = globalThis.setTimeout(() => {
      if (selectionTimer) globalThis.clearTimeout(selectionTimer);
      channel.close();
      resolve(false);
    }, timeoutMs);

    const selectCandidate = () => {
      if (selected) return;
      selected = true;

      const best = candidates.sort((a, b) => a.priority - b.priority)[0];
      if (!best) {
        globalThis.clearTimeout(timeout);
        channel.close();
        resolve(false);
        return;
      }

      channel.postMessage({
        type: OPEN_MAILTO_IN_CLIENT,
        id,
        clientId: best.clientId,
        value,
      } satisfies OpenMailtoInClientRequest);
    };

    channel.onmessage = (event) => {
      if (isPendingMailtoCandidate(event.data, id)) {
        candidates.push(event.data);
        selectionTimer ??= globalThis.setTimeout(selectCandidate, candidateWindowMs);
        return;
      }

      if (isPendingMailtoAck(event.data, id)) {
        if (selectionTimer) globalThis.clearTimeout(selectionTimer);
        globalThis.clearTimeout(timeout);
        channel.close();
        resolve(true);
      }
    };

    channel.postMessage({ type: MAILTO_REQUEST, id, value } satisfies PendingMailtoRequest);
  });
}

export async function requestOpenMailtoInExistingClient(value: ParsedMailto, timeoutMs = 300): Promise<boolean> {
  if (await requestMailtoViaServiceWorker(value, timeoutMs)) return true;
  return requestMailtoViaBroadcastChannel(value, timeoutMs);
}

export function listenForMailtoRequests(
  onMailto: (value: ParsedMailto) => void,
  getClientInfo: () => ProtocolClientInfo = getDefaultProtocolClientInfo,
): () => void {
  const cleanup: Array<() => void> = [];
  const clientInfo = getClientInfo();

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (isPendingMailtoRequest(event.data)) {
        if (event.data.clientId !== undefined && event.data.clientId !== BROWSER_CLIENT_ID) return;
        if (typeof window !== "undefined") window.focus();
        onMailto(event.data.value);
      }
    };
    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    notifyServiceWorker(MAILTO_CLIENT_READY, { ...clientInfo, clientId: BROWSER_CLIENT_ID });
    cleanup.push(() => {
      notifyServiceWorker(MAILTO_CLIENT_GONE, { ...clientInfo, clientId: BROWSER_CLIENT_ID });
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    });
  }

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(PROTOCOL_CHANNEL);
    channel.onmessage = (event) => {
      if (isPendingMailtoRequest(event.data)) {
        channel.postMessage({
          type: MAILTO_CANDIDATE,
          id: event.data.id,
          clientId: BROWSER_CLIENT_ID,
          priority: getMailtoClientPriority(getClientInfo()),
        } satisfies PendingMailtoCandidate);
        return;
      }

      if (!isOpenMailtoInClientRequest(event.data) || event.data.clientId !== BROWSER_CLIENT_ID) return;
      if (typeof window !== "undefined") window.focus();
      onMailto(event.data.value);
      channel.postMessage({ type: MAILTO_ACK, id: event.data.id } satisfies PendingMailtoAck);
    };
    cleanup.push(() => channel.close());
  }

  return () => cleanup.forEach((dispose) => dispose());
}

export function savePendingWebcal(value: ParsedWebcal) {
  savePending(WEBCAL_KEY, value);
}

export function consumePendingWebcal(): ParsedWebcal | null {
  return consumePending(WEBCAL_KEY, isParsedWebcal);
}

export function notifyPendingWebcal() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PENDING_WEBCAL_EVENT));
  }
}

export function subscribeToPendingWebcal(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PENDING_WEBCAL_EVENT, callback);
  return () => window.removeEventListener(PENDING_WEBCAL_EVENT, callback);
}

export function hasPendingWebcal(): boolean {
  return hasPending(WEBCAL_KEY, isParsedWebcal);
}
