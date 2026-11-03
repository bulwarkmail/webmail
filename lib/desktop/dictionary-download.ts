/**
 * Spellcheck dictionaries for languages the OS has no checker for. They'd come from
 * this Google host, so nothing is fetched until the user says yes in the composer,
 * and never in no-third-party mode. The shell starts every session with the address
 * pointing nowhere (src/main/spellcheck.ts in the desktop repo).
 */

import { noThirdPartyTraffic } from '@/lib/third-party-mode';

export const DICTIONARY_HOST_URL = 'https://redirector.gvt1.com/edgedl/chrome/dict/';

export function dictionaryDownloadAllowed(): boolean {
  return !noThirdPartyTraffic();
}
