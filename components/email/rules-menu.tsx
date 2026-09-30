"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from "@/components/ui/context-menu";
import {
  Archive,
  Ban,
  ChevronLeft,
  ChevronRight,
  File,
  Filter,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  List,
  MailOpen,
  Plus,
  Send,
  Settings,
  Tag,
  Trash2,
} from "@/components/icons";
import { useRouter } from "@/i18n/navigation";
import { buildMailboxTree, cn, generateUUID, type MailboxNode } from "@/lib/utils";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { useAuthStore } from "@/stores/auth-store";
import { useFilterStore } from "@/stores/filter-store";
import { useQuickRuleStore, type FiltersStatus } from "@/stores/quick-rule-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import {
  buildPrefillRule,
  buildSuggestions,
  collectSenders,
  findJunkMailbox,
  ruleTargetMailboxIds,
  rulesMenuAvailability,
  sharedDomain,
  sharedListId,
  toRuleMailbox,
  type QuickRulePreset,
  type QuickRuleSubject,
  type RuleMailbox,
  type RulesMenuAvailability,
} from "@/lib/filters/quick-rules";
import {
  getOwnAddresses,
  knownListId,
  loadListIds,
  resolveQuickRuleTarget,
  sourceMailboxOf,
  type QuickRuleTarget,
} from "@/lib/filters/quick-rule-target";
import { ensureFiltersStatus, openFilterSettings, runPresetRule, type QuickRuleText } from "@/lib/filters/quick-rule-flow";

/** Translators for the rule flows, which outlive the menu that starts them. */
export function useQuickRuleText(): QuickRuleText {
  const tNotifications = useTranslations("notifications");
  const tFilters = useTranslations("settings.filters");
  const tMenu = useTranslations("context_menu");
  return useMemo(() => ({
    notifications: (key, values) => tNotifications(key, values),
    filters: (key, values) => tFilters(key, values),
    menu: (key, values) => tMenu(key, values),
  }), [tNotifications, tFilters, tMenu]);
}

/**
 * Whether messages get a Rules entry, and for which account. Every message
 * of a selection has to belong to the same account; shared/group accounts
 * and accounts without Sieve get none.
 */
export function useRulesAvailability(emails: Email[]): { availability: RulesMenuAvailability; target: QuickRuleTarget | null } {
  // The auth client is read by the resolution; a login change re-resolves.
  const client = useAuthStore((s) => s.client);
  return useMemo(() => {
    if (!client) return { availability: "hidden", target: null };
    const targets = emails.map((email) => resolveQuickRuleTarget(email));
    const availability = rulesMenuAvailability(
      targets.map((t) => t && { key: t.key, shared: t.shared, supportsSieve: t.supportsSieve }),
    );
    return { availability, target: availability === "available" ? targets[0] : null };
  }, [emails, client]);
}

/** Whether the account's script can take a rule; the filter store answers for the account it holds. */
function useFiltersStatus(target: QuickRuleTarget): FiltersStatus {
  const authClient = useAuthStore((s) => s.client);
  const selectedAccountId = useFilterStore((s) => s.selectedAccountId);
  const isSupported = useFilterStore((s) => s.isSupported);
  const isLoading = useFilterStore((s) => s.isLoading);
  const error = useFilterStore((s) => s.error);
  const isOpaque = useFilterStore((s) => s.isOpaque);
  const cached = useQuickRuleStore((s) => s.statuses[target.key]?.status);
  const storeHolds = authClient === target.client
    && selectedAccountId === target.sieveAccountId
    && isSupported && !isLoading && !error;

  useEffect(() => {
    if (!storeHolds) ensureFiltersStatus(target);
  }, [target, storeHolds]);

  if (storeHolds) return isOpaque ? "opaque" : "ready";
  return cached ?? "loading";
}

function filterTree(nodes: MailboxNode[], targetIds: Set<string>): MailboxNode[] {
  return nodes.reduce<MailboxNode[]>((acc, node) => {
    const children = filterTree(node.children, targetIds);
    if (targetIds.has(node.id) || children.length > 0) acc.push({ ...node, children });
    return acc;
  }, []);
}

const mailboxIcon = (role?: string) => {
  switch (role) {
    case "inbox": return Inbox;
    case "sent": return Send;
    case "drafts": return File;
    case "trash": return Trash2;
    case "archive": return Archive;
    default: return Folder;
  }
};

function truncate(value: string, max = 36): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

type MovePresetKind = "move_sender" | "move_domain" | "move_list";

