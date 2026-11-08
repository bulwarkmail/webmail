"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuietState } from "@/hooks/use-quiet-state";
import { cn } from "@/lib/utils";
import { ShieldAlert } from "@/components/icons";
import { getLuminance, parseColor } from "@/lib/color-transform";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore, getContactPhotoIndex, type ContactPhotoRef } from "@/stores/contact-store";
import { useConfig } from "@/hooks/use-config";
import { useContactPhotoSrc } from "@/hooks/use-contact-photo";
import { avatarHooks } from "@/lib/plugin-hooks";
import { withBasePath } from "@/lib/browser-navigation";
import { IS_LITE } from "@/lib/lite";
import { avatarUrlAllowed, sampleAvatarsAllowed, senderFaviconsAllowed } from "@/lib/outgoing-hosts";
import { useNoThirdPartyTraffic } from "@/hooks/use-third-party-mode";
import { useFaviconRefreshStore, failedFaviconDomains, failedBrandDomains } from "@/stores/favicon-refresh-store";

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

// An unspaced Han-character name is usually surname + given name. Compound
// surnames take two characters, so the given name of 司马光 starts at the
// third character, not the second.
const HAN_CHAR = /\p{Script=Han}/u;
const COMPOUND_SURNAMES = new Set([
  "欧阳", "司马", "上官", "诸葛", "东方", "独孤", "南宫", "万俟", "闻人",
  "夏侯", "令狐", "尉迟", "公孙", "长孙", "慕容", "司徒", "司空", "皇甫",
  "宇文", "呼延", "端木", "申屠", "公冶", "太叔", "西门", "鲜于", "闾丘",
  "轩辕", "百里", "拓跋", "澹台", "谷梁",
]);

/**
 * The given-name initials of a Han-script name: Chinese names are written
 * without spaces, so the Western "first letters of the words" rule
 * degenerates to the first two characters of the whole string - the surname
 * plus one character of the given name (王阳明 showed 王阳). What reads
 * naturally there is the given name instead: 王阳明 → 阳明, 陈阳 → 陈阳,
 * 司马光 → 光. Only a name made entirely of Han characters takes this path;
 * anything mixed, Latin, or kana keeps the Western rule.
 *
 * Accepted lengths: 2 (the whole name), 3 (surname + 2-char given name),
 * and 4 only with a known compound surname. Anything longer falls back to
 * the Western rule: the surname/given-name split of a 4+ character Han
 * string is not guessable (Japanese 山田太郎 is 1+3, 高桥和也 is 2+2), so
 * slicing at any fixed point produces a cross-boundary pair that is
 * neither a name nor a surname - worse than the plain leading characters.
 *
 * Known trade-off at 3 characters: Chinese 1+2 is the dominant shape this
 * rule exists for, and Japanese 1+2 (林太郎 → 太郎) cuts the same way, but
 * a Japanese 2+1 name (田中実) slices to 中実, a cross-boundary pair.
 * Script alone cannot tell the languages apart, and a surname dictionary
 * is out of scope, so the majority case wins.
 * Korean names in Hangul are NOT Han script (김 is \p{Script=Hangul}) and
 * never take this path; they keep the Western rule.
 */
function hanGivenName(name: string): string | null {
  const compact = name.replace(/\s+/g, "");
  if (compact.length < 2) return null;
  for (const ch of compact) {
    if (!HAN_CHAR.test(ch)) return null;
  }
  if (compact.length === 2) return compact;
  const compound = COMPOUND_SURNAMES.has(compact.slice(0, 2));
  if (compact.length === 3) return compound ? compact.slice(2, 3) : compact.slice(1, 3);
  if (compact.length === 4 && compound) return compact.slice(2, 4);
  return null;
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
  if (!devMode || !sampleAvatarsAllowed()) return null;
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
  /**
   * The photo of the contact this avatar stands for (see getContactPhotoRef).
   * Left undefined, the email is looked up among the contacts; null means the
   * contact has no photo, so no other card's photo is borrowed.
   */
  contactPhoto?: ContactPhotoRef | null;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** When true, suppress all image sources (favicons, plugin avatars, profile pics, contact photos) and render initials only. */
  disableImages?: boolean;
  /** When true, do not fall through to the sender's domain favicon. Use for the user's own account avatar where the mail-provider logo is not meaningful. */
  disableFavicon?: boolean;
  /** Background color used when no image source resolves. Overrides the hash-based default. */
  fallbackColor?: string;
  /**
   * The message's sender check failed (see useSenderWarning): show a warning
   * shield with this label instead of any image or the initials, so a forged
   * From doesn't get the real sender's logo or photo (#1439).
   */
  senderWarning?: string;
  /**
   * The From domain of a message that passed DMARC for it (see
   * brandIndicatorDomain): its BIMI logo, when it publishes one, comes before
   * every source but a contact photo.
   */
  brandDomain?: string;
}

