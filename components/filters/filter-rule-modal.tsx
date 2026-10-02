"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus, Trash2 } from "@/components/icons";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { toast } from "@/stores/toast-store";
import type {
  FilterRule,
  FilterCondition,
  FilterAction,
  FilterConditionField,
  FilterComparator,
  FilterActionType,
} from "@/lib/jmap/sieve-types";
import type { Mailbox } from "@/lib/jmap/types";
import { buildMailboxTree, flattenMailboxTree, type MailboxNode, generateUUID, cn } from "@/lib/utils";
import type { RuleSuggestion } from "@/lib/filters/quick-rules";
import { retroactiveSupport } from "@/lib/filters/retroactive";
import { ruleForwards, ruleStops } from "@/lib/filters/forward-limit";
import { hasPeriod, isPeriodBoundary } from "@/lib/sieve/period";
import { fromWallClock, getEffectiveTimeZone, getWallClock } from "@/lib/timezone";
import { useSettingsStore } from "@/stores/settings-store";
import { useKeywordFormat } from "@/hooks/use-keyword-format";

interface FilterRuleModalProps {
  rule?: FilterRule;
  /**
   * Values a new rule starts from ("Create rule…" on a message). Unlike
   * `rule`, saving creates a rule rather than editing one.
   */
  initialRule?: FilterRule;
  /** Conditions offered as one-click chips above the conditions. */
  suggestions?: RuleSuggestion[];
  /** Offer "Also apply to existing messages in this folder". */
  offerApplyToExisting?: boolean;
  mailboxes: Mailbox[];
  /** Server cap on redirects per message (Sieve `maxNumberRedirects`). */
  maxRedirects?: number | null;
  /**
   * Forwards a message can have collected when it reaches this rule, and
   * the most it can still collect below it when the rule does not stop
   * (see forwardsAround in lib/filters/forward-limit.ts).
   */
  forwardsBefore?: number;
  forwardsAfter?: number;
  /** The server can confine a rule to a period (Sieve "date" and "relational"). */
  periodsSupported?: boolean;
  onSave: (rule: FilterRule, options?: { applyToExisting: boolean }) => void;
  onClose: () => void;
}

const ALL_FIELDS: FilterConditionField[] = [
  "from", "to", "cc", "subject", "header", "size", "body", "attachment", "all",
];

const TEXT_COMPARATORS: FilterComparator[] = [
  "contains", "not_contains", "is", "not_is", "starts_with", "ends_with", "matches",
];

// Address headers can also be compared on the parsed address.
const ADDRESS_COMPARATORS: FilterComparator[] = [...TEXT_COMPARATORS, "address_is", "domain_is"];

const SIZE_COMPARATORS: FilterComparator[] = ["greater_than", "less_than"];

const ATTACHMENT_COMPARATORS: FilterComparator[] = ["has_any", "has_type"];

// "All messages" has nothing to choose: its one comparator is not shown.
const ALL_MESSAGES_COMPARATORS: FilterComparator[] = ["any"];

function comparatorsFor(field: FilterConditionField): FilterComparator[] {
  if (field === "size") return SIZE_COMPARATORS;
  if (field === "attachment") return ATTACHMENT_COMPARATORS;
  if (field === "all") return ALL_MESSAGES_COMPARATORS;
  if (field === "from" || field === "to" || field === "cc") return ADDRESS_COMPARATORS;
  return TEXT_COMPARATORS;
}

const ALL_ACTION_TYPES: FilterActionType[] = [
  "move", "copy", "forward", "mark_read", "star", "add_label", "discard", "reject", "keep", "stop",
];

const ACTIONS_WITH_VALUE = new Set<FilterActionType>(["move", "copy", "forward", "reject", "add_label"]);
const ACTIONS_WITH_MAILBOX = new Set<FilterActionType>(["move", "copy"]);

function makeEmptyCondition(): FilterCondition {
  return { field: "from", comparator: "contains", value: "" };
}

