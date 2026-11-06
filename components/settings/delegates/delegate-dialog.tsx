"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Info, Loader2, X } from "@/components/icons";
import { OrgLockedNote } from "@/components/settings/org-locked-note";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Principal, PrincipalListing } from "@/lib/jmap/types";
import type { ShareChange, ShareChangeResult, ShareTarget } from "@/lib/jmap/share-batch";
import type { AccessLevel } from "@/lib/jmap/share-rights";
import {
  buildGrantChanges,
  DEFAULT_DELEGATE_SCOPE,
  failedChanges,
  scopeIsEmpty,
  type CollectionScope,
  type DelegateScope,
  type LevelChoice,
  type MailScope,
} from "@/lib/delegation/delegation";
import { principalDisplay } from "./principal-display";
import { cn } from "@/lib/utils";
import { ModalWindow } from "@/components/ui/dialog-surface";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Lookup =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "notFound"; address: string }
  | { state: "directoryOff" }
  | { state: "self" }
  | { state: "failed" };

export interface DelegateDialogProps {
  client: IJMAPClient;
  targets: ShareTarget[];
  directory: PrincipalListing | null;
  /** The user's own principal ids, never offered. */
  ownIds: string[];
  /** The user's own addresses: typing one says "That's you". */
  ownEmails: string[];
  /** Ids that already have access to something. */
  existingIds: Set<string>;
  /** Set for "Change": the person, and what they have now. */
  initial?: { principal: Principal; scope: DelegateScope; level: LevelChoice };
  levels: AccessLevel[];
  /** The admin limited the rights (sharingRights). */
  levelsRestricted: boolean;
  /**
   * The server keeps "mark as read" and flags as one right on folders
   * (Stalwart 1.0), so read delegates can flag too; the read hint says so.
   */
  seenSetsKeywords?: boolean;
  onApplied: (principal: Principal, results: ShareChangeResult[]) => void;
  onClose: () => void;
}

/**
 * "Give access" and "Change": one person, what they get, and with which
 * rights, applied to every folder, calendar and address book in one batch.
 * Full screen on a phone.
 */
