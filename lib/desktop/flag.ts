/**
 * The desktop app's own webmail build (`npm run build:desktop`).
 *
 * A build-time constant, inlined through next.config.ts `env` into client and
 * server bundles alike, like `IS_LITE`. A server admin can't switch it on: in
 * any other build the value is compiled in as empty, and the bundler drops
 * the branches. Never read this flag through a runtime environment variable.
 *
 * What it unlocks, and only in that build:
 * - login routes accept the servers the user approved in the app
 *   (`isDesktopTrustedServer`, the list comes from the Electron main process)
 * - sign-in through the system browser for any server
 * - a per-slot record of the upstream for refresh tokens
 * - a login budget per mail server rather than per client address
 * - pairing and hand-off routes are gone
 */
export const IS_DESKTOP_BUILD = process.env.NEXT_PUBLIC_BULWARK_DESKTOP === '1';