/** Everything the Rules menu shows and does, for one message or a selection. */
function useRulesModel(anchor: Email, senderEmails: Email[], target: QuickRuleTarget) {
  const text = useQuickRuleText();
  const tMenu = useTranslations("context_menu");
  const router = useRouter();
  const { tagName, tagColor } = useKeywordFormat();
  const emailKeywords = useSettingsStore((s) => s.emailKeywords);
  const status = useFiltersStatus(target);

  const own = useMemo(() => getOwnAddresses(), []);
  const senders = useMemo(() => collectSenders(senderEmails, own), [senderEmails, own]);

  // Rows carry no headers, so the List-Id is asked for when the menu opens.
  const [listIds, setListIds] = useState(() => senderEmails.map((e) => knownListId(target, e)));
  useEffect(() => {
    let cancelled = false;
    setListIds(senderEmails.map((e) => knownListId(target, e)));
    loadListIds(target, senderEmails)
      .then(() => { if (!cancelled) setListIds(senderEmails.map((e) => knownListId(target, e))); })
      .catch(() => { /* no list preset then */ });
    return () => { cancelled = true; };
  }, [target, senderEmails]);

  const subject: QuickRuleSubject = useMemo(() => ({
    senders,
    domain: sharedDomain(senders),
    listId: sharedListId(listIds),
  }), [senders, listIds]);

  const targetIds = useMemo(() => ruleTargetMailboxIds(target.mailboxes), [target]);
  const tree = useMemo(() => filterTree(buildMailboxTree(target.mailboxes), targetIds), [target, targetIds]);
  const junk = useMemo(() => findJunkMailbox(target.mailboxes), [target]);
  const sourceMailboxId = useMemo(() => sourceMailboxOf(anchor, target)?.id ?? null, [anchor, target]);

  const senderLabel = senders.length === 1
    ? truncate(senders[0].name || senders[0].email)
    : tMenu("rules.senders_count", { count: senders.length });
  const senderTitle = senders.map((s) => s.email).join(", ");

  const run = (preset: QuickRulePreset) => {
    void runPresetRule({ target, preset, subject, sourceMailboxId, text });
  };
  const moveTo = (kind: MovePresetKind, mailbox: Mailbox) => {
    run({ kind, mailbox: toRuleMailbox(target.mailboxes, mailbox) });
  };
  const moveToNewFolder = (kind: MovePresetKind) => {
    useQuickRuleStore.getState().requestNewFolder({
      target,
      subject,
      sourceMailboxId,
      preset: (mailbox: RuleMailbox) => ({ kind, mailbox }),
    });
  };
  const createRule = () => {
    // A thread row's own reply stands aside for the message it answered.
    const source = senderEmails.length === 1 ? senderEmails[0] : anchor;
    useQuickRuleStore.getState().openEditor({
      mode: "prefill",
      target,
      rule: buildPrefillRule(subject, text.filters, generateUUID()),
      suggestions: buildSuggestions(source, subject, own, text.filters),
      sourceMailboxId,
    });
  };
  const manageRules = () => {
    void openFilterSettings(target, (href) => router.push(href));
  };

  return {
    status,
    locked: status === "opaque",
    subject,
    senders,
    senderLabel,
    senderTitle,
    tree,
    targetIds,
    junk,
    tags: emailKeywords.map((kw) => ({ id: kw.id, name: tagName(kw.id), dot: tagColor(kw.id).dot })),
    run,
    moveTo,
    moveToNewFolder,
    createRule,
    manageRules,
  };
}

type RulesModel = ReturnType<typeof useRulesModel>;

// ── Right-click menu ─────────────────────────────────────────────────────

function ContextFolderItems({
  model,
  kind,
  onDone,
}: {
  model: RulesModel;
  kind: MovePresetKind;
  onDone: () => void;
}) {
  const tSidebar = useTranslations("sidebar");
  const tFolderMenu = useTranslations("mailbox_context_menu");
  const render = (nodes: MailboxNode[]): React.ReactNode => nodes.map((node) => {
    const Icon = mailboxIcon(node.role);
    const label = localizeMailboxName(node.role, node.name, (k) => tSidebar(`mailboxes.${k}`));
    return (
      <div key={node.id}>
        {model.targetIds.has(node.id) ? (
          <ContextMenuItem
            icon={Icon}
            label={label}
            testId={`rules:${kind}:${node.id}`}
            onClick={() => { model.moveTo(kind, node); onDone(); }}
          />
        ) : (
          <div className="px-3 py-1.5 text-sm flex items-center gap-2 text-muted-foreground">
            <Icon className="w-4 h-4 flex-shrink-0" />
            <span>{label}</span>
          </div>
        )}
        {node.children.length > 0 && <div className="ps-4">{render(node.children)}</div>}
      </div>
    );
  });
  return (
    <>
      {render(model.tree)}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={FolderPlus}
        label={tFolderMenu("new_folder")}
        testId={`rules:${kind}:new-folder`}
        onClick={() => { model.moveToNewFolder(kind); onDone(); }}
      />
    </>
  );
}