/**
 * White or black initials, whichever contrasts more with the background.
 * One of the two always reaches 4.58:1, so the initials pass 4.5:1 on every
 * generated colour (white alone failed on yellows and greens).
 */
function initialsColor(background: string): string {
  const rgb = parseColor(background);
  if (!rgb) return '#ffffff';
  const l = getLuminance(rgb.r, rgb.g, rgb.b);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

export function Avatar({ name, email, contactPhoto, size = "md", className, disableImages = false, disableFavicon = false, fallbackColor, senderWarning, brandDomain }: AvatarProps) {
  const [imgError, setImgError] = useQuietState(false);
  // The BIMI logo of this domain answered with no logo (or didn't load).
  const [failedBrand, setFailedBrand] = useQuietState<string | null>(null);
  const [pluginAvatarUrl, setPluginAvatarUrl] = useQuietState<string | null>(null);
  // Reset for every sender shown: quiet, so an avatar with nothing to reset is not drawn again.
  const [pluginAvatarFailed, setPluginAvatarFailed] = useQuietState(false);
  // A contact photo that downloaded but would not render (an SVG made inert,
  // corrupt bytes) falls through to the next source instead of an empty circle.
  const [failedContactPhoto, setFailedContactPhoto] = useState<string | null>(null);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const faviconRefreshedAt = useFaviconRefreshStore((s) => s.refreshedAt);
  const contacts = useContactStore((s) => s.contacts);
  const { devMode } = useConfig();
  // Re-render when the config arrives: until then nothing outside is asked (#903).
  useNoThirdPartyTraffic();

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
  }, [email, name, setPluginAvatarFailed, setPluginAvatarUrl]);

  // The caller's contact photo, else the photo of a contact with this address.
  const photoRef = useMemo(() => {
    if (disableImages) return null;
    if (contactPhoto !== undefined) return contactPhoto;
    if (!email) return null;
    return getContactPhotoIndex(contacts).get(email.toLowerCase()) ?? null;
  }, [disableImages, contactPhoto, email, contacts]);
  const { src: contactPhotoSrc, observe } = useContactPhotoSrc(photoRef);
  const resolvedContactPhoto = contactPhotoSrc && contactPhotoSrc !== failedContactPhoto && avatarUrlAllowed(contactPhotoSrc) ? contactPhotoSrc : undefined;

  // A refresh of the sender icons gives a failed favicon another chance.
  useEffect(() => {
    setImgError(false);
    setFailedBrand(null);
  }, [faviconRefreshedAt, setFailedBrand, setImgError]);

  const domain = email?.split("@")[1]?.toLowerCase();
  // Use root domain for favicon lookups (e.g. newsletter.example.com → example.com)
  const faviconDomain = domain ? getRootDomain(domain) : undefined;
  const domainFailed = faviconDomain ? failedFaviconDomains.has(faviconDomain) : false;

  const getInitials = () => {
    if (name) {
      const han = hanGivenName(name);
      if (han) return han;
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
  const warningIconClasses = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  const profilePic = email && domain ? getProfilePictureUrl(email, domain, devMode, name) : null;
  // Sender favicons come from the /api/favicon proxy, absent in the static
  // build and off while third-party traffic is (#903).
  const showFavicon =
    !IS_LITE && senderFaviconsAllowed() && !disableFavicon && senderFavicons && faviconDomain && !PERSONAL_DOMAINS.has(faviconDomain) && !imgError && !domainFailed;

  // Priority: contact photo > BIMI logo > plugin avatar (e.g. Gravatar) > custom avatar > profile picture > company favicon > initials
  const customAvatar = devMode && email && sampleAvatarsAllowed() ? CUSTOM_AVATARS[email.toLowerCase()] : null;
  // Gravatar and the like are outside hosts: initials instead in the no-third-party mode.
  const pluginAvatar = pluginAvatarFailed || !avatarUrlAllowed(pluginAvatarUrl) ? null : pluginAvatarUrl;
  // BIMI logos come from /api/bimi under the same switches as favicons, and
  // only for the address shown: a thread row may show another participant
  // than the message whose DMARC pass named the domain.
  const showBrand =
    !IS_LITE && senderFaviconsAllowed() && senderFavicons && !!brandDomain && domain === brandDomain && brandDomain !== failedBrand && !failedBrandDomains.has(brandDomain);
  const brandSrc = showBrand ? withBasePath(`/api/bimi?domain=${encodeURIComponent(brandDomain!)}${faviconRefreshedAt ? `&v=${faviconRefreshedAt}` : ""}`) : null;
  const photoSrc = resolvedContactPhoto || brandSrc || pluginAvatar || customAvatar || profilePic || null;
  const faviconSrc = !imgError && !domainFailed && showFavicon ? withBasePath(`/api/favicon?domain=${encodeURIComponent(faviconDomain!)}${faviconRefreshedAt ? `&v=${faviconRefreshedAt}` : ""}`) : null;
  const imgSrc = disableImages ? null : (photoSrc || faviconSrc);
  const isFavicon = imgSrc !== null && imgSrc === faviconSrc;
  const isBrand = imgSrc !== null && imgSrc === brandSrc;

  const handleImgError = useCallback(() => {
    if (resolvedContactPhoto && imgSrc === resolvedContactPhoto) {
      setFailedContactPhoto(resolvedContactPhoto);
      return;
    }
    if (brandSrc && brandDomain && imgSrc === brandSrc) {
      failedBrandDomains.add(brandDomain);
      setFailedBrand(brandDomain);
      return;
    }
    // If the plugin avatar just failed, mark it and fall through to the next source
    if (pluginAvatar && imgSrc === pluginAvatar) {
      setPluginAvatarFailed(true);
      return;
    }
    setImgError(true);
    // If this was a favicon URL (not a contact photo, plugin avatar, custom avatar or profile pic), remember the domain
    if (faviconDomain && !resolvedContactPhoto && !pluginAvatar && !customAvatar && !profilePic) {
      failedFaviconDomains.add(faviconDomain);
    }
  }, [imgSrc, pluginAvatar, faviconDomain, resolvedContactPhoto, brandSrc, brandDomain, customAvatar, profilePic, setFailedBrand, setImgError, setPluginAvatarFailed]);

  const initialsBackground = fallbackColor ?? getBackgroundColor();

  if (senderWarning) {
    return (
      <div
        className={cn(
          "rounded-full flex items-center justify-center overflow-hidden bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
          sizeClasses[size],
          className
        )}
        title={`${name || email || ""} (${senderWarning})`}
        data-sender-warning=""
      >
        <ShieldAlert className={warningIconClasses[size]} aria-hidden />
      </div>
    );
  }

  return (
    <div
      ref={observe}
      className={cn(
        "rounded-full flex items-center justify-center font-semibold text-white overflow-hidden",
        sizeClasses[size],
        className
      )}
      style={{
        backgroundColor: imgSrc ? (isFavicon || isBrand ? "#ffffff" : "transparent") : initialsBackground,
        color: imgSrc ? undefined : initialsColor(initialsBackground),
      }}
      title={name || email}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt=""
          className="w-full h-full object-cover"
          onError={handleImgError}
          // /api/favicon and /api/bimi return a 1x1 transparent PNG (HTTP 200)
          // when there is no icon, to avoid spamming the DevTools console with
          // 404s. Detect that sentinel by naturalWidth and fall through.
          onLoad={(e) => {
            const img = e.currentTarget;
            if ((isFavicon || isBrand) && img.naturalWidth <= 1) {
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