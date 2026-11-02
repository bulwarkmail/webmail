'use client';
import { useEffect, useRef, useId, type ReactNode } from 'react';
import { acquireWorkspaceViews } from './workspace-views';
import { useWorkspacePreferences } from './workspace-preferences';
import { FOCUS_MODES } from './plugins/focus-inbox/views';
import { useSettingsStore } from '../stores/settings-store';
import { useMessageListTabsStore } from '../stores/message-list-tabs-store';
import { PanelRight, List, Rows3, Settings, Keyboard, Zap, X } from '../components/icons';

const control = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-ring';

export function WorkspaceToolbar({ title, onShortcuts, searchActions, context, onClearSearch }: { title: string; onShortcuts: () => void; searchActions?: ReactNode; context?:string; onClearSearch?:()=>void }) {
  useEffect(acquireWorkspaceViews, []);
  const density = useSettingsStore(s => s.density);
  const readingWidth = useSettingsStore(s => s.readingWidth);
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
    <div className="min-w-0 flex-1 basis-full sm:basis-auto"><p title={context} className="mb-1 truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{context ?? 'Your workspace'}</p><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-2xl font-semibold tracking-tight">{title}</h2>{onClearSearch && <button type="button" onClick={onClearSearch} aria-label="Clear search and filters" className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><X className="size-3.5" aria-hidden="true" />Clear</button>}</div></div>
    <div className="flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-start" role="group" aria-label="Mail workspace layout">
      {searchActions}
      <button type="button" className={control} aria-label="Triage layout" title="Focus layout, compact rows, no sender avatars and comfortable reading width" aria-pressed={layout === 'focus' && density === 'compact' && readingWidth === 'comfortable' && !preferences.showSenderAvatars} onClick={() => { update('mailLayout', 'focus'); update('density', 'compact'); update('readingWidth', 'comfortable'); preferences.configure({showSenderAvatars:false}); }}><Zap className="size-4" aria-hidden="true" /><span className="hidden lg:inline">Triage</span></button>
      <button type="button" aria-label="Compact conversations" title="Compact conversations" aria-pressed={density === 'compact'} onClick={() => update('density', density === 'compact' ? 'regular' : 'compact')} className={control}><Rows3 className="size-4" aria-hidden="true" /></button>
      <div className="hidden items-center rounded-lg border border-border p-0.5 md:flex">
        <button type="button" aria-pressed={layout === 'focus'} onClick={() => update('mailLayout', 'focus')} className={control}><List className="size-4" aria-hidden="true" />Focus</button>
        <button type="button" aria-pressed={layout === 'split'} onClick={() => update('mailLayout', 'split')} className={control}><PanelRight className="size-4" aria-hidden="true" />Split</button>
      </div>
      <details ref={menu} className="group" data-keyboard-layer onBlur={event=>{
        if(event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) menu.current?.removeAttribute('open');
      }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus(); }
      }}>
        <summary className={`${control} cursor-pointer list-none [&::-webkit-details-marker]:hidden`} aria-label="Inbox view rules" title="Inbox view rules"><Settings className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Views</span></summary>
        <section aria-label="Inbox view rules" className="absolute end-3 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg overflow-y-auto max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mt-0 max-sm:w-auto max-sm:max-w-none max-sm:max-h-[calc(100dvh-6rem)]">
          <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Workspace preferences</h3><button type="button" aria-label="Close workspace preferences" className={control} onClick={()=>{menu.current?.removeAttribute('open');menu.current?.querySelector('summary')?.focus();}}><X className="size-4" aria-hidden="true" /></button></div>
          <label className="mt-3 flex min-h-11 items-center justify-between gap-3 text-sm">Comfortable reading width<input type="checkbox" checked={readingWidth === 'comfortable'} onChange={e => update('readingWidth', e.target.checked ? 'comfortable' : 'full')} className="size-4 accent-primary" /></label>
          <label className="mt-2 flex min-h-11 items-center justify-between gap-3 text-sm">Sender avatars in wide lists<input type="checkbox" checked={preferences.showSenderAvatars} onChange={e => preferences.configure({showSenderAvatars:e.target.checked})} className="size-4 accent-primary" /></label>
          <div className="my-3 border-t border-border" />
          <h4 className="text-sm font-semibold">Inbox views</h4>
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
      <button type="button" onClick={onShortcuts} className={control} title="Keyboard shortcuts" aria-label="Keyboard shortcuts"><Keyboard className="size-4" aria-hidden="true" /></button>
    </div>
  </header>;
}
