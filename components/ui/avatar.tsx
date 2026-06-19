"use client";

import { useState, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore, getContactPhotoUri } from "@/stores/contact-store";
import { useConfig } from "@/hooks/use-config";

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

// Module-level cache of domains whose favicons failed to load.
// Shared across all Avatar instances to avoid re-requesting known-bad domains.
const failedFaviconDomains = new Set<string>();
// Emails whose Libravatar lookup 404'd this session — don't retry.
const failedAvatarEmails = new Set<string>();
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
}

export function Avatar({ name, email, contactPhotoUri, size = "md", className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const senderAvatars = useSettingsStore((s) => s.senderAvatars);
  const contacts = useContactStore((s) => s.contacts);
  const { devMode } = useConfig();

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
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
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
  const avatarPx = size === "lg" ? 96 : size === "sm" ? 64 : 80;
  const avatarFailed = email ? failedAvatarEmails.has(email.toLowerCase()) : false;
  // Libravatar (federated, privacy-friendly) avatar for any address, resolved
  // server-side via /api/libravatar (SRV federation + central fallback).
  const libravatarSrc =
    senderAvatars && email && !avatarFailed && !imgError && !domainFailed
      ? `/api/libravatar?email=${encodeURIComponent(email)}&s=${avatarPx}`
      : null;
  const showFavicon =
    senderFavicons && faviconDomain && !PERSONAL_DOMAINS.has(faviconDomain) && !imgError && !domainFailed;

  // Priority: contact photo > custom avatar > profile picture > company favicon > initials
  const customAvatar = devMode && email ? CUSTOM_AVATARS[email.toLowerCase()] : null;
  const imgSrc = !imgError && !domainFailed
    ? resolvedContactPhoto || customAvatar || profilePic || libravatarSrc || (showFavicon ? `/api/favicon?domain=${encodeURIComponent(faviconDomain!)}` : null)
    : (resolvedContactPhoto || customAvatar || profilePic || null);

  const handleImgError = useCallback(() => {
    // A failed Libravatar lookup shouldn't poison the favicon domain — record
    // it separately so the next render falls through to favicon/initials.
    if (libravatarSrc && imgSrc === libravatarSrc && email) {
      failedAvatarEmails.add(email.toLowerCase());
    }
    setImgError(true);
    // If this was a favicon URL (not a contact photo, custom avatar, profile
    // pic or libravatar), remember the domain.
    if (faviconDomain && !resolvedContactPhoto && !customAvatar && !profilePic && !libravatarSrc) {
      failedFaviconDomains.add(faviconDomain);
    }
  }, [faviconDomain, resolvedContactPhoto, customAvatar, profilePic, libravatarSrc, imgSrc, email]);

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center font-semibold text-white overflow-hidden",
        sizeClasses[size],
        className
      )}
      style={{ backgroundColor: imgSrc ? "#ffffff" : getBackgroundColor() }}
      title={name || email}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt=""
          className="w-full h-full object-cover"
          onError={handleImgError}
        />
      ) : (
        getInitials()
      )}
    </div>
  );
}