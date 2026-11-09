"use client";

import { DesktopOsSettings } from "./desktop-os-settings";

/**
 * Settings > Desktop app, in the desktop app only: how it starts and closes (sign-in,
 * tray), its windows and menu bar, its keys from any other app, and the mail links and
 * files it opens. These were sections of General until the reorg of 2026-11-05.
 */
export function DesktopAppSettings() {
  return (
    <div className="space-y-8">
      <DesktopOsSettings />
    </div>
  );
}