export function DelegateDialog({
  client, targets, directory, ownIds, ownEmails, existingIds, initial, levels, levelsRestricted, seenSetsKeywords, onApplied, onClose,
}: DelegateDialogProps) {
  const t = useTranslations("delegates");
  const tCommon = useTranslations("common");
  const titleId = useId();
  const changing = !!initial;

  const [principal, setPrincipal] = useState<Principal | null>(initial?.principal ?? null);
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [scope, setScope] = useState<DelegateScope>(initial?.scope ?? DEFAULT_DELEGATE_SCOPE);
  const [level, setLevel] = useState<LevelChoice>(() => {
    const wanted = initial?.level ?? "read";
    return wanted === "keep" || levels.includes(wanted) ? wanted : levels[0];
  });
  // "Keep as it is" is offered where Change started with it, and stays offered.
  const keep = {
    mail: initial?.scope.mail === "keep",
    calendars: initial?.scope.calendars === "keep",
    addressBooks: initial?.scope.addressBooks === "keep",
    level: initial?.level === "keep",
  };
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<ShareChangeResult[] | null>(null);

  const dialogRef = useFocusTrap({ isActive: true, onEscape: () => { if (!saving) onClose(); }, restoreFocus: true });
  // The trap focuses the first control, the close button; picking a person
  // starts in the search field. Declared after the trap, so it runs after it.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const has = (kind: ShareTarget["kind"]) => targets.some((target) => target.kind === kind);
  const directoryOff = directory?.status === "restricted" && !!directory.directoryQueriesOff;

  const candidates = useMemo(() => {
    const own = new Set(ownIds);
    const q = query.trim().toLowerCase();
    return (directory?.principals ?? [])
      .filter((p) => !own.has(p.id))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q));
  }, [directory, ownIds, query]);

  const typedAddress = query.trim();
  const canLookUp = EMAIL_RE.test(typedAddress)
    && !candidates.some((p) => p.email?.toLowerCase() === typedAddress.toLowerCase());

  const lookUp = async () => {
    if (!canLookUp || lookup.state === "busy") return;
    if (ownEmails.some((email) => email.toLowerCase() === typedAddress.toLowerCase())) {
      setLookup({ state: "self" });
      return;
    }
    if (!client.findPrincipalByEmail) {
      setLookup({ state: "failed" });
      return;
    }
    setLookup({ state: "busy" });
    const found = await client.findPrincipalByEmail(typedAddress);
    if (found.principal && ownIds.includes(found.principal.id)) {
      setLookup({ state: "self" });
    } else if (found.principal) {
      setPrincipal(found.principal);
      setLookup({ state: "idle" });
    } else if (found.status === "forbidden") {
      setLookup({ state: "directoryOff" });
    } else if (found.status === "ok") {
      setLookup({ state: "notFound", address: typedAddress });
    } else {
      setLookup({ state: "failed" });
    }
  };

  const apply = async (changes: ShareChange[]) => {
    if (!principal || !client.applyShareChanges) return;
    setSaving(true);
    try {
      const results = await client.applyShareChanges(changes);
      const failed = failedChanges(results);
      onApplied(principal, results);
      if (failed.length === 0) onClose();
      else setFailures(failed);
    } finally {
      setSaving(false);
    }
  };

  const changes = useMemo(
    () => (principal ? buildGrantChanges(targets, principal.id, scope, level, { replace: changing }) : []),
    [targets, principal, scope, level, changing],
  );
  const nothingToDo = changing ? changes.length === 0 : scopeIsEmpty(scope);

  const submit = () => {
    if (!principal || nothingToDo) return;
    void apply(changes);
  };

  const retry = () => {
    if (failures) void apply(failures.map((f) => f.change));
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <ModalWindow title={changing && principal ? t("dialog_title_change", { name: principalDisplay(principal).name }) : t("dialog_title_add")} onClose={() => { if (!saving) onClose(); }}>
      <div
        data-modal-backdrop="" className="fixed inset-0 z-[100000] flex items-stretch justify-center bg-black/50 backdrop-blur-[1px] sm:items-center sm:p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
        // Keys typed here are the dialog's: the mail shortcuts behind it must not see them.
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="delegate-dialog"
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="relative flex h-full w-full flex-col bg-background shadow-xl sm:h-auto sm:max-h-[85vh] sm:max-w-lg sm:rounded-lg sm:border sm:border-border"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
            <h2 id={titleId} className="truncate text-lg font-semibold">
              {changing && principal ? t("dialog_title_change", { name: principalDisplay(principal).name }) : t("dialog_title_add")}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              aria-label={tCommon("close")}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {failures ? (
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6" role="alert">
              <p className="text-sm font-medium">{t("partial_title")}</p>
              <ul className="divide-y divide-border rounded-md border border-border text-sm">
                {failures.map((f) => (
                  <li key={`${f.change.kind}:${f.change.id}`} className="px-3 py-2">
                    <span className="font-medium">{f.change.name}</span>
                    <span className="text-muted-foreground"> · {t(`kind.${f.change.kind}`)}</span>
                    {f.error && <div className="text-xs text-muted-foreground">{f.error}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
              <Field label={t("person")}>
                {principal ? (
                  <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                    <Avatar name={principal.name} email={principal.email ?? undefined} size="sm" className="shrink-0" />
                    <PrincipalText principal={principal} />
                    {!changing && (
                      <Button variant="ghost" size="sm" onClick={() => { setPrincipal(null); setLookup({ state: "idle" }); }}>
                        {t("change_person")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => { setQuery(e.target.value); setLookup({ state: "idle" }); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void lookUp(); } }}
                      placeholder={t("search_placeholder")}
                      aria-label={t("person")}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
                      ref={searchRef}
                    />
                    {directory === null ? (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t("loading")}</p>
                    ) : (
                      <ul className="max-h-48 overflow-y-auto rounded-md border border-border" aria-label={t("person")} data-testid="delegate-candidates">
                        {candidates.length === 0 && !canLookUp && (
                          <li className="px-3 py-2 text-xs text-muted-foreground">{t("no_match")}</li>
                        )}
                        {candidates.map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => setPrincipal(p)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-muted focus:bg-muted focus:outline-none"
                            >
                              <Avatar name={p.name} email={p.email ?? undefined} size="sm" className="shrink-0" />
                              <PrincipalText principal={p} />
                              {existingIds.has(p.id) && <span className="shrink-0 text-[0.625rem] text-muted-foreground">{t("has_access")}</span>}
                            </button>
                          </li>
                        ))}
                        {canLookUp && (
                          <li>
                            <button
                              type="button"
                              onClick={() => void lookUp()}
                              disabled={lookup.state === "busy"}
                              className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
                            >
                              {lookup.state === "busy" && <Loader2 className="h-4 w-4 animate-spin" />}
                              {lookup.state === "busy" ? t("looking_up") : t("use_address", { address: typedAddress })}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                    {lookup.state === "notFound" && <p className="text-xs text-destructive" role="status">{t("not_found", { address: lookup.address })}</p>}
                    {lookup.state === "failed" && <p className="text-xs text-destructive" role="status">{t("lookup_failed")}</p>}
                    {lookup.state === "self" && <p className="text-xs text-destructive" role="status">{t("is_you")}</p>}
                    {(directoryOff || lookup.state === "directoryOff") && (
                      <p className="text-xs text-muted-foreground" role="status" data-testid="delegate-directory-off">
                        {directoryOff ? `${t("known_only")} ` : ""}{t("directory_off_note")}
                      </p>
                    )}
                    {directory?.status === "error" && <p className="text-xs text-muted-foreground">{t("directory_failed")}</p>}
                  </div>
                )}
              </Field>

              <fieldset className="space-y-3">
                <legend className="mb-1 text-sm font-medium">{t("what")}</legend>
                {has("mailbox") && (
                  <Choice<MailScope>
                    label={t("mail")}
                    value={scope.mail}
                    onChange={(mail) => setScope({ ...scope, mail })}
                    options={[...keepOption<MailScope>(keep.mail, t("keep")), ["all", t("mail_all")], ["inbox", t("mail_inbox")], ["none", t("none")]]}
                  />
                )}
                {has("calendar") && (
                  <Choice<CollectionScope>
                    label={t("calendars")}
                    value={scope.calendars}
                    onChange={(calendars) => setScope({ ...scope, calendars })}
                    options={[...keepOption<CollectionScope>(keep.calendars, t("keep")), ["default", t("calendars_default")], ["all", t("calendars_all")], ["none", t("none")]]}
                  />
                )}
                {has("addressBook") && (
                  <Choice<CollectionScope>
                    label={t("address_books")}
                    value={scope.addressBooks}
                    onChange={(addressBooks) => setScope({ ...scope, addressBooks })}
                    options={[...keepOption<CollectionScope>(keep.addressBooks, t("keep")), ["default", t("address_books_default")], ["all", t("address_books_all")], ["none", t("none")]]}
                  />
                )}
                {!changing && scopeIsEmpty(scope) && <p className="text-xs text-destructive">{t("empty_scope")}</p>}
                {changing && <p className="text-xs text-muted-foreground">{t("change_note")}</p>}
              </fieldset>

              <fieldset className="space-y-2" data-testid="delegate-rights">
                <legend className="mb-1 text-sm font-medium">{t("rights")}</legend>
                {[...(keep.level ? ["keep" as const] : []), ...levels].map((option) => (
                  <label key={option} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="delegate-level"
                      value={option}
                      checked={level === option}
                      onChange={() => setLevel(option)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block">{t(`rights_${option}`)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(option === "read" && seenSetsKeywords ? "rights_read_hint_flags" : `rights_${option}_hint`)}
                      </span>
                    </span>
                  </label>
                ))}
                {levelsRestricted && <OrgLockedNote />}
              </fieldset>

              {changing && nothingToDo && <p className="text-xs text-muted-foreground" role="status">{t("nothing_to_change")}</p>}

              <p className="flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t("send_note")}</span>
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6 sm:py-4">
            {failures ? (
              <>
                <Button variant="outline" onClick={onClose} disabled={saving}>{tCommon("close")}</Button>
                <Button onClick={retry} disabled={saving}>
                  {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                  {t("retry")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={onClose} disabled={saving}>{tCommon("cancel")}</Button>
                <Button onClick={submit} disabled={saving || !principal || nothingToDo}>
                  {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                  {changing ? t("apply_change") : t("apply_add")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </ModalWindow>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      {children}
    </div>
  );
}

function PrincipalText({ principal }: { principal: Principal }) {
  const t = useTranslations("delegates");
  const { name, detail } = principalDisplay(principal);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 truncate text-sm font-medium">
        <span className="truncate">{name}</span>
        {principal.type === "group" && (
          <span className="rounded bg-muted px-1 py-0.5 text-[0.6875rem] font-normal text-muted-foreground">{t("group")}</span>
        )}
      </div>
      {detail && <div className="truncate text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function keepOption<T extends string>(offered: boolean, label: string): [T, string][] {
  return offered ? [["keep" as T, label]] : [];
}

function Choice<T extends string>({ label, value, onChange, options }: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: [T, string][];
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([option, text]) => (
          <label
            key={option}
            className={cn(
              "cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === option ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="sr-only" />
            {text}
          </label>
        ))}
      </div>
    </div>
  );
}