function ContextRulesContent({
  anchor,
  senderEmails,
  target,
  onDone,
}: {
  anchor: Email;
  senderEmails: Email[];
  target: QuickRuleTarget;
  onDone: () => void;
}) {
  const t = useTranslations("context_menu");
  const model = useRulesModel(anchor, senderEmails, target);
  const { locked, subject, senders } = model;
  const hasSenders = senders.length > 0;
  const act = (fn: () => void) => { fn(); onDone(); };

  return (
    <div className="max-w-[22rem]">
      {locked && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground" data-testid="rules:opaque-hint">
          {t("rules.opaque_hint")}
        </div>
      )}
      {hasSenders && (
        <ContextMenuSubMenu
          icon={FolderInput}
          label={t("rules.move_from", { sender: model.senderLabel })}
          title={model.senderTitle}
          disabled={locked}
          testId="rules:move_sender"
        >
          <ContextFolderItems model={model} kind="move_sender" onDone={onDone} />
        </ContextMenuSubMenu>
      )}
      {hasSenders && subject.domain && (
        <ContextMenuSubMenu
          icon={FolderInput}
          label={t("rules.move_from_domain", { domain: subject.domain })}
          disabled={locked}
          testId="rules:move_domain"
        >
          <ContextFolderItems model={model} kind="move_domain" onDone={onDone} />
        </ContextMenuSubMenu>
      )}
      {subject.listId && (
        <ContextMenuSubMenu
          icon={List}
          label={t("rules.move_from_list")}
          title={subject.listId}
          disabled={locked}
          testId="rules:move_list"
        >
          <ContextFolderItems model={model} kind="move_list" onDone={onDone} />
        </ContextMenuSubMenu>
      )}
      {hasSenders && (
        <ContextMenuItem
          icon={MailOpen}
          label={t("rules.mark_read_from", { sender: model.senderLabel })}
          title={model.senderTitle}
          disabled={locked}
          testId="rules:mark_read"
          onClick={() => act(() => model.run({ kind: "mark_read" }))}
        />
      )}
      {hasSenders && model.tags.length > 0 && (
        <ContextMenuSubMenu icon={Tag} label={t("rules.tag_with")} disabled={locked} testId="rules:tag">
          {model.tags.map((tag) => (
            <button
              key={tag.id}
              role="menuitem"
              type="button"
              data-testid={`rules:tag:${tag.id}`}
              onClick={(e) => {
                e.stopPropagation();
                act(() => model.run({ kind: "tag", tagId: tag.id, tagName: tag.name }));
              }}
              className="w-full px-3 py-1.5 text-sm text-start flex items-center gap-2 hover:bg-muted focus:outline-none focus:bg-muted"
            >
              <span className={cn("w-3 h-3 rounded-full flex-shrink-0", tag.dot)} />
              <span className="flex-1 truncate">{tag.name}</span>
            </button>
          ))}
        </ContextMenuSubMenu>
      )}
      {hasSenders && (
        <ContextMenuItem
          icon={Ban}
          label={t("rules.block", { count: senders.length })}
          title={model.senderTitle}
          disabled={locked || !model.junk}
          hint={model.junk ? undefined : t("rules.no_junk")}
          destructive
          testId="rules:block"
          onClick={() => act(() => model.junk && model.run({ kind: "block", junk: toRuleMailbox(target.mailboxes, model.junk) }))}
        />
      )}
      {(hasSenders || subject.listId) && <ContextMenuSeparator />}
      <ContextMenuItem
        icon={Plus}
        label={t("rules.create")}
        disabled={locked}
        testId="rules:create"
        onClick={() => act(model.createRule)}
      />
      <ContextMenuItem
        icon={Settings}
        label={t("rules.manage")}
        testId="rules:manage"
        onClick={() => act(model.manageRules)}
      />
    </div>
  );
}

/**
 * The "Rules" entry of the message list's right-click menu: one-click rules
 * for the sender(s) of `senderEmails`, "Create rule…" and "Manage rules".
 * `anchor` is the message the menu was opened on; its folder is where
 * "apply to existing messages" runs.
 */
