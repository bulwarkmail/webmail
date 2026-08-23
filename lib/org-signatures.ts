import { sanitizeSignatureHtml } from '@/lib/email-sanitization';
import { htmlToPlainText } from '@/lib/html-to-text';
import type {
  OrgSignatureMergeMode,
  OrgSignaturePolicy,
  OrgSignatureScope,
  OrgSignatureTemplate,
} from '@/lib/admin/types';

export type SignatureSource = {
  htmlSignature?: string;
  textSignature?: string;
};

function normalizeSignatureInput(signature: {
  htmlSignature?: string | null;
  textSignature?: string | null;
}): SignatureSource {
  return {
    htmlSignature: signature.htmlSignature ?? undefined,
    textSignature: signature.textSignature ?? undefined,
  };
}

export type SignatureIdentityContext = {
  name?: string;
  email?: string;
};

const PLACEHOLDER_REGEX = /\{\{([\w.]+)\}\}/g;

const DOMAIN_KEY_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeSenderDomain(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidSenderDomain(value: string): boolean {
  const normalized = normalizeSenderDomain(value);
  return normalized.length > 0 && DOMAIN_KEY_RE.test(normalized);
}

export function extractEmailDomain(email: string | undefined | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at >= email.length - 1) return null;
  const domain = normalizeSenderDomain(email.slice(at + 1));
  return isValidSenderDomain(domain) ? domain : null;
}

export function buildOrgSignaturePlaceholderValues(
  context: SignatureIdentityContext,
  domainBrandNames?: Record<string, string>,
): Record<string, string> {
  const email = context.email?.trim() ?? '';
  const displayName = context.name?.trim() ?? '';
  const domain = extractEmailDomain(email);
  const brandName = domain ? (domainBrandNames?.[domain] ?? '') : '';

  return {
    email,
    name: displayName,
    'display.name': displayName,
    display_name: displayName,
    'brand.name': brandName,
    brand_name: brandName,
  };
}

export function substituteOrgSignaturePlaceholders(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(PLACEHOLDER_REGEX, (full, key: string) => {
    if (values[key] === undefined) return full;
    return values[key];
  });
}

export function resolveOrgSignatureTemplate(
  policy: OrgSignaturePolicy | undefined,
  senderEmail: string | undefined,
): OrgSignatureTemplate | null {
  if (!policy?.enabled) return null;

  if (policy.scope === 'per_domain') {
    const domain = extractEmailDomain(senderEmail);
    if (!domain) return null;
    const template = policy.perDomain?.[domain];
    return templateHasContent(template) ? template! : null;
  }

  const instance = policy.instance;
  return templateHasContent(instance) ? instance! : null;
}

function templateHasContent(template: OrgSignatureTemplate | undefined): boolean {
  if (!template) return false;
  return !!(template.htmlTemplate?.trim() || template.textTemplate?.trim());
}

export function resolveOrgSignatureContent(
  template: OrgSignatureTemplate,
  context: SignatureIdentityContext,
  domainBrandNames?: Record<string, string>,
): { html: string; text: string } {
  const values = buildOrgSignaturePlaceholderValues(context, domainBrandNames);
  const htmlRaw = substituteOrgSignaturePlaceholders(template.htmlTemplate ?? '', values);
  const textRaw = substituteOrgSignaturePlaceholders(template.textTemplate ?? '', values);
  const html = htmlRaw.trim() ? sanitizeSignatureHtml(htmlRaw) : '';
  let text = textRaw.trim();
  if (!text && html) {
    text = htmlToPlainText(html);
  }
  return { html, text };
}

export function hasUserSignature(signature: SignatureSource): boolean {
  return !!(signature.htmlSignature?.trim() || signature.textSignature?.trim());
}

function getUserPlainText(signature: SignatureSource): string {
  if (signature.textSignature?.trim()) {
    return signature.textSignature.trim();
  }
  if (signature.htmlSignature?.trim()) {
    return htmlToPlainText(sanitizeSignatureHtml(signature.htmlSignature));
  }
  return '';
}

function mergeHtmlSignatures(userHtml: string | undefined | null, orgHtml: string): string | undefined {
  const parts: string[] = [];
  if (userHtml?.trim()) parts.push(sanitizeSignatureHtml(userHtml));
  if (orgHtml.trim()) parts.push(orgHtml);
  if (parts.length === 0) return undefined;
  return parts.join('');
}

