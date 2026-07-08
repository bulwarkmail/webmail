'use client';

import { useState, useRef, useEffect } from 'react';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { isValidUnsubscribeUrl, parseMailtoUrl } from '@/lib/validation';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useIsDesktop } from '@/hooks/use-media-query';

interface UnsubscribeBannerProps {
  listUnsubscribe: {
    http?: string;
    mailto?: string;
    preferred?: 'http' | 'mailto';
  };
  senderEmail: string;
  // Sends the unsubscribe message through the app's own account. This is a
  // webmail client - handing a mailto: URL to the OS mail handler goes
  // nowhere for most users.
  onSendMailtoUnsubscribe: (fields: { to: string[]; subject?: string; body?: string }) => Promise<void>;
  onDismiss: () => void;
}

export function UnsubscribeBanner({
  listUnsubscribe,
  senderEmail: _senderEmail,
  onSendMailtoUnsubscribe,
  onDismiss
}: UnsubscribeBannerProps) {
  const t = useTranslations();
  const [showConfirm, setShowConfirm] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isDesktop = useIsDesktop();

  const unsubMethod = listUnsubscribe.preferred;
  const unsubUrl = unsubMethod === 'http'
    ? listUnsubscribe.http
    : listUnsubscribe.mailto;

  useEffect(() => {
    if (!showConfirm) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowConfirm(false);
      }
    };
    // Use setTimeout to avoid the opening click triggering immediate close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showConfirm]);

  if (!unsubUrl || !unsubMethod) {
    return null;
  }

  const handleUnsubscribe = async () => {
    if (!isValidUnsubscribeUrl(unsubUrl)) {
      setError(true);
      setProcessing(false);
      setShowConfirm(false);
      return;
    }

    setProcessing(true);

    try {
      if (unsubMethod === 'http') {
        window.open(unsubUrl, '_blank', 'noopener,noreferrer');
        setSuccess(true);
        setProcessing(false);
        setShowConfirm(false);
        setTimeout(onDismiss, 3000);
      } else {
        // Send the unsubscribe message ourselves and only report success
        // once the server accepted it. The previous hidden-link click handed
        // the mailto: to the OS mail handler and claimed success even though
        // nothing was ever sent.
        const fields = parseMailtoUrl(unsubUrl);
        if (!fields) {
          setError(true);
          setProcessing(false);
          setShowConfirm(false);
          return;
        }
        await onSendMailtoUnsubscribe(fields);

        setSuccess(true);
        setProcessing(false);
        setShowConfirm(false);
        setTimeout(onDismiss, 3000);
      }
    } catch (err) {
      console.error('Unsubscribe error:', err);
      setError(true);
      setProcessing(false);
      setShowConfirm(false);
    }
  };

  if (success) {
    return (
      <span className="inline-flex items-center gap-1 ms-1">
        <CheckCircle className="w-3 h-3 text-green-600 dark:text-green-400" />
        <span className="text-xs text-green-600 dark:text-green-400">
          {t(unsubMethod === 'http'
            ? 'email_viewer.unsubscribe_banner.success_http'
            : 'email_viewer.unsubscribe_banner.success_mailto'
          )}
        </span>
      </span>
    );
  }

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 ms-1">
        <AlertCircle className="w-3 h-3 text-red-500 dark:text-red-400" />
        <button
          onClick={onDismiss}
          className="text-xs text-red-500 dark:text-red-400 hover:underline bg-transparent p-0 min-h-0"
        >
          {t('email_viewer.unsubscribe_banner.error')}
        </button>
      </span>
    );
  }

  return (
    <>
      <span className="relative inline-flex items-center">
        <span className="text-muted-foreground/40 mx-1">·</span>
        <button
          onClick={() => setShowConfirm(true)}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline bg-transparent p-0 min-h-0 leading-normal"
        >
          {t('email_viewer.unsubscribe_banner.button')}
        </button>
        {/* Desktop popover */}
        {showConfirm && isDesktop && (
          <div
            ref={popoverRef}
            className="absolute top-full left-0 mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-3 min-w-[220px]"
          >
            <p className="text-sm text-foreground mb-2">
              {t('email_viewer.unsubscribe_banner.confirm_title')}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleUnsubscribe}
                disabled={processing}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {processing && <Loader2 className="w-3 h-3 animate-spin" />}
                {t('email_viewer.unsubscribe_banner.confirm_button')}
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="text-xs px-3 py-1.5 rounded-md text-muted-foreground hover:bg-muted transition-colors"
              >
                {t('email_viewer.unsubscribe_banner.cancel')}
              </button>
            </div>
          </div>
        )}
      </span>
      {/* Mobile/tablet: proper confirm dialog */}
      {!isDesktop && (
        <ConfirmDialog
          isOpen={showConfirm}
          onClose={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            handleUnsubscribe();
          }}
          title={t('email_viewer.unsubscribe_banner.confirm_title')}
          message={t(unsubMethod === 'http'
            ? 'email_viewer.unsubscribe_banner.confirm_message_http'
            : 'email_viewer.unsubscribe_banner.confirm_message_mailto'
          )}
          confirmText={t('email_viewer.unsubscribe_banner.confirm_button')}
          cancelText={t('email_viewer.unsubscribe_banner.cancel')}
          variant="destructive"
        />
      )}
    </>
  );
}
