"use client";

// xenaxio step 119: the person's own menu — order of the entries of object types
// and which ones they hide (kept by the platform, the same on every device).
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { ArrowDown, ArrowUp } from "@/components/icons";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { refreshObjectMenu } from "@/lib/xenaxio/projects-nav";
import { local, type MenuItem, projectsApi } from "@/lib/xenaxio/projects";

function MenuEditor() {
  const t = useXT();
  const locale = useLocale();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    projectsApi
      .menu()
      .then((r) => setItems(r.items))
      .catch((err: unknown) => setError(errorText(t, err)));
  }, [t]);
  const save = async (next: MenuItem[]) => {
    setItems(next);
    try {
      const r = await projectsApi.setMenu({ order: next.map((i) => i.key), hidden: next.filter((i) => i.hidden).map((i) => i.key) });
      setItems(r.items);
      refreshObjectMenu(r.items);
    } catch (err) {
      setError(errorText(t, err));
    }
  };
  if (!items) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("my_menu.title")} />;
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    void save(next);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("my_menu.intro")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("my_menu.none")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {items.map((m, i) => (
            <li key={m.key} className="flex items-center gap-2 px-3 py-2">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input type="checkbox" checked={!m.hidden} onChange={(e) => void save(items.map((x) => (x.key === m.key ? { ...x, hidden: !e.target.checked } : x)))} />
                <span className="truncate">{local(m.plural, locale)}</span>
              </label>
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 disabled:opacity-30" aria-label={t("typeeditor.up")}>
                <ArrowUp className="h-4 w-4" />
              </button>
              <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="rounded p-1 disabled:opacity-30" aria-label={t("typeeditor.down")}>
                <ArrowDown className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MyMenuPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("my_menu.title")}>
      <MenuEditor />
    </WorkspaceShell>
  );
}
