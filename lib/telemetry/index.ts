export { startScheduler, stopScheduler, reschedule, sendOnce } from './sender';
export { buildPayload, markProcessStart } from './payload';
export {
  loadState, saveState, getInstanceId, effectiveConsent,
} from './state';
export { recordLogin, getLoginCounts } from './login-tracker';
export type {
  TelemetryPayload, TelemetryStateFile, ConsentState,
  Platform, OsFamily, CountBucket, TelemetryFeatures,
} from './types';
export { DEFAULT_ENDPOINT } from './types';
