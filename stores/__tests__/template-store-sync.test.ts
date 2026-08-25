import { beforeEach, describe, expect, it } from 'vitest';
import { useTemplateStore } from '../template-store';
import type { EmailTemplate } from '@/lib/template-types';

function makeTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: 'test-id',
    name: 'Test Template',
    subject: '',
    body: '',
    isHTML: false,
    category: '',
    isFavorite: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  useTemplateStore.setState({
    templates: [],
    recentTemplateIds: [],
    deletedTemplateIds: {},
  });
});

describe('deleteTemplate', () => {
  it('records a tombstone so the deletion can propagate through sync', () => {
    useTemplateStore.setState({ templates: [makeTemplate({ id: 'a' })] });
    useTemplateStore.getState().deleteTemplate('a');

    const state = useTemplateStore.getState();
    expect(state.templates).toEqual([]);
    expect(Object.keys(state.deletedTemplateIds)).toEqual(['a']);
    expect(Date.parse(state.deletedTemplateIds.a)).not.toBeNaN();
  });
});

describe('applySyncedState', () => {
  it('merges by id on server loads instead of clobbering local templates', () => {
    useTemplateStore.setState({ templates: [makeTemplate({ id: 'local' })] });

    useTemplateStore.getState().applySyncedState(
      [makeTemplate({ id: 'remote' })],
      {},
      { merge: true }
    );

    const ids = useTemplateStore.getState().templates.map((t) => t.id).sort();
    expect(ids).toEqual(['local', 'remote']);
  });

  it('replaces wholesale on file imports', () => {
    useTemplateStore.setState({ templates: [makeTemplate({ id: 'local' })] });

    useTemplateStore.getState().applySyncedState(
      [makeTemplate({ id: 'imported' })],
      {},
      { merge: false }
    );

    expect(useTemplateStore.getState().templates.map((t) => t.id)).toEqual(['imported']);
  });

  it('leaves the store untouched when the blob has no templates array', () => {
    useTemplateStore.setState({ templates: [makeTemplate({ id: 'local' })] });

    useTemplateStore.getState().applySyncedState(undefined, undefined, { merge: true });

    expect(useTemplateStore.getState().templates.map((t) => t.id)).toEqual(['local']);
  });

  it('removes templates deleted on another device and prunes recents', () => {
    // Recent enough to be inside the tombstone TTL regardless of when this runs.
    const deletedAt = new Date(Date.now() - 1000).toISOString();
    useTemplateStore.setState({
      templates: [makeTemplate({ id: 'a' }), makeTemplate({ id: 'b' })],
      recentTemplateIds: ['a', 'b'],
    });

    useTemplateStore.getState().applySyncedState(
      [makeTemplate({ id: 'b' })],
      { a: deletedAt },
      { merge: true }
    );

    const state = useTemplateStore.getState();
    expect(state.templates.map((t) => t.id)).toEqual(['b']);
    expect(state.recentTemplateIds).toEqual(['b']);
    expect(state.deletedTemplateIds).toEqual({ a: deletedAt });
  });
});
