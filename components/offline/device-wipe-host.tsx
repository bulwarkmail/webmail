'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { consumeWipeNote } from '@/lib/devices/wipe-state';
import { startDeviceWipe } from '@/lib/offline/device-wipe';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';

/**
 * Runs the device's side of wipes on every page, the sign-in page too, so a
 * device with nobody signed in still finishes a wipe and hears about a new one.
 * When another account stays signed in, the note about lost mail is a toast here;
 * otherwise the sign-in page shows it. Not mounted in Lite.
 */
export function DeviceWipeHost() {
  const t = useTranslations('offlineWipe');
  const tRef = useRef(t);
  tRef.current = t;
  const signedIn = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => startDeviceWipe(), []);

  useEffect(() => {
    if (!signedIn) return;
    const note = consumeWipeNote();
    if (note) toast.warning(note.unsent > 0 ? tRef.current('note_unsent', { count: note.unsent }) : tRef.current('note'), { duration: 0 });
  }, [signedIn]);

  return null;
}
