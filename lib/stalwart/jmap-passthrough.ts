import { apiFetch } from '@/lib/browser-navigation';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';

export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapMethodResponse = [string, Record<string, unknown>, string];

export const STALWART_JMAP_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

export interface StalwartJmapError extends Error {
  status: number;
  methodError?: { type: string; description?: string };
}

function buildError(message: string, status: number, methodError?: StalwartJmapError['methodError']): StalwartJmapError {
  const err = new Error(message) as StalwartJmapError;
  err.status = status;
  if (methodError) err.methodError = methodError;
  return err;
}

/**
 * Send a JMAP request to Stalwart via the server-side passthrough.
 * The passthrough injects the stored basic-auth header so credentials
 * stay in an httpOnly cookie.
 */
export async function stalwartJmap(methodCalls: JmapMethodCall[]): Promise<JmapMethodResponse[]> {
  const response = await apiFetch('/api/account/stalwart/jmap', {
    method: 'POST',
    headers: { ...getActiveAccountSlotHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: STALWART_JMAP_USING, methodCalls }),
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    throw buildError(message, response.status);
  }

  const data = await response.json();
  const responses = (data.methodResponses ?? []) as JmapMethodResponse[];

  const first = responses[0];
  if (first && first[0] === 'error') {
    const result = first[1] as { type?: string; description?: string };
    throw buildError(result.description || result.type || 'JMAP error', 200, {
      type: result.type || 'unknown',
      description: result.description,
    });
  }

  return responses;
}

export function requireResult<T = Record<string, unknown>>(
  responses: JmapMethodResponse[],
  expectedMethod: string,
): T {
  const match = responses.find(r => r[0] === expectedMethod);
  if (!match) {
    throw buildError(`Expected method ${expectedMethod} in response`, 200);
  }
  return match[1] as T;
}
