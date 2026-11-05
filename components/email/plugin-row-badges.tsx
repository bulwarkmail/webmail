"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Email } from "@/lib/jmap/types";
import type { EmailListBadge } from "@/lib/plugin-types";
import { renderHooks } from "@/lib/plugin-hooks";
import { emailSummary } from "@/lib/plugin-projection";
import { rowBadgeGeneration, subscribeRowBadges } from "@/lib/plugin-sandbox/row-badges";
import { PLUGIN_ICON_RE } from "@/lib/plugin-sandbox/actions";
import { cn } from "@/lib/utils";
import { iconForName } from "@/components/icons";
import { TAG_GROUP_CLASS, TAG_LOZENGE_CLASS } from "./tag-badge";

// Badges plugins add to a message-list row through onEmailListItemRender.
//
// The hook is async and would otherwise run for every row on every render, so
// the answer is kept per message and keyword state: scrolling a row back into
// view, or re-rendering the list, reuses it. A keyword change (read, flagged,
// a tag) asks again, since that is what most badges are about.

/** At most this many plugin badges per row; the row has little room. */
export const MAX_ROW_BADGES = 3;
const MAX_LABEL_LENGTH = 32;
const MAX_TITLE_LENGTH = 200;
const CACHE_LIMIT = 2000;

const cache = new Map<string, EmailListBadge[]>();
const inflight = new Map<string, Promise<EmailListBadge[]>>();

function cacheKey(email: Email, listeners: number, generation: number): string {
  const keywords = Object.keys(email.keywords ?? {})
    .filter((k) => email.keywords?.[k])
    .sort()
    .join(",");
  // The listener count is part of the key so a plugin being switched on or
  // off doesn't leave the old answer behind.
  // The generation moves on when a plugin asks for a refresh.
  return `${generation}|${listeners}|${email.id}|${keywords}`;
}

// A colour the badge may use: hex, rgb()/hsl() with plain numbers, a CSS
// variable or a colour name. Anything else (url(), expressions, several
// declarations) is dropped and the badge keeps the theme colours.
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)|var\(--[a-z0-9-]+\)|[a-z]{3,30})$/i;

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, "").trim().slice(0, max) : "";
}

/** Keep only well-formed badges, as plain text, capped at MAX_ROW_BADGES. A
 * badge needs a label, or an icon and a key (an icon-only badge, read out by
 * its title). */
export function normalizeBadges(raw: unknown): EmailListBadge[] {
  if (!Array.isArray(raw)) return [];
  const out: EmailListBadge[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_ROW_BADGES) break;
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const label = cleanText(candidate.label, MAX_LABEL_LENGTH);
    const iconName = cleanText(candidate.icon, 40);
    const icon = iconName && PLUGIN_ICON_RE.test(iconName) ? iconName : "";
    const key = cleanText(candidate.key, 100) || label;
    if (!key || (!label && !icon)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const badge: EmailListBadge = { key, label };
    const color = cleanText(candidate.color, 60);
    if (color && SAFE_COLOR.test(color)) badge.color = color;
    const title = cleanText(candidate.title, MAX_TITLE_LENGTH);
    if (title) badge.title = title;
    if (icon) badge.icon = icon;
    out.push(badge);
  }
  return out;
}

function remember(key: string, badges: EmailListBadge[]): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, badges);
}

function resolveBadges(email: Email, key: string): Promise<EmailListBadge[]> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = renderHooks.onEmailListItemRender.transform<EmailListBadge[]>([], { email: emailSummary(email) })
    .then(normalizeBadges, () => [])
    .then((badges) => {
      remember(key, badges);
      return badges;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Forget every cached answer (tests). */
export function clearRowBadgeCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The plugin badges for a row: none at first, then whatever the plugins
 * returned. Without any onEmailListItemRender handler this does nothing.
 */
export function usePluginRowBadges(email: Email): EmailListBadge[] {
  const listeners = renderHooks.onEmailListItemRender.size;
  const generation = useSyncExternalStore(subscribeRowBadges, rowBadgeGeneration, rowBadgeGeneration);
  const key = listeners > 0 ? cacheKey(email, listeners, generation) : null;
  const [state, setState] = useState<{ key: string | null; badges: EmailListBadge[] }>(() => ({
    key,
    badges: key ? cache.get(key) ?? [] : [],
  }));

  useEffect(() => {
    if (!key) return;
    const cached = cache.get(key);
    if (cached) {
      setState((prev) => (prev.key === key && prev.badges === cached ? prev : { key, badges: cached }));
      return;
    }
    let cancelled = false;
    void resolveBadges(email, key).then((badges) => {
      if (!cancelled) setState({ key, badges });
    });
    return () => { cancelled = true; };
    // `key` covers the parts of the email the answer depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return [];
  // While a new answer is on its way, show the cached one for this key, if
  // any, rather than the previous key's badges.
  return state.key === key ? state.badges : cache.get(key) ?? [];
}

/** Plugin badges next to a row's subject. Renders nothing when there are none. */
export function PluginRowBadges({ email, className }: { email: Email; className?: string }) {
  const badges = usePluginRowBadges(email);
  if (badges.length === 0) return null;
  return (
    <span className={cn(TAG_GROUP_CLASS, className)} data-testid="plugin-row-badges">
      {badges.map((badge) => {
        const Icon = iconForName(badge.icon);
        // An icon-only badge is read out by its title.
        const iconOnly = !badge.label && !!Icon;
        return (
          <span
            key={badge.key}
            title={badge.title}
            role={iconOnly ? "img" : undefined}
            aria-label={iconOnly ? badge.title || badge.key : undefined}
            data-plugin-row-badge={badge.key}
            className={cn(
              TAG_LOZENGE_CLASS,
              "max-w-[8rem] truncate border",
              Icon && "gap-0.5",
              !badge.color && "border-border bg-muted text-muted-foreground",
            )}
            style={badge.color ? {
              color: badge.color,
              borderColor: badge.color,
              backgroundColor: `color-mix(in srgb, ${badge.color} 12%, transparent)`,
            } : undefined}
          >
            {Icon && <Icon className="w-3 h-3 flex-shrink-0" aria-hidden data-badge-icon={badge.icon} />}
            {Icon ? (badge.label ? <span className="truncate">{badge.label}</span> : null) : badge.label}
          </span>
        );
      })}
    </span>
  );
}
