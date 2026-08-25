import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── module mocks (hoisted) ───────────────────────────────────────────────────
vi.mock('next/server', () => {
  class NextResponse {
    static json(data: unknown, init?: { status?: number }) {
      return { status: init?.status ?? 200, headers: new Headers(), json: async () => data };
    }
  }
  return { NextResponse, NextRequest: class {} };
});
vi.mock('@/lib/logger', () => ({ logger: { error: () => {}, debug: () => {} } }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(),
  postJmap: vi.fn(),
  rebaseApiUrl: vi.fn(() => 'https://mail.example.com/jmap/'),
}));

import { POST } from '@/app/api/calendar-agenda/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession, postJmap } from '@/lib/stalwart/jmap-api';

const mockCreds = getStalwartCredentials as unknown as Mock;
const mockSession = fetchJmapSession as unknown as Mock;
const mockPost = postJmap as unknown as Mock;

const CALENDAR_CAP = 'urn:ietf:params:jmap:calendars';

function makeSession(capabilities: Record<string, unknown>) {
  return {
    capabilities,
    primaryAccounts: { [CALENDAR_CAP]: 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/',
  };
}

function makeReq(): Parameters<typeof POST>[0] {
  return { json: async () => ({}) } as unknown as Parameters<typeof POST>[0];
}

async function agendaUsing(capabilities: Record<string, unknown>): Promise<string[]> {
  mockSession.mockResolvedValue(makeSession(capabilities));
  mockPost.mockResolvedValue({
    ok: true,
    json: async () => ({
      methodResponses: [
        ['CalendarEvent/query', { ids: [] }, '0'],
        ['Calendar/get', { list: [] }, 'c'],
      ],
    }),
  });

  const res = await POST(makeReq());
  expect(res.status).toBe(200);
  return JSON.parse(mockPost.mock.calls[0][2] as string).using;
}

describe('calendar-agenda route (principals:owner declaration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreds.mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      username: 'user@example.com',
      authHeader: 'Basic abc',
    });
  });

  it('omits principals:owner when the server advertises only base principals', async () => {
    const using = await agendaUsing({
      'urn:ietf:params:jmap:core': {},
      [CALENDAR_CAP]: {},
      'urn:ietf:params:jmap:principals': {},
    });
    expect(using).toContain(CALENDAR_CAP);
    expect(using).not.toContain('urn:ietf:params:jmap:principals:owner');
  });

  it('declares principals:owner when the server advertises it', async () => {
    const using = await agendaUsing({
      'urn:ietf:params:jmap:core': {},
      [CALENDAR_CAP]: {},
      'urn:ietf:params:jmap:principals': {},
      'urn:ietf:params:jmap:principals:owner': {},
    });
    expect(using).toContain('urn:ietf:params:jmap:principals:owner');
  });
});
