import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importDescribedTags } from '../described-tags';
import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';
import type { IJMAPClient } from '../jmap/client-interface';

const label = (id: string, name: string, color: string | null) => ({
  id,
  name,
  color,
  total: 3,
  unread: 0,
  isProviderLabel: true,
  source: 'provider' as const,
});

function client(
  labels: ReturnType<typeof label>[],
  supported = true,
): IJMAPClient & { getKeywords: ReturnType<typeof vi.fn> } {
  return {
    supportsKeywordEnumeration: () => supported,
    getKeywords: vi.fn().mockResolvedValue({
      keywords: Object.fromEntries(labels.map((l) => [l.id, l.total])),
      labels,
      scanned: 0,
      total: 0,
      complete: true,
    }),
  } as unknown as IJMAPClient & { getKeywords: ReturnType<typeof vi.fn> };
}

describe('importDescribedTags', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [], nestedTags: false });
  });

  it('adopts a tag under the name and colour the server gives it', async () => {
    const added = await importDescribedTags(client([label('$label:fatture-q3', 'Fatture Q3', '#b6cff5')]));

    expect(added).toBe(1);
    expect(useSettingsStore.getState().emailKeywords).toEqual([
      { id: 'fatture-q3', label: 'Fatture Q3', color: 'blue-light', visibility: 'hide' },
    ]);
  });

  it('keeps adopted tags out of the sidebar, where the same labels are already folders', async () => {
    await importDescribedTags(client([label('$label:work', 'Work', '#ef4444')]));

    expect(useSettingsStore.getState().emailKeywords[0].visibility).toBe('hide');
  });

  it('leaves a tag the user has already named alone', async () => {
    const mine: KeywordDefinition = { id: 'work', label: 'Il mio lavoro', color: 'purple' };
    useSettingsStore.setState({ emailKeywords: [mine] });

    const added = await importDescribedTags(client([label('$label:work', 'Work', '#ef4444')]));

    expect(added).toBe(0);
    expect(useSettingsStore.getState().emailKeywords).toEqual([mine]);
  });

  it('asks nothing of a server that cannot enumerate its keywords', async () => {
    const c = client([label('$label:work', 'Work', null)], false);

    expect(await importDescribedTags(c)).toBe(0);
    expect(c.getKeywords).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().emailKeywords).toEqual([]);
  });

  it('is not worth failing a login over', async () => {
    const c = client([]);
    c.getKeywords.mockRejectedValue(new Error('down'));

    await expect(importDescribedTags(c)).resolves.toBe(0);
  });
});
