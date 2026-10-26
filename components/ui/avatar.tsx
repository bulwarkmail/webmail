"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore, getContactPhotoUri } from "@/stores/contact-store";
import { useConfig } from "@/hooks/use-config";
import { avatarHooks } from "@/lib/plugin-hooks";
import { withBasePath } from "@/lib/browser-navigation";
import { IS_LITE } from "@/lib/lite";
import { useFaviconRefreshStore, failedFaviconDomains } from "@/stores/favicon-refresh-store";
import { useXenaxioAvatar } from "@/lib/xenaxio/avatars";

const IS_DEV = process.env.NODE_ENV !== "production";

// Known multi-part TLDs where the "main" domain includes one extra label.
// e.g. "newsletter.example.co.uk" → "example.co.uk", not "co.uk".
const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr", "ac.kr",
  "co.in", "net.in", "org.in", "ac.in", "gov.in",
  "co.nz", "org.nz", "net.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "gov.za", "ac.za",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.br", "net.br", "org.br", "edu.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.mx", "net.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "net.ar", "org.ar", "gob.ar", "edu.ar",
  "com.tw", "net.tw", "org.tw", "edu.tw", "gov.tw",
  "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk",
  "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg",
  "com.my", "net.my", "org.my", "edu.my", "gov.my",
  "com.ph", "net.ph", "org.ph", "edu.ph", "gov.ph",
  "com.pk", "net.pk", "org.pk", "edu.pk", "gov.pk",
  "com.ng", "net.ng", "org.ng", "edu.ng", "gov.ng",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "co.th", "or.th", "ac.th", "go.th", "in.th",
  "co.id", "or.id", "ac.id", "go.id", "web.id",
  "com.tr", "net.tr", "org.tr", "edu.tr", "gov.tr",
  "com.ua", "net.ua", "org.ua", "edu.ua", "gov.ua",
  "com.eg", "net.eg", "org.eg", "edu.eg", "gov.eg",
  "com.sa", "net.sa", "org.sa", "edu.sa", "gov.sa",
  "co.ke", "or.ke", "ac.ke", "go.ke", "ne.ke",
]);

/**
 * Extract the root/registrable domain from a full domain.
 * e.g. "newsletter.example.com" → "example.com"
 *      "mail.shop.example.co.uk" → "example.co.uk"
 *      "example.com" → "example.com"
 */
function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;

  // Check if the last two parts form a known multi-part TLD
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) {
    // Need at least 3 parts for a valid domain under a multi-part TLD
    return parts.length >= 3 ? parts.slice(-3).join(".") : domain;
  }

  // Standard TLD: take last two parts
  return parts.slice(-2).join(".");
}

// Personal email domains where the favicon is the mail provider logo, not the sender
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.fr", "yahoo.co.uk", "yahoo.co.jp",
  "aol.com", "icloud.com", "me.com", "mac.com", "mail.com",
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.com",
  "zoho.com", "yandex.com", "yandex.ru", "gmx.com", "gmx.net",
  "fastmail.com", "hey.com", "posteo.de", "mailbox.org",
  "example.com", "example.org",
]);

