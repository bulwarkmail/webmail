/** What one request may hold: the session's limits, never past the ones the engine was built for. */

import type { StoreSession } from './transport';

export interface RequestLimits {
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  maxCallsInRequest: number;
  maxSizeRequest: number;
}

const DEFAULTS: RequestLimits = {
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  maxCallsInRequest: 16,
  maxSizeRequest: 10 * 1024 * 1024,
};

export function requestLimits(session: StoreSession): RequestLimits {
  const core = (session.capabilities['urn:ietf:params:jmap:core'] ?? {}) as Partial<RequestLimits>;
  const limit = (key: keyof RequestLimits) => {
    const value = core[key];
    return typeof value === 'number' && value > 0 ? Math.min(value, DEFAULTS[key]) : DEFAULTS[key];
  };
  return {
    maxObjectsInGet: limit('maxObjectsInGet'),
    maxObjectsInSet: limit('maxObjectsInSet'),
    maxCallsInRequest: limit('maxCallsInRequest'),
    maxSizeRequest: limit('maxSizeRequest'),
  };
}
