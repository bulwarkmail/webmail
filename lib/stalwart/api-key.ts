/**
 * A Stalwart API key: "API_" and 28 bytes (account id, credential id, secret)
 * as unpadded base64url, which is 38 characters (Stalwart's
 * crates/common/src/auth/credential.rs). A password that only starts with
 * "API_" is not one.
 */
const STALWART_API_KEY = /^API_[A-Za-z0-9_-]{38}$/;

export function isStalwartApiKey(value: string): boolean {
  return STALWART_API_KEY.test(value);
}
