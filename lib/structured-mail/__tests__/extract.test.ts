import { describe, expect, it } from 'vitest';
import { extractStructuredData, mayContainStructuredData } from '../extract';

const page = (head: string, body = '') => `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (value: unknown, type = 'application/ld+json') => `<script type="${type}">${JSON.stringify(value)}</script>`;
const order = { '@context': 'http://schema.org', '@type': 'Order', orderNumber: '42' };

describe('extractStructuredData: JSON-LD', () => {
  it('reads blocks in head and body, type compared loosely', () => {
    const html = page(ld(order), ld({ ...order, orderNumber: '43' }, ' Application/LD+JSON '));
    expect(extractStructuredData(html).map((f) => f.item)).toEqual([order, { ...order, orderNumber: '43' }]);
  });

  it('reads a block nested inside a microdata tree', () => {
    const html = page('', `<div itemscope itemtype="http://schema.org/EmailMessage">${ld(order)}</div>`);
    expect(extractStructuredData(html).filter((f) => f.source === 'json-ld').map((f) => f.item)).toEqual([order]);
  });

  it('skips mail without any type it reads, without parsing', () => {
    const html = page(ld({ '@context': 'http://schema.org', '@type': 'PromotionCard' }));
    expect(mayContainStructuredData(html)).toBe(false);
    expect(extractStructuredData(html)).toEqual([]);
  });

  it('ignores markup inside quoted or forwarded parts', () => {
    const quoted = `<blockquote>${ld(order)}</blockquote><div class="gmail_quote">${ld(order)}</div>`;
    const outlook = `<p>FYI</p><div id="divRplyFwdMsg">From: someone</div><div>${ld(order)}</div>`;
    expect(extractStructuredData(page('', quoted))).toEqual([]);
    expect(extractStructuredData(page('', outlook))).toEqual([]);
  });

  it('caps the number of blocks it reads', () => {
    const html = page(Array.from({ length: 60 }, () => ld(order)).join(''));
    expect(extractStructuredData(html)).toHaveLength(50);
  });

  it('runs no script and loads nothing while parsing', () => {
    const html = page('<script>window.__structuredMailRan = true</script>', `<img src="https://tracker.invalid/x.gif">${ld(order)}`);
    extractStructuredData(html);
    expect((window as unknown as Record<string, unknown>).__structuredMailRan).toBeUndefined();
  });
});

describe('extractStructuredData: microdata', () => {
  it('reads values from content, href, src, datetime and text', () => {
    const html = page('', `
      <div itemscope itemtype="http://schema.org/ParcelDelivery">
        <meta itemprop="trackingNumber" content=" 123 ">
        <a itemprop="trackingUrl" href="https://track.example.com/123">track</a>
        <img itemprop="image" src="https://img.example.com/a.png">
        <time itemprop="expectedArrivalUntil" datetime="2026-11-02">2 Nov</time>
        <span itemprop="carrier">  DHL
           Express </span>
      </div>`);
    expect(extractStructuredData(html)).toEqual([{
      source: 'microdata',
      item: {
        '@context': 'https://schema.org', '@type': 'ParcelDelivery', trackingNumber: '123',
        trackingUrl: 'https://track.example.com/123', image: 'https://img.example.com/a.png',
        expectedArrivalUntil: '2026-11-02', carrier: 'DHL Express',
      },
    }]);
  });

  it('nests items, splits itemprop lists and turns repeats into arrays', () => {
    const html = page('', `
      <div itemscope itemtype="https://schema.org/Order">
        <meta itemprop="orderNumber" content="7">
        <div itemprop="merchant seller" itemscope itemtype="http://schema.org/Organization"><meta itemprop="name" content="Shop"></div>
        <meta itemprop="orderStatus" content="">
        <link itemprop="orderStatus" href="http://schema.org/OrderProcessing">
        <div itemprop="acceptedOffer" itemscope itemtype="http://schema.org/Offer">
          <div itemprop="itemOffered" itemscope itemtype="http://schema.org/Product"><meta itemprop="name" content="One"></div>
        </div>
        <div itemprop="acceptedOffer" itemscope itemtype="http://schema.org/Offer">
          <div itemprop="itemOffered" itemscope itemtype="http://schema.org/Product"><meta itemprop="name" content="Two"></div>
        </div>
      </div>`);
    const [{ item }] = extractStructuredData(html);
    const shop = { '@type': 'Organization', name: 'Shop' };
    expect(item).toEqual({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber: '7', merchant: shop, seller: shop,
      orderStatus: 'http://schema.org/OrderProcessing',
      acceptedOffer: [
        { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'One' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Two' } },
      ],
    });
  });

  it('ignores items not typed on schema.org', () => {
    const html = page('', `
      <div itemscope itemtype="http://example.com/Order"><meta itemprop="orderNumber" content="1"></div>
      <div itemscope><meta itemprop="orderNumber" content="2"></div>`);
    expect(extractStructuredData(html)).toEqual([]);
  });

  it('accepts several itemtypes and keeps the schema.org ones', () => {
    const html = page('', '<div itemscope itemtype="http://example.com/X http://schema.org/Order"><meta itemprop="orderNumber" content="1"></div>');
    expect(extractStructuredData(html)[0].item).toMatchObject({ '@type': 'Order', orderNumber: '1' });
  });
});
