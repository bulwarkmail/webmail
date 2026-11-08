"use client";

// xenaxio step 124, part C: the person's choice which notifications about tasks they
// get — per kind bell and push, only the bell, or off; the emails about assignment and
// due dates; their tasks in the calendar. Kept on the platform (catalog entry
// "task_notifications", tool set_notification_prefs), shown in the Notifications tab.
import { useEffect, useState } from "react";
import { SettingItem, SettingsSection, Select, ToggleSwitch } from "@/components/settings/settings-section";
import { errorText } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { NOTICE_KINDS, type NoticeLevel, notificationsApi, type NotifyPrefs } from "@/lib/xenaxio/notifications";
import { toast } from "@/stores/toast-store";

export function TaskNotifySettings() {
  return XENAXIO_BFF ? <Settings /> : null;
}

function Settings() {
  const t = useXT();
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);

  useEffect(() => {
    notificationsApi
      .prefs()
      .then(setPrefs)
      .catch(() => setPrefs(null));
  }, []);

  if (!prefs) return null;

  const save = async (change: Parameters<typeof notificationsApi.savePrefs>[0]) => {
    const before = prefs;
    setPrefs({ ...prefs, ...change, kinds: { ...prefs.kinds, ...change.kinds } } as NotifyPrefs);
    try {
      setPrefs(await notificationsApi.savePrefs(change));
    } catch (err) {
      setPrefs(before);
      toast.error(errorText(t, err));
    }
  };

  const levels = (["push", "bell", "off"] as const).map((l) => ({ value: l, label: t(`notices.level.${l}`) }));

  return (
    <SettingsSection id="xenaxio-tasks" title={t("notices.settings_title")} description={t("notices.settings_intro")}>
      {NOTICE_KINDS.map((kind) => (
        <SettingItem key={kind} label={t(`notices.setting.${kind}`)}>
          <Select value={prefs.kinds[kind]} onChange={(v) => void save({ kinds: { [kind]: v as NoticeLevel } })} options={levels} />
        </SettingItem>
      ))}
      <SettingItem label={t("notices.assign_email")}>
        <ToggleSwitch checked={prefs.assignEmail} onChange={(v) => void save({ assignEmail: v })} />
      </SettingItem>
      <SettingItem label={t("notices.due_email")}>
        <ToggleSwitch checked={prefs.dueEmail} onChange={(v) => void save({ dueEmail: v })} />
      </SettingItem>
      <SettingItem label={t("notices.calendar_tasks")}>
        <ToggleSwitch checked={prefs.calendarTasks} onChange={(v) => void save({ calendarTasks: v })} />
      </SettingItem>
    </SettingsSection>
  );
}
