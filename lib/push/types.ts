// Types shared between the relay routes and the store. Kept in a leaf module
// so both server code and admin UIs can import without pulling `node:fs`.

export interface SubscriptionRecord {
  fcmToken: string;
  verificationCode: string | null;
  createdAt: number;
  lastPushAt: number | null;
  accountLabel?: string;
}

export interface PushVerification {
  '@type': 'PushVerification';
  pushSubscriptionId: string;
  verificationCode: string;
}

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<string, Record<string, string>>;
}

export type JmapPushBody = PushVerification | StateChange;
