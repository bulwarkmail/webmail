import { describe, expect, it } from 'vitest';
import {
  buildOrgSignaturePlaceholderValues,
  extractEmailDomain,
  normalizeDomainBrandNames,
  normalizeOrgSignaturePolicy,
  resolveEffectiveSignature,
  resolveOrgSignatureContent,
  resolveOrgSignatureTemplate,
  shouldLockIdentitySignatures,
  substituteOrgSignaturePlaceholders,
} from '@/lib/org-signatures';
import type { OrgSignaturePolicy } from '@/lib/admin/types';

const basePolicy = (overrides: Partial<OrgSignaturePolicy> = {}): OrgSignaturePolicy => ({
  enabled: true,
  scope: 'instance',
  mergeMode: 'replace',
  instance: {
    htmlTemplate: '<p>Org — {{display.name}} · {{brand.name}}</p>',
    textTemplate: 'Org — {{display.name}} · {{brand.name}}',
  },
  perDomain: {},
  ...overrides,
});

describe('org-signatures', () => {
  it('extracts sender email domain', () => {
    expect(extractEmailDomain('User@Example.COM')).toBe('example.com');
    expect(extractEmailDomain('invalid')).toBeNull();
  });

  it('substitutes dotted placeholders and brand map by sender domain', () => {
    const values = buildOrgSignaturePlaceholderValues(
      { name: 'Alex Example', email: 'alex@acme.example.com' },
      { 'acme.example.com': 'Acme Corp' },
    );
    expect(values['display.name']).toBe('Alex Example');
    expect(values['brand.name']).toBe('Acme Corp');
    expect(
      substituteOrgSignaturePlaceholders('Hello {{display.name}} from {{brand.name}}', values),
    ).toBe('Hello Alex Example from Acme Corp');
  });

  it('selects instance-wide or per-domain templates', () => {
    const policy = basePolicy({
      scope: 'per_domain',
      perDomain: {
        'example.com': {
          htmlTemplate: '<p>Example domain sig</p>',
          textTemplate: 'Example domain sig',
        },
      },
    });
    expect(resolveOrgSignatureTemplate(policy, 'user@example.com')?.htmlTemplate).toContain('Example domain');
    expect(resolveOrgSignatureTemplate(policy, 'user@other.com')).toBeNull();
    expect(resolveOrgSignatureTemplate(basePolicy(), 'user@example.com')?.htmlTemplate).toContain('Org —');
  });

  it('replace mode ignores user signature', () => {
    const result = resolveEffectiveSignature(
      { htmlSignature: '<p>User sig</p>', textSignature: 'User sig' },
      { name: 'Alex', email: 'alex@example.com' },
      basePolicy({ mergeMode: 'replace' }),
      { 'example.com': 'Example Brand' },
    );
    expect(result.htmlSignature).toContain('Org — Alex');
    expect(result.htmlSignature).not.toContain('User sig');
  });

  it('fallback mode keeps user signature when present', () => {
    const result = resolveEffectiveSignature(
      { textSignature: 'User sig' },
      { name: 'Alex', email: 'alex@example.com' },
      basePolicy({ mergeMode: 'fallback' }),
      {},
    );
    expect(result.textSignature).toBe('User sig');
  });

  it('fallback mode uses org signature when user has none', () => {
    const result = resolveEffectiveSignature(
      {},
      { name: 'Alex', email: 'alex@example.com' },
      basePolicy({ mergeMode: 'fallback' }),
      {},
    );
    expect(result.textSignature).toContain('Org — Alex');
  });

  it('append mode combines user and org signatures', () => {
    const result = resolveEffectiveSignature(
      { textSignature: 'User sig', htmlSignature: '<p>User sig</p>' },
      { name: 'Alex', email: 'alex@example.com' },
      basePolicy({ mergeMode: 'append' }),
      {},
    );
    expect(result.textSignature).toBe('User sig\n\nOrg — Alex ·');
    expect(result.htmlSignature).toContain('User sig');
    expect(result.htmlSignature).toContain('Org — Alex');
  });

  it('locks identity editor only in replace mode', () => {
    expect(shouldLockIdentitySignatures(basePolicy({ mergeMode: 'replace' }))).toBe(true);
    expect(shouldLockIdentitySignatures(basePolicy({ mergeMode: 'append' }))).toBe(false);
    expect(shouldLockIdentitySignatures(basePolicy({ enabled: false }))).toBe(false);
  });

  it('normalizes domain keys in brand map and per-domain templates', () => {
    const normalized = normalizeOrgSignaturePolicy(
      basePolicy({
        scope: 'per_domain',
        perDomain: {
          'Example.COM': {
            htmlTemplate: '<p>Domain</p>',
            textTemplate: 'Domain',
          },
        },
      }),
    );
    expect(normalized?.perDomain?.['example.com']?.textTemplate).toBe('Domain');

    const brands = normalizeDomainBrandNames({
      'Example.COM': 'Example Brand',
      'bad domain': 'Skip',
    });
    expect(brands['example.com']).toBe('Example Brand');
    expect(brands['bad domain']).toBeUndefined();
  });

  it('derives plain text from html when text template is empty', () => {
    const content = resolveOrgSignatureContent(
      { htmlTemplate: '<p>Line one</p><p>Line two</p>', textTemplate: '' },
      { name: 'Alex', email: 'alex@example.com' },
      {},
    );
    expect(content.text).toContain('Line one');
    expect(content.text).toContain('Line two');
  });
});
