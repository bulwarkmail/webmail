import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { subscriptionStore } from '@/lib/push/store';
import { sendFcmPush } from '@/lib/push/fcm';
import { isValidSubscriptionId } from '@/lib/push/validation';
import type { JmapPushBody } from '@/lib/push/types';

/**
 * POST /api/push/jmap/:id
 *
 * Destination configured on JMAP PushSubscription. Spec (RFC 8620 §7.2)
 * allows two body shapes:
 *
 *   { "@type": "PushVerification", pushSubscriptionId, verificationCode }
 *   { "@type": "StateChange",      changed: { [accountId]: { [type]: state } } }
 *
 * PushVerification is terminated here — cached against the subscription so
 * the client can poll it. StateChange is fanned out via FCM so the mobile
 * app wakes and re-fetches with its own credentials.
 */

function getAllowedOrigin(): string | null {
  const raw = process.env.PUSH_ALLOWED_JMAP_ORIGIN?.trim();
  return raw ? raw : null;
}

function getSharedSecret(): string | null {
  const raw = process.env.PUSH_SHARED_SECRET?.trim();
  return raw ? raw : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isValidSubscriptionId(id)) {
      return NextResponse.json({ error: 'Invalid subscriptionId' }, { status: 400 });
    }

    const allowedOrigin = getAllowedOrigin();
    if (allowedOrigin) {
      const origin = request.headers.get('origin') ?? '';
      if (origin && origin !== allowedOrigin) {
        return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
      }
    }

    const sharedSecret = getSharedSecret();
    if (sharedSecret) {
      // Stalwart supports a custom `Authorization` header on the push URL via
      // PushSubscription.keys/headers — a shared secret is the strongest
      // authentication a stateless relay can enforce.
      const presented = request.headers.get('x-push-secret') ?? '';
      if (presented !== sharedSecret) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const record = await subscriptionStore.get(id);
    if (!record) {
      return NextResponse.json({ error: 'Unknown subscription' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as JmapPushBody | null;
    if (!body || typeof body['@type'] !== 'string') {
      return NextResponse.json({ error: 'Invalid JMAP push body' }, { status: 400 });
    }

    if (body['@type'] === 'PushVerification') {
      record.verificationCode = body.verificationCode;
      await subscriptionStore.put(id, record);
      return NextResponse.json({ ok: true });
    }

    if (body['@type'] === 'StateChange') {
      const result = await sendFcmPush(record, body);
      record.lastPushAt = Date.now();
      await subscriptionStore.put(id, record);
      if (result.unregistered) {
        // FCM told us the token is no longer valid — drop the subscription
        // so the device re-registers on next launch.
        await subscriptionStore.delete(id);
      }
      return NextResponse.json({ ok: result.ok });
    }

    return NextResponse.json({ error: 'Unsupported JMAP push type' }, { status: 400 });
  } catch (error) {
    logger.error('push: jmap handler failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