export function RulesContextSubMenu({
  anchor,
  senderEmails,
  onClose,
}: {
  anchor: Email;
  senderEmails: Email[];
  onClose: () => void;
}) {
  const t = useTranslations("context_menu");
  const accountEmails = useMemo(
    () => (senderEmails.some((e) => e.id === anchor.id) ? senderEmails : [anchor, ...senderEmails]),
    [anchor, senderEmails],
  );
  const { availability, target } = useRulesAvailability(accountEmails);
  if (availability === "hidden") return null;
  return (
    <ContextMenuSubMenu
      icon={Filter}
      label={t("rules.title")}
      testId="ctx-rules"
      disabled={availability === "cross_account"}
      hint={availability === "cross_account" ? t("rules.cross_account") : undefined}
    >
      {target && <ContextRulesContent anchor={anchor} senderEmails={senderEmails} target={target} onDone={onClose} />}
    </ContextMenuSubMenu>
  );
}

// ── Reading pane ⋮ menu ──────────────────────────────────────────────────

type PanelView = "root" | MovePresetKind | "tag";

function PanelButton({
  variant,
  icon: Icon,
  label,
  title,
  hint,
  disabled,
  destructive,
  chevron,
  depth = 0,
  testId,
  onClick,
}: {
  variant: "desktop" | "mobile";
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  title?: string;
  hint?: string;
  disabled?: boolean;
  destructive?: boolean;
  chevron?: boolean;
  depth?: number;
  testId?: string;
  onClick: () => void;
}) {
  const mobile = variant === "mobile";
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled}
      title={title}
      data-testid={testId}
      aria-haspopup={chevron ? "menu" : undefined}
      onClick={onClick}
      className={cn(
        "w-full text-sm text-start flex items-center",
        mobile ? "px-4 py-3 min-h-[44px] gap-3" : "px-3 py-1.5 gap-2",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted",
        destructive && !disabled ? "text-destructive" : "text-foreground",
      )}
      style={depth > 0 ? { paddingInlineStart: `${(mobile ? 1 : 0.75) + depth}rem` } : undefined}
    >
      <Icon className={cn("flex-shrink-0", mobile ? "w-5 h-5" : "w-4 h-4")} />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground whitespace-normal">{hint}</span>}
      </span>
      {chevron && <ChevronRight className={cn("text-muted-foreground flex-shrink-0", mobile ? "w-4 h-4" : "w-3 h-3")} />}
    </button>
  );
}

