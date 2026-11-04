'use client';

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { popoverShift } from '@/lib/popover-shift';
import { useTranslations } from 'next-intl';
import { Plus, Tag, X } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import {
  generateSubAddress,
  extractDomain,
  suggestTagsForDomain,
  getTagValidationError,
  MAX_TAG_LENGTH,
} from '@/lib/sub-addressing';

interface SubAddressHelperProps {
  baseEmail: string;
  recipientEmails: string[];
  onSelectTag: (tag: string) => void;
  disabled?: boolean;
  /** Opened from elsewhere (the composer's From list) instead of its own button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** No button of its own: the host opens it. */
  hideTrigger?: boolean;
}

export function SubAddressHelper({
  baseEmail,
  recipientEmails,
  onSelectTag,
  disabled = false,
  open,
  onOpenChange,
  hideTrigger = false,
}: SubAddressHelperProps) {
  const t = useTranslations('identities.sub_address');
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const setIsOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { subAddress, addRecentTag, addTagSuggestion } = useIdentityStore();
  const subAddressDelimiter = useSettingsStore((state) => state.subAddressDelimiter);

  // Get suggestions based on recipient (memoized for performance)
  const suggestions = useMemo(() => {
    return recipientEmails
      .map(extractDomain)
      .filter(Boolean)
      .flatMap((domain) => suggestTagsForDomain(domain!))
      .filter((tag, index, self) => self.indexOf(tag) === index)
      .slice(0, 5);
  }, [recipientEmails]);

  // Generate preview
  const preview = tag ? generateSubAddress(baseEmail, tag, subAddressDelimiter) : baseEmail;

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Anchored to its button, it would run off the left of a phone's screen.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!isOpen || !el) return;
    const shift = popoverShift(el.getBoundingClientRect(), { left: 0, right: window.innerWidth });
    el.style.translate = shift !== 0 ? `${shift}px` : '';
  }, [isOpen]);

  const handleTagChange = (value: string) => {
    setTag(value);
    const errorCode = getTagValidationError(value);

    // Translate error code to localized message
    let errorMessage: string | null = null;
    if (errorCode === 'EMPTY') {
      errorMessage = t('validation.empty');
    } else if (errorCode === 'TOO_LONG') {
      errorMessage = t('validation.too_long', { max: MAX_TAG_LENGTH });
    } else if (errorCode === 'INVALID_CHARS') {
      errorMessage = t('validation.invalid_chars');
    }

    setError(errorMessage);
  };

  const handleSelectTag = (selectedTag: string) => {
    const errorCode = getTagValidationError(selectedTag);
    if (errorCode) {
      // Translate error code to localized message
      let errorMessage: string | null = null;
      if (errorCode === 'EMPTY') {
        errorMessage = t('validation.empty');
      } else if (errorCode === 'TOO_LONG') {
        errorMessage = t('validation.too_long', { max: MAX_TAG_LENGTH });
      } else if (errorCode === 'INVALID_CHARS') {
        errorMessage = t('validation.invalid_chars');
      }
      setError(errorMessage);
      return;
    }

    // Add to recent tags and suggestions
    addRecentTag(selectedTag);
    const domain = recipientEmails.map(extractDomain).find(Boolean);
    if (domain) {
      addTagSuggestion(domain, selectedTag);
    }

    onSelectTag(selectedTag);
    setIsOpen(false);
    setTag('');
    setError(null);
  };

  const handleUseAddress = () => {
    if (!tag) return;
    handleSelectTag(tag);
  };

  return (
    <div className="relative">
      {/* Trigger Button */}
      {!hideTrigger && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled}
          title={t('button_tooltip')}
          className="h-8 px-2"
        >
          <Plus className="w-4 h-4 me-1" />
          <Tag className="w-4 h-4" />
        </Button>
      )}

      {/* Popover */}
      {isOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('popover_title')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setIsOpen(false);
            }
          }}
          className={cn(
            'absolute top-full end-0 mt-1 z-50',
            'bg-background border border-border rounded-lg shadow-lg',
            'w-80 max-w-[calc(100vw-1rem)] p-4 animate-in fade-in zoom-in-95 duration-150'
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              {t('popover_title')}
            </h3>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tag Input */}
          <div className="mb-3">
            <Input
              type="text"
              value={tag}
              onChange={(e) => handleTagChange(e.target.value)}
              placeholder={t('tag_input_placeholder')}
              className={cn(error && 'border-destructive')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tag && !error) {
                  e.preventDefault();
                  handleUseAddress();
                }
              }}
            />
            {error && (
              <p className="text-xs text-destructive mt-1">{error}</p>
            )}
          </div>

          {/* Preview */}
          <div className="mb-3 p-2 bg-muted rounded text-sm">
            <div className="text-xs text-muted-foreground mb-1">
              {t('preview_label')}
            </div>
            <div className="font-mono text-foreground break-all">
              {preview}
            </div>
          </div>

          {/* Recent Tags */}
          {subAddress.recentTags.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-muted-foreground mb-2">
                {t('recent_tags')}
              </div>
              <div className="flex flex-wrap gap-1">
                {subAddress.recentTags.slice(0, 5).map((recentTag) => (
                  <button
                    key={recentTag}
                    onClick={() => handleSelectTag(recentTag)}
                    className="px-2 py-1 text-xs rounded bg-secondary hover:bg-accent text-foreground transition-colors"
                  >
                    {recentTag}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Suggested Tags */}
          {suggestions.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-muted-foreground mb-2">
                {t('suggested_tags')}
              </div>
              <div className="flex flex-wrap gap-1">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => handleSelectTag(suggestion)}
                    className="px-2 py-1 text-xs rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Help Text */}
          <div className="mb-3 text-xs text-muted-foreground">
            {t('help_text', { delimiter: subAddressDelimiter })}
          </div>

          {/* Use Address Button */}
          <Button
            onClick={handleUseAddress}
            disabled={!tag || !!error}
            className="w-full"
            size="sm"
          >
            {t('use_address')}
          </Button>
        </div>
      )}
    </div>
  );
}