// Deterministic hash for an email string
function emailHash(email: string): number {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

// Dev-only: common first names to infer gender for demo portrait selection
const FEMALE_NAMES: Set<string> = IS_DEV ? new Set([
  "alice", "emily", "sarah", "priya", "carol", "anna", "maria", "emma", "olivia",
  "sophia", "isabella", "mia", "charlotte", "amelia", "harper", "ella", "grace",
  "chloe", "luna", "lily", "zoey", "hannah", "nora", "riley", "elena", "maya",
  "claire", "victoria", "natalie", "rachel", "jessica", "jennifer", "lisa",
  "karen", "nancy", "betty", "sandra", "ashley", "margaret", "dorothy",
  "julia", "laura", "susan", "andrea", "diana", "marie", "sophie",
]) : new Set();

const MALE_NAMES: Set<string> = IS_DEV ? new Set([
  "bob", "marcus", "alex", "david", "james", "john", "robert", "michael",
  "william", "richard", "joseph", "thomas", "charles", "daniel", "matthew",
  "anthony", "mark", "steven", "paul", "andrew", "kevin", "brian", "george",
  "timothy", "jason", "ryan", "jacob", "gary", "eric", "peter", "frank",
  "samuel", "benjamin", "henry", "patrick", "jack", "noah", "liam", "oliver",
  "lucas", "ethan", "mason", "logan", "leo", "max", "oscar", "hugo",
]) : new Set();

function inferGender(name: string | undefined, hash: number): "women" | "men" {
  if (name) {
    const firstName = name.trim().split(/\s+/)[0].toLowerCase();
    if (FEMALE_NAMES.has(firstName)) return "women";
    if (MALE_NAMES.has(firstName)) return "men";
  }
  return hash % 2 === 0 ? "women" : "men";
}

// Dev-only: custom avatar URLs for specific demo senders
const CUSTOM_AVATARS: Record<string, string> = IS_DEV ? {
  "newsletter@launchweekly.com": "https://img.freepik.com/premium-vector/swoosh-letter-lw-logo-design-business-company-identity-water-wave-lw-logo-with-modern-trendy_754537-799.jpg?w=360",
  "hello@launchpad.example": "https://img.freepik.com/premium-vector/swoosh-letter-lw-logo-design-business-company-identity-water-wave-lw-logo-with-modern-trendy_754537-799.jpg?w=360",
  "news@techdigest.example": "https://img.freepik.com/premium-vector/technology-letter-t-logo-design-template_125964-1249.jpg?w=360",
  "alice@example.com": "https://randomuser.me/api/portraits/thumb/women/44.jpg",
  "bob@example.org": "https://randomuser.me/api/portraits/thumb/men/32.jpg",
  "carol@example.com": "https://randomuser.me/api/portraits/thumb/women/68.jpg",
} : {};

// Mock-server-only: for personal-domain emails, deterministically pick a randomuser.me portrait.
// Returns null for ~30% of addresses so not everyone has a photo.
function getProfilePictureUrl(email: string, domain: string, devMode: boolean, name?: string): string | null {
  if (!devMode) return null;
  if (!PERSONAL_DOMAINS.has(domain)) return null;
  const h = emailHash(email);
  if (h % 10 < 3) return null; // ~30% get no photo
  const gender = inferGender(name, h);
  const id = h % 100;
  return `https://randomuser.me/api/portraits/thumb/${gender}/${id}.jpg`;
}

interface AvatarProps {
  name?: string;
  email?: string;
  contactPhotoUri?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** When true, suppress all image sources (favicons, plugin avatars, profile pics, contact photos) and render initials only. */
  disableImages?: boolean;
  /** When true, do not fall through to the sender's domain favicon. Use for the user's own account avatar where the mail-provider logo is not meaningful. */
  disableFavicon?: boolean;
  /** Background color used when no image source resolves. Overrides the hash-based default. */
  fallbackColor?: string;
}

export function Avatar({ name, email, contactPhotoUri, size = "md", className, disableImages = false, disableFavicon = false, fallbackColor }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [pluginAvatarUrl, setPluginAvatarUrl] = useState<string | null>(null);
  const [pluginAvatarFailed, setPluginAvatarFailed] = useState(false);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const faviconRefreshedAt = useFaviconRefreshStore((s) => s.refreshedAt);
  const contacts = useContactStore((s) => s.contacts);
  const { devMode } = useConfig();
  // xenaxio (step 39): the picture a colleague set for this address in the company.
  const xenaxioAvatar = useXenaxioAvatar(email);

  // Ask plugins (e.g. Gravatar) to resolve an avatar URL for this email address.
  // Runs whenever email or name changes; resets plugin avatar state on each change.
  useEffect(() => {
    setPluginAvatarUrl(null);
    setPluginAvatarFailed(false);
    if (!email || avatarHooks.onAvatarResolve.size === 0) return;
    let cancelled = false;
    avatarHooks.onAvatarResolve.transform(null as string | null, { email, name })
      .then((url) => { if (!cancelled) setPluginAvatarUrl(url); })
      .catch(() => { if (!cancelled) setPluginAvatarFailed(true); });
    return () => { cancelled = true; };
  }, [email, name]);

  // A refresh of the sender icons gives a failed favicon another chance.
  useEffect(() => {
    setImgError(false);
  }, [faviconRefreshedAt]);

  // Look up contact photo by email from the contact store
  const resolvedContactPhoto = useMemo(() => {
    if (contactPhotoUri) return contactPhotoUri;
    if (!email) return undefined;
    const lowerEmail = email.toLowerCase();
    for (const contact of contacts) {
      if (!contact.emails) continue;
      for (const e of Object.values(contact.emails)) {
        if (e.address.toLowerCase() === lowerEmail) {
          return getContactPhotoUri(contact);
        }
      }
    }
    return undefined;
  }, [contactPhotoUri, email, contacts]);

  const domain = email?.split("@")[1]?.toLowerCase();
  // Use root domain for favicon lookups (e.g. newsletter.example.com → example.com)
  const faviconDomain = domain ? getRootDomain(domain) : undefined;
  const domainFailed = faviconDomain ? failedFaviconDomains.has(faviconDomain) : false;

  const getInitials = () => {
    if (name) {
      const parts = name
        .trim()
        .split(/\s+/)
        .map((p) => p.replace(/^[^\p{L}\p{N}]+/u, ""))
        .filter((p) => p.length > 0);
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
      }
      if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email[0].toUpperCase();
    }
    return "?";
  };

  const getBackgroundColor = () => {
    const str = name || email || "";
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  };

  const sizeClasses = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-12 h-12 text-base",
  };

  const profilePic = email && domain ? getProfilePictureUrl(email, domain, devMode, name) : null;
  // Sender favicons come from the /api/favicon proxy, absent in the static build.
  const showFavicon =
    !IS_LITE && !disableFavicon && senderFavicons && faviconDomain && !PERSONAL_DOMAINS.has(faviconDomain) && !imgError && !domainFailed;

  // Priority: contact photo > plugin avatar (e.g. Gravatar) > custom avatar > profile picture > company favicon > initials
  const customAvatar = devMode && email ? CUSTOM_AVATARS[email.toLowerCase()] : null;
  const pluginAvatar = pluginAvatarFailed ? null : pluginAvatarUrl;
  const companyPhoto = imgError ? null : xenaxioAvatar;
  const photoSrc = companyPhoto || resolvedContactPhoto || pluginAvatar || customAvatar || profilePic || null;
  const faviconSrc = !imgError && !domainFailed && showFavicon ? withBasePath(`/api/favicon?domain=${encodeURIComponent(faviconDomain!)}${faviconRefreshedAt ? `&v=${faviconRefreshedAt}` : ""}`) : null;
  const imgSrc = disableImages ? null : (photoSrc || faviconSrc);
  const isFavicon = imgSrc !== null && imgSrc === faviconSrc;

  const handleImgError = useCallback(() => {
    // If the plugin avatar just failed, mark it and fall through to the next source
    if (pluginAvatar && imgSrc === pluginAvatar) {
      setPluginAvatarFailed(true);
      return;
    }
    setImgError(true);
    // If this was a favicon URL (not a contact photo, plugin avatar, custom avatar or profile pic), remember the domain
    if (faviconDomain && !companyPhoto && !resolvedContactPhoto && !pluginAvatar && !customAvatar && !profilePic) {
      failedFaviconDomains.add(faviconDomain);
    }
  }, [imgSrc, pluginAvatar, faviconDomain, companyPhoto, resolvedContactPhoto, customAvatar, profilePic]);

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center font-semibold text-white overflow-hidden",
        sizeClasses[size],
        className
      )}
      style={{ backgroundColor: imgSrc ? (isFavicon ? "#ffffff" : "transparent") : (fallbackColor ?? getBackgroundColor()) }}
      title={name || email}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt=""
          className="w-full h-full object-cover"
          onError={handleImgError}
          // /api/favicon returns a 1x1 transparent PNG (HTTP 200) when no real
          // favicon exists, to avoid spamming the DevTools console with 404s.
          // Detect that sentinel by naturalWidth and fall back to initials.
          onLoad={(e) => {
            const img = e.currentTarget;
            if (isFavicon && img.naturalWidth <= 1) {
              handleImgError();
            }
          }}
        />
      ) : (
        getInitials()
      )}
    </div>
  );
}