"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { sortFolderTree } from "@/lib/move-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { Dialog } from "@/components/ui/dialog";
import { useDiscardChanges } from "@/components/settings/use-discard-changes";
import type {
  FilterRule,
  FilterCondition,
  FilterAction,
  FilterConditionField,
  FilterComparator,
  FilterActionType,
} from "@/lib/jmap/sieve-types";
import type { Mailbox } from "@/lib/jmap/types";
import { isValidSieveHeaderName } from "@/lib/sieve/generator";
import { REGEX_FIELDS, isValidSieveRegex, usesRegex } from "@/lib/sieve/regex";
import { buildMailboxTree, type MailboxNode, generateUUID, cn } from "@/lib/utils";
import { sameCondition, type RuleSuggestion } from "@/lib/filters/quick-rules";
import { RuleFolderPicker } from "./rule-folder-picker";
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
  /**
   * The folder the offer is about, by name ("Inbox"), when the dialog isn't
   * opened from that folder (Settings › Filters).
   */
  applyExistingFolder?: string;
  /**
   * How many messages in that folder the rule as typed would change. The
   * offer says the number, and is greyed when it is 0.
   */
  countExisting?: (rule: FilterRule) => Promise<number>;
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
  /** The server lists the Sieve "regex" extension. */
  regexSupported?: boolean;
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

function baseComparatorsFor(field: FilterConditionField): FilterComparator[] {
  if (field === "size") return SIZE_COMPARATORS;
  if (field === "attachment") return ATTACHMENT_COMPARATORS;
  if (field === "all") return ALL_MESSAGES_COMPARATORS;
  if (field === "from" || field === "to" || field === "cc") return ADDRESS_COMPARATORS;
  return TEXT_COMPARATORS;
}

// "matches regex" only where the server can run it, or on a row that already
// uses it, so editing such a rule does not change its comparator.
function comparatorsFor(field: FilterConditionField, regex: boolean): FilterComparator[] {
  const base = baseComparatorsFor(field);
  return regex && REGEX_FIELDS.has(field) ? [...base, "regex"] : base;
}

// "Stop processing" is not offered as an action: the "Don't apply later
// rules" checkbox does the same, and two ways to say it confused people.
const ALL_ACTION_TYPES: FilterActionType[] = [
  "move", "copy", "forward", "mark_read", "star", "add_label", "discard", "reject", "keep",
];

/**
 * A rule saved with the old "Stop processing" action opens with that action
 * folded into the checkbox, so it keeps working and can be saved again. What
 * came after the stop never ran, so it goes; a rule that did nothing before
 * it keeps the message in the inbox, as it did.
 */
export function foldStopAction(actions: FilterAction[], stopProcessing: boolean): {
  actions: FilterAction[];
  stopProcessing: boolean;
} {
  const stopAt = actions.findIndex((a) => a.type === "stop");
  if (stopAt === -1) return { actions, stopProcessing };
  const before = actions.slice(0, stopAt);
  return { actions: before.length > 0 ? before : [{ type: "keep" }], stopProcessing: true };
}

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

