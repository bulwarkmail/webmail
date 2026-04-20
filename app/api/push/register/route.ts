import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { subscriptionStore } from '@/lib/push/store';
import { isValidFcmToken, isValidSubscriptionId } from '@/lib/push/validation';
import type { SubscriptionRecord } from '@/lib/push/types';

/**
 * POST /api/push/register
 * Body: { subscriptionId, fcmToken, accountLabel? }
 *
 * Called by the mobile app once Firebase has issued an FCM registration
 * token. The relay stores only the opaque token — no user credentials.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      subscriptionId?: unknown;
      fcmToken?: unknown;
      accountLabel?: unknown;
    } | null;
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

    const { subscriptionId, fcmToken, accountLabel } = body;
    if (!isValidSubscriptionId(subscriptionId)) {
      return NextResponse.json({ error: 'Invalid subscriptionId' }, { status: 400 });
    }
    if (!isValidFcmToken(fcmToken)) {
      return NextResponse.json({ error: 'Invalid fcmToken' }, { status: 400 });
    }

    // Preserve verificationCode if a previous record exists — the JMAP server
    // may have already POSTed PushVerification before the app re-registers.
    const existing = await subscriptionStore.get(subscriptionId);

    const record: SubscriptionRecord = {
      fcmToken,
      verificationCode: existing?.verificationCode ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      lastPushAt: existing?.lastPushAt ?? null,
      accountLabel:
        typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
    };
    await subscriptionStore.put(subscriptionId, record);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('push: register failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
