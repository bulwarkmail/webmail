'use client';

import { useTranslations } from 'next-intl';
import { Mail, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Email, Identity } from '@/lib/jmap/types';
import { parseSubAddress } from '@/lib/sub-addressing';
import { useSettingsStore } from '@/stores/settings-store';

interface EmailIdentityBadgeProps {
  email: Email;
  identities: Identity[];
  compact?: boolean;
  className?: string;
}

export function EmailIdentityBadge({
  email,
  identities,
  compact = false,
  className,
}: EmailIdentityBadgeProps) {
  const t = useTranslations('identities.badge');
  const subAddressDelimiter = useSettingsStore((state) => state.subAddressDelimiter);

  const fromAddress = email.from?.[0]?.email;
  if (!fromAddress) return null;

  // Parse the from address to check for sub-addressing
  const parsedFrom = parseSubAddress(fromAddress, subAddressDelimiter);

  // Find matching identity (email sent BY the user)
  const matchingIdentity = identities.find(
    (identity) => identity.email === fromAddress || identity.email === `${parsedFrom.baseUser}@${parsedFrom.domain}`
  );

  // Check if email was sent TO a sub-address (received email)
  let receivedToTag: string | null = null;
  if (!matchingIdentity) {
    // Check all TO addresses for sub-address tags matching user's identities
    for (const recipient of email.to || []) {
      const parsedTo = parseSubAddress(recipient.email, subAddressDelimiter);
      if (parsedTo.tag) {
        // Check if this base email matches any of the user's identities
        const matchingToIdentity = identities.find(
          (identity) => identity.email === `${parsedTo.baseUser}@${parsedTo.domain}`
        );
        if (matchingToIdentity) {
          receivedToTag = parsedTo.tag;
          break;
        }
      }
    }
  }

  // Determine which tag to display (sent or received)
  const displayTag = matchingIdentity ? parsedFrom.tag : receivedToTag;

  // Don't show badge if not from user's identity and not to user's sub-address
  if (!matchingIdentity && !receivedToTag) return null;

  if (compact) {
    // Compact view for email list
    if (displayTag) {
      return (
        <div
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
            'bg-primary/10 text-primary',
            className
          )}
          title={t('sub_address_tag', { tag: displayTag })}
        >
          <Tag className="w-3 h-3" />
          <span className="font-mono">{subAddressDelimiter}{displayTag}</span>
        </div>
      );
    }

    if (
      matchingIdentity &&
      matchingIdentity.name &&
      matchingIdentity.name !== matchingIdentity.email &&
      matchingIdentity.name !== fromAddress
    ) {
      return (
        <div
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
            'bg-secondary text-muted-foreground',
            className
          )}
          title={t('identity_name', { name: matchingIdentity.name })}
        >
          <Mail className="w-3 h-3" />
          <span className="truncate max-w-[100px]">{matchingIdentity.name}</span>
        </div>
      );
    }

    return null;
  }

  // Full view for email viewer - now shows compact badges only
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      {/* Sub-address tag badge */}
      {displayTag && (
        <div
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md',
            'bg-primary/10 text-primary border border-primary/20',
            'text-xs font-semibold'
          )}
          title={t('sub_address_tag', { tag: displayTag })}
          aria-label={t('sub_address_tag', { tag: displayTag })}
        >
          <Tag className="w-3 h-3" />
          <span className="font-mono">{subAddressDelimiter}{displayTag}</span>
        </div>
      )}

      {/* Identity badge (only if identity has a name and no sub-address tag) */}
      {!displayTag &&
        matchingIdentity &&
        matchingIdentity.name &&
        matchingIdentity.name !== matchingIdentity.email &&
        matchingIdentity.name !== fromAddress && (
          <div
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-md',
              'bg-secondary text-muted-foreground border border-border',
              'text-xs font-medium'
            )}
            title={t('identity_name', { name: matchingIdentity.name })}
            aria-label={t('identity_name', { name: matchingIdentity.name })}
          >
            <Mail className="w-3 h-3" />
            <span>{t('identity_short', { name: matchingIdentity.name })}</span>
          </div>
        )}
    </div>
  );
}
