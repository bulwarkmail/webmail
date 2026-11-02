'use client';
import { useEffect, useRef, useId } from 'react';
import { acquireWorkspaceViews } from './workspace-views';
import { useWorkspacePreferences } from './workspace-preferences';
import { FOCUS_MODES } from './plugins/focus-inbox/views';
import { useSettingsStore } from '../stores/settings-store';
import { useMessageListTabsStore } from '../stores/message-list-tabs-store';
import { PanelRight, List, Rows3, Settings } from '../components/icons';

const control = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-ring';

export function WorkspaceToolbar({ title }: { title: string }) {
  useEffect(acquireWorkspaceViews, []);
  const density = useSettingsStore(s => s.density);
  const layout = useSettingsStore(s => s.mailLayout);
  const update = useSettingsStore(s => s.updateSetting);
  const preferences = useWorkspacePreferences();
  const foreignProvider = useMessageListTabsStore(s => Object.keys(s.registrations).some(id => id !== 'memail-workspace'));
  const modeId = useId();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  return <header className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-background px-4 py-3 sm:px-6">
    <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h2>
    <div className="flex items-center gap-1" role="group" aria-label="Mail workspace layout">
      <button type="button" aria-label="Compact conversations" title="Compact conversations" aria-pressed={density === 'compact'} onClick={() => update('density', density === 'compact' ? 'regular' : 'compact')} className={control}><Rows3 className="size-4" aria-hidden="true" /></button>
      <div className="hidden items-center rounded-lg border border-border p-0.5 md:flex">
        <button type="button" aria-pressed={layout === 'focus'} onClick={() => update('mailLayout', 'focus')} className={control}><List className="size-4" aria-hidden="true" />Focus</button>
        <button type="button" aria-pressed={layout === 'split'} onClick={() => update('mailLayout', 'split')} className={control}><PanelRight className="size-4" aria-hidden="true" />Split</button>
      </div>
      <details ref={menu} className="group" onKeyDown={event => {
        if (event.key === 'Escape') { menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus(); }
      }}>
        <summary className={`${control} cursor-pointer list-none [&::-webkit-details-marker]:hidden`} aria-label="Inbox view rules" title="Inbox view rules"><Settings className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Views</span></summary>
        <section aria-label="Inbox view rules" className="absolute end-3 top-full z-40 mt-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <h3 className="font-semibold">Inbox views</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Filter your inbox without moving mail. All inbox always includes every inbox conversation.</p>
          {foreignProvider ? <p role="status" className="mt-4 text-sm">An installed category provider controls your inbox views. Its rules take priority.</p> : <>
            <label className="mt-4 flex min-h-11 items-center justify-between gap-3 text-sm">Show inbox views<input type="checkbox" checked={preferences.enabled} onChange={e => preferences.configure({enabled:e.target.checked})} className="size-4 accent-primary" /></label>
            <label className="mt-3 block text-sm font-medium" htmlFor={modeId}>Focus includes</label>
            <select id={modeId} disabled={!preferences.enabled} value={preferences.focusMode} onChange={e => preferences.configure({focusMode:e.target.value as typeof preferences.focusMode})} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50">
              {FOCUS_MODES.map(mode => <option key={mode}>{mode}</option>)}
            </select>
            <label className="mt-3 flex min-h-11 items-center justify-between gap-3 text-sm">Show newsletters<input type="checkbox" disabled={!preferences.enabled} checked={preferences.showNewsletters} onChange={e => preferences.configure({showNewsletters:e.target.checked})} className="size-4 accent-primary" /></label>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Newsletters have a List-Unsubscribe header. Views may overlap. Preferences apply on this device.</p>
          </>}
        </section>
      </details>
    </div>
  </header>;
}
