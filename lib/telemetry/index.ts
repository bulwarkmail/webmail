export { startScheduler, stopScheduler, reschedule, sendOnce } from './sender';
export { buildPayload, errorsForDay, errorsForPayload, markProcessStart } from './payload';
export {
  loadState, saveState, updateState, getInstanceId, effectiveConsent, effectiveErrorsConsent,
} from './state';
export { recordLogin, getLoginCounts } from './login-tracker';
export {
  validateEndpointUrl, resolveEndpointAllowed, isPrivateAddress,
} from './endpoint-guard';
export type { EndpointCheck } from './endpoint-guard';
export type {
  TelemetryPayload, TelemetryPayloadV2, AnyTelemetryPayload, TelemetryError, TelemetryStateFile, ConsentState,
  ErrorsConsent, TelemetryErrorBatch,
  Platform, OsFamily, CountBucket, TelemetryFeatures,
} from './types';
export { DEFAULT_ENDPOINT } from './types';