// Multi-value handling: conditions are stored as string | string[]. The UI
// presents them as a single comma-separated text input — the user types
// "a, b, c" and the saved value becomes ["a","b","c"]. Single entries stay
// strings so existing single-value rules don't change shape.
function valueToInputString(v: string | string[]): string {
  if (Array.isArray(v)) return v.join(", ");
  return v;
}

function inputStringToValue(s: string): string | string[] {
  const parts = s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts;
}

function isConditionValueEmpty(v: string | string[]): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => !x.trim());
  return !v.trim();
}

// Conditions that test without a value: "has an attachment" and "all messages".
function takesNoValue(c: Pick<FilterCondition, "field" | "comparator">): boolean {
  return c.field === "all" || (c.field === "attachment" && c.comparator === "has_any");
}

function makeEmptyAction(): FilterAction {
  return { type: "move", value: "" };
}

// A period boundary as the "yyyy-mm-ddThh:mm" a datetime-local input shows,
// read on the clock of the user's time zone - the one dates are shown in.
function toPeriodInput(boundary: string | undefined): string {
  if (!isPeriodBoundary(boundary)) return "";
  const w = getWallClock(new Date(boundary), getEffectiveTimeZone());
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

// The latest moment the period fields offer: a later year has no room in
// the four digits a stored boundary has.
const PERIOD_INPUT_MAX = "9999-12-31T23:59";

// The input's wall-clock time in the user's time zone, as the UTC moment the
// rule stores: undefined for an empty field, null for one that holds no
// usable moment (a five-digit year). A boundary left as the dialog showed it
// is kept exactly: the input shows whole minutes, so reading it back would
// drop a saved second, or pick the other one of the two moments in the hour
// a DST switch repeats.
function fromPeriodInput(value: string, saved: string | undefined): string | null | undefined {
  if (!value) return undefined;
  if (saved !== undefined && value === toPeriodInput(saved)) return saved;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((part) => Number(part ?? 0));
  const moment = fromWallClock({ year, month, day, hour, minute, second }, getEffectiveTimeZone());
  if (Number.isNaN(moment.getTime())) return null;
  const boundary = moment.toISOString();
  return isPeriodBoundary(boundary) ? boundary : null;
}

export function FilterRuleModal({
  rule,
  initialRule,
  suggestions = [],
  offerApplyToExisting = false,
  mailboxes,
  maxRedirects,
  forwardsBefore = 0,
  forwardsAfter = 0,
  periodsSupported = false,
  onSave,
  onClose,
}: FilterRuleModalProps) {
  const t = useTranslations("settings.filters");
  const isEdit = !!rule;
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  const { tagName } = useKeywordFormat();

  const start = rule ?? initialRule;
  const [name, setName] = useState(start?.name || "");
  const [matchType, setMatchType] = useState<"all" | "any">(start?.matchType || "all");
  const [conditions, setConditions] = useState<FilterCondition[]>(
    start?.conditions.length ? [...start.conditions] : [makeEmptyCondition()]
  );
  const [actions, setActions] = useState<FilterAction[]>(
    start?.actions.length ? [...start.actions] : [makeEmptyAction()]
  );
  const [stopProcessing, setStopProcessing] = useState(start?.stopProcessing ?? false);
  const [includeSpam, setIncludeSpam] = useState(start?.includeSpam ?? false);
  const [usedSuggestions, setUsedSuggestions] = useState<ReadonlySet<string>>(new Set());
  const [applyToExisting, setApplyToExisting] = useState(false);
  const hadPeriod = !!start && hasPeriod(start);
  const [periodOn, setPeriodOn] = useState(hadPeriod);
  const [periodStart, setPeriodStart] = useState(toPeriodInput(start?.activeFrom));
  const [periodEnd, setPeriodEnd] = useState(toPeriodInput(start?.activeUntil));
  const periodStartRef = useRef<HTMLInputElement>(null);
  const periodEndRef = useRef<HTMLInputElement>(null);

  const modalRef = useFocusTrap({ isActive: true, onEscape: onClose });

  const { hierarchicalMailboxes, mailboxPathMap } = useMemo(() => {
    const tree = buildMailboxTree(mailboxes.filter((mb) => !mb.isShared));
    const pathMap = new Map<string, string>();
    const buildPaths = (nodes: MailboxNode[], parentPath = "") => {
      for (const node of nodes) {
        // Sieve fileinto expects the IMAP-canonical "INBOX" for the inbox,
        // not the localized JMAP display name (e.g. "Entrada" in pt-BR).
        const segment = node.role === "inbox" ? "INBOX" : node.name;
        const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
        pathMap.set(node.id, fullPath);
        if (node.children.length > 0) buildPaths(node.children, fullPath);
      }
    };
    buildPaths(tree);
    return { hierarchicalMailboxes: flattenMailboxTree(tree), mailboxPathMap: pathMap };
  }, [mailboxes]);

  // Rules saved before folder ids were stored only carry the path; resolve it
  // so the select shows the folder and the next save adds the id.
  const mailboxIdFor = useCallback((action: FilterAction): string => {
    if (action.mailboxId) return action.mailboxId;
    for (const [id, path] of mailboxPathMap) {
      if (path === action.value) return id;
    }
    return "";
  }, [mailboxPathMap]);

  // What counts is the most forwards one message can collect: those of the
  // rules above that let it go on, this rule's, and those below unless this
  // rule stops.
  const forwardCount = ruleForwards({ actions });
  const otherForwards = forwardsBefore + (ruleStops({ actions, stopProcessing }) ? 0 : forwardsAfter);
  const forwardLimit = typeof maxRedirects === "number" && maxRedirects > 0 ? maxRedirects : null;
  const forwardOverLimit = forwardLimit !== null && forwardCount + otherForwards > forwardLimit;

  // While editing, condition.value is always the raw string typed into the
  // input (commas not yet split). Convert to array form here on save so a
  // user typing "a, b, c" actually persists as ["a","b","c"]. This is the
  // moment we know editing is finished - splitting earlier would eat any
  // comma the user just typed mid-edit.
  const validConditions = useMemo(() => conditions
    .filter((c) => {
      if (takesNoValue(c)) return true;
      return !isConditionValueEmpty(c.value);
    })
    .map((c) => {
      if (takesNoValue(c)) return c;
      if (c.field === "size") return c; // numeric, single-value only
      if (typeof c.value !== "string") return c; // already structured
      const parsed = inputStringToValue(c.value);
      return { ...c, value: parsed };
    }), [conditions]);

  const validActions = useMemo(() => actions
    .map((a) => {
      if (!ACTIONS_WITH_MAILBOX.has(a.type)) return a;
      // Store the folder id next to the path and refresh the path from it,
      // so a renamed folder keeps receiving the rule's mail.
      const mailboxId = mailboxIdFor(a);
      const path = mailboxId ? mailboxPathMap.get(mailboxId) : undefined;
      return mailboxId ? { ...a, mailboxId, value: path ?? a.value } : a;
    })
    .filter((a) => !ACTIONS_WITH_VALUE.has(a.type) || a.value?.trim()), [actions, mailboxIdFor, mailboxPathMap]);

  // Old mail can only be sorted by what the client can check the way Sieve
  // does. Until an action is complete (a Move still without its folder), only
  // the conditions decide.
  const canApplyToExisting = useMemo(() => {
    if (!offerApplyToExisting) return false;
    // A rule with a period acts on mail as it arrives within it, which says
    // nothing about the mail already there.
    if (periodOn) return false;
    const checkActions: FilterAction[] = validActions.length > 0 ? validActions : [{ type: "mark_read" }];
    return retroactiveSupport({ conditions: validConditions, actions: checkActions }).ok;
  }, [offerApplyToExisting, validConditions, validActions, periodOn]);

  const handleSave = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t("validation_empty_name"));
      return;
    }

    if (validConditions.length === 0) {
      toast.error(t("validation_empty_conditions"));
      return;
    }

    if (validActions.length === 0) {
      toast.error(t("validation_empty_actions"));
      return;
    }

    const activeFrom = periodOn ? fromPeriodInput(periodStart, start?.activeFrom) : undefined;
    const activeUntil = periodOn ? fromPeriodInput(periodEnd, start?.activeUntil) : undefined;
    // A field the browser holds half filled in (a date without its time)
    // reads as empty, and must not pass for an open end of the period.
    const halfFilled = !!periodStartRef.current?.validity.badInput || !!periodEndRef.current?.validity.badInput;
    if (activeFrom === null || activeUntil === null || (periodOn && halfFilled)) {
      toast.error(t("validation_period_invalid"));
      return;
    }
    if (periodOn && !activeFrom && !activeUntil) {
      toast.error(t("validation_period_empty"));
      return;
    }
    if (activeFrom && activeUntil && Date.parse(activeUntil) <= Date.parse(activeFrom)) {
      toast.error(t("validation_period_order"));
      return;
    }

    onSave({
      id: start?.id || generateUUID(),
      name: trimmedName,
      enabled: start?.enabled ?? true,
      matchType,
      conditions: validConditions,
      actions: validActions,
      stopProcessing,
      // Each optional field this dialog controls is set, to undefined when it
      // is off: the settings page merges the result into the stored rule, and
      // a field left out would keep its old value there.
      includeSpam: includeSpam && validActions.some((a) => ACTIONS_WITH_MAILBOX.has(a.type)) ? true : undefined,
      activeFrom,
      activeUntil,
    }, { applyToExisting: applyToExisting && canApplyToExisting });
  }, [name, matchType, validConditions, validActions, stopProcessing, includeSpam, periodOn, periodStart, periodEnd, start, onSave, t, applyToExisting, canApplyToExisting]);

  const visibleSuggestions = suggestions.filter((s) => !usedSuggestions.has(s.id));

  const applySuggestion = (suggestion: RuleSuggestion) => {
    setConditions((prev) => {
      // The blank row a rule starts with makes way for the suggestion.
      const kept = prev.filter((c) => !(c.field !== "attachment" && c.field !== "all" && isConditionValueEmpty(c.value)));
      const replaceAt = suggestion.replaces ? kept.findIndex(suggestion.replaces) : -1;
      if (replaceAt === -1) return [...kept, suggestion.condition];
      return kept.map((c, i) => (i === replaceAt ? suggestion.condition : c));
    });
    setUsedSuggestions((prev) => new Set(prev).add(suggestion.id));
  };

  const updateCondition = (index: number, updates: Partial<FilterCondition>) => {
    setConditions((prev) =>
      prev.map((c, i) => {
        if (i !== index) return c;
        const updated = { ...c, ...updates };
        // Reconcile the comparator when the field changes so we never end up
        // with e.g. (field=attachment, comparator=contains) — invalid for the
        // Sieve generator. Each field has its own valid comparator set.
        if (updates.field && updates.field !== c.field) {
          const allowed = comparatorsFor(updates.field);
          if (!allowed.includes(c.comparator)) {
            updated.comparator = allowed[0];
          }
        }
        if (updates.field && updates.field !== "header") {
          delete updated.headerName;
        }
        // has_any and "all messages" take no value; clear it so we don't
        // leak old text into the generated Sieve.
        if (takesNoValue(updated)) {
          updated.value = "";
        }
        // Size is numeric, single value only - collapse any list to scalar.
        if (updated.field === "size" && Array.isArray(updated.value)) {
          updated.value = updated.value[0] ?? "";
        }
        return updated;
      })
    );
  };

  const removeCondition = (index: number) => {
    if (conditions.length <= 1) return;
    setConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateAction = (index: number, updates: Partial<FilterAction>) => {
    setActions((prev) =>
      prev.map((a, i) => {
        if (i !== index) return a;
        const updated = { ...a, ...updates };
        if (updates.type && !ACTIONS_WITH_VALUE.has(updates.type)) {
          delete updated.value;
        }
        if (updates.type && !ACTIONS_WITH_MAILBOX.has(updates.type)) {
          delete updated.mailboxId;
        }
        if (updates.type && updates.type !== "forward") {
          delete updated.keepCopy;
        }
        if (updates.type && ACTIONS_WITH_MAILBOX.has(updates.type) && !updated.value) {
          const firstMb = hierarchicalMailboxes[0];
          updated.value = firstMb ? (mailboxPathMap.get(firstMb.id) || firstMb.name) : "";
          if (firstMb) updated.mailboxId = firstMb.id;
        }
        return updated;
      })
    );
  };

  const removeAction = (index: number) => {
    if (actions.length <= 1) return;
    setActions((prev) => prev.filter((_, i) => i !== index));
  };

  const selectClass =
    "px-2.5 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 cursor-pointer hover:border-muted-foreground";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? t("edit_rule") : t("new_rule")}
        className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? t("edit_rule") : t("new_rule")}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
            aria-label={t("cancel")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-6">
          <div>
            <label className="text-sm font-medium mb-1 block text-foreground">
              {t("rule_name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("rule_name_placeholder")}
              maxLength={200}
              autoFocus
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block text-foreground">
              {t("match_type")}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMatchType("all")}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors duration-150 ${
                  matchType === "all"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted hover:bg-accent text-foreground"
                }`}
              >
                {t("match_all")}
              </button>
              <button
                type="button"
                onClick={() => setMatchType("any")}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors duration-150 ${
                  matchType === "any"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted hover:bg-accent text-foreground"
                }`}
              >
                {t("match_any")}
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block text-foreground">
              {t("conditions")}
            </label>
            {visibleSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2" role="group" aria-label={t("suggestions")}>
                {visibleSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    onClick={() => applySuggestion(suggestion)}
                    className="inline-flex items-center gap-1 max-w-full px-2 py-1 text-xs rounded-full border border-border bg-muted hover:bg-accent text-foreground transition-colors duration-150"
                  >
                    <Plus className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{suggestion.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {conditions.map((condition, index) => (
                <div key={index} className="flex items-center gap-2 flex-wrap">
                  <select
                    value={condition.field}
                    onChange={(e) =>
                      updateCondition(index, { field: e.target.value as FilterConditionField })
                    }
                    className={selectClass}
                    aria-label={t("conditions")}
                  >
                    {ALL_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {t(`condition_fields.${f}`)}
                      </option>
                    ))}
                  </select>

                  {condition.field === "header" && (
                    <Input
                      value={condition.headerName || ""}
                      onChange={(e) =>
                        updateCondition(index, { headerName: e.target.value })
                      }
                      placeholder={t("header_name")}
                      className="w-28"
                    />
                  )}

                  {condition.field !== "all" && (
                    <select
                      value={condition.comparator}
                      onChange={(e) =>
                        updateCondition(index, { comparator: e.target.value as FilterComparator })
                      }
                      className={selectClass}
                      aria-label={t("comparators.contains")}
                    >
                      {comparatorsFor(condition.field).map((c) => (
                        <option key={c} value={c}>
                          {t(`comparators.${c}`)}
                        </option>
                      ))}
                    </select>
                  )}

                  {/* has_any and "all messages" take no value; render a stub
                      so the row layout stays consistent but no input is
                      editable. */}
                  {takesNoValue(condition) ? (
                    <div className="flex-1 min-w-[120px]" />
                  ) : (
                    <Input
                      value={valueToInputString(condition.value)}
                      onChange={(e) =>
                        // Store the raw input string while typing. Splitting
                        // commas into an array on every keystroke would eat
                        // the comma the moment it's typed.
                        updateCondition(index, { value: e.target.value })
                      }
                      onBlur={(e) => {
                        // On blur: normalise comma-separated input into an
                        // array (or single string when only one item). Size
                        // stays numeric/single-value; attachment-has_any has
                        // no value at all.
                        if (condition.field === "size") return;
                        if (
                          condition.field === "attachment" &&
                          condition.comparator === "has_any"
                        )
                          return;
                        const parsed = inputStringToValue(e.target.value);
                        // Only update if the normalised shape actually
                        // differs - avoids triggering a no-op re-render and
                        // resetting the user's cursor on every blur.
                        if (
                          JSON.stringify(parsed) !== JSON.stringify(condition.value)
                        ) {
                          updateCondition(index, { value: parsed });
                        }
                      }}
                      placeholder={
                        condition.field === "size"
                          ? t("size_placeholder")
                          : condition.field === "attachment"
                            ? t("attachment_type_placeholder")
                            : t("value_placeholder_multi")
                      }
                      className="flex-1 min-w-[120px]"
                      type={condition.field === "size" ? "number" : "text"}
                    />
                  )}

                  <button
                    type="button"
                    onClick={() => removeCondition(index)}
                    disabled={conditions.length <= 1}
                    className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:pointer-events-none"
                    aria-label={t("delete_rule")}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setConditions((prev) => [...prev, makeEmptyCondition()])}
              className="flex items-center gap-1 mt-2 text-sm text-primary hover:underline"
            >
              <Plus className="w-3.5 h-3.5" />
              {t("add_condition")}
            </button>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block text-foreground">
              {t("actions")}
            </label>
            <div className="space-y-2">
              {actions.map((action, index) => (
                <div key={index} className="flex items-center gap-2 flex-wrap">
                  <select
                    value={action.type}
                    onChange={(e) =>
                      updateAction(index, { type: e.target.value as FilterActionType })
                    }
                    className={selectClass}
                    aria-label={t("actions")}
                  >
                    {ALL_ACTION_TYPES.map((a) => (
                      <option
                        key={a}
                        value={a}
                        disabled={
                          a === "forward" && action.type !== "forward" && forwardLimit !== null &&
                          forwardCount + otherForwards >= forwardLimit
                        }
                      >
                        {t(`action_types.${a}`)}
                      </option>
                    ))}
                  </select>

                  {ACTIONS_WITH_MAILBOX.has(action.type) && (() => {
                    const selectedId = mailboxIdFor(action);
                    const missing = !!selectedId && !mailboxPathMap.has(selectedId);
                    return (
                      <select
                        value={selectedId}
                        onChange={(e) => {
                          const id = e.target.value;
                          updateAction(index, {
                            mailboxId: id || undefined,
                            value: id ? (mailboxPathMap.get(id) ?? "") : "",
                          });
                        }}
                        className={`${selectClass} flex-1 min-w-[140px]`}
                        aria-label={t("move_to_folder")}
                      >
                        <option value="">{t("move_to_folder")}</option>
                        {missing && <option value={selectedId}>{action.value}</option>}
                        {hierarchicalMailboxes.map((mb) => (
                          <option key={mb.id} value={mb.id}>
                            {"\u00A0".repeat(mb.depth * 3)}{mb.name}
                          </option>
                        ))}
                      </select>
                    );
                  })()}

                  {action.type === "forward" && (
                    <>
                      <Input
                        value={action.value || ""}
                        onChange={(e) => updateAction(index, { value: e.target.value })}
                        placeholder={t("forward_placeholder")}
                        type="email"
                        className="flex-1 min-w-[180px]"
                      />
                      <label className="flex items-center gap-1.5 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={!!action.keepCopy}
                          onChange={(e) => updateAction(index, { keepCopy: e.target.checked || undefined })}
                          className="rounded border-input"
                        />
                        {t("forward_keep_copy")}
                      </label>
                    </>
                  )}

                  {action.type === "reject" && (
                    <Input
                      value={action.value || ""}
                      onChange={(e) => updateAction(index, { value: e.target.value })}
                      placeholder={t("reject_placeholder")}
                      className="flex-1 min-w-[180px]"
                    />
                  )}

                  {action.type === "add_label" && (
                    <select
                      value={action.value || ""}
                      onChange={(e) => updateAction(index, { value: e.target.value })}
                      className={`${selectClass} flex-1 min-w-[140px]`}
                      aria-label={t("label_placeholder")}
                    >
                      <option value="">{t("label_placeholder")}</option>
                      {emailKeywords.map((kw) => (
                        <option key={kw.id} value={kw.id}>{tagName(kw.id)}</option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={() => removeAction(index)}
                    disabled={actions.length <= 1}
                    className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:pointer-events-none"
                    aria-label={t("delete_rule")}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            {forwardOverLimit && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {t("forward_limit", { count: forwardLimit })}
              </p>
            )}
            <button
              type="button"
              onClick={() => setActions((prev) => [...prev, makeEmptyAction()])}
              className="flex items-center gap-1 mt-2 text-sm text-primary hover:underline"
            >
              <Plus className="w-3.5 h-3.5" />
              {t("add_action")}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="stopProcessing"
              checked={stopProcessing}
              onChange={(e) => setStopProcessing(e.target.checked)}
              className="rounded border-input"
            />
            <label htmlFor="stopProcessing" className="text-sm text-foreground">
              {t("stop_processing")}
            </label>
          </div>

          {actions.some((a) => ACTIONS_WITH_MAILBOX.has(a.type)) && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="includeSpam"
                checked={includeSpam}
                onChange={(e) => setIncludeSpam(e.target.checked)}
                className="rounded border-input"
              />
              <label htmlFor="includeSpam" className="text-sm text-foreground">
                {t("include_spam")}
              </label>
            </div>
          )}

          {/* Offered where the server supports it; a rule that already has a
              period always shows it, so it can be removed. */}
          {(periodsSupported || hadPeriod) && (
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="limitToPeriod"
                  checked={periodOn}
                  onChange={(e) => setPeriodOn(e.target.checked)}
                  className="rounded border-input"
                />
                <label htmlFor="limitToPeriod" className="text-sm text-foreground">
                  {t("period_toggle")}
                </label>
              </div>
              {periodOn && (
                <div className="mt-2 ms-6 space-y-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      {t("period_start")}
                      <input
                        ref={periodStartRef}
                        type="datetime-local"
                        max={PERIOD_INPUT_MAX}
                        value={periodStart}
                        onChange={(e) => setPeriodStart(e.target.value)}
                        className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      {t("period_end")}
                      <input
                        ref={periodEndRef}
                        type="datetime-local"
                        max={PERIOD_INPUT_MAX}
                        value={periodEnd}
                        onChange={(e) => setPeriodEnd(e.target.value)}
                        className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
                      />
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("period_hint")}</p>
                </div>
              )}
            </div>
          )}

          {offerApplyToExisting && (
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="applyToExisting"
                  checked={applyToExisting && canApplyToExisting}
                  disabled={!canApplyToExisting}
                  onChange={(e) => setApplyToExisting(e.target.checked)}
                  className="rounded border-input disabled:opacity-50"
                  aria-describedby={canApplyToExisting ? undefined : "applyToExistingHint"}
                />
                <label
                  htmlFor="applyToExisting"
                  className={cn("text-sm", canApplyToExisting ? "text-foreground" : "text-muted-foreground")}
                >
                  {t("apply_existing")}
                </label>
              </div>
              {!canApplyToExisting && (
                <p id="applyToExistingHint" className="mt-1 ms-6 text-xs text-muted-foreground">
                  {periodOn ? t("apply_existing_period") : t("apply_existing_unsupported")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!name.trim()}>
            {t("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
