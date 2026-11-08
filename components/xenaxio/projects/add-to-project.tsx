"use client";

// xenaxio step 118, part D: "Zu Projekt hinzufügen" for an open email and a
// file. One email may belong to several projects; the dialog shows the
// projects it is in already and finds others by their name.
import { useEffect, useState } from "react";
import { IconLayoutKanban } from "@tabler/icons-react";
import { Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import type { Email } from "@/lib/jmap/types";
import { errorText } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { useLocale } from "next-intl";
import { type LinkKind, local, type ObjectSummary, type ObjectType, projectsApi, typeHref } from "@/lib/xenaxio/projects";
import { selectClass } from "./bits";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";
import { useAuthStore } from "@/stores/auth-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/stores/toast-store";
import { Modal } from "./bits";

export interface LinkTarget {
  kind: LinkKind;
  ref: string;
  account: string | null;
  title: string;
}

export function AddToProjectDialog({ target, onClose }: { target: LinkTarget; onClose: () => void }) {
  const t = useXT();
  const [q, setQ] = useState("");
  const [projects, setProjects] = useState<ObjectSummary[] | null>(null);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  // Step 119: projects or a type of the company's own ("Add to…").
  const locale = useLocale();
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [typeKey, setTypeKey] = useState("project");
  useEffect(() => {
    projectsApi
      .types()
      .then((r) => setTypes(r.types))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    projectsApi
      .linked(target.kind, target.ref, target.account)
      .then((r) => setLinked(new Set(r.objects.map((o) => o.id))))
      .catch(() => undefined);
  }, [target.kind, target.ref, target.account]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      projectsApi
        .query({ type: typeKey, mine: typeKey === "project", ...(q.trim() ? { q: q.trim() } : {}), limit: 50 })
        .then((r) => setProjects(r.objects))
        .catch((err: unknown) => toast.error(errorText(t, err)));
    }, q ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [q, t, typeKey]);

  const add = async (p: ObjectSummary) => {
    setBusy(p.id);
    try {
      await projectsApi.addLink(p.id, { kind: target.kind, ref: target.ref, account: target.account, title: target.title });
      setLinked((cur) => new Set([...cur, p.id]));
      toast.success(t("projects.added_to", { title: p.title }));
    } catch (err) {
      toast.error(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title={t("objects.add_to")}>
      <p className="mb-2 truncate text-sm text-muted-foreground">{target.title}</p>
      {types.length > 1 && (
        <select className={`${selectClass} mb-2`} value={typeKey} onChange={(e) => setTypeKey(e.target.value)} aria-label={t("objects.type")}>
          {types.map((x) => (
            <option key={x.key} value={x.key}>
              {local(x.plural, locale)}
            </option>
          ))}
        </select>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("objects.search")} aria-label={t("objects.search")} autoFocus />
      <ul className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border">
        {(projects ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <span className="text-xs text-muted-foreground">{p.ref}</span>
            <span className="min-w-0 flex-1 truncate">{p.title}</span>
            {linked.has(p.id) ? (
              <Link href={typeHref(typeKey, p.id)} className="flex items-center gap-1 text-xs text-green-700 hover:underline dark:text-green-400">
                <Check className="h-3.5 w-3.5" />
                {t("projects.added")}
              </Link>
            ) : (
              <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void add(p)}>
                {t("projects.add")}
              </Button>
            )}
          </li>
        ))}
        {projects && projects.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">{t("projects.add_none")}</li>}
      </ul>
    </Modal>
  );
}

/** The workspace has projects (not companies without email). */
function useHasProjects(): boolean {
  const me = useXenaxioMe();
  return XENAXIO_BFF && !!me && (me.tenant.product ?? "workspace") === "workspace" && me.user.kind !== "chat";
}

type LinkableEmail = Pick<Email, "id" | "subject" | "sourceAccountId">;

export function AddEmailToProjectButton({ email }: { email: LinkableEmail }) {
  const t = useXT();
  const has = useHasProjects();
  const [open, setOpen] = useState(false);
  if (!has) return null;
  const account = email.sourceAccountId ?? useAuthStore.getState().client?.getAccountId() ?? null;
  return (
    <>
      <Button variant="ghost" size="sm" className="sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0" title={t("objects.add_to")} onClick={() => setOpen(true)}>
        <IconLayoutKanban className="w-4 h-4" />
        <span className="hidden lg:inline text-sm">{t("projects.add_to_short")}</span>
      </Button>
      {open && <AddToProjectDialog target={{ kind: "email", ref: email.id, account, title: email.subject || t("projects.no_subject") }} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Files: "Zu Projekt hinzufügen" in the menu of a file. Returns the action and
 * the dialog to render; a file links by its id in its owner's files account.
 */
export function useAddFileToProject(): [((resource: { id: string; name: string; isDirectory: boolean; ownerAccountId?: string | null }) => void) | null, React.ReactNode] {
  const has = useHasProjects();
  const [target, setTarget] = useState<LinkTarget | null>(null);
  const open = (resource: { id: string; name: string; isDirectory: boolean; ownerAccountId?: string | null }) =>
    setTarget({ kind: "file", ref: resource.id, account: resource.ownerAccountId ?? filesAccount(), title: resource.name });
  return [has ? open : null, target ? <AddToProjectDialog target={target} onClose={() => setTarget(null)} /> : null];
}

function filesAccount(): string | null {
  return useFileStore.getState().client?.getFilesAccountId() ?? null;
}
