import { NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { TARGET_NAMES } from '@/lib/connector/registry';

/**
 * What a connector asks an instance about itself.
 *
 * Someone adding this instance at connector.bulwarkmail.org gets a request
 * here, from their own browser, straight to their own server, with no
 * credentials. It answers two questions: is this really a Bulwark, and which
 * connector links can it resolve - so a link to a target this version does not
 * have can warn before it opens instead of after.
 *
 * Unauthenticated on purpose: the browser making the probe has no session
 * here, and the answer is narrower than the login page it sits next to. It
 * says nothing about accounts, domains or the mail server - only the product,
 * its version, the branded app name, and the target names, which are a
 * compile-time constant.
 *
 * `appName` can be a customer's own branding, so the whole endpoint is gated
 * on `connectorEnabled` for deployments that would rather disclose nothing.
 *
 * Bulwark Lite has no route handlers; scripts/lite/postbuild.mjs writes the
 * same document to /connector.json, and the connector tries this first and
 * falls back to that.
 */
export async function GET() {
  await configManager.ensureLoaded();

  if (!configManager.get<boolean>('connectorEnabled', true)) {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.json(
    {
      product: 'bulwark-webmail',
      appName:
        configManager.get<string>('appName', '') || process.env.NEXT_PUBLIC_APP_NAME || 'Bulwark',
      version: process.env.NEXT_PUBLIC_APP_VERSION || null,
      connectorPath: '/connector',
      targets: TARGET_NAMES,
    },
    {
      headers: {
        // The probe is cross-origin by definition - it comes from the
        // connector's origin, or from any other site someone points at their
        // instance. Nothing here is per-user, so there is nothing for a
        // wildcard to leak; credentials are never read.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    },
  );
}
