'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { BadgeCheck } from '@/components/icons';
import { cn } from '@/lib/utils';
import { IS_LITE } from '@/lib/lite';
import { withBasePath } from '@/lib/browser-navigation';
import { senderFaviconsAllowed } from '@/lib/outgoing-hosts';
import { useNoThirdPartyTraffic } from '@/hooks/use-third-party-mode';
import { useSettingsStore } from '@/stores/settings-store';
import type { BimiInfo } from '@/lib/bimi/types';

// One request per domain and tab; the answer is the same for every message.
const infoByDomain = new Map<string, Promise<BimiInfo>>();

function fetchInfo(domain: string): Promise<BimiInfo> {
  let pending = infoByDomain.get(domain);
  if (!pending) {
    pending = fetch(withBasePath(`/api/bimi?domain=${encodeURIComponent(domain)}&format=json`))
      .then((response) => (response.ok ? (response.json() as Promise<BimiInfo>) : { status: 'none' as const }))
      .catch(() => {
        infoByDomain.delete(domain);
        return { status: 'none' as const };
      });
    infoByDomain.set(domain, pending);
  }
  return pending;
}

/**
 * A check mark beside the sender's name when a Verified Mark or Common Mark
 * Certificate backs the domain's BIMI logo. A logo the sender only published
 * in DNS gets none: anyone can do that for a lookalike domain.
 *
 * `domain` comes from brandIndicatorDomain (the message passed DMARC for it).
 * A tap opens a line naming who the logo is verified for and by whom. That
 * line floats on the page, because the badge sits inside the sender line,
 * which clips anything below its one row.
 */
export function BrandVerifiedBadge({ domain, className }: { domain?: string; className?: string }) {
  const t = useTranslations('email_viewer.brand_logo');
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  useNoThirdPartyTraffic();
  const enabled = !!domain && !IS_LITE && senderFavicons && senderFaviconsAllowed();
  const [info, setInfo] = useState<{ domain: string; info: BimiInfo } | null>(null);
  // Where the open line goes, from the badge's place on screen; null is closed.
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const open = placement !== null;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  const close = () => setPlacement(null);
  const toggle = () => {
    if (open) return close();
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rtl = !!wrapRef.current && getComputedStyle(wrapRef.current).direction === 'rtl';
    const room = rtl ? rect.right - 8 : window.innerWidth - rect.left - 8;
    setPlacement({
      top: rect.bottom + 4,
      ...(rtl ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      maxWidth: `min(16rem, ${Math.max(room, 160)}px)`,
    });
  };

  useEffect(() => {
    if (!enabled || !domain) return;
    let cancelled = false;
    void fetchInfo(domain).then((result) => {
      if (!cancelled) setInfo({ domain, info: result });
    });
    return () => { cancelled = true; };
  }, [enabled, domain]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: Event) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setPlacement(null);
    };
    // The line is pinned to where the badge was, so it goes when the page moves.
    const closeNow = () => setPlacement(null);
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('scroll', closeNow, true);
    window.addEventListener('resize', closeNow);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('scroll', closeNow, true);
      window.removeEventListener('resize', closeNow);
    };
  }, [open]);

  const current = enabled && info?.domain === domain ? info.info : null;
  if (!current || current.status !== 'verified') return null;

  const organization = current.organization || domain!;
  const description = current.issuer
    ? t('verified_by', { organization, issuer: current.issuer })
    : t('verified', { organization });

  return (
    <span ref={wrapRef} className={cn('inline-flex flex-shrink-0', className)}>
      <button
        type="button"
        data-brand-verified=""
        title={description}
        aria-label={`${t('verified_label')}: ${description}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            close();
          }
        }}
        className="inline-flex items-center rounded-full text-primary hover:opacity-80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <BadgeCheck className="h-4 w-4" aria-hidden="true" />
      </button>
      {placement && createPortal(
        <span
          ref={popoverRef}
          id={popoverId}
          role="status"
          data-brand-verified-popover=""
          // React passes clicks up through the portal to the header, which
          // would fold the message.
          onClick={(e) => e.stopPropagation()}
          style={placement}
          className="fixed z-50 w-max whitespace-normal rounded-md border border-border bg-popover px-2.5 py-1.5 text-start text-xs font-normal text-popover-foreground shadow-md"
        >
          {description}
        </span>,
        document.body,
      )}
    </span>
  );
}
