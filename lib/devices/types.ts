/**
 * The device registry as both sides see it: what the instance lists for its
 * admin and what a device says about its own wipe. No secrets, no store.
 */

/** Who asked for a wipe. `rejected`: the server refused the stored login for good. */
export const WIPE_REASONS = ['admin', 'user', 'rejected'] as const;
export type WipeReason = (typeof WIPE_REASONS)[number];

export interface DeviceView {
  /** `<settingsId(user, server)>/<deviceId>`. */
  id: string;
  /** The first part of `id`: every device of this user on this server. */
  userKey: string;
  user: string;
  server: string;
  platform: string;
  appVersion: string;
  firstSeen: string;
  lastSeen: string;
  /** Asked for and not confirmed yet. Stays until the device answers or the admin takes it back. */
  wipe: { requestedAt: string; by: string } | null;
  wipedAt: string | null;
  wipeReason: WipeReason | null;
}

export const AUDIT_DEVICE_WIPE_REQUEST = 'device.wipe.request';
export const AUDIT_DEVICE_WIPE_CANCEL = 'device.wipe.cancel';
export const AUDIT_DEVICE_WIPE_CONFIRM = 'device.wipe.confirm';
export const AUDIT_DEVICE_FORGET = 'device.forget';
