"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { SettingsSection, ToggleSwitch } from "./settings-section";
import { Button } from "@/components/ui/button";
import { FilterRuleModal } from "@/components/filters/filter-rule-modal";
import { SieveEditorModal } from "@/components/filters/sieve-editor-modal";
import { useFilterStore } from "@/stores/filter-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import type { FilterRule } from "@/lib/jmap/sieve-types";
import { useVacationStore } from "@/stores/vacation-store";
import {
  Plus,
  GripVertical,
  X,
  Code,
  AlertTriangle,
  Loader2,
  Filter,
  RotateCcw,
  PalmtreeIcon,
  Lock,
} from "lucide-react";

function isReadonlyRule(r: FilterRule): boolean {
  return r.origin === "external" || r.origin === "opaque";
}

function RuleSummary({ rule }: { rule: FilterRule }) {
  const t = useTranslations("settings.filters");

  const conditions = rule.conditions.slice(0, 2).map((c) => {
    const field = t(`condition_fields.${c.field}`);
    const comparator = t(`comparators.${c.comparator}`);
    return `${field} ${comparator} "${c.value}"`;
  });

  const joiner = rule.matchType === "all" ? t("and") : t("or");

  const extra = rule.conditions.length > 2
    ? ` (+${rule.conditions.length - 2})`
    : "";

  const actions = rule.actions.slice(0, 2).map((a) => {
    const action = t(`action_types.${a.type}`);
    return a.value ? `${action} "${a.value}"` : action;
  });

  return (
    <div className="text-xs text-muted-foreground break-words">
      <span className="inline">
        {conditions.map((cond, i) => (
          <span key={i}>
            {i > 0 && <span className="italic opacity-70"> {joiner} </span>}
            {cond}
          </span>
        ))}
        {extra}
      </span>
      <span className="mx-1 opacity-50">→</span>
      <span className="inline">
        {actions.map((act, i) => (
          <span key={i}>
            {i > 0 && ", "}
            {act}
          </span>
        ))}
      </span>
    </div>
  );
}

