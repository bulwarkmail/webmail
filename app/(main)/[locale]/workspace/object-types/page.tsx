"use client";

// xenaxio step 119: the company admin's editor of object types (?type=<key> opens one).
import { TypeEditorPage } from "@/components/xenaxio/projects/type-editor";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";

export default function ObjectTypesPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("typeeditor.title")}>
      <TypeEditorPage />
    </WorkspaceShell>
  );
}
