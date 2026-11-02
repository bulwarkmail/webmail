import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTemplateStore, renderTemplateWithPlugins } from '../template-store';
import { clearAllHooks, templateHooks } from '@/lib/plugin-hooks';

const DATA = { name: 'Greeting', category: 'Work', subject: 'Hi', body: 'Hello', isHTML: false, isFavorite: false, placeholders: [] };

describe('template plugin hooks', () => {
  beforeEach(() => {
    useTemplateStore.setState({ templates: [], recentTemplateIds: [], deletedTemplateIds: {} });
  });
  afterEach(() => clearAllHooks());

  it('reports created, duplicated, changed and deleted templates', () => {
    const created = vi.fn();
    const updated = vi.fn();
    const deleted = vi.fn();
    templateHooks.onTemplateCreate.register('test', created);
    templateHooks.onTemplateUpdate.register('test', updated);
    templateHooks.onTemplateDelete.register('test', deleted);
    const store = useTemplateStore.getState();

    const t = store.addTemplate(DATA as never);
    expect(created).toHaveBeenCalledWith({ id: t.id, name: 'Greeting', category: 'Work', subject: 'Hi', body: 'Hello', isHTML: false });

    const copy = store.duplicateTemplate(t.id)!;
    expect(created).toHaveBeenLastCalledWith(expect.objectContaining({ id: copy.id }));

    store.updateTemplate(t.id, { subject: 'Hey' });
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: t.id, subject: 'Hey' }));

    store.deleteTemplate(t.id);
    store.deleteTemplate(t.id);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledWith({ templateId: t.id });
  });

  it('reports how many templates an import added, and nothing for a failed one', () => {
    const imported = vi.fn();
    templateHooks.onTemplatesImport.register('test', imported);
    useTemplateStore.getState().importTemplates('not json');
    expect(imported).not.toHaveBeenCalled();

    const json = JSON.stringify({ type: 'webmail-templates', version: 1, templates: [{ ...DATA, id: 'x' }] });
    const { count } = useTemplateStore.getState().importTemplates(json);
    expect(count).toBe(1);
    expect(imported).toHaveBeenCalledWith({ count: 1 });
  });

  it('renders through plugins only when one listens, and keeps fields a plugin got wrong', async () => {
    const input = { subject: 'Hi', html: '<p>Hello</p>', text: 'Hello' };
    expect(await renderTemplateWithPlugins('t1', input)).toBeNull();

    templateHooks.onTemplateRender.register('test', (value: typeof input) => ({ ...value, subject: 42, html: '<p>Changed</p>', text: 'Changed too' }));
    expect(await renderTemplateWithPlugins('t1', input)).toEqual({ subject: 'Hi', html: '<p>Changed</p>', text: 'Changed too' });
  });

  // The composer takes the text in plain-text mode and the HTML in rich mode.
  it('makes the text from the HTML when a plugin changed only the HTML', async () => {
    const input = { subject: 'Hi', html: '<p>Hello</p>', text: 'Hello' };
    templateHooks.onTemplateRender.register('test', (value: typeof input) => ({ ...value, html: '<p>Hello &amp; welcome</p><p>Ann</p>', text: 42 }));
    expect(await renderTemplateWithPlugins('t1', input)).toEqual({
      subject: 'Hi', html: '<p>Hello &amp; welcome</p><p>Ann</p>', text: 'Hello & welcome\n\nAnn',
    });
  });

  it('makes the HTML from the text when a plugin changed only the text', async () => {
    const input = { subject: 'Hi', html: '<p>Hello</p>', text: 'Hello' };
    templateHooks.onTemplateRender.register('test', (value: typeof input) => ({ ...value, text: 'Hello <team>\nAnn' }));
    expect(await renderTemplateWithPlugins('t1', input)).toEqual({
      subject: 'Hi', html: '<p>Hello &lt;team&gt;<br>Ann</p>', text: 'Hello <team>\nAnn',
    });
  });
});
