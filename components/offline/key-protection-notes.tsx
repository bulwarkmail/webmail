'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { useOfflineStore } from '@/lib/offline/state';

/**
 * What protects the key to the mail on this device, where that's less than one would think, and
 * how a re-encryption is getting on. `browser`: also says what a browser can't do. The app lock's
 * own settings have said that already.
 */
export function KeyProtectionNotes({ browser = false }: { browser?: boolean }) {
  const t = useTranslations('keyProtection');
  const keyUnprotected = useOfflineStore((state) => state.keyUnprotected);
  const rekey = useOfflineStore((state) => state.rekey);
  const [bridge, setBridge] = useState<'none' | 'wraps' | 'obfuscates'>('wraps');

  useEffect(() => {
    const member = getDesktopBridge()?.appLock;
    if (!member) {
      setBridge('none');
      return;
    }
    let live = true;
    void member.status().then((status) => {
      if (live) setBridge(status.wrap ? 'wraps' : 'obfuscates');
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const states = Object.values(rekey);
  const running = states.filter((state): state is number => typeof state === 'number');
  const lines = [
    bridge === 'obfuscates' ? t('no_secure_storage') : null,
    bridge === 'none' && browser ? t('browser_note') : null,
    keyUnprotected ? t('wrap_failed') : null,
    states.includes('failed') ? t('rekey_failed') : null,
    running.length > 0 ? t('rekey_progress', { percent: Math.min(...running) }) : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground" data-testid="key-protection-notes">
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}
