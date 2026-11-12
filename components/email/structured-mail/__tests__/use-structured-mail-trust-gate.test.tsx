import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAuthenticationResults } from '@/lib/email-headers';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import { usePolicyStore } from '@/stores/policy-store';
import { useStructuredMail } from '../use-structured-mail';

// The trust check reads the whole body of every message it is asked about. A message without
// booking markup and without an attachment a card source could read has no card to show, so the
// reader never asks.
const trustCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/structured-mail/trust', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/structured-mail/trust')>();
  return {
    ...actual,
    getStructuredMailTrust: (...args: Parameters<typeof actual.getStructuredMailTrust>) => {
      trustCalls.count++;
      return actual.getStructuredMailTrust(...args);
    },
  };
});

const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';
const ORDER = `<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop' })}</script>`;

function mail(html: string | undefined, attachments: Email['attachments'] = []): Email {
  return {
    id: 'm', threadId: 't', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-10-30T09:00:00Z', subject: 'Hello',
    from: [{ email: 'orders@shop.example' }],
    authenticationResults: parseAuthenticationResults([PASS]), authenticationResultsOnReceipt: true,
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart],
    bodyValues: html === undefined ? {} : { '1': { value: html, isTruncated: false, isEncodingProblem: false } },
    attachments,
  } as unknown as Email;
}

const initial = usePolicyStore.getState();

beforeEach(() => {
  trustCalls.count = 0;
  usePolicyStore.setState((state) => ({ policy: { ...state.policy, features: { ...state.policy.features, structuredMailEnabled: true } } }));
});

afterEach(() => {
  usePolicyStore.setState(initial, true);
});

describe('useStructuredMail before the trust check', () => {
  it('does not run it for a message with no booking markup and no attachment', () => {
    const { result } = renderHook(() => useStructuredMail(mail(`<p>Hello</p>${'<br>'.repeat(1000)}`)));
    expect(result.current).toEqual([]);
    expect(trustCalls.count).toBe(0);
  });

  it('runs it for booking markup, for an attachment, and while the HTML has not loaded', () => {
    const { result } = renderHook(() => useStructuredMail(mail(`<html><head>${ORDER}</head><body></body></html>`)));
    expect(result.current).toMatchObject([{ kind: 'shipment', orderNumber: 'SO-1' }]);
    expect(trustCalls.count).toBeGreaterThan(0);

    trustCalls.count = 0;
    renderHook(() => useStructuredMail(mail('<p>Your pass is attached.</p>', [
      { partId: '2', blobId: 'b', size: 10, name: 'pass.pkpass', type: 'application/vnd.apple.pkpass' },
    ])));
    expect(trustCalls.count).toBeGreaterThan(0);

    trustCalls.count = 0;
    renderHook(() => useStructuredMail(mail(undefined)));
    expect(trustCalls.count).toBeGreaterThan(0);
  });
});
