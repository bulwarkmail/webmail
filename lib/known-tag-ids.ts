import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';
import { useSharedTagsStore, type SharedTagsEntry } from '@/stores/shared-tags-store';

/**
 * The ids of every defined tag: the user's own, then the shared definitions
 * of the group accounts loaded so far. Keywords are case-insensitive
 * (RFC 8621 §4.1.1), so ids that differ only in case are one tag; the first
 * spelling is kept. Hidden tags count too. Tags found on messages that
 * nobody defined are not included.
 */
export function collectTagIds(
  personal: ReadonlyArray<Pick<KeywordDefinition, 'id'>>,
  sharedEntries: Readonly<Record<string, Pick<SharedTagsEntry, 'tags'>>>,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (!id) return;
    const folded = id.toLowerCase();
    if (seen.has(folded)) return;
    seen.add(folded);
    ids.push(id);
  };
  for (const tag of personal) add(tag.id);
  for (const entry of Object.values(sharedEntries)) {
    for (const tag of entry.tags) add(tag.id);
  }
  return ids;
}

/** collectTagIds over what the settings and shared tags stores hold now. */
export function knownTagIds(): string[] {
  return collectTagIds(useSettingsStore.getState().emailKeywords ?? [], useSharedTagsStore.getState().entries);
}
