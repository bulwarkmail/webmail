// Area c of the assistant's host APIs, inside the plugin sandbox (see README.md).

import type { CallApi, RuntimeAdditions } from './runtime';

/** The methods this area adds to the plugin's api, by namespace. */
export function runtime(_callApi: CallApi): RuntimeAdditions {
  return {};
}