function VisualRuleSummary({ rule }: { rule: FilterRule }) {
  const t = useTranslations("settings.filters");

  const joiner = rule.matchType === "all" ? t("and") : t("or");
  const matchLabel = rule.matchType === "all" ? t("match_all_conditions") : t("match_any_condition");

  return (
    <div className="mt-1.5 space-y-1 text-xs">
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-500 dark:text-blue-400">
          {t("if")}
        </span>
        {rule.conditions.map((c, i) => {
          const field = t(`condition_fields.${c.field}`);
          const comparator = t(`comparators.${c.comparator}`);
          return (
            <span key={i} className="contents">
              {i > 0 && (
                <span className="text-[10px] text-muted-foreground/70 italic">{joiner}</span>
              )}
              <span className="inline-flex items-baseline gap-1 px-1.5 py-px rounded-sm bg-muted/60 text-foreground">
                <span className="font-medium text-blue-600 dark:text-blue-400">{field}</span>
                <span className="text-muted-foreground">{comparator}</span>
                <span className="text-foreground">“{c.value}”</span>
              </span>
            </span>
          );
        })}
        <span className="text-[10px] text-muted-foreground/60 italic">({matchLabel})</span>
      </div>

      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500 dark:text-emerald-400">
          {t("then")}
        </span>
        {rule.actions.map((a, i) => {
          const action = t(`action_types.${a.type}`);
          return (
            <span key={i} className="contents">
              {i > 0 && (
                <span className="text-muted-foreground/50">›</span>
              )}
              <span className="inline-flex items-baseline gap-1 px-1.5 py-px rounded-sm bg-muted/60 text-foreground">
                <span className="font-medium text-emerald-600 dark:text-emerald-400">{action}</span>
                {a.value && <span className="text-muted-foreground">“{a.value}”</span>}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function FilterSettings() {
  const t = useTranslations("settings.filters");
  const tNotifications = useTranslations("notifications");
  const { client } = useAuthStore();
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const expandedFilterView = useSettingsStore((s) => s.expandedFilterView);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const {
    rules,
    isLoading,
    isSaving,
    error,
    isSupported,
    isOpaque,
    rawScript,
    vacationSettings,
    fetchFilters,
    saveFilters,
    addRule,
    updateRule,
    deleteRule,
    reorderRules,
    toggleRule,
    setRawScript,
    resetToVisualBuilder,
    validateScript,
  } = useFilterStore();

  const vacationEnabled = useVacationStore((s) => s.isEnabled) || vacationSettings?.isEnabled;

  const [editingRule, setEditingRule] = useState<FilterRule | undefined>();
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [showSieveEditor, setShowSieveEditor] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const draggedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    if (client && isSupported) {
      void fetchFilters(client);
    }
  }, [client, isSupported, fetchFilters]);

  const handleToggle = useCallback(
    async (ruleId: string) => {
      toggleRule(ruleId);
      if (client) {
        try {
          await saveFilters(client);
        } catch {
          toggleRule(ruleId);
          toast.error(tNotifications("filters_save_failed"));
        }
      }
    },
    [client, toggleRule, saveFilters, tNotifications]
  );

  const handleDelete = useCallback(
    async (ruleId: string) => {
      const deletedRule = rules.find((r) => r.id === ruleId);
      deleteRule(ruleId);
      setDeleteConfirmId(null);
      if (client) {
        try {
          await saveFilters(client);
          toast.success(tNotifications("filters_deleted"));
        } catch {
          if (deletedRule) addRule(deletedRule);
          toast.error(tNotifications("filters_save_failed"));
        }
      }
    },
    [client, rules, deleteRule, addRule, saveFilters, tNotifications]
  );

  const handleSaveRule = useCallback(
    async (rule: FilterRule) => {
      const previousRules = [...rules];
      if (editingRule) {
        updateRule(rule.id, rule);
      } else {
        addRule(rule);
      }
      setShowRuleModal(false);
      setEditingRule(undefined);

      if (client) {
        try {
          await saveFilters(client);
        } catch {
          useFilterStore.setState({ rules: previousRules });
          toast.error(tNotifications("filters_save_failed"));
        }
      }
    },
    [editingRule, updateRule, addRule, rules, client, saveFilters, tNotifications]
  );

  const handleSaveSieve = useCallback(
    async (content: string) => {
      setRawScript(content);
      useFilterStore.setState({ isOpaque: true, rules: [] });
      if (client) {
        try {
          await saveFilters(client);
          toast.success(tNotifications("filters_saved"));
          setShowSieveEditor(false);
        } catch {
          toast.error(tNotifications("filters_save_failed"));
        }
      }
    },
    [client, setRawScript, saveFilters, tNotifications]
  );

  const handleResetToVisual = useCallback(async () => {
    if (!showResetConfirm) {
      setShowResetConfirm(true);
      return;
    }
    resetToVisualBuilder();
    setShowResetConfirm(false);
    if (client) {
      try {
        await saveFilters(client);
        toast.success(tNotifications("filters_saved"));
      } catch {
        toast.error(tNotifications("filters_save_failed"));
      }
    }
  }, [showResetConfirm, resetToVisualBuilder, client, saveFilters, tNotifications]);

  const handleValidate = useCallback(
    async (content: string) => {
      if (!client) return { isValid: false, errors: ["No client"] };
      return validateScript(client, content);
    },
    [client, validateScript]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, index: number) => {
      draggedIndexRef.current = index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    []
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverIndex(index);
    },
    []
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault();
      setDragOverIndex(null);
      const fromIndex = draggedIndexRef.current;
      if (fromIndex === null || fromIndex === dropIndex) return;

      const previousOrder = rules.map((r) => r.id);
      const newOrder = [...previousOrder];
      const [moved] = newOrder.splice(fromIndex, 1);
      newOrder.splice(dropIndex, 0, moved);
      reorderRules(newOrder);

      if (client) {
        try {
          await saveFilters(client);
        } catch {
          reorderRules(previousOrder);
          toast.error(tNotifications("filters_save_failed"));
        }
      }
    },
    [rules, reorderRules, client, saveFilters, tNotifications]
  );

  const handleDragEnd = useCallback(() => {
    draggedIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  if (!isSupported) {
    return (
      <SettingsSection title={t("title")} description={t("description")}>
        <div className="text-sm text-muted-foreground py-4">
          {t("not_supported")}
        </div>
      </SettingsSection>
    );
  }

  if (isLoading) {
    return (
      <SettingsSection title={t("title")} description={t("description")}>
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t("loading")}
        </div>
      </SettingsSection>
    );
  }

  if (error) {
    return (
      <SettingsSection title={t("title")} description={t("description")}>
        <div className="text-sm text-red-600 dark:text-red-400 py-4">
          {t("fetch_error")}
        </div>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection title={t("title")} description={t("description")}>
        {isOpaque && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p>{t("opaque_warning")}</p>
              <div className="flex gap-3 mt-2">
                <button
                  type="button"
                  onClick={() => setShowSieveEditor(true)}
                  className="text-primary hover:underline font-medium"
                >
                  {t("open_sieve_editor")}
                </button>
                {showResetConfirm ? (
                  <span className="flex items-center gap-2">
                    <span className="text-red-600 dark:text-red-400">{t("reset_warning")}</span>
                    <button
                      type="button"
                      onClick={handleResetToVisual}
                      className="text-red-600 dark:text-red-400 hover:underline font-medium"
                    >
                      {t("confirm_reset")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowResetConfirm(false)}
                      className="text-muted-foreground hover:underline"
                    >
                      {t("cancel")}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleResetToVisual}
                    className="text-red-600 dark:text-red-400 hover:underline font-medium flex items-center gap-1"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {t("reset_to_visual")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {!isOpaque && vacationEnabled && (
          <button
            type="button"
            onClick={() => {
              try { localStorage.setItem('settings-active-tab', 'vacation'); } catch { /* ignore */ }
              window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: 'vacation' }));
            }}
            className="flex items-center gap-3 w-full p-3 rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors text-left"
          >
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/40">
              <PalmtreeIcon className="w-4 h-4 text-green-600 dark:text-green-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                {t("vacation_active")}
              </p>
              <p className="text-xs text-green-600/70 dark:text-green-400/70">
                {t("vacation_active_description")}
              </p>
            </div>
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">
              {t("vacation_configure")} &rarr;
            </span>
          </button>
        )}

        {!isOpaque && rules.length === 0 && !vacationEnabled && (
          <div className="flex flex-col items-center py-8 text-muted-foreground">
            <Filter className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">{t("no_rules")}</p>
          </div>
        )}

        {!isOpaque && rules.length > 0 && (
          <div className="space-y-1" role="list" aria-label={t("rule_list")}>
            {rules.map((rule, index) => {
              const readonly = isReadonlyRule(rule);

              if (readonly) {
                const label = rule.originLabel || t("origin_external");
                const tooltip = t("managed_by_tooltip", { source: label });
                const hasStructuredSummary =
                  rule.origin === "external" &&
                  rule.conditions.length > 0 &&
                  rule.actions.length > 0;
                return (
                  <div
                    key={rule.id}
                    role="listitem"
                    className="flex items-start gap-3 p-3 rounded-md border border-border"
                    title={tooltip}
                  >
                    <div className="pt-0.5 text-muted-foreground" aria-label={tooltip}>
                      <Lock className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate">
                          {rule.name}
                        </p>
                        <span className="inline-flex items-baseline px-1.5 py-px rounded-sm bg-muted/60 text-muted-foreground text-[10px]">
                          {label}
                        </span>
                      </div>
                      {hasStructuredSummary ? (
                        expandedFilterView ? (
                          <VisualRuleSummary rule={rule} />
                        ) : (
                          <RuleSummary rule={rule} />
                        )
                      ) : rule.rawBlock ? (
                        <pre className="mt-1.5 text-xs font-mono whitespace-pre-wrap break-all text-muted-foreground bg-muted rounded p-2 max-h-32 overflow-y-auto">
                          {rule.rawBlock.trim()}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={rule.id}
                  role="listitem"
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-start gap-3 p-3 rounded-md border transition-colors ${
                    dragOverIndex === index
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  } ${!rule.enabled ? "opacity-60" : ""}`}
                >
                  <div
                    className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground pt-0.5"
                    aria-label={t("drag_to_reorder")}
                  >
                    <GripVertical className="w-4 h-4" />
                  </div>

                  <div className="pt-0.5">
                    <ToggleSwitch
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule.id)}
                    />
                  </div>

                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => {
                      setEditingRule(rule);
                      setShowRuleModal(true);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditingRule(rule);
                        setShowRuleModal(true);
                      }
                    }}
                  >
                    <p className="text-sm font-medium text-foreground truncate">
                      {rule.name}
                    </p>
                    {expandedFilterView ? (
                      <VisualRuleSummary rule={rule} />
                    ) : (
                      <RuleSummary rule={rule} />
                    )}
                  </div>

                  {deleteConfirmId === rule.id ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(rule.id)}
                      >
                        {t("confirm_delete")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteConfirmId(null)}
                      >
                        {t("cancel")}
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(rule.id)}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      aria-label={t("delete_rule")}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {!isOpaque && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingRule(undefined);
                setShowRuleModal(true);
              }}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t("add_rule")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSieveEditor(true)}
          >
            <Code className="w-4 h-4 mr-1" />
            {t("raw_editor")}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          {isSaving && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("saving")}
            </div>
          )}
          {!isOpaque && rules.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("expanded_view")}</span>
              <ToggleSwitch
                checked={expandedFilterView}
                onChange={(v) => updateSetting("expandedFilterView", v)}
              />
            </div>
          )}
        </div>
      </div>

      {showRuleModal && (
        <FilterRuleModal
          rule={editingRule}
          mailboxes={mailboxes}
          onSave={handleSaveRule}
          onClose={() => {
            setShowRuleModal(false);
            setEditingRule(undefined);
          }}
        />
      )}

      {showSieveEditor && (
        <SieveEditorModal
          content={rawScript}
          onSave={handleSaveSieve}
          onClose={() => setShowSieveEditor(false)}
          onValidate={handleValidate}
        />
      )}
    </div>
  );
}
