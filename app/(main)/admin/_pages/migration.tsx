'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsSection, SettingItem, ToggleSwitch, SectionNav } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { useAdminFeedback } from '@/components/admin/feedback';
import { inputClass } from '@/components/admin/config-items';
import { MigrationSourcesSection } from '@/components/admin/migration/sources-section';
import { MigrationsSection } from '@/components/admin/migration/migrations-section';
import { MIGRATION_API, postMigration, type MigrationOverview } from '@/components/admin/migration/shared';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { apiFetch } from '@/lib/browser-navigation';
import type { MigrationOptions } from '@/lib/migration/types';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { cn } from '@/lib/utils';

const PAGE = adminPageDef('migration');
/** How often the page looks again while an account is being copied. */
const REFRESH_MS = 5000;

interface OptionsDraft {
  concurrency: string;
  forgetAfterDays: string;
  allowUserServers: boolean;
}

function optionsToDraft(o: MigrationOptions): OptionsDraft {
  return { concurrency: String(o.concurrency), forgetAfterDays: String(o.forgetAfterDays), allowUserServers: o.allowUserServers };
}

export function MigrationPage() {
  const [overview, setOverview] = useState<MigrationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped on every load, so an open account list asks again too.
  const [refreshKey, setRefreshKey] = useState(0);
  const [draft, setDraft] = useState<OptionsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const setMessage = useAdminFeedback();
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(MIGRATION_API);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as MigrationOverview;
      if (!mounted.current) return;
      setOverview(data);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const running = !!overview?.migrations.some((m) => m.running);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const saved = overview ? optionsToDraft(overview.options) : null;
  const shown = draft ?? saved;
  const dirty = !!draft && !!saved && (draft.concurrency !== saved.concurrency || draft.forgetAfterDays !== saved.forgetAfterDays || draft.allowUserServers !== saved.allowUserServers);
  useAdminUnsavedChanges('migration', dirty);

  function change(patch: Partial<OptionsDraft>) {
    if (!shown) return;
    setDraft({ ...shown, ...patch });
  }

  async function saveOptions(): Promise<void> {
    if (!draft) return;
    const concurrency = Number(draft.concurrency);
    const days = Number(draft.forgetAfterDays);
    // The server would quietly fall back to the defaults.
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      setMessage({ type: 'error', text: 'Accounts copied at the same time: enter a number from 1 to 10.' });
      return;
    }
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setMessage({ type: 'error', text: 'Forget source passwords after: enter 1 to 365 days.' });
      return;
    }
    setSaving(true);
    try {
      const result = await postMigration({
        action: 'save-options',
        options: {
          concurrency,
          forgetAfterDays: days,
          allowUserServers: draft.allowUserServers,
        },
      });
      if (!result.ok) {
        setMessage({ type: 'error', text: `Couldn't save: ${result.error}` });
        return;
      }
      setDraft(null);
      setMessage({ type: 'success', text: 'Migration options saved.' });
      await load();
    } finally {
      setSaving(false);
    }
  }

  const header = <AdminPageHeader title={PAGE.label} description={PAGE.description} />;

  if (!loading && !overview) {
    return (
      <div>
        {header}
        <EmptyState
          title="Could not load the mailbox migration"
          action={<Button type="button" size="sm" onClick={() => { setLoading(true); void load(); }}>Retry</Button>}
        />
      </div>
    );
  }

  if (!overview || !shown) {
    return (
      <div>
        {header}
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  return (
    <div>
      {header}

      <div className="space-y-10">
        <SectionNav />

        <MigrationSourcesSection sources={overview.sources} onChanged={load} />

        <MigrationsSection
          masterConfigured={overview.masterConfigured}
          sources={overview.sources}
          migrations={overview.migrations}
          refreshKey={refreshKey}
          onChanged={load}
        />

        <SettingsSection id="options" title="Options">
          <SettingItem label="Accounts copied at the same time" description="More finish sooner but load the old server and Stalwart more. 1 to 10.">
            <input
              type="number"
              min={1}
              max={10}
              value={shown.concurrency}
              onChange={(e) => change({ concurrency: e.target.value })}
              aria-label="Accounts copied at the same time"
              className={cn(inputClass, 'w-24')}
            />
          </SettingItem>
          <SettingItem
            label="Forget source passwords after"
            description="Unfinished migrations delete their stored passwords this many days after their last pass. New items can't be copied after that."
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={365}
                value={shown.forgetAfterDays}
                onChange={(e) => change({ forgetAfterDays: e.target.value })}
                aria-label="Forget source passwords after"
                className={cn(inputClass, 'w-24')}
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
          </SettingItem>
          <SettingItem
            label="Let users enter any server"
            description="Users can move their mailbox from a server you have not set up here. Only servers on the public internet are allowed."
          >
            <ToggleSwitch checked={shown.allowUserServers} onChange={(checked) => change({ allowUserServers: checked })} />
          </SettingItem>
        </SettingsSection>
      </div>

      <AdminSaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void saveOptions()}
        onDiscard={() => setDraft(null)}
        saveLabel="Save"
      />
    </div>
  );
}
