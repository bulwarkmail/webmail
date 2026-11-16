"use client";

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { sortFolderTree } from "@/lib/move-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, Plus, X } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { Dialog } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useDiscardChanges } from "@/components/settings/use-discard-changes";
import type { FilterRule, FilterCondition, FilterConditionField, FilterComparator } from "@/lib/jmap/sieve-types";
import type { Mailbox } from "@/lib/jmap/types";
import { isValidSieveHeaderName } from "@/lib/sieve/generator";
import { REGEX_FIELDS, isValidSieveRegex, usesRegex } from "@/lib/sieve/regex";
import { buildMailboxTree, type MailboxNode, generateUUID, cn } from "@/lib/utils";
import { sameCondition, type RuleSuggestion } from "@/lib/filters/quick-rules";
import { appliesToExisting, skipsJunk, type ApplyScope } from "@/lib/filters/rule-scope";
import { ruleForwards, ruleStops } from "@/lib/filters/forward-limit";
import { hasPeriod, isPeriodBoundary } from "@/lib/sieve/period";
import { fromWallClock, getEffectiveTimeZone, getWallClock } from "@/lib/timezone";
import {
  blockedActions,
  checklistFromActions,
  checklistProblem,
  checklistToActions,
  formatSize,
  keepActionOrder,
  parseSize,
  type Checklist,
  type ChecklistKey,
  type SizeUnit,
} from "@/lib/filters/rule-editor-model";
import type { RulePreview } from "@/lib/filters/rule-preview";
import { useSettingsStore } from "@/stores/settings-store";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { RuleFolderPicker } from "./rule-folder-picker";
import { foldStopAction } from "./filter-rule-modal";

export interface RuleEditorProps {
  rule?: FilterRule;
  initialRule?: FilterRule;
  suggestions?: RuleSuggestion[];
  offerApplyToExisting?: boolean;
  applyExistingFolder?: string;
  previewMatches?: (rule: FilterRule, options: { skipJunk: boolean }) => Promise<RulePreview | null>;
  mailboxes: Mailbox[];
  maxRedirects?: number | null;
  forwardsBefore?: number;
  forwardsAfter?: number;
  periodsSupported?: boolean;
  regexSupported?: boolean;
  onSave: (rule: FilterRule, options?: { applyTo: ApplyScope }) => void;
  onDelete?: () => void;
  onClose: () => void;
}

type ConditionKind = Exclude<FilterConditionField, "attachment"> | "attachment_any" | "attachment_type";

const KINDS: ConditionKind[] = [
  "from", "to", "cc", "delivered_to", "subject", "body", "header", "size", "attachment_any", "attachment_type", "all",
];

const TEXT_COMPARATORS: FilterComparator[] = [
  "contains", "not_contains", "is", "not_is", "starts_with", "ends_with", "matches",
];
const ADDRESS_COMPARATORS: FilterComparator[] = [...TEXT_COMPARATORS, "address_is", "domain_is"];
const SIZE_COMPARATORS: FilterComparator[] = ["greater_than", "less_than"];
const UNIT_KEYS: Record<SizeUnit, "bytes" | "kb" | "mb"> = { "": "bytes", K: "kb", M: "mb" };
const BODY_COMPARATORS: FilterComparator[] = ["contains", "not_contains"];
const DELIVERED_COMPARATORS: FilterComparator[] = ["address_is", "domain_is", "contains"];
const PLAIN_COMPARATORS = new Set<FilterComparator>(["contains", "is", "address_is", "domain_is"]);

function kindOf(c: FilterCondition): ConditionKind {
  if (c.field === "attachment") return c.comparator === "has_type" ? "attachment_type" : "attachment_any";
  return c.field;
}

function comparatorsFor(kind: ConditionKind, regex: boolean): FilterComparator[] {
  if (kind === "size") return SIZE_COMPARATORS;
  if (kind === "attachment_any" || kind === "attachment_type" || kind === "all") return [];
  if (kind === "delivered_to") return DELIVERED_COMPARATORS;
  const base = kind === "from" || kind === "to" || kind === "cc" ? ADDRESS_COMPARATORS : kind === "body" ? BODY_COMPARATORS : TEXT_COMPARATORS;
  return regex && REGEX_FIELDS.has(kind) ? [...base, "regex"] : base;
}