// A regex row whose expression (or one of them) would not compile.
function regexInvalid(c: FilterCondition): boolean {
  if (!usesRegex(c) || isConditionValueEmpty(c.value)) return false;
  const values = Array.isArray(c.value) ? c.value : [c.value];
  return values.some((v) => !isValidSieveRegex(v));
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
  applyExistingFolder,
  countExisting,
  mailboxes,
  maxRedirects,
  forwardsBefore = 0,
  forwardsAfter = 0,
  periodsSupported = false,
  regexSupported = false,
  onSave,
  onClose,
}: FilterRuleModalProps) {
  const t = useTranslations("settings.filters");
  const tWords = useTranslations("ux_p3_words");
  const isEdit = !!rule;
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  // Regular expressions are for people who asked for the advanced settings;
  // a rule that already uses one keeps its comparator either way.
  const showAdvanced = useSettingsStore((state) => state.showAdvancedSettings);
  const regexOffered = regexSupported && showAdvanced;
  const { tagName } = useKeywordFormat();

  const start = rule ?? initialRule;
  const [name, setName] = useState(start?.name || "");
  const [matchType, setMatchType] = useState<"all" | "any">(start?.matchType || "all");
  const [conditions, setConditions] = useState<FilterCondition[]>(
    start?.conditions.length ? [...start.conditions] : [makeEmptyCondition()]
  );
  const [folded] = useState(() => foldStopAction(start?.actions ?? [], start?.stopProcessing ?? false));
  const [actions, setActions] = useState<FilterAction[]>(
    folded.actions.length ? [...folded.actions] : [makeEmptyAction()]
  );
  const [stopProcessing, setStopProcessing] = useState(folded.stopProcessing);
  const [includeSpam, setIncludeSpam] = useState(start?.includeSpam ?? false);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const hadPeriod = !!start && hasPeriod(start);
  const [periodOn, setPeriodOn] = useState(hadPeriod);
  const [periodStart, setPeriodStart] = useState(toPeriodInput(start?.activeFrom));
  const [periodEnd, setPeriodEnd] = useState(toPeriodInput(start?.activeUntil));
  const periodStartRef = useRef<HTMLInputElement>(null);
  const periodEndRef = useRef<HTMLInputElement>(null);

  // Unsaved input is dropped only when the user says so (R5): Escape, the
  // X and Cancel ask, a click outside is ignored.
  const draft = JSON.stringify([
    name, matchType, conditions, actions, stopProcessing, includeSpam, applyToExisting, periodOn, periodStart, periodEnd,
  ]);
  const [initialDraft] = useState(draft);
  const dirty = draft !== initialDraft;
  const { confirmDiscard, discardDialog } = useDiscardChanges();
  const requestClose = useCallback(async () => {
    if (await confirmDiscard(dirty)) onClose();
  }, [confirmDiscard, dirty, onClose]);
  const nameRef = useRef<HTMLInputElement>(null);

  // Each folder's Sieve path; the picker itself is the Move list (rule-folder-picker.tsx).
  const locale = useLocale();
  const { mailboxPathMap } = useMemo(() => {
    const tree = sortFolderTree(buildMailboxTree(mailboxes.filter((mb) => !mb.isShared)), locale);
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
    return { mailboxPathMap: pathMap };
  }, [mailboxes, locale]);

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
  // A limit of 0: the server runs no redirect at all, as the out of office
  // card also takes it. A forward the rule already has stays, to be removed.
  const forwardUnavailable = maxRedirects === 0;

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
      // A comma belongs to the expression ("a{1,3}"); several patterns are
      // written with "|".
      if (usesRegex(c)) return c;
      const parsed = inputStringToValue(c.value);
      return { ...c, value: parsed };
    })
    .map((c) => (c.field === "header" ? { ...c, headerName: (c.headerName ?? "").trim() } : c)), [conditions]);

  const resolvedActions = useMemo(() => actions
    .map((a) => {
      if (!ACTIONS_WITH_MAILBOX.has(a.type)) return a;
      // Store the folder id next to the path and refresh the path from it,
      // so a renamed folder keeps receiving the rule's mail.
      const mailboxId = mailboxIdFor(a);
      const path = mailboxId ? mailboxPathMap.get(mailboxId) : undefined;
      return mailboxId ? { ...a, mailboxId, value: path ?? a.value } : a;
    }), [actions, mailboxIdFor, mailboxPathMap]);
  // A row still missing its folder, tag, address or message.
  const actionIncomplete = useMemo(
    () => resolvedActions.map((a) => ACTIONS_WITH_VALUE.has(a.type) && !a.value?.trim()),
    [resolvedActions],
  );
  const validActions = useMemo(
    () => resolvedActions.filter((_, i) => !actionIncomplete[i]),
    [resolvedActions, actionIncomplete],
  );
  const firstIncompleteAction = resolvedActions.find((_, i) => actionIncomplete[i]);

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

  // How many messages the rule would change there, asked of the server a
  // moment after the conditions and actions stop changing. null: not known
  // (still asking, no action yet, or the server didn't answer).
  const [existingCount, setExistingCount] = useState<number | null>(null);
  const countKey = canApplyToExisting && countExisting && validActions.length > 0
    ? JSON.stringify([matchType, validConditions, validActions])
    : null;
  const countRef = useRef(countExisting);
  countRef.current = countExisting;
  useEffect(() => {
    setExistingCount(null);
    if (!countKey || !countRef.current) return;
    const [type, conds, acts] = JSON.parse(countKey) as [FilterRule["matchType"], FilterCondition[], FilterAction[]];
    let stale = false;
    const timer = setTimeout(() => {
      countRef.current!({ id: "count", name: "", enabled: true, matchType: type, conditions: conds, actions: acts, stopProcessing: false })
        .then((count) => { if (!stale) setExistingCount(count); })
        .catch(() => { /* the offer stays, without a number */ });
    }, 400);
    return () => { stale = true; clearTimeout(timer); };
  }, [countKey]);
  const noneToApply = existingCount === 0;
  const canTickApply = canApplyToExisting && !noneToApply;

  // What keeps the rule from being saved, said under the part it is about
  // once Save was pressed, and updated as the user fixes it.
  const [showErrors, setShowErrors] = useState(false);
  const [halfFilledPeriod, setHalfFilledPeriod] = useState(false);
  const activeFrom = periodOn ? fromPeriodInput(periodStart, start?.activeFrom) : undefined;
  const activeUntil = periodOn ? fromPeriodInput(periodEnd, start?.activeUntil) : undefined;
  const errors = {
    name: !name.trim() ? t("validation_empty_name") : null,
    conditions: validConditions.length === 0
      ? t("validation_empty_conditions")
      // Stalwart's Sieve compiler refuses any other header name, and with
      // it the whole script, so every other rule would stop working too.
      : validConditions.some((c) => c.field === "header" && !isValidSieveHeaderName(c.headerName ?? ""))
        ? t("validation_header_name")
        // The server compiles every expression on save and refuses the
        // whole script for one that does not compile.
        : validConditions.some(regexInvalid)
          ? t("validation_regex")
          : null,
    // A row that is there but unfinished says what it misses; "at least one
    // action" is left for when no row has a type at all.
    actions: firstIncompleteAction
      ? t(ACTIONS_WITH_MAILBOX.has(firstIncompleteAction.type)
        ? "validation_action_folder"
        : firstIncompleteAction.type === "add_label"
          ? "validation_action_tag"
          : firstIncompleteAction.type === "forward"
            ? "validation_action_forward"
            : "validation_action_reject")
      : validActions.length === 0 ? t("validation_empty_actions") : null,
    period: !periodOn
      ? null
      // A field the browser holds half filled in (a date without its time)
      // reads as empty, and must not pass for an open end of the period.
      : activeFrom === null || activeUntil === null || halfFilledPeriod
        ? t("validation_period_invalid")
        : !activeFrom && !activeUntil
          ? t("validation_period_empty")
          : activeFrom && activeUntil && Date.parse(activeUntil) <= Date.parse(activeFrom)
            ? t("validation_period_order")
            : null,
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const shown = (error: string | null) => (showErrors ? error : null);
  // The fields the shown errors are about: every empty value while no
  // condition has one, a header name Sieve refuses, an unfinished action.
  const valueMissing = (c: FilterCondition) =>
    !!shown(errors.conditions) && validConditions.length === 0 && !takesNoValue(c) && isConditionValueEmpty(c.value);
  const headerInvalid = (c: FilterCondition) =>
    !!shown(errors.conditions) && c.field === "header" && !isConditionValueEmpty(c.value) &&
    !isValidSieveHeaderName((c.headerName ?? "").trim());
  const regexInvalidShown = (c: FilterCondition) => !!shown(errors.conditions) && regexInvalid(c);
  const actionInvalid = (index: number) => !!shown(errors.actions) && actionIncomplete[index];

  const handleSave = useCallback(() => {
    const halfFilled = periodOn &&
      (!!periodStartRef.current?.validity.badInput || !!periodEndRef.current?.validity.badInput);
    setHalfFilledPeriod(halfFilled);
    if (halfFilled || hasErrors) {
      setShowErrors(true);
      // Focus goes to the first part that needs fixing.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-rule-error="true"]')?.focus();
      });
      return;
    }
    const trimmedName = name.trim();

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
      activeFrom: activeFrom ?? undefined,
      activeUntil: activeUntil ?? undefined,
    }, { applyToExisting: applyToExisting && canTickApply });
  }, [name, matchType, validConditions, validActions, stopProcessing, includeSpam, periodOn, activeFrom, activeUntil, hasErrors, start, onSave, applyToExisting, canTickApply]);

  // A chip goes once the rule has its condition, and comes back when that
  // row goes: the sender chip shows again after the domain took its place.
  const visibleSuggestions = suggestions.filter((s) => !conditions.some((c) => sameCondition(c, s.condition)));

  const applySuggestion = (suggestion: RuleSuggestion) => {
    setConditions((prev) => {
      // The blank row a rule starts with makes way for the suggestion.
      const kept = prev.filter((c) => !(c.field !== "attachment" && c.field !== "all" && isConditionValueEmpty(c.value)));
      const replaceAt = suggestion.replaces ? kept.findIndex(suggestion.replaces) : -1;
      if (replaceAt === -1) return [...kept, suggestion.condition];
      return kept.map((c, i) => (i === replaceAt ? suggestion.condition : c));
    });
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
          const allowed = comparatorsFor(updates.field, regexOffered);
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
        return updated;
      })
    );
  };

  const removeAction = (index: number) => {
    if (actions.length <= 1) return;
    setActions((prev) => prev.filter((_, i) => i !== index));
  };

  const selectClass =
    "px-2.5 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-hidden transition-colors duration-150 cursor-pointer hover:border-muted-foreground";

  return (
    <>
    <Dialog
      isOpen
      onClose={() => void requestClose()}
      dirty={dirty}
      title={isEdit ? t("edit_rule") : t("new_rule")}
      size="lg"
      className="max-h-[90vh]"
      initialFocus={nameRef}
      footer={
        <>
          {/* Next to Save, where it is always in view: in the body it and the note
              saying why it is greyed sat below the dialog's fold (settings-p3-20). */}
          {offerApplyToExisting && (
            <div className="basis-full" data-testid="rule-apply-existing">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="applyToExisting"
                  checked={applyToExisting && canTickApply}
                  disabled={!canTickApply}
                  onChange={(e) => setApplyToExisting(e.target.checked)}
                  className="rounded border-input disabled:opacity-50"
                  aria-describedby={canTickApply ? undefined : "applyToExistingHint"}
                />
                <label
                  htmlFor="applyToExisting"
                  className={cn("text-sm", canTickApply ? "text-foreground" : "text-muted-foreground")}
                >
                  {applyExistingFolder === undefined
                    ? t("apply_existing")
                    : existingCount && canApplyToExisting
                      ? t("apply_existing_count", { count: existingCount, folder: applyExistingFolder })
                      : t("apply_existing_in", { folder: applyExistingFolder })}
                </label>
              </div>
              {!canTickApply && (
                <p id="applyToExistingHint" className="mt-1 ms-6 text-xs text-muted-foreground">
                  {!canApplyToExisting
                    ? (periodOn ? t("apply_existing_period") : t("apply_existing_unsupported"))
                    : t("apply_existing_none", { folder: applyExistingFolder ?? "" })}
                </p>
              )}
            </div>
          )}
          <Button variant="outline" onClick={() => void requestClose()}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave}>
            {t("save")}
          </Button>
        </>
      }
    >
        <div className="pt-4 space-y-6">
          <div>
            <label className="text-sm font-medium mb-1 block text-foreground">
              {t("rule_name")}
            </label>
            <Input
              aria-label={t("rule_name")}
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("rule_name_placeholder")}
              maxLength={200}
              aria-invalid={!!shown(errors.name)}
              aria-describedby={shown(errors.name) ? "rule-name-error" : undefined}
              data-rule-error={!!shown(errors.name)}
              className={cn(shown(errors.name) && "border-destructive")}
            />
            <FieldError id="rule-name-error" text={shown(errors.name)} />
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
                      aria-label={t("header_name")}
                      aria-invalid={headerInvalid(condition)}
                      data-rule-error={headerInvalid(condition)}
                      className={cn("w-28", headerInvalid(condition) && "border-destructive")}
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
                      {comparatorsFor(condition.field, regexOffered || condition.comparator === "regex").map((c) => (
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
                        if (usesRegex(condition)) return;
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
                            : usesRegex(condition)
                              ? t("regex_placeholder")
                              // Short: the long one was cut in a narrow field. The note
                              // under the conditions says commas give several values.
                              : tWords("filter_value_placeholder")
                      }
                      aria-label={t("condition_value")}
                      aria-invalid={valueMissing(condition) || regexInvalidShown(condition)}
                      aria-describedby={valueMissing(condition) || regexInvalidShown(condition) ? "rule-conditions-error" : undefined}
                      data-rule-error={valueMissing(condition) || regexInvalidShown(condition)}
                      className={cn("flex-1 min-w-[120px]", (valueMissing(condition) || regexInvalidShown(condition)) && "border-destructive")}
                      type={condition.field === "size" ? "number" : "text"}
                    />
                  )}

                  <IconButton
                    label={t("remove_condition")}
                    onClick={() => removeCondition(index)}
                    disabled={conditions.length <= 1}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <X />
                  </IconButton>
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
            <p className="mt-1 text-xs text-muted-foreground">{tWords("filter_values_hint")}</p>
            <FieldError id="rule-conditions-error" text={shown(errors.conditions)} />
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
                    {ALL_ACTION_TYPES.filter((a) => !(forwardUnavailable && a === "forward" && action.type !== "forward")).map((a) => (
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
                    const invalid = actionInvalid(index);
                    const missing = !!selectedId && !mailboxPathMap.has(selectedId);
                    return (
                      <RuleFolderPicker
                        mailboxes={mailboxes}
                        value={selectedId}
                        missingLabel={missing ? action.value : undefined}
                        onPick={(id) => updateAction(index, { mailboxId: id, value: mailboxPathMap.get(id) ?? "" })}
                        invalid={invalid}
                        describedBy={invalid ? "rule-actions-error" : undefined}
                        className="flex-1 min-w-[140px] max-w-full"
                      />
                    );
                  })()}

                  {action.type === "forward" && (
                    <>
                      <Input
                        value={action.value || ""}
                        onChange={(e) => updateAction(index, { value: e.target.value })}
                        placeholder={t("forward_placeholder")}
                        type="email"
                        aria-label={t("forward_to")}
                        aria-invalid={actionInvalid(index)}
                        aria-describedby={actionInvalid(index) ? "rule-actions-error" : undefined}
                        data-rule-error={actionInvalid(index)}
                        className={cn("flex-1 min-w-[180px]", actionInvalid(index) && "border-destructive")}
                      />
                      <label className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
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
                      aria-label={t("reject_message")}
                      aria-invalid={actionInvalid(index)}
                      aria-describedby={actionInvalid(index) ? "rule-actions-error" : undefined}
                      data-rule-error={actionInvalid(index)}
                      className={cn("flex-1 min-w-[180px]", actionInvalid(index) && "border-destructive")}
                    />
                  )}

                  {action.type === "add_label" && (
                    <select
                      value={action.value || ""}
                      onChange={(e) => updateAction(index, { value: e.target.value })}
                      className={cn(selectClass, "flex-1 min-w-[140px]", actionInvalid(index) && "border-destructive")}
                      aria-label={t("label_placeholder")}
                      aria-invalid={actionInvalid(index)}
                      aria-describedby={actionInvalid(index) ? "rule-actions-error" : undefined}
                      data-rule-error={actionInvalid(index)}
                    >
                      <option value="">{t("label_placeholder")}</option>
                      {emailKeywords.map((kw) => (
                        <option key={kw.id} value={kw.id}>{tagName(kw.id)}</option>
                      ))}
                    </select>
                  )}

                  <IconButton
                    label={t("remove_action")}
                    onClick={() => removeAction(index)}
                    disabled={actions.length <= 1}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
            </div>
            {forwardUnavailable && forwardCount > 0 && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {t("forward_unavailable")}
              </p>
            )}
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
            <FieldError id="rule-actions-error" text={shown(errors.actions)} />
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
                        onChange={(e) => { setPeriodStart(e.target.value); setHalfFilledPeriod(false); }}
                        className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      {t("period_end")}
                      <input
                        ref={periodEndRef}
                        type="datetime-local"
                        max={PERIOD_INPUT_MAX}
                        value={periodEnd}
                        onChange={(e) => { setPeriodEnd(e.target.value); setHalfFilledPeriod(false); }}
                        className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground"
                      />
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("period_hint")}</p>
                  <FieldError text={shown(errors.period)} />
                </div>
              )}
            </div>
          )}
        </div>

    </Dialog>
    {discardDialog}
    </>
  );
}

/** Why the rule can't be saved yet, under the part it is about. */
function FieldError({ id, text }: { id?: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
      {text}
    </p>
  );
}
