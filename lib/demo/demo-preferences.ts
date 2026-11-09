import { useSettingsStore } from '@/stores/settings-store';
import { useTemplateStore } from '@/stores/template-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEMO_KEYWORDS } from './fixtures/keywords';
import { createDemoTemplates } from './fixtures/templates';
import { DEMO_SIGNATURE_DETAILS } from './fixtures/identities';

/** Bump when the seeded preferences change, so returning visitors get them. */
const SEED_VERSION = '2026-11';
export const DEMO_SEED_KEY = 'bulwark-demo-seed';

/**
 * Device-local preferences the demo needs to show its data: the persona's
 * tags, tasks switched on, the merged inbox across both demo accounts, and
 * a few templates. Runs once per device per version, so a visitor's own
 * changes survive a reload; "Reset demo" clears storage and seeds again.
 */
export function seedDemoPreferences(): void {
  // The merged views across accounts are gated off by default and nobody
  // administers the demo; the demo's second account and shared mailbox exist
  // for those views, so switch the gate on for this session.
  usePolicyStore.getState().setDemoFeatureOverrides({ unifiedCrossAccountEnabled: true });

  let seeded: string | null = null;
  try { seeded = localStorage.getItem(DEMO_SEED_KEY); } catch { /* storage blocked */ }
  if (seeded === SEED_VERSION) return;

  const settings = useSettingsStore.getState();
  settings.updateSetting('emailKeywords', DEMO_KEYWORDS);
  settings.updateSetting('enableCalendarTasks', true);
  settings.updateSetting('enableUnifiedMailbox', true);
  settings.updateSetting('unifiedCrossAccount', true);
  settings.updateSetting('includeGroupInUnified', true);
  // Fills the organisation signature, when an administrator sets one.
  settings.updateSetting('signatureDetails', DEMO_SIGNATURE_DETAILS);

  const templates = useTemplateStore.getState();
  if (templates.templates.length === 0) {
    useTemplateStore.setState({ templates: createDemoTemplates() });
  }

  try { localStorage.setItem(DEMO_SEED_KEY, SEED_VERSION); } catch { /* storage blocked */ }
}
