export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export function isValidFcmToken(value: unknown): value is string {
  // FCM registration tokens are opaque. In practice they're ~140–250 chars of
  // [A-Za-z0-9:_-]. Be permissive on length; strict on charset to block
  // obvious garbage without rejecting future token formats.
  return typeof value === 'string' && value.length >= 64 && value.length <= 4096 && /^[A-Za-z0-9:_\-]+$/.test(value);
}
