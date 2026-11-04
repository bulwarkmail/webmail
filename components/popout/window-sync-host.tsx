"use client";

import { useEffect } from "react";
import { startWindowSync } from "@/lib/desktop/window-sync";

/** See lib/desktop/window-sync.ts. */
export function WindowSyncHost() {
  useEffect(() => startWindowSync(), []);
  return null;
}