function PanelContent({
  email,
  target,
  variant,
  onDone,
}: {
  email: Email;
  target: QuickRuleTarget;
  variant: "desktop" | "mobile";
  onDone: () => void;
}) {
  const t = useTranslations("context_menu");
  const tSidebar = useTranslations("sidebar");
  const tFolderMenu = useTranslations("mailbox_context_menu");
  const senderEmails = useMemo(() => [email], [email]);
  const model = useRulesModel(email, senderEmails, target);
  const [view, setView] = useState<PanelView>("root");
  const { locked, subject, senders } = model;
  const hasSenders = senders.length > 0;
  const act = (fn: () => void) => { fn(); onDone(); };

  const moveLabels: Record<MovePresetKind, string> = {
    move_sender: t("rules.move_from", { sender: model.senderLabel }),
    move_domain: t("rules.move_from_domain", { domain: subject.domain ?? "" }),
    move_list: t("rules.move_from_list"),
  };

  if (view !== "root") {
    const back = (
      <PanelButton
        variant={variant}
        icon={ChevronLeft}
        label={view === "tag" ? t("rules.tag_with") : moveLabels[view]}
        onClick={() => setView("root")}
      />
    );
    if (view === "tag") {
      return (
        <>
          {back}
          <div className="h-px bg-border my-1" />
          {model.tags.map((tag) => (
            <button
              key={tag.id}
              role="menuitem"
              type="button"
              data-testid={`rules:tag:${tag.id}`}
              onClick={() => act(() => model.run({ kind: "tag", tagId: tag.id, tagName: tag.name }))}
              className={cn(
                "w-full text-sm text-start flex items-center hover:bg-muted text-foreground",
                variant === "mobile" ? "px-4 py-3 min-h-[44px] gap-3" : "px-3 py-1.5 gap-2",
              )}
            >
              <span className={cn("w-3 h-3 rounded-full flex-shrink-0", tag.dot)} />
              <span className="flex-1 truncate">{tag.name}</span>
            </button>
          ))}
        </>
      );
    }
    const kind = view;
    const render = (nodes: MailboxNode[], depth = 0): React.ReactNode => nodes.map((node) => {
      const label = localizeMailboxName(node.role, node.name, (k) => tSidebar(`mailboxes.${k}`));
      const Icon = mailboxIcon(node.role);
      return (
        <div key={node.id}>
          {model.targetIds.has(node.id) ? (
            <PanelButton
              variant={variant}
              icon={Icon}
              label={label}
              depth={depth}
              testId={`rules:${kind}:${node.id}`}
              onClick={() => act(() => model.moveTo(kind, node))}
            />
          ) : (
            <div
              className={cn(
                "text-sm flex items-center text-muted-foreground",
                variant === "mobile" ? "px-4 py-3 min-h-[44px] gap-3" : "px-3 py-1.5 gap-2",
              )}
              style={depth > 0 ? { paddingInlineStart: `${(variant === "mobile" ? 1 : 0.75) + depth}rem` } : undefined}
            >
              <Icon className={cn("flex-shrink-0", variant === "mobile" ? "w-5 h-5" : "w-4 h-4")} />
              <span className="truncate">{label}</span>
            </div>
          )}
          {node.children.length > 0 && render(node.children, depth + 1)}
        </div>
      );
    });
    return (
      <>
        {back}
        <div className="h-px bg-border my-1" />
        {render(model.tree)}
        <div className="h-px bg-border my-1" />
        <PanelButton
          variant={variant}
          icon={FolderPlus}
          label={tFolderMenu("new_folder")}
          testId={`rules:${kind}:new-folder`}
          onClick={() => act(() => model.moveToNewFolder(kind))}
        />
      </>
    );
  }

  return (
    <>
      {locked && (
        <div
          className={cn("text-xs text-muted-foreground", variant === "mobile" ? "px-4 py-2" : "px-3 py-1.5")}
          data-testid="rules:opaque-hint"
        >
          {t("rules.opaque_hint")}
        </div>
      )}
      {hasSenders && (
        <PanelButton
          variant={variant}
          icon={FolderInput}
          label={moveLabels.move_sender}
          title={model.senderTitle}
          disabled={locked}
          chevron
          testId="rules:move_sender"
          onClick={() => setView("move_sender")}
        />
      )}
      {hasSenders && subject.domain && (
        <PanelButton
          variant={variant}
          icon={FolderInput}
          label={moveLabels.move_domain}
          disabled={locked}
          chevron
          testId="rules:move_domain"
          onClick={() => setView("move_domain")}
        />
      )}
      {subject.listId && (
        <PanelButton
          variant={variant}
          icon={List}
          label={moveLabels.move_list}
          title={subject.listId}
          disabled={locked}
          chevron
          testId="rules:move_list"
          onClick={() => setView("move_list")}
        />
      )}
      {hasSenders && (
        <PanelButton
          variant={variant}
          icon={MailOpen}
          label={t("rules.mark_read_from", { sender: model.senderLabel })}
          title={model.senderTitle}
          disabled={locked}
          testId="rules:mark_read"
          onClick={() => act(() => model.run({ kind: "mark_read" }))}
        />
      )}
      {hasSenders && model.tags.length > 0 && (
        <PanelButton
          variant={variant}
          icon={Tag}
          label={t("rules.tag_with")}
          disabled={locked}
          chevron
          testId="rules:tag"
          onClick={() => setView("tag")}
        />
      )}
      {hasSenders && (
        <PanelButton
          variant={variant}
          icon={Ban}
          label={t("rules.block", { count: senders.length })}
          title={model.senderTitle}
          hint={model.junk ? undefined : t("rules.no_junk")}
          disabled={locked || !model.junk}
          destructive
          testId="rules:block"
          onClick={() => act(() => model.junk && model.run({ kind: "block", junk: toRuleMailbox(target.mailboxes, model.junk) }))}
        />
      )}
      {(hasSenders || subject.listId) && <div className="h-px bg-border my-1" />}
      <PanelButton
        variant={variant}
        icon={Plus}
        label={t("rules.create")}
        disabled={locked}
        testId="rules:create"
        onClick={() => act(model.createRule)}
      />
      <PanelButton
        variant={variant}
        icon={Settings}
        label={t("rules.manage")}
        testId="rules:manage"
        onClick={() => act(model.manageRules)}
      />
    </>
  );
}

/**
 * The Rules sub-view of the reading pane's More menu, for the open message.
 * Nested lists (the folders, the tags) replace the view with a back row, so
 * the same component serves the desktop flyout and the mobile panel.
 */
export function RulesPanel({
  email,
  target,
  variant,
  onDone,
}: {
  email: Email;
  target: QuickRuleTarget;
  variant: "desktop" | "mobile";
  onDone: () => void;
}) {
  return <PanelContent key={email.id} email={email} target={target} variant={variant} onDone={onDone} />;
}
