export { startScheduler, stopScheduler, checkOnce } from './sender';
export {
  loadState, saveState, updateState, effectiveEndpoint, disabledByEnv,
  getCurrentVersion, isStatusStale, freshStatus,
} from './state';
export { fetchStatus, parseStatus } from './fetcher';
export type {
  UpdateStatus, UpdateSeverity, VersionCheckStateFile,
} from './types';
export { DEFAULT_VERSION_ENDPOINT } from './types';
