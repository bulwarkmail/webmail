import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = vi.fn();
const loaded = vi.fn();
vi.mock('@/lib/vacation-calendar', () => ({
  vacationReplySaved: (...args: unknown[]) => saved(...args),
  vacationReplyLoaded: (...args: unknown[]) => loaded(...args),
}));

import { useVacationStore } from '../vacation-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Every writer of the reply goes through the store (the settings page and
// plugins), so the out-of-office calendar block hooks in there.

const SERVER = {
  id: 'singleton', isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z',
  subject: 'Away', textBody: 'Back soon', htmlBody: null,
};

function mockClient() {
  return {
    supportsSieve: () => false,
    accountSupports: () => false,
    getVacationResponse: vi.fn(async () => ({ ...SERVER })),
    setVacationResponse: vi.fn(async () => {}),
  } as unknown as IJMAPClient;
}

const initial = useVacationStore.getState();
afterEach(() => {
  useVacationStore.setState(initial, true);
  saved.mockClear();
  loaded.mockClear();
});

describe('vacation store and the calendar block', () => {
  it('hands the loaded reply over for the account it was loaded for', async () => {
    const client = mockClient();
    await useVacationStore.getState().fetchVacationResponse(client, 'boss');
    expect(loaded).toHaveBeenCalledWith(client, 'boss', {
      isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z', subject: 'Away',
    });
  });

  it('hands over the reply before and after a save', async () => {
    const client = mockClient();
    await useVacationStore.getState().fetchVacationResponse(client);
    await useVacationStore.getState().updateVacationResponse(client, { toDate: '2026-12-08T17:00:00Z' });
    expect(saved).toHaveBeenCalledWith(
      client, undefined,
      expect.objectContaining({ isEnabled: true, toDate: '2026-12-05T17:00:00Z', subject: 'Away' }),
      { isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-08T17:00:00Z', subject: 'Away' },
    );
  });

  it('hands nothing over when the save failed', async () => {
    const client = mockClient();
    (client.setVacationResponse as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'));
    await expect(useVacationStore.getState().updateVacationResponse(client, { isEnabled: false })).rejects.toThrow();
    expect(saved).not.toHaveBeenCalled();
  });
});
