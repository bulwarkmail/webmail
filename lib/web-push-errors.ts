import { jmapErrorType } from '@/lib/jmap/jmap-error';

type WebPushStep = 'blocked' | 'not-granted' | 'relay' | 'verification-timeout' | 'teardown';

/** A step that failed for a reason the user can act on. The message stays for logs. */
export class WebPushStepError extends Error {
  constructor(public readonly step: WebPushStep, message: string) {
    super(message);
    this.name = 'WebPushStepError';
  }
}

export type WebPushErrorKey =
  | 'error_blocked' | 'error_not_granted' | 'error_relay' | 'error_verification_timeout' | 'error_teardown'
  | 'error_forbidden' | 'error_over_quota';

const STEP_MESSAGES: Record<WebPushStep, WebPushErrorKey> = {
  blocked: 'error_blocked',
  'not-granted': 'error_not_granted',
  relay: 'error_relay',
  'verification-timeout': 'error_verification_timeout',
  teardown: 'error_teardown',
};

/** The key under settings.notifications.push that says what went wrong, if any does. */
export function webPushErrorKey(error: unknown): WebPushErrorKey | null {
  if (error instanceof WebPushStepError) return STEP_MESSAGES[error.step];
  const type = jmapErrorType(error);
  if (type === 'forbidden') return 'error_forbidden';
  if (type === 'overQuota') return 'error_over_quota';
  return null;
}
