'use client';

import { useMemo } from 'react';
import { useDevicePolicy, useStrictestDevices } from '@/hooks/use-device-policy';
import { watermarkAddress, watermarkText, type DeviceSubject } from '@/lib/device-policy';
import { WATERMARK_COLUMNS, WATERMARK_CSS, WATERMARK_ROWS } from '@/lib/watermark';
import { useAuthStore } from '@/stores/auth-store';
import { useLocaleStore } from '@/stores/locale-store';
import { useEmailStore } from '@/stores/email-store';

type HookSubject = Exclude<DeviceSubject, { client: object }>;

/**
 * The watermark text for a message or file of this account ("user@example.org
 * · 1 Nov 2026"), or null when its device policy has no watermark. Without a
 * subject: the strictest of the signed-in accounts, with the active
 * account's address.
 */
export function useWatermarkText(subject?: HookSubject, options: { strictest?: boolean } = {}): string | null {
  const own = useDevicePolicy(subject);
  const strictest = useStrictestDevices();
  const locale = useLocaleStore((s) => s.locale) || undefined;
  const username = useAuthStore((s) => s.username);
  const viewing = useEmailStore((s) => s.viewingAccountId);
  const on = options.strictest ? strictest.watermark : own.watermark;
  return useMemo(
    () => (on ? watermarkText(watermarkAddress(subject) || username || '', new Date(), locale) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [on, locale, username, viewing, typeof subject === 'string' ? subject : subject?.sourceClientAccountId],
  );
}

/**
 * The watermark layer over a reader or preview: its parent needs
 * `position: relative`. Hidden from screen readers and from the pointer.
 */
export function Watermark({ text, fixed = false }: { text: string | null; fixed?: boolean }) {
  if (!text) return null;
  return (
    <>
      <style>{WATERMARK_CSS}</style>
      <div className="bulwark-watermark" aria-hidden="true" data-testid="watermark" data-fixed={fixed ? '' : undefined}>
        {Array.from({ length: WATERMARK_ROWS * WATERMARK_COLUMNS }, (_, i) => <span key={i}>{text}</span>)}
      </div>
    </>
  );
}
