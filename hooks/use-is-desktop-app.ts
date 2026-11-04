"use client";

import { useEffect, useState } from 'react';
import { isDesktopApp } from '@/lib/desktop/bridge';

/**
 * True in the desktop app. Read after mount, so the server's render and the
 * first client render agree (the server has no bridge).
 */
export function useIsDesktopApp(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(isDesktopApp()), []);
  return desktop;
}
