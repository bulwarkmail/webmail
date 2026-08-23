import { INLINE_IMAGE_PLACEHOLDER } from '@/lib/email-composer-utils';

/** Attribute marking a Bulwark-managed persistent signature image. */
export const SIGNATURE_ASSET_ATTR = 'data-signature-asset';

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExtendedSignature {
  identityId: string;
  html: string;
  assets: string[];
}

export type ExtendedSignaturesMap = Record<string, Record<string, ExtendedSignature>>;

export function isValidSignatureAssetId(id: string): boolean {
  return ASSET_ID_RE.test(id);
}

/** Collect unique `data-signature-asset` ids from HTML. */
export function collectSignatureAssetIds(html: string): string[] {
  if (!html || html.indexOf(SIGNATURE_ASSET_ATTR) === -1) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /data-signature-asset\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const id = match[1];
    if (!isValidSignatureAssetId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Build a JMAP-safe fallback signature: drop Bulwark asset images (and any
 * remaining data: images) so Identity.htmlSignature stays within size limits
 * and remains useful in other clients.
 */
export function buildJmapSignatureFallback(html: string): string {
  if (!html?.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    // Server / non-DOM environments: strip img tags referencing assets crudely.
    return html
      .replace(/<img\b[^>]*data-signature-asset\b[^>]*>/gi, '')
      .replace(/<img\b[^>]*src\s*=\s*["']data:image\/[^"']*["'][^>]*>/gi, '')
      .trim();
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('img').forEach((img) => {
    const assetId = img.getAttribute(SIGNATURE_ASSET_ATTR);
    const src = img.getAttribute('src') || '';
    if (assetId || /^data:image\//i.test(src)) {
      img.remove();
    }
  });
  return doc.body.innerHTML.trim();
}

/**
 * Replace asset markers with editor-ready inline image markup (data URL + cid).
 * Failed assets are removed so we never send a broken cid: reference.
 */
export function applyResolvedSignatureAssets(
  html: string,
  resolved: Map<string, { dataUrl: string; cid: string }>,
  failedIds: Set<string>,
): string {
  if (!html || html.indexOf(SIGNATURE_ASSET_ATTR) === -1) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll(`img[${SIGNATURE_ASSET_ATTR}]`).forEach((img) => {
    const assetId = img.getAttribute(SIGNATURE_ASSET_ATTR);
    if (!assetId) return;
    if (failedIds.has(assetId)) {
      img.remove();
      return;
    }
    const entry = resolved.get(assetId);
    if (!entry) {
      img.remove();
      return;
    }
    img.setAttribute('src', entry.dataUrl);
    img.setAttribute('data-cid', entry.cid);
    // Keep data-signature-asset so identity-switch cleanup can identify them.
  });
  return doc.body.innerHTML;
}

/**
 * For authenticated editor preview: swap asset markers to a placeholder until
 * real bytes are loaded, preserving the asset id attribute.
 */
export function placeholderSignatureAssetImages(html: string): string {
  if (!html || html.indexOf(SIGNATURE_ASSET_ATTR) === -1) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  let touched = false;
  doc.querySelectorAll(`img[${SIGNATURE_ASSET_ATTR}]`).forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src || src === INLINE_IMAGE_PLACEHOLDER || !/^https?:|^data:|^blob:/i.test(src)) {
      img.setAttribute('src', INLINE_IMAGE_PLACEHOLDER);
      touched = true;
    }
  });
  return touched ? doc.body.innerHTML : html;
}

export function getExtendedSignature(
  map: ExtendedSignaturesMap | undefined,
  accountId: string,
  identityId: string,
): ExtendedSignature | null {
  const entry = map?.[accountId]?.[identityId];
  if (!entry || typeof entry.html !== 'string') return null;
  return {
    identityId,
    html: entry.html,
    assets: Array.isArray(entry.assets)
      ? entry.assets.filter((id): id is string => typeof id === 'string')
      : collectSignatureAssetIds(entry.html),
  };
}

export function upsertExtendedSignature(
  map: ExtendedSignaturesMap,
  accountId: string,
  identityId: string,
  html: string,
): ExtendedSignaturesMap {
  const assets = collectSignatureAssetIds(html);
  const nextAccount = { ...(map[accountId] || {}) };
  if (!html.trim() && assets.length === 0) {
    delete nextAccount[identityId];
  } else {
    nextAccount[identityId] = { identityId, html, assets };
  }
  const next = { ...map };
  if (Object.keys(nextAccount).length === 0) {
    delete next[accountId];
  } else {
    next[accountId] = nextAccount;
  }
  return next;
}

export function removeExtendedSignature(
  map: ExtendedSignaturesMap,
  accountId: string,
  identityId: string,
): ExtendedSignaturesMap {
  const account = map[accountId];
  if (!account || !(identityId in account)) return map;
  const nextAccount = { ...account };
  delete nextAccount[identityId];
  const next = { ...map };
  if (Object.keys(nextAccount).length === 0) {
    delete next[accountId];
  } else {
    next[accountId] = nextAccount;
  }
  return next;
}
