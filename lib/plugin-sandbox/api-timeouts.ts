// How long the sandbox runtime waits for the host to answer an api call.

export const DEFAULT_API_TIMEOUT_MS = 30_000;
// http.post / http.fetch can be carrying an attachment to an external store,
// which is a transfer rather than a round-trip - 30s is not enough for the
// files a plugin has any reason to offload. Still bounded so a hung host
// can't leak the pending promise. Reads that download a file (attachments,
// their text and pictures) use it too.
export const NETWORK_API_TIMEOUT_MS = 120_000;