function withKind(c: FilterCondition, kind: ConditionKind, regex: boolean): FilterCondition {
  if (kind === "attachment_any") return { field: "attachment", comparator: "has_any", value: "" };
  if (kind === "attachment_type") {
    return { field: "attachment", comparator: "has_type", value: c.field === "attachment" ? c.value : "" };
  }
  if (kind === "all") return { field: "all", comparator: "any", value: "" };
  const allowed = comparatorsFor(kind, regex);
  const comparator = allowed.includes(c.comparator) ? c.comparator : allowed[0];
  const keepValue = c.field !== "all" && c.field !== "attachment" && (kind === "size") === (c.field === "size");
  const next: FilterCondition = { field: kind, comparator, value: keepValue ? c.value : "" };
  if (kind === "header") next.headerName = c.headerName ?? "";
  return next;
}

function takesNoValue(c: Pick<FilterCondition, "field" | "comparator">): boolean {
  return c.field === "all" || (c.field === "attachment" && c.comparator === "has_any");
}

function valueToInput(v: string | string[]): string {
  return Array.isArray(v) ? v.join(", ") : v;
}

function inputToValue(s: string): string | string[] {
  const parts = s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : parts;
}

function isEmptyValue(v: string | string[]): boolean {
  return Array.isArray(v) ? v.every((x) => !x.trim()) : !v.trim();
}

function attachmentTypeInvalid(c: FilterCondition): boolean {
  if (c.field !== "attachment" || c.comparator !== "has_type" || isEmptyValue(c.value)) return false;
  return (Array.isArray(c.value) ? c.value : [c.value]).some((v) => !v.replace(/^[.*]+/, "").trim());
}

function regexInvalid(c: FilterCondition): boolean {
  if (!usesRegex(c) || isEmptyValue(c.value)) return false;
  return (Array.isArray(c.value) ? c.value : [c.value]).some((v) => !isValidSieveRegex(v));
}

