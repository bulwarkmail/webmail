"use client";

// The proofreading control in the composer's toolbar: "3 issues", or why
// nothing is checked (off, paused for a signed or encrypted message, the
// checker is unavailable). It opens a panel with:
// - the switch for this message, or "Required by your organisation";
// - what is sent where, before the user turns proofreading on;
// - every issue, each a button: in the rich editor it selects the word and
//   opens its popup, in the plain-text composer it shows the suggestions in
//   place (a textarea can't underline).
// The count is read out politely when it settles, never each underline.

import { useEffect, useId, useRef } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2, Lock, SpellCheck } from "@/components/icons";
import { ToggleSwitch } from "@/components/settings/settings-section";
import { announce } from "@/lib/announce";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { formatShortcutCombo } from "@/lib/shortcut-keys";
import type { Proofreading } from "./use-proofreading";
import { IssueActions, KIND_DOT, issueListLabel } from "./issue-actions";

interface Props {
  proofreading: Proofreading;
  plainTextMode: boolean;
}

export const NEXT_ISSUE_KEYS = "Mod + '";
export const PREVIOUS_ISSUE_KEYS = "Mod + ;";

export function ProofreadingStatus({ proofreading, plainTextMode }: Props) {
  const t = useTranslations("proofreading");
  const { status, issues, panel, setPanel } = proofreading;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const open = panel !== null;

  // The count, read out when it settles.
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (!status.on || status.paused || status.checking) return;
    if (lastCount.current === status.count) return;
    lastCount.current = status.count;
    announce(t("announce_count", { count: status.count }), { key: "proofreading-count", debounceMs: 1500 });
  }, [status.on, status.paused, status.checking, status.count, t]);

  // Opening the panel from the keyboard focuses the issue asked for, or the first control.
  useEffect(() => {
    if (!panel) return;
    const root = panelRef.current;
    if (!root) return;
    const target = panel.focusKey
      ? root.querySelector<HTMLElement>(`[data-issue-key="${CSS.escape(panel.focusKey)}"]`)
      : null;
    (target ?? root.querySelector<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])"))?.focus();
  }, [panel]);

  // A click outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setPanel(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, setPanel]);

  if (!status.available) return null;

  let icon = <SpellCheck className="h-4 w-4" aria-hidden="true" />;
  let label: string;
  let tone = "text-muted-foreground";
  if (!status.on) {
    label = t("status.off");
  } else if (status.paused) {
    icon = <Lock className="h-4 w-4" aria-hidden="true" />;
    label = t("status.paused");
  } else if (status.trouble) {
    icon = <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
    label = status.trouble.status === "paused" ? t("status.rate_limited") : t("status.unavailable");
  } else if (status.checking && status.count === 0) {
    icon = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
    label = t("status.checking");
  } else {
    label = t("status.issues", { count: status.count });
    if (status.count > 0) tone = "text-foreground";
  }

  const close = (refocus: boolean) => {
    setPanel(null);
    if (refocus) buttonRef.current?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="proofreading-status"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={t("status.title")}
        onClick={() => setPanel(open ? null : { focusKey: null })}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-10",
          tone,
        )}
      >
        {icon}
        <span className="whitespace-nowrap">{label}</span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t("panel.title")}
          data-testid="proofreading-panel"
          className="absolute bottom-full start-0 z-50 mb-1 flex max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
          }}
        >
          <PanelBody proofreading={proofreading} plainTextMode={plainTextMode} issues={issues} onDone={() => close(false)} />
        </div>
      )}
    </div>
  );
}

function PanelBody({ proofreading, plainTextMode, issues, onDone }: Props & { issues: Proofreading["issues"]; onDone: () => void }) {
  const t = useTranslations("proofreading");
  const { status, composerOn, setComposerOn } = proofreading;
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const noticeSeen = useSettingsStore((s) => s.proofreadingNoticeSeen);
  const checkers = (status.on ? status.activePlugins : status.availablePlugins);
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(checkers.map((c) => c.label));

  const turnOn = () => {
    updateSetting("proofreading", true);
    updateSetting("proofreadingNoticeSeen", { ...noticeSeen, ...Object.fromEntries(checkers.map((c) => [c.pluginId, true])) });
    if (!composerOn) setComposerOn(true);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("panel.title")}</h2>
        {status.forced ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden="true" />
            {t("panel.required")}
          </span>
        ) : status.userOn ? (
          <label className="flex items-center gap-2 text-xs">
            <span>{t("panel.check_message")}</span>
            <ToggleSwitch checked={composerOn} onChange={setComposerOn} ariaLabel={t("panel.check_message")} testId="proofreading-composer-switch" />
          </label>
        ) : null}
      </div>

      {!status.userOn && !status.forced && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t("panel.notice", { checkers: names })}</p>
          <button
            type="button"
            data-testid="proofreading-turn-on"
            onClick={turnOn}
            className="self-start rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("panel.turn_on")}
          </button>
        </div>
      )}

      {status.on && status.paused && (
        <p className="text-sm text-muted-foreground">
          {status.paused.reason === "unknown" ? t("panel.paused_unknown", { plugin: status.paused.pluginName }) : t("panel.paused_protected")}
        </p>
      )}

      {status.on && !status.paused && status.trouble && (
        <p className="text-sm text-muted-foreground" role="status">
          {t(status.trouble.status === "paused" ? "panel.rate_limited" : "panel.unavailable", { checker: status.trouble.label })}
          {status.trouble.message && <span className="block text-xs" dir="auto">{status.trouble.message}</span>}
        </p>
      )}

      {status.on && !status.paused && (
        issues.length === 0 ? (
          !status.trouble && <p className="text-sm text-muted-foreground">{status.checking ? t("status.checking") : t("panel.no_issues")}</p>
        ) : (
          <ul aria-label={t("panel.list_label")} className="flex flex-col gap-1" data-testid="proofreading-issue-list">
            {issues.map((issue) => (
              <li key={issue.key}>
                {plainTextMode ? (
                  <PlainIssue issue={issue} proofreading={proofreading} />
                ) : (
                  <button
                    type="button"
                    data-issue-key={issue.key}
                    aria-label={issueListLabel(t, issue)}
                    onClick={() => { onDone(); proofreading.jumpTo(issue); }}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", KIND_DOT[issue.kind])} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <bdi className="font-medium">{issue.annotation.text}</bdi>
                      {issue.annotation.replacements[0] && (
                        <> <span aria-hidden="true">→</span> <bdi>{issue.annotation.replacements[0]}</bdi></>
                      )}
                      <span className="block truncate text-xs text-muted-foreground" dir="auto">{issue.annotation.shortMessage ?? issue.annotation.message}</span>
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {status.on && (
        <p className="text-xs text-muted-foreground">
          {t("panel.shortcuts", { next: formatShortcutCombo(NEXT_ISSUE_KEYS), previous: formatShortcutCombo(PREVIOUS_ISSUE_KEYS) })}
        </p>
      )}
    </>
  );
}

function PlainIssue({ issue, proofreading }: { issue: Proofreading["issues"][number]; proofreading: Proofreading }) {
  const t = useTranslations("proofreading");
  return (
    <div
      tabIndex={-1}
      data-issue-key={issue.key}
      aria-label={issueListLabel(t, issue)}
      className="rounded-md border border-border p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <IssueActions issue={issue} showWord onApply={(i, r) => { proofreading.apply(i, r); }} onDismiss={proofreading.dismiss} />
    </div>
  );
}
