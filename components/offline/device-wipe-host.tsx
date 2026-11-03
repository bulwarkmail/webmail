'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { consumeWipeNote, type WipeNote } from '@/lib/devices/wipe-state';
import { startDeviceWipe } from '@/lib/offline/device-wipe';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';

/** What a wipe left to say, as a sentence. Counts only. */
export function wipeNoteText(note: WipeNote, t: (key: string, values?: { count: number }) => string): string {
  if (note.unknown) return t('note_unknown');
  return note.unsent > 0 ? t('note_unsent', { count: note.unsent }) : t('note');
}

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
    if (note) toast.warning(wipeNoteText(note, tRef.current), { duration: 0 });
  }, [signedIn]);

  return null;
}