function toPeriodInput(boundary: string | undefined): string {
  if (!isPeriodBoundary(boundary)) return "";
  const w = getWallClock(new Date(boundary), getEffectiveTimeZone());
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

const PERIOD_INPUT_MAX = "9999-12-31T23:59";

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

const fieldClass =
  "px-2.5 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground";
const selectClass = cn(fieldClass, "cursor-pointer");

export function RuleEditor({
  rule,
  initialRule,
  suggestions = [],
  offerApplyToExisting = false,
  applyExistingFolder,
  previewMatches,
  mailboxes,
  maxRedirects,
  forwardsBefore = 0,
  forwardsAfter = 0,
  periodsSupported = false,
  regexSupported = false,
  onSave,
  onDelete,
  onClose,
}: RuleEditorProps) {
  const t = useTranslations("settings.filters");
  const tEditor = useTranslations("settings.filters.editor");
  const tWords = useTranslations("ux_p3_words");
  const locale = useLocale();
  const isEdit = !!rule;
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  const showAdvanced = useSettingsStore((state) => state.showAdvancedSettings);
  const regexOffered = regexSupported && showAdvanced;
  const { tagName } = useKeywordFormat();

  const start = rule ?? initialRule;
  const [name, setName] = useState(start?.name || "");
  const [matchType, setMatchType] = useState<"all" | "any">(start?.matchType || "all");
  const [conditions, setConditions] = useState<FilterCondition[]>(
    start?.conditions.length ? [...start.conditions] : [{ field: "from", comparator: "contains", value: "" }],
  );
  const [folded] = useState(() => foldStopAction(start?.actions ?? [], start?.stopProcessing ?? false));
  const [checklist, setChecklist] = useState<Checklist>(() => checklistFromActions(folded.actions));
  const [stopProcessing, setStopProcessing] = useState(folded.stopProcessing);
  const [enabled, setEnabled] = useState(start?.enabled ?? true);
  const [includeSpam, setIncludeSpam] = useState(start?.includeSpam ?? false);
  const [applyTo, setApplyTo] = useState<ApplyScope>("new");
  const hadPeriod = !!start && hasPeriod(start);
  const [periodOn, setPeriodOn] = useState(hadPeriod);
  const [periodStart, setPeriodStart] = useState(toPeriodInput(start?.activeFrom));
  const [periodEnd, setPeriodEnd] = useState(toPeriodInput(start?.activeUntil));
  const periodStartRef = useRef<HTMLInputElement>(null);
  const periodEndRef = useRef<HTMLInputElement>(null);
  const firstValueRef = useRef<HTMLInputElement>(null);

  const draft = JSON.stringify([
    name, matchType, conditions, checklist, stopProcessing, enabled, includeSpam, applyTo, periodOn, periodStart, periodEnd,
  ]);
  const [initialDraft] = useState(draft);
  const dirty = draft !== initialDraft;
  const { confirmDiscard, discardDialog } = useDiscardChanges();
  const { dialogProps: trashDialogProps, confirm: confirmTrash } = useConfirmDialog();
  const requestClose = useCallback(async () => {
    if (await confirmDiscard(dirty)) onClose();
  }, [confirmDiscard, dirty, onClose]);

  const mailboxPathMap = useMemo(() => {
    const tree = sortFolderTree(buildMailboxTree(mailboxes.filter((mb) => !mb.isShared)), locale);
    const pathMap = new Map<string, string>();
    const walk = (nodes: MailboxNode[], parentPath = "") => {
      for (const node of nodes) {
        const segment = node.role === "inbox" ? "INBOX" : node.name;
        const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
        pathMap.set(node.id, fullPath);
        if (node.children.length > 0) walk(node.children, fullPath);
      }
    };
    walk(tree);
    return pathMap;
  }, [mailboxes, locale]);

  const folderIdFor = useCallback((choice: { mailboxId?: string; value: string }): string => {
    if (choice.mailboxId) return choice.mailboxId;
    for (const [id, path] of mailboxPathMap) if (path === choice.value) return id;
    return "";
  }, [mailboxPathMap]);

  const resolvedChecklist = useMemo<Checklist>(() => {
    const resolve = (choice: Checklist["move"]) => {
      const mailboxId = folderIdFor(choice);
      return mailboxId ? { ...choice, mailboxId, value: mailboxPathMap.get(mailboxId) ?? choice.value } : choice;
    };
    return { ...checklist, move: resolve(checklist.move), copy: resolve(checklist.copy) };
  }, [checklist, folderIdFor, mailboxPathMap]);
  const actions = useMemo(
    () => keepActionOrder(checklistToActions(resolvedChecklist), folded.actions),
    [resolvedChecklist, folded.actions],
  );
  const blocked = blockedActions(checklist);
  const filing = checklist.move.on || checklist.copy.on;

  const update = (patch: Partial<Checklist>) => setChecklist((prev) => ({ ...prev, ...patch }));

  const forwardCount = ruleForwards({ actions });
  const otherForwards = forwardsBefore + (ruleStops({ actions, stopProcessing }) ? 0 : forwardsAfter);
  const forwardLimit = typeof maxRedirects === "number" && maxRedirects > 0 ? maxRedirects : null;
  const forwardOverLimit = forwardLimit !== null && forwardCount + otherForwards > forwardLimit;
  const forwardUnavailable = maxRedirects === 0;
  const forwardLocked = !checklist.forward.on && forwardLimit !== null && forwardCount + otherForwards >= forwardLimit;

  const validConditions = useMemo(() => conditions
    .map((c) => {
      if (takesNoValue(c) || c.field === "size" || typeof c.value !== "string" || usesRegex(c)) return c;
      return { ...c, value: inputToValue(c.value) };
    })
    .filter((c) => takesNoValue(c) || !isEmptyValue(c.value))
    .map((c) => (c.field === "header" ? { ...c, headerName: (c.headerName ?? "").trim() } : c)), [conditions]);

  const folderLabel = useCallback((choice: Checklist["move"]) => {
    const id = folderIdFor(choice);
    const mailbox = id ? mailboxes.find((m) => m.id === id) : undefined;
    return mailbox?.name ?? choice.value.split("/").pop() ?? "";
  }, [folderIdFor, mailboxes]);

  const autoName = useMemo(() => {
    const describe = (c: FilterCondition): string => {
      const value = valueToInput(c.value);
      if (c.field === "all") return t("condition_fields.all");
      if (c.field === "attachment") return c.comparator === "has_any" ? tEditor("has_attachment") : `${tEditor("attachment_type")} ${value}`;
      const field = c.field === "header" ? (c.headerName || t("condition_fields.header")) : t(`condition_fields.${c.field}`);
      return PLAIN_COMPARATORS.has(c.comparator) ? `${field} ${value}` : `${field} ${t(`comparators.${c.comparator}`)} ${value}`;
    };
    const conds = validConditions.length > 0 ? describe(validConditions[0]) + (validConditions.length > 1 ? ` +${validConditions.length - 1}` : "") : "";
    const doing: string[] = [];
    if (checklist.markRead) doing.push(t("action_types.mark_read"));
    if (checklist.star) doing.push(t("action_types.star"));
    if (checklist.tag.on) doing.push(...checklist.tag.ids.map((id) => tagName(id)));
    if (checklist.move.on) doing.push(folderLabel(checklist.move) || t("action_types.move"));
    if (checklist.copy.on) doing.push(`+ ${folderLabel(checklist.copy) || t("action_types.copy")}`);
    if (checklist.forward.on) doing.push(`${t("action_types.forward")} ${checklist.forward.to}`.trim());
    if (checklist.keep) doing.push(t("action_types.keep"));
    if (checklist.reject.on) doing.push(t("action_types.reject"));
    if (checklist.discard) doing.push(t("action_types.discard"));
    const joined = [conds, doing.join(", ")].filter(Boolean).join(" → ");
    return (joined || t("new_rule")).slice(0, 200);
  }, [validConditions, checklist, folderLabel, t, tEditor, tagName]);

  const [showErrors, setShowErrors] = useState(false);
  const [halfFilledPeriod, setHalfFilledPeriod] = useState(false);
  const activeFrom = periodOn ? fromPeriodInput(periodStart, start?.activeFrom) : undefined;
  const activeUntil = periodOn ? fromPeriodInput(periodEnd, start?.activeUntil) : undefined;
  const problem = checklistProblem(resolvedChecklist);

  const guardJunk = skipsJunk({ actions, includeSpam: includeSpam && filing });
  const [preview, setPreview] = useState<{ key: string; result: RulePreview | null } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Mail that is already there no longer has its envelope, so a rule on
  // "Delivered to" is for new mail only: no preview, no Apply to.
  const newMailOnly = validConditions.some((c) => c.field === "delivered_to");
  const previewKey = previewMatches && validConditions.length > 0 && !newMailOnly && !validConditions.some(regexInvalid) && activeFrom !== null && activeUntil !== null
    ? JSON.stringify([matchType, validConditions, guardJunk, activeFrom ?? null, activeUntil ?? null])
    : null;
  const previewRef = useRef(previewMatches);
  previewRef.current = previewMatches;
  useEffect(() => {
    if (!previewKey || !previewRef.current) return;
    const [type, conds, junk, from, until] = JSON.parse(previewKey) as [FilterRule["matchType"], FilterCondition[], boolean, string | null, string | null];
    let stale = false;
    const timer = setTimeout(() => {
      previewRef.current!(
        { id: "preview", name: "", enabled: true, matchType: type, conditions: conds, actions: [], stopProcessing: false, activeFrom: from ?? undefined, activeUntil: until ?? undefined },
        { skipJunk: junk },
      )
        .then((result) => { if (!stale) setPreview({ key: previewKey, result }); })
        .catch(() => { if (!stale) setPreview({ key: previewKey, result: null }); });
    }, 500);
    return () => { stale = true; clearTimeout(timer); };
  }, [previewKey]);
  const previewCurrent = preview && preview.key === previewKey ? preview.result : undefined;

  const partial = previewCurrent?.complete === false;
  const counted = (n: number) => (n === 0 && partial ? null : `${n}${partial ? "+" : ""}`);
  const applyLabel = (key: "apply_folder" | "apply_all", count: string | null, folder = "") =>
    count === null ? tEditor(key, { folder }) : tEditor(`${key}_count`, { folder, count });
  const applyOffered = offerApplyToExisting && !!previewCurrent && (previewCurrent.total > 0 || partial)
    && appliesToExisting({ actions, conditions: validConditions });
  const folderOffered = applyOffered && applyExistingFolder !== undefined && previewCurrent?.inFolder !== undefined;
  const folderUsable = folderOffered && ((previewCurrent?.inFolder ?? 0) > 0 || partial);
  const effectiveApply: ApplyScope = !applyOffered ? "new" : applyTo === "folder" && !folderUsable ? "new" : applyTo;

  const errors = {
    conditions: validConditions.length === 0
      ? t("validation_empty_conditions")
      : validConditions.some((c) => c.field === "header" && !isValidSieveHeaderName(c.headerName ?? ""))
        ? t("validation_header_name")
        : validConditions.some(regexInvalid)
          ? t("validation_regex")
          : validConditions.some(attachmentTypeInvalid)
            ? tEditor("attachment_type_invalid")
            : null,
    actions: problem === null
      ? null
      : problem === "conflict"
        ? tEditor("action_conflict")
        : t({
        none: "validation_empty_actions",
        tag: "validation_action_tag",
        copy: "validation_action_folder",
        move: "validation_action_folder",
        forward: "validation_action_forward",
        reject: "validation_action_reject",
      }[problem]),
    period: !periodOn
      ? null
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
  const valueMissing = (c: FilterCondition) =>
    !!shown(errors.conditions) && validConditions.length === 0 && !takesNoValue(c) && isEmptyValue(c.value);
  const headerInvalid = (c: FilterCondition) =>
    !!shown(errors.conditions) && c.field === "header" && !isEmptyValue(c.value) && !isValidSieveHeaderName((c.headerName ?? "").trim());
  const regexShown = (c: FilterCondition) => !!shown(errors.conditions) && (regexInvalid(c) || attachmentTypeInvalid(c));
  const actionInvalid = (key: ChecklistKey) => !!shown(errors.actions) && problem === key;

  const handleSave = async () => {
    const halfFilled = periodOn &&
      (!!periodStartRef.current?.validity.badInput || !!periodEndRef.current?.validity.badInput);
    setHalfFilledPeriod(halfFilled);
    if (halfFilled || hasErrors) {
      setShowErrors(true);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-rule-error="true"]')?.focus();
      });
      return;
    }
    // On mail that is already there, Discard moves to Trash: say how much
    // first, with the preview's count (a lower bound when the scan stopped).
    if (effectiveApply !== "new" && actions.some((a) => a.type === "discard")) {
      const count = (effectiveApply === "folder" ? previewCurrent?.inFolder : previewCurrent?.total) ?? 0;
      const confirmed = await confirmTrash({
        title: tEditor("trash_title"),
        message: tEditor(partial ? "trash_confirm_partial" : "trash_confirm", { count }),
        confirmText: tEditor("trash_button"),
        cancelText: t("cancel"),
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    onSave({
      id: start?.id || generateUUID(),
      name: name.trim() || autoName,
      enabled,
      matchType,
      conditions: validConditions,
      actions,
      stopProcessing,
      includeSpam: includeSpam && filing ? true : undefined,
      activeFrom: activeFrom ?? undefined,
      activeUntil: activeUntil ?? undefined,
    }, { applyTo: effectiveApply });
  };

  const visibleSuggestions = suggestions.filter((s) => !conditions.some((c) => sameCondition(c, s.condition)));
  const applySuggestion = (suggestion: RuleSuggestion) => {
    setConditions((prev) => {
      const kept = prev.filter((c) => takesNoValue(c) || !isEmptyValue(c.value));
      const replaceAt = suggestion.replaces ? kept.findIndex(suggestion.replaces) : -1;
      if (replaceAt === -1) return [...kept, suggestion.condition];
      return kept.map((c, i) => (i === replaceAt ? suggestion.condition : c));
    });
  };

  const updateCondition = (index: number, next: FilterCondition) =>
    setConditions((prev) => prev.map((c, i) => (i === index ? next : c)));

  const tagIds = useMemo(() => {
    const ids = emailKeywords.map((kw) => kw.id);
    for (const id of checklist.tag.ids) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [emailKeywords, checklist.tag.ids]);

  const thenRow = (key: ChecklistKey, on: boolean, toggle: (on: boolean) => void, control?: ReactNode, below?: ReactNode) => {
    const id = `rule-then-${key}`;
    const disabled = blocked.has(key) || (key === "forward" && forwardLocked);
    return (
      <div key={key} className="py-1">
        <div className="grid grid-cols-1 sm:grid-cols-[13rem_1fr] items-center gap-x-4 gap-y-1.5 min-h-9">
          <label htmlFor={id} className={cn("flex items-center gap-2.5 text-sm", disabled ? "text-muted-foreground" : "text-foreground cursor-pointer")}>
            <input
              id={id}
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={(e) => toggle(e.target.checked)}
              className="rounded border-input disabled:opacity-50"
            />
            {t(`action_types.${{ markRead: "mark_read", tag: "add_label" }[key as string] ?? key}`)}
          </label>
          {control && <div className={cn("min-w-0", !on && "opacity-60 focus-within:opacity-100 hover:opacity-100")}>{control}</div>}
        </div>
        {below}
      </div>
    );
  };

  const numberBadge = (n: number) => (
    <span aria-hidden className="flex-shrink-0 w-7 h-7 rounded-full border border-border text-xs font-medium flex items-center justify-center text-muted-foreground">
      {n}
    </span>
  );

  return (
    <>
      <Dialog
        isOpen
        onClose={() => void requestClose()}
        dirty={dirty}
        title={isEdit ? t("edit_rule") : t("new_rule")}
        size="lg"
        className="max-h-[90vh]"
        initialFocus={firstValueRef}
        footer={
          <>
            {applyOffered && (
              <div className="basis-full flex flex-wrap items-center gap-2 text-sm text-foreground" data-testid="rule-apply-existing">
                <span aria-hidden>{tEditor("apply_to")}</span>
                <select
                  value={effectiveApply}
                  onChange={(e) => setApplyTo(e.target.value as ApplyScope)}
                  className={cn(selectClass, "max-w-full min-w-0")}
                  aria-label={tEditor("apply_to")}
                >
                  <option value="new">{tEditor("apply_new")}</option>
                  {folderOffered && (
                    <option value="folder" disabled={!folderUsable}>
                      {applyLabel("apply_folder", counted(previewCurrent!.inFolder!), applyExistingFolder)}
                    </option>
                  )}
                  <option value="all">{applyLabel("apply_all", counted(previewCurrent!.total))}</option>
                </select>
              </div>
            )}
            {isEdit && onDelete && (
              <Button variant="ghost" className="me-auto text-destructive hover:text-destructive" onClick={onDelete}>
                {t("delete_rule")}
              </Button>
            )}
            <Button variant="outline" onClick={() => void requestClose()}>{t("cancel")}</Button>
            <Button onClick={() => void handleSave()}>{t("save")}</Button>
          </>
        }
      >
        <div className="pt-4 space-y-7">
          <section>
            <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground mb-3">
              {tEditor("if")}
              <select
                value={matchType}
                onChange={(e) => setMatchType(e.target.value as "all" | "any")}
                className={cn(selectClass, "font-semibold")}
                aria-label={tEditor("match_type")}
              >
                <option value="all">{tEditor("match_all")}</option>
                <option value="any">{tEditor("match_any")}</option>
              </select>
              {tEditor("of_conditions")}
            </h3>

            {visibleSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label={t("suggestions")}>
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

            <ol className="space-y-2">
              {conditions.map((condition, index) => {
                const kind = kindOf(condition);
                const offered = comparatorsFor(kind, regexOffered || condition.comparator === "regex");
                const comparators = offered.length > 0 && !offered.includes(condition.comparator) ? [...offered, condition.comparator] : offered;
                const invalid = valueMissing(condition) || regexShown(condition);
                const size = condition.field === "size" ? parseSize(valueToInput(condition.value)) : null;
                return (
                  <li key={index} className="flex items-start gap-2">
                    <div className="pt-0.5">{numberBadge(index + 1)}</div>
                    <div className="flex flex-1 min-w-0 flex-wrap items-center gap-2">
                      <select
                        value={kind}
                        onChange={(e) => updateCondition(index, withKind(condition, e.target.value as ConditionKind, regexOffered))}
                        className={selectClass}
                        aria-label={tEditor("condition_number", { number: index + 1 })}
                      >
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k === "attachment_any" ? tEditor("has_attachment") : k === "attachment_type" ? tEditor("attachment_type") : t(`condition_fields.${k}`)}
                          </option>
                        ))}
                      </select>

                      {kind === "header" && (
                        <Input
                          value={condition.headerName || ""}
                          onChange={(e) => updateCondition(index, { ...condition, headerName: e.target.value })}
                          placeholder={t("header_name")}
                          aria-label={t("header_name")}
                          aria-invalid={headerInvalid(condition)}
                          data-rule-error={headerInvalid(condition)}
                          className={cn("w-32", headerInvalid(condition) && "border-destructive")}
                        />
                      )}

                      {comparators.length > 0 && (
                        <select
                          value={condition.comparator}
                          onChange={(e) => updateCondition(index, { ...condition, comparator: e.target.value as FilterComparator })}
                          className={selectClass}
                          aria-label={tEditor("comparison")}
                        >
                          {comparators.map((c) => (
                            <option key={c} value={c}>{t(`comparators.${c}`)}</option>
                          ))}
                        </select>
                      )}

                      {size && (
                        <div className="flex flex-1 min-w-[10rem] gap-2">
                          <Input
                            ref={index === 0 ? firstValueRef : undefined}
                            type="number"
                            min={0}
                            value={size.amount}
                            onChange={(e) => updateCondition(index, { ...condition, value: formatSize(e.target.value, size.unit) || e.target.value })}
                            aria-label={t("condition_value")}
                            aria-invalid={invalid}
                            data-rule-error={invalid}
                            className={cn("flex-1", invalid && "border-destructive")}
                          />
                          <select
                            value={size.unit}
                            onChange={(e) => updateCondition(index, { ...condition, value: formatSize(size.amount, e.target.value as SizeUnit) })}
                            className={selectClass}
                            aria-label={tEditor("size_unit")}
                          >
                            {(["", "K", "M"] as SizeUnit[]).map((u) => (
                              <option key={u} value={u}>{tEditor(`size_units.${UNIT_KEYS[u]}`)}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      {!size && !takesNoValue(condition) && (
                        <Input
                          ref={index === 0 ? firstValueRef : undefined}
                          value={valueToInput(condition.value)}
                          onChange={(e) => updateCondition(index, { ...condition, value: e.target.value })}
                          onBlur={(e) => {
                            if (usesRegex(condition)) return;
                            const parsed = inputToValue(e.target.value);
                            if (JSON.stringify(parsed) !== JSON.stringify(condition.value)) updateCondition(index, { ...condition, value: parsed });
                          }}
                          placeholder={
                            kind === "attachment_type"
                              ? t("attachment_type_placeholder")
                              : usesRegex(condition)
                                ? t("regex_placeholder")
                                : tWords("filter_value_placeholder")
                          }
                          title={usesRegex(condition) ? undefined : tWords("filter_values_hint")}
                          aria-label={t("condition_value")}
                          aria-invalid={invalid}
                          aria-describedby={invalid ? "rule-conditions-error" : undefined}
                          data-rule-error={invalid}
                          className={cn("flex-1 min-w-[10rem]", invalid && "border-destructive")}
                        />
                      )}
                      {takesNoValue(condition) && <div className="flex-1" />}
                    </div>
                    <IconButton
                      label={t("remove_condition")}
                      onClick={() => setConditions((prev) => prev.filter((_, i) => i !== index))}
                      disabled={conditions.length <= 1}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                    >
                      <X />
                    </IconButton>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center justify-between gap-2 mt-2 ms-9">
              <button
                type="button"
                onClick={() => setConditions((prev) => [...prev, { field: "from", comparator: "contains", value: "" }])}
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <Plus className="w-3.5 h-3.5" />
                {t("add_condition")}
              </button>
              {/* One live region that stays, so a screen reader hears the count when it replaces "Looking…". */}
              <div aria-live="polite" aria-atomic="true">
              {newMailOnly && (
                <span className="text-xs text-muted-foreground" data-testid="rule-new-mail-only">{tEditor("delivered_to_new_only")}</span>
              )}
              {previewKey && (
                previewCurrent === undefined ? (
                  <span className="text-xs text-muted-foreground">{tEditor("checking")}</span>
                ) : previewCurrent && (
                  <button
                    type="button"
                    aria-expanded={previewOpen}
                    disabled={previewCurrent.items.length === 0}
                    onClick={() => setPreviewOpen((open) => !open)}
                    className="flex items-center gap-1 text-xs text-muted-foreground enabled:hover:text-foreground"
                  >
                    {tEditor(previewCurrent.complete ? "matching" : "matching_partial", { count: previewCurrent.total })}
                    {previewCurrent.items.length > 0 && (
                      <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", previewOpen && "rotate-180")} />
                    )}
                  </button>
                )
              )}
              </div>
            </div>
            {previewOpen && previewCurrent && previewCurrent.items.length > 0 && (
              <ul className="mt-2 ms-9 max-h-56 overflow-y-auto rounded-md border border-border divide-y divide-border" data-testid="rule-preview">
                {previewCurrent.items.map((item) => (
                  <li key={item.id} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
                    <span className="w-32 flex-shrink-0 truncate font-medium text-foreground" dir="auto">{item.from}</span>
                    <span className="flex-1 min-w-0 truncate text-muted-foreground" dir="auto">{item.subject}</span>
                    <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                      {item.receivedAt ? new Date(item.receivedAt).toLocaleDateString(locale, { month: "short", day: "numeric", year: "2-digit" }) : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <FieldError id="rule-conditions-error" text={shown(errors.conditions)} />
          </section>

          <section>
            <h3 className="text-base font-semibold text-foreground mb-2">{t("then")}</h3>
            <div className="divide-y divide-border/50">
              {thenRow("markRead", checklist.markRead, (on) => update({ markRead: on }))}
              {thenRow("star", checklist.star, (on) => update({ star: on }))}
              {(tagIds.length > 0 || checklist.tag.on) && thenRow(
                "tag",
                checklist.tag.on,
                (on) => update({ tag: { ...checklist.tag, on } }),
                <div
                  className={cn("flex flex-wrap gap-1.5 rounded-md", actionInvalid("tag") && "ring-1 ring-destructive")}
                  role="group"
                  aria-label={tEditor("tags")}
                  data-rule-error={actionInvalid("tag")}
                  tabIndex={actionInvalid("tag") ? -1 : undefined}
                >
                  {tagIds.map((id) => {
                    const chosen = checklist.tag.ids.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => {
                          const ids = chosen ? checklist.tag.ids.filter((x) => x !== id) : [...checklist.tag.ids, id];
                          update({ tag: { on: ids.length > 0, ids } });
                        }}
                        className={cn(
                          "px-2.5 py-1 text-xs rounded-full border transition-colors duration-150",
                          chosen ? "bg-primary text-primary-foreground border-primary" : "bg-muted border-border text-foreground hover:bg-accent",
                        )}
                      >
                        {tagName(id)}
                      </button>
                    );
                  })}
                </div>,
              )}
              {thenRow(
                "move",
                checklist.move.on,
                (on) => update({ move: { ...checklist.move, on } }),
                <RuleFolderPicker
                  mailboxes={mailboxes}
                  value={folderIdFor(checklist.move)}
                  missingLabel={checklist.move.value || undefined}
                  onPick={(id) => update({ move: { on: !blocked.has("move"), mailboxId: id, value: mailboxPathMap.get(id) ?? "" } })}
                  invalid={actionInvalid("move")}
                  className="w-full"
                />,
              )}
              {thenRow(
                "copy",
                checklist.copy.on,
                (on) => update({ copy: { ...checklist.copy, on } }),
                <RuleFolderPicker
                  mailboxes={mailboxes}
                  value={folderIdFor(checklist.copy)}
                  missingLabel={checklist.copy.value || undefined}
                  onPick={(id) => update({ copy: { on: !blocked.has("copy"), mailboxId: id, value: mailboxPathMap.get(id) ?? "" } })}
                  invalid={actionInvalid("copy")}
                  className="w-full"
                />,
                filing && (
                  <label className="flex items-center gap-2.5 mt-1.5 text-sm text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeSpam}
                      onChange={(e) => setIncludeSpam(e.target.checked)}
                      className="rounded border-input"
                    />
                    {t("include_spam")}
                  </label>
                ),
              )}
              {(!forwardUnavailable || checklist.forward.on) && thenRow(
                "forward",
                checklist.forward.on,
                (on) => update({ forward: { ...checklist.forward, on } }),
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Input
                    value={checklist.forward.to}
                    onChange={(e) => update({ forward: { ...checklist.forward, to: e.target.value, on: !forwardLocked && e.target.value.trim() ? true : checklist.forward.on } })}
                    placeholder={t("forward_placeholder")}
                    aria-label={t("forward_to")}
                    title={tWords("filter_values_hint")}
                    aria-invalid={actionInvalid("forward")}
                    data-rule-error={actionInvalid("forward")}
                    className={cn("flex-1 min-w-[12rem]", actionInvalid("forward") && "border-destructive")}
                  />
                  <label className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checklist.forward.keepCopy}
                      onChange={(e) => update({ forward: { ...checklist.forward, keepCopy: e.target.checked } })}
                      className="rounded border-input"
                    />
                    {t("forward_keep_copy")}
                  </label>
                </div>,
                (forwardOverLimit || (forwardUnavailable && forwardCount > 0)) && (
                  <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                    {forwardUnavailable ? t("forward_unavailable") : t("forward_limit", { count: forwardLimit ?? 0 })}
                  </p>
                ),
              )}
              {(folded.actions.some((a) => a.type === "keep") || checklist.keep) && thenRow("keep", checklist.keep, (on) => update({ keep: on }))}
              {thenRow(
                "reject",
                checklist.reject.on,
                (on) => update({ reject: { ...checklist.reject, on } }),
                <Input
                  value={checklist.reject.message}
                  onChange={(e) => update({ reject: { message: e.target.value, on: !blocked.has("reject") && (e.target.value.trim() ? true : checklist.reject.on) } })}
                  disabled={blocked.has("reject")}
                  placeholder={t("reject_placeholder")}
                  aria-label={t("reject_message")}
                  aria-invalid={actionInvalid("reject")}
                  data-rule-error={actionInvalid("reject")}
                  className={cn("w-full", actionInvalid("reject") && "border-destructive")}
                />,
              )}
              {thenRow("discard", checklist.discard, (on) => update({ discard: on }))}
              <div className="py-1">
                <label className="flex items-center gap-2.5 min-h-9 text-sm text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!stopProcessing}
                    onChange={(e) => setStopProcessing(!e.target.checked)}
                    className="rounded border-input"
                  />
                  {tEditor("continue_rules")}
                </label>
              </div>
            </div>
            <FieldError id="rule-actions-error" text={shown(errors.actions)} />
          </section>

          <section className="space-y-4">
            <div>
              <label htmlFor="rule-name" className="text-sm font-medium mb-1 block text-foreground">{t("rule_name")}</label>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={autoName}
                maxLength={200}
              />
            </div>

            {(periodsSupported || hadPeriod) && (
              <div>
                <label className="flex items-center gap-2.5 text-sm text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={periodOn}
                    onChange={(e) => setPeriodOn(e.target.checked)}
                    className="rounded border-input"
                  />
                  {t("period_toggle")}
                </label>
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
                          className={fieldClass}
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
                          className={fieldClass}
                        />
                      </label>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("period_hint")}</p>
                    <FieldError text={shown(errors.period)} />
                  </div>
                )}
              </div>
            )}

            <label className="flex items-center gap-2.5 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={!enabled}
                onChange={(e) => setEnabled(!e.target.checked)}
                className="rounded border-input"
              />
              {tEditor("skip_rule")}
            </label>
          </section>
        </div>
      </Dialog>
      {discardDialog}
      <ConfirmDialog {...trashDialogProps} />
    </>
  );
}

function FieldError({ id, text: message }: { id?: string; text: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}
