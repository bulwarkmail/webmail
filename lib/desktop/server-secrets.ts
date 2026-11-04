/**
 * The session secret and local admin password of the desktop app's own server.
 *
 * The Electron main process sends them by message, and src/server/host.ts in the
 * desktop repo puts them on globalThis, which all of Next's bundles share. They stay
 * out of the environment block, where a child process would inherit them.
 *
 * Every other build reads its secrets the usual way, and this compiles to nothing.
 */

interface ShellSecrets {
  sessionSecret?: string;
  adminPassword?: string;
}

export function desktopServerSecret(name: keyof ShellSecrets): string {
  if (process.env.NEXT_PUBLIC_BULWARK_DESKTOP !== '1') return '';
  const holder = globalThis as unknown as Record<symbol, ShellSecrets | undefined>;
  return holder[Symbol.for('bulwark.desktop.serverSecrets')]?.[name] ?? '';
}
