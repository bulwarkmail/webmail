// The value next.config.ts inlines as NEXT_PUBLIC_BULWARK_DESKTOP.
//
// Always defined, so every build compiles `process.env.NEXT_PUBLIC_BULWARK_DESKTOP`
// to a literal. Left undefined, Next would leave the read in the server bundle,
// and setting the variable when starting a server build would turn the flag on.

/** The marker scripts/standalone-guard.mjs looks for in a non-desktop build. */
export const DESKTOP_TRUST_MARKER = 'bulwark.desktop.trustedJmapOrigins';

export function desktopBuildFlag(env = process.env) {
  return env.NEXT_PUBLIC_BULWARK_DESKTOP === '1' ? '1' : '';
}
