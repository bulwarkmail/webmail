"use client";

// xenaxio step 118: the company admin decides who creates projects — every
// employee (default) or only admins. A permission: the assistant only points
// here (settings catalog "projects_creators").
import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { Field, Notice, Spinner } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { projectsApi } from "@/lib/xenaxio/projects";

type Msg = { kind: "error" | "success"; text: string } | null;

function ProjectsAdminView() {
  const t = useXT();
  const [creators, setCreators] = useState<"all" | "admins" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    projectsApi
      .creators()
      .then((r) => setCreators(r.creators))
      .catch((err: unknown) => setMsg({ kind: "error", text: errorText(t, err) }));
  }, [t]);
  if (!creators) return msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : <Spinner label={t("projects.title")} />;
  const save = async (value: "all" | "admins") => {
    setMsg(null);
    try {
      setCreators((await projectsApi.setCreators(value)).creators);
      setMsg({ kind: "success", text: t("projects.admin_saved") });
    } catch (err) {
      setMsg({ kind: "error", text: errorText(t, err) });
    }
  };
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("projects.admin_intro")}</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Field label={t("projects.admin_creators")} hint={t("projects.admin_creators_hint")} htmlFor="projects-creators">
        <select id="projects-creators" className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm" value={creators} onChange={(e) => void save(e.target.value as "all" | "admins")}>
          <option value="all">{t("projects.admin_creators_all")}</option>
          <option value="admins">{t("projects.admin_creators_admins")}</option>
        </select>
      </Field>
      <Link href="/projects" className="text-sm underline">
        {t("projects.open_section")}
      </Link>
    </div>
  );
}

export default function ProjectsAdminPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("projects.title")}>
      <ProjectsAdminView />
    </WorkspaceShell>
  );
}