function mergeTextSignatures(userSignature: SignatureSource, orgText: string): string | undefined {
  const parts: string[] = [];
  const userText = getUserPlainText(userSignature);
  if (userText) parts.push(userText);
  if (orgText.trim()) parts.push(orgText.trim());
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

export function resolveEffectiveSignature(
  userSignature: {
    htmlSignature?: string | null;
    textSignature?: string | null;
  },
  context: SignatureIdentityContext,
  policy: OrgSignaturePolicy | undefined,
  domainBrandNames?: Record<string, string>,
): SignatureSource {
  const normalizedUser = normalizeSignatureInput(userSignature);
  const template = resolveOrgSignatureTemplate(policy, context.email);
  if (!policy?.enabled || !template) {
    return normalizedUser;
  }

  const org = resolveOrgSignatureContent(template, context, domainBrandNames);
  const userHasSignature = hasUserSignature(normalizedUser);

  switch (policy.mergeMode) {
    case 'replace':
      return {
        htmlSignature: org.html || undefined,
        textSignature: org.text || undefined,
      };
    case 'fallback':
      if (userHasSignature) return normalizedUser;
      return {
        htmlSignature: org.html || undefined,
        textSignature: org.text || undefined,
      };
    case 'append':
      return {
        htmlSignature: mergeHtmlSignatures(normalizedUser.htmlSignature, org.html),
        textSignature: mergeTextSignatures(normalizedUser, org.text),
      };
    default:
      return normalizedUser;
  }
}

export function shouldLockIdentitySignatures(policy: OrgSignaturePolicy | undefined): boolean {
  return !!(policy?.enabled && policy.mergeMode === 'replace');
}

export function getEffectiveSignaturePosition(
  userPosition: 'above_quote' | 'below_quote',
  policy: OrgSignaturePolicy | undefined,
): 'above_quote' | 'below_quote' {
  if (
    policy?.enabled &&
    policy.lockReplySignaturePosition &&
    policy.replySignaturePosition
  ) {
    return policy.replySignaturePosition;
  }
  return userPosition;
}

export function getEffectiveSignatureSeparator(
  userEnabled: boolean,
  policy: OrgSignaturePolicy | undefined,
): boolean {
  if (policy?.enabled && policy.lockSignatureSeparator && policy.signatureSeparatorEnabled !== undefined) {
    return policy.signatureSeparatorEnabled;
  }
  return userEnabled;
}

export function isReplySignaturePositionLocked(policy: OrgSignaturePolicy | undefined): boolean {
  return !!(policy?.enabled && policy.lockReplySignaturePosition);
}

export function isSignatureSeparatorLocked(policy: OrgSignaturePolicy | undefined): boolean {
  return !!(policy?.enabled && policy.lockSignatureSeparator);
}

export function normalizeOrgSignaturePolicy(
  policy: OrgSignaturePolicy | undefined,
): OrgSignaturePolicy | undefined {
  if (!policy) return undefined;

  const perDomain: Record<string, OrgSignatureTemplate> = {};
  if (policy.perDomain && typeof policy.perDomain === 'object') {
    for (const [rawDomain, template] of Object.entries(policy.perDomain)) {
      const domain = normalizeSenderDomain(rawDomain);
      if (!isValidSenderDomain(domain)) continue;
      if (!template || typeof template !== 'object') continue;
      perDomain[domain] = {
        htmlTemplate: typeof template.htmlTemplate === 'string' ? template.htmlTemplate : '',
        textTemplate: typeof template.textTemplate === 'string' ? template.textTemplate : '',
      };
    }
  }

  const scope: OrgSignatureScope = policy.scope === 'per_domain' ? 'per_domain' : 'instance';
  const mergeMode: OrgSignatureMergeMode =
    policy.mergeMode === 'append' || policy.mergeMode === 'fallback'
      ? policy.mergeMode
      : 'replace';

  return {
    enabled: policy.enabled === true,
    scope,
    mergeMode,
    instance: policy.instance && typeof policy.instance === 'object'
      ? {
          htmlTemplate: typeof policy.instance.htmlTemplate === 'string' ? policy.instance.htmlTemplate : '',
          textTemplate: typeof policy.instance.textTemplate === 'string' ? policy.instance.textTemplate : '',
        }
      : { htmlTemplate: '', textTemplate: '' },
    perDomain,
    replySignaturePosition:
      policy.replySignaturePosition === 'below_quote' ? 'below_quote' : 'above_quote',
    lockReplySignaturePosition: policy.lockReplySignaturePosition === true,
    signatureSeparatorEnabled: policy.signatureSeparatorEnabled !== false,
    lockSignatureSeparator: policy.lockSignatureSeparator === true,
  };
}

export function normalizeDomainBrandNames(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [rawDomain, brand] of Object.entries(value)) {
    const domain = normalizeSenderDomain(rawDomain);
    if (!isValidSenderDomain(domain)) continue;
    if (typeof brand !== 'string') continue;
    const trimmed = brand.trim();
    if (!trimmed) continue;
    out[domain] = trimmed;
  }
  return out;
}

export function buildComposerSignatureIdentity<
  T extends SignatureSource & { id?: string; name?: string; email?: string },
>(
  currentIdentity: T | null | undefined,
  primaryIdentity: T | null | undefined,
  orgPolicy: OrgSignaturePolicy | undefined,
  domainBrandNames?: Record<string, string>,
): (SignatureSource & { id?: string }) | null {
  const contextIdentity = currentIdentity ?? primaryIdentity;
  if (!contextIdentity) return null;

  const userSource =
    currentIdentity?.htmlSignature || currentIdentity?.textSignature
      ? currentIdentity
      : primaryIdentity;

  const merged = resolveEffectiveSignature(
    {
      htmlSignature: userSource?.htmlSignature,
      textSignature: userSource?.textSignature,
    },
    { name: contextIdentity.name, email: contextIdentity.email },
    orgPolicy,
    domainBrandNames,
  );

  if (!merged.htmlSignature && !merged.textSignature) return null;
  return {
    id: contextIdentity.id,
    htmlSignature: merged.htmlSignature ?? undefined,
    textSignature: merged.textSignature ?? undefined,
  };
}
