import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { isNoThirdPartyTrafficOn, thirdPartyRefusal } from '@/lib/admin/third-party-mode';
import { bimiResolver, normalizeBimiDomain, type BimiAnswer, type BimiIndicator } from '@/lib/bimi/lookup';
import type { BimiInfo } from '@/lib/bimi/types';
import { lookupLease, NO_STORE, senderIconAccess } from '@/lib/sender-icon-access';

/**
 * BIMI sender logos. GET ?domain=<From domain> answers the logo as a PNG, or
 * the same 1x1 transparent PNG /api/favicon sends when there is none (the
 * avatar falls through on naturalWidth <= 1). With &format=json it answers
 * what backs the logo, for the verified badge in the message view.
 *
 * Ask only for messages that passed DMARC for that domain (see
 * brandIndicatorDomain in lib/email-headers.ts): the logo says who the domain
 * is, not that a given message came from it.
 *
 * For the webmail's own signed-in pages, and the logo itself for the mobile
 * app (lib/sender-icon-access.ts), so answers may be kept by the client but
 * never by a cache shared by users.
 */

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  'base64',
);

const IMAGE_HEADERS = {
  'Content-Type': 'image/png',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

// Short enough that switching "Require a mark certificate" reaches browsers
// the same day.
const LOGO_MAX_AGE = 6 * 60 * 60;
const MISSING_MAX_AGE = 60 * 60;

async function requireCertificate(): Promise<boolean> {
  await configManager.ensureLoaded();
  return configManager.get<boolean>('bimiRequireCertificate', false) === true;
}

function info(indicator: BimiIndicator | null): BimiInfo {
  if (!indicator) return { status: 'none' };
  const { status, markType, organization, issuer } = indicator;
  return { status, markType, organization, issuer };
}

export async function GET(request: NextRequest) {
  // The lookups reach the sender's DNS and whatever hosts its record names.
  if (await isNoThirdPartyTrafficOn()) return thirdPartyRefusal('Brand logos');
  const access = await senderIconAccess(request, 'bimi');
  if ('refusal' in access) return access.refusal;

  const domain = normalizeBimiDomain(request.nextUrl.searchParams.get('domain'));
  const asJson = request.nextUrl.searchParams.get('format') === 'json';
  // What backs a logo is for the signed-in message view; the app shows the logo only.
  if (asJson && access.caller.sessionless) {
    return new NextResponse(null, { status: 401, headers: NO_STORE });
  }
  if (!domain) {
    return new NextResponse(null, { status: 400, headers: NO_STORE });
  }

  const lease = lookupLease(access.caller, 'bimi');
  let answer: BimiAnswer;
  try {
    answer = await bimiResolver().answer(domain, () => lease.take(), access.caller.sessionless);
  } finally {
    await lease.release();
  }
  let indicator = answer.indicator;
  if (indicator && indicator.status !== 'verified' && await requireCertificate()) indicator = null;
  // Not now (too many lookups running, this caller's budget or running
  // lookups are used up, or the drawing was busy): the next request asks again.
  const cacheControl = (maxAge: number) => (answer.deferred ? NO_STORE['Cache-Control'] : `private, max-age=${maxAge}`);

  if (asJson) {
    return NextResponse.json(info(indicator), {
      headers: { 'Cache-Control': cacheControl(indicator ? LOGO_MAX_AGE : MISSING_MAX_AGE) },
    });
  }
  if (!indicator) {
    return new NextResponse(new Uint8Array(TRANSPARENT_PNG), {
      headers: { ...IMAGE_HEADERS, 'Cache-Control': cacheControl(MISSING_MAX_AGE), 'X-Bulwark-Bimi': 'missing' },
    });
  }
  return new NextResponse(new Uint8Array(indicator.png), {
    headers: { ...IMAGE_HEADERS, 'Cache-Control': cacheControl(LOGO_MAX_AGE), 'X-Bulwark-Bimi': indicator.status },
  });
}
