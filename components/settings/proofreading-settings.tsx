"use client";

// Settings > Composing > Proofreading: whether checker plugins may check
// what the user writes (overall and per plugin), and the writing language.
// The admin can preset or lock both (settings policy); locked rows show
// "Set by your organisation", a hidden setting isn't shown.

import { useMemo, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { allCheckers, subscribeCheckers } from "@/lib/plugin-sandbox/checkers";
import { checkerAccess, proofreadingAccess, PROOFREADING_KEY, type PolicyView } from "@/lib/proofreading/gate";
import { writingLanguageOptions } from "@/lib/proofreading/languages";
import { policySettled } from "@/components/email/proofreading/use-proofreading";
import { SettingsSection, SettingItem, Select, ToggleSwitch } from "./settings-section";

export function ProofreadingSettings() {
  const t = useTranslations("proofreading.settings");
  const locale = useLocale();
  const checkers = useSyncExternalStore(subscribeCheckers, allCheckers, allCheckers);
  const proofreading = useSettingsStore((s) => s.proofreading);
  const proofreadingPlugins = useSettingsStore((s) => s.proofreadingPlugins);
  const writingLanguage = useSettingsStore((s) => s.writingLanguage);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const policy = usePolicyStore((s) => s.policy);
  const settled = usePolicyStore(policySettled);
  const view: PolicyView = { restrictions: policy.restrictions ?? {}, defaults: (policy.defaults ?? {}) as Record<string, unknown>, settled };
  const user = { proofreading, proofreadingPlugins };
  const main = proofreadingAccess(view, user);
  const languageLocked = policy.restrictions?.writingLanguage?.locked === true;
  const languageHidden = policy.restrictions?.writingLanguage?.hidden === true;

  // One row per checker plugin, even if it registered several checkers.
  const plugins = useMemo(() => {
    const seen = new Map<string, { pluginId: string; label: string; languages: string[] }>();
    for (const c of checkers) {
      const entry = seen.get(c.pluginId) ?? { pluginId: c.pluginId, label: c.pluginName, languages: [] };
      entry.languages.push(...c.languages);
      seen.set(c.pluginId, entry);
    }
    return [...seen.values()];
  }, [checkers]);
  const languages = useMemo(
    () => writingLanguageOptions(locale, plugins.flatMap((p) => p.languages).filter((l) => l.includes("-"))),
    [locale, plugins],
  );

  if (main.lockedOff && main.hidden && languageHidden) return null;

  return (
    <SettingsSection id="proofreading" title={t("title")} description={t("description")}>
      {!(main.lockedOff && main.hidden) && (
        <SettingItem label={t("enable")} description={plugins.length ? t("enable_description") : t("no_checker")} locked={main.forced || main.lockedOff}>
          <ToggleSwitch
            checked={main.forced || (!main.lockedOff && proofreading)}
            onChange={(checked) => updateSetting(PROOFREADING_KEY, checked)}
            testId="settings-proofreading"
          />
        </SettingItem>
      )}

      {!main.lockedOff && plugins.length > 1 && plugins.map((p) => {
        const access = checkerAccess(view, user, p.pluginId);
        return (
          <SettingItem
            key={p.pluginId}
            nested
            label={p.label}
            description={t("plugin_description", { plugin: p.label })}
            locked={access.forced || access.lockedOff}
          >
            <ToggleSwitch
              checked={access.on}
              onChange={(checked) => updateSetting("proofreadingPlugins", { ...proofreadingPlugins, [p.pluginId]: checked })}
              testId={`settings-proofreading-${p.pluginId}`}
            />
          </SettingItem>
        );
      })}

      {!languageHidden && (
        <SettingItem label={t("writing_language")} description={t("writing_language_description")} locked={languageLocked}>
          <Select
            value={writingLanguage}
            onChange={(value) => updateSetting("writingLanguage", value)}
            options={[{ value: "auto", label: t("auto") }, ...languages]}
          />
        </SettingItem>
      )}
    </SettingsSection>
  );
}
