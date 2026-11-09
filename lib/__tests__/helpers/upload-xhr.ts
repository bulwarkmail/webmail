import { vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';

// No native networking: tests explicitly deliver progress and terminal events.
export class UploadXHR {
  static instances: UploadXHR[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  responseType = '';
  responseText = '';
  status = 0;
  body: File | null = null;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private done = false;

  constructor() { UploadXHR.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: File) { this.body = body; }
  abort = vi.fn(() => {
    // Native abort emits no abort event before send or after DONE.
    if (this.body && !this.done) { this.done = true; this.onabort?.(); }
  });
  progress(loaded: number, total = this.body?.size ?? 0, lengthComputable = true) {
    this.upload.onprogress?.(new ProgressEvent('progress', { loaded, total, lengthComputable }));
  }
  load(status = 201, text = JSON.stringify({ blobId: `blob-${this.body?.name}`, size: this.body?.size, type: this.body?.type })) {
    this.done = true;
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
  error() { this.done = true; this.onerror?.(); }
  timeout() { this.done = true; this.ontimeout?.(); }
}

export function uploadClient() {
  const client = new JMAPClient('https://upload.invalid', 'synthetic', 'synthetic');
  // Seed only a synthetic connected session; avoid keep-alive/reconnect traffic.
  Object.assign(client, {
    accountId: 'synthetic',
    session: {
      capabilities: { 'urn:ietf:params:jmap:core': {} },
      accounts: { synthetic: { accountCapabilities: {} } },
      primaryAccounts: {},
      uploadUrl: 'https://upload.invalid/upload/{accountId}',
    },
  });
  return client;
}
