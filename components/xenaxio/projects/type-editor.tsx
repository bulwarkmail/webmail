"use client";

// xenaxio step 119: the company admin's editor of object types — Projects
// (a copy for the company on the first change) and the company's own types:
// names, number prefix, board, fields (safe changes only; the admin sees how
// many records a change touches), stages, who sees and creates, menu entry.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { ArrowDown, ArrowUp, Lock, Plus, Trash } from "@/components/icons";
import { IconPicker } from "@/components/layout/icon-picker";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { Link } from "@/i18n/navigation";
import { apiFetch } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { refreshObjectMenu } from "@/lib/xenaxio/projects-nav";
import { FIELD_KINDS, type FieldKind, local, type ObjectType, projectsApi, STATUS_COLORS, type Text, type TypeAccess, type TypeField, type TypeStatus, typeHref } from "@/lib/xenaxio/projects";
import { Modal, selectClass, StatusChip } from "./bits";

type Group = { id: string; name: string };
type Msg = { kind: "error" | "success"; text: string } | null;

const DEFAULT_STAGES: TypeStatus[] = [
  { key: "open", name: { de: "Offen", en: "Open" }, color: "blue", closed: false },
  { key: "done", name: { de: "Erledigt", en: "Done" }, color: "green", closed: true },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "")
    .slice(0, 39) || "field";

function TextPair({ value, onChange, label }: { value: Text; onChange: (t: Text) => void; label: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-muted-foreground">{label} (EN)</span>
        <Input value={value.en} onChange={(e) => onChange({ ...value, en: e.target.value })} maxLength={60} />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-muted-foreground">{label} (DE)</span>
        <Input value={value.de} onChange={(e) => onChange({ ...value, de: e.target.value })} maxLength={60} />
      </label>
    </div>
  );
}

function GroupChecks({ groups, value, onChange }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void }) {
  const t = useXT();
  if (groups.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {t("typeeditor.no_groups")}{" "}
        <Link href="/workspace/groups" className="underline">
          {t("typeeditor.groups_link")}
        </Link>
      </p>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((g) => (
        <label key={g.id} className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={value.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))} />
          {g.name}
        </label>
      ))}
    </div>
  );
}

function FieldDialog({ type, types, field, onClose, onSaved }: { type: ObjectType; types: ObjectType[]; field: TypeField | null; onClose: () => void; onSaved: (t: ObjectType, affected: number) => void }) {
  const t = useXT();
  const locale = useLocale();
  const [def, setDef] = useState<TypeField>(field ?? { key: "", type: "text", label: { de: "", en: "" } });
  const [optionsText, setOptionsText] = useState((field?.options ?? []).map((o) => (o.label.de && o.label.de !== o.label.en ? `${o.label.en} | ${o.label.de}` : o.label.en)).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const editing = !!field;
  const withOptions = def.type === "select" || def.type === "multiselect";

  const build = (): TypeField => {
    const label = { de: def.label.de.trim() || def.label.en.trim(), en: def.label.en.trim() || def.label.de.trim() };
    const out: TypeField = { key: editing ? field!.key : slug(label.en || label.de), type: def.type, label };
    if (def.required) out.required = true;
    if (def.sensitive) out.sensitive = true;
    if (def.ref) out.ref = def.ref;
    if (withOptions) {
      const before = field?.options ?? [];
      out.options = optionsText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [en, de] = l.split("|").map((x) => x.trim());
          const known = before.find((o) => o.label.en === en || o.label.de === (de ?? en));
          return { key: known?.key ?? slug(en!), label: { en: en!, de: de || en! } };
        });
    }
    return out;
  };

  const save = async (confirmed = false) => {
    setError(null);
    const next = build();
    try {
      if (!editing) {
        onSaved(await projectsApi.addField(type.key, next), 0);
        return;
      }
      // Removed options clear values: the admin sees how many records first.
      const gone = (field!.options ?? []).filter((o) => !(next.options ?? []).some((x) => x.key === o.key));
      if (!confirmed && gone.length) {
        let n = 0;
        for (const o of gone) n += (await projectsApi.fieldUsage(type.key, field!.key, o.key)).records;
        if (n > 0) return setConfirm(t("typeeditor.options_removed", { n }));
      }
      const r = await projectsApi.updateField(type.key, next);
      onSaved(r.type, r.affected);
    } catch (err) {
      setError(errorText(t, err));
    }
  };

  return (
    <Modal open onClose={onClose} title={editing ? t("typeeditor.field_edit") : t("typeeditor.field_add")} wide>
      <div className="space-y-3 text-sm">
        {error && <Notice kind="error">{error}</Notice>}
        <TextPair label={t("typeeditor.field_name")} value={def.label} onChange={(label) => setDef({ ...def, label })} />
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t("typeeditor.field_kind")}</span>
          <select className={selectClass} value={def.type} onChange={(e) => setDef({ ...def, type: e.target.value as FieldKind })}>
            {FIELD_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`typeeditor.kind.${k}`)}
              </option>
            ))}
          </select>
          {editing && <span className="text-xs text-muted-foreground">{t("typeeditor.kind_hint")}</span>}
        </label>
        {withOptions && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("typeeditor.options")}</span>
            <textarea className="min-h-28 w-full rounded-md border border-input bg-background p-2 text-sm" value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder={t("typeeditor.options_hint")} />
          </label>
        )}
        {(def.type === "ref" || def.type === "refs") && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("typeeditor.ref_type")}</span>
            <select className={selectClass} value={def.ref ?? ""} onChange={(e) => setDef({ ...def, ref: e.target.value })}>
              <option value="">—</option>
              {types.map((x) => (
                <option key={x.key} value={x.key}>
                  {local(x.plural, locale)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!def.required} onChange={(e) => setDef({ ...def, required: e.target.checked })} />
          {t("typeeditor.required")}
        </label>
        {!["ref", "refs", "user"].includes(def.type) && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={!!def.sensitive} onChange={(e) => setDef({ ...def, sensitive: e.target.checked })} />
            <span>
              {t("typeeditor.sensitive")}
              <span className="block text-xs text-muted-foreground">{t("typeeditor.sensitive_hint")}</span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!(def.label.en.trim() || def.label.de.trim()) || ((def.type === "ref" || def.type === "refs") && !def.ref)}>
            {t("common.save")}
          </Button>
        </div>
      </div>
      <ConfirmDialog isOpen={!!confirm} onClose={() => setConfirm(null)} title={t("typeeditor.field_edit")} message={confirm ?? ""} variant="destructive" onConfirm={() => (setConfirm(null), void save(true))} />
    </Modal>
  );
}

function StagesEditor({ type, onSaved }: { type: ObjectType; onSaved: (t: ObjectType) => void }) {
  const t = useXT();
  const [list, setList] = useState<TypeStatus[]>(type.statuses);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setList(type.statuses), [type.statuses]);
  const removed = type.statuses.filter((s) => !list.some((x) => x.key === s.key));
  const update = (i: number, s: Partial<TypeStatus>) => setList((cur) => cur.map((x, j) => (j === i ? { ...x, ...s } : x)));
  const move = (i: number, d: -1 | 1) =>
    setList((cur) => {
      const next = [...cur];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x!);
      return next;
    });
  const save = async () => {
    setError(null);
    try {
      const clean = list.map((s) => ({ ...s, key: s.key || slug(s.name.en || s.name.de), name: { de: s.name.de || s.name.en, en: s.name.en || s.name.de } }));
      onSaved(await projectsApi.setStatuses(type.key, clean, moveTo));
      setMoveTo({});
    } catch (err) {
      setError(errorText(t, err));
    }
  };
  return (
    <div className="space-y-2">
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="space-y-2">
        {list.map((s, i) => (
          <li key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 sm:grid-cols-[1fr_1fr_7rem_auto_auto]">
            <Input value={s.name.en} onChange={(e) => update(i, { name: { ...s.name, en: e.target.value } })} placeholder="EN" aria-label={`${t("typeeditor.stage")} EN`} />
            <Input value={s.name.de} onChange={(e) => update(i, { name: { ...s.name, de: e.target.value } })} placeholder="DE" aria-label={`${t("typeeditor.stage")} DE`} />
            <select className={cn(selectClass, "hidden sm:block")} value={s.color} onChange={(e) => update(i, { color: e.target.value })} aria-label={t("typeeditor.color")}>
              {STATUS_COLORS.map((c) => (
                <option key={c} value={c}>
                  {t(`typeeditor.colors.${c}`)}
                </option>
              ))}
            </select>
            <label className="hidden items-center gap-1 text-xs sm:flex">
              <input type="checkbox" checked={s.closed} onChange={(e) => update(i, { closed: e.target.checked })} />
              {t("typeeditor.closes")}
            </label>
            <span className="flex">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 disabled:opacity-30" aria-label={t("typeeditor.up")}>
                <ArrowUp className="h-4 w-4" />
              </button>
              <button type="button" disabled={i === list.length - 1} onClick={() => move(i, 1)} className="rounded p-1 disabled:opacity-30" aria-label={t("typeeditor.down")}>
                <ArrowDown className="h-4 w-4" />
              </button>
              <button type="button" disabled={list.length <= 1} onClick={() => setList((cur) => cur.filter((_, j) => j !== i))} className="rounded p-1 text-destructive disabled:opacity-30" aria-label={t("typeeditor.remove")}>
                <Trash className="h-4 w-4" />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {removed.length > 0 && (
        <div className="space-y-1 rounded-md border border-border p-2 text-sm">
          <p className="text-xs text-muted-foreground">{t("typeeditor.stages_move")}</p>
          {removed.map((r) => (
            <label key={r.key} className="flex items-center gap-2">
              <span className="w-32 truncate">{local(r.name, "en")}</span>→
              <select className={selectClass} value={moveTo[r.key] ?? ""} onChange={(e) => setMoveTo((m) => ({ ...m, [r.key]: e.target.value }))}>
                <option value="">—</option>
                {list
                  .filter((x) => x.key)
                  .map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name.en || x.name.de}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setList((cur) => [...cur, { key: "", name: { de: "", en: "" }, color: "gray", closed: false }])}>
          <Plus className="mr-1 h-4 w-4" />
          {t("typeeditor.stage_add")}
        </Button>
        <Button size="sm" onClick={() => void save()}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function TypeForm({ type, types, groups, onChanged, onGone }: { type: ObjectType; types: ObjectType[]; groups: Group[]; onChanged: (t: ObjectType) => void; onGone: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const [msg, setMsg] = useState<Msg>(null);
  const [name, setName] = useState(type.name);
  const [plural, setPlural] = useState(type.plural);
  const [prefix, setPrefix] = useState(type.prefix);
  const [field, setField] = useState<TypeField | null | "new">(null);
  const [removing, setRemoving] = useState<{ field: TypeField; records: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [stagesOff, setStagesOff] = useState(false);
  const access: TypeAccess = type.access;

  const act = async (fn: () => Promise<ObjectType>, ok?: string) => {
    setMsg(null);
    try {
      const next = await fn();
      onChanged(next);
      refreshObjectMenu();
      if (ok) setMsg({ kind: "success", text: ok });
    } catch (err) {
      setMsg({ kind: "error", text: errorText(t, err) });
    }
  };

  const moveField = (i: number, d: -1 | 1) => {
    const order = type.fields.map((f) => f.key);
    const [k] = order.splice(i, 1);
    order.splice(i + d, 0, k!);
    void act(() => projectsApi.reorderFields(type.key, order));
  };

  return (
    <div className="space-y-8">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {type.builtin && <Notice kind="info">{t("typeeditor.builtin_note")}</Notice>}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("typeeditor.general")}</h2>
        <TextPair label={t("typeeditor.name")} value={name} onChange={setName} />
        <TextPair label={t("typeeditor.plural")} value={plural} onChange={setPlural} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">{t("typeeditor.prefix")}</span>
            <Input value={prefix} maxLength={4} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
          </label>
          <label className="flex items-center gap-2 pt-5 text-sm">
            <input type="checkbox" checked={type.hasTasks} onChange={(e) => void act(() => projectsApi.updateType(type.key, { hasTasks: e.target.checked }))} />
            {t("typeeditor.has_tasks")}
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={type.parentTypes.includes(type.key)}
            onChange={(e) => void act(() => projectsApi.updateType(type.key, { parentTypes: e.target.checked ? [...type.parentTypes, type.key] : type.parentTypes.filter((k) => k !== type.key) }))}
          />
          {t("typeeditor.nested")}
        </label>
        <Button size="sm" onClick={() => void act(() => projectsApi.updateType(type.key, { name, plural, prefix }), t("typeeditor.saved"))}>
          {t("common.save")}
        </Button>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("typeeditor.fields")}</h2>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setField("new")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("typeeditor.field_add")}
          </Button>
        </div>
        {type.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("typeeditor.fields_none")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {type.fields.map((f, i) => (
              <li key={f.key} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate">
                  {local(f.label, locale)}
                  {f.required ? " *" : ""} <span className="text-xs text-muted-foreground">· {t(`typeeditor.kind.${f.type}`)}</span>
                </span>
                {f.sensitive && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("typeeditor.sensitive")} />}
                <button type="button" disabled={i === 0} onClick={() => moveField(i, -1)} className="rounded p-1 disabled:opacity-30" aria-label={t("typeeditor.up")}>
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button type="button" disabled={i === type.fields.length - 1} onClick={() => moveField(i, 1)} className="rounded p-1 disabled:opacity-30" aria-label={t("typeeditor.down")}>
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button type="button" className="text-primary hover:underline" onClick={() => setField(f)}>
                  {t("typeeditor.edit")}
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-destructive"
                  aria-label={t("typeeditor.remove")}
                  onClick={async () => setRemoving({ field: f, records: (await projectsApi.fieldUsage(type.key, f.key).catch(() => ({ records: 0 }))).records })}
                >
                  <Trash className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("typeeditor.stages")}</h2>
        {/* Variant B (owner 07.11.2026): stages only where records go through them; projects always have them. */}
        {type.key !== "project" && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={type.statuses.length > 0}
              onChange={(e) => (e.target.checked ? void act(() => projectsApi.setStatuses(type.key, DEFAULT_STAGES)) : setStagesOff(true))}
            />
            <span>
              {t("typeeditor.use_stages")}
              <span className="block text-xs text-muted-foreground">{t("typeeditor.use_stages_hint")}</span>
            </span>
          </label>
        )}
        {type.statuses.length > 0 && (
        <>
        <div className="flex flex-wrap gap-1">
          {type.statuses.map((s) => (
            <StatusChip key={s.key} text={local(s.name, locale)} color={s.color} />
          ))}
        </div>
        <StagesEditor type={type} onSaved={(next) => (onChanged(next), setMsg({ kind: "success", text: t("typeeditor.saved") }))} />
        </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("typeeditor.access")}</h2>
        <label className="block space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">{t("typeeditor.read")}</span>
          <select className={selectClass} value={access.read ?? "members"} onChange={(e) => void act(() => projectsApi.updateType(type.key, { access: { ...access, read: e.target.value as TypeAccess["read"], ...(e.target.value === "groups" ? { readGroups: access.readGroups?.length ? access.readGroups : groups.slice(0, 1).map((g) => g.id) } : {}) } }))}>
            <option value="members">{t("typeeditor.read_members")}</option>
            <option value="all">{t("typeeditor.read_all")}</option>
            <option value="groups" disabled={groups.length === 0}>
              {t("typeeditor.read_groups")}
            </option>
          </select>
        </label>
        {access.read === "groups" && <GroupChecks groups={groups} value={access.readGroups ?? []} onChange={(v) => v.length && void act(() => projectsApi.updateType(type.key, { access: { ...access, readGroups: v } }))} />}
        <label className="block space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">{t("typeeditor.create")}</span>
          <select className={selectClass} value={access.create ?? "all"} onChange={(e) => void act(() => projectsApi.updateType(type.key, { access: { ...access, create: e.target.value as TypeAccess["create"], ...(e.target.value === "groups" ? { createGroups: access.createGroups?.length ? access.createGroups : groups.slice(0, 1).map((g) => g.id) } : {}) } }))}>
            <option value="all">{t("typeeditor.create_all")}</option>
            <option value="groups" disabled={groups.length === 0}>
              {t("typeeditor.create_groups")}
            </option>
            <option value="admins">{t("typeeditor.create_admins")}</option>
          </select>
        </label>
        {access.create === "groups" && <GroupChecks groups={groups} value={access.createGroups ?? []} onChange={(v) => v.length && void act(() => projectsApi.updateType(type.key, { access: { ...access, createGroups: v } }))} />}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("typeeditor.menu")}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!type.menu.show} onChange={(e) => void act(() => projectsApi.updateType(type.key, { menu: { ...type.menu, show: e.target.checked } }))} />
          {t("typeeditor.menu_show")}
        </label>
        {type.menu.show && (
          <>
            <IconPicker value={type.menu.icon ?? "folder"} onChange={(icon) => void act(() => projectsApi.updateType(type.key, { menu: { ...type.menu, icon: icon.replace(/^tabler:/, "") } }))} />
            <p className="text-xs text-muted-foreground">{t("typeeditor.menu_groups")}</p>
            <GroupChecks groups={groups} value={type.menu.groups ?? []} onChange={(v) => void act(() => projectsApi.updateType(type.key, { menu: { ...type.menu, groups: v } }))} />
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("typeeditor.records")}</h2>
        <Link href={typeHref(type.key)} className="text-sm underline">
          {t("typeeditor.open_records", { n: type.records ?? 0 })}
        </Link>
        {type.key !== "project" && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void act(() => projectsApi.archiveType(type.key, !type.archivedAt))}>
              {type.archivedAt ? t("typeeditor.restore") : t("typeeditor.archive")}
            </Button>
            {!type.builtin && (
              <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}>
                {t("typeeditor.delete")}
              </Button>
            )}
          </div>
        )}
      </section>

      {field && <FieldDialog type={type} types={types} field={field === "new" ? null : field} onClose={() => setField(null)} onSaved={(next, affected) => (setField(null), onChanged(next), setMsg({ kind: "success", text: affected ? t("typeeditor.saved_affected", { n: affected }) : t("typeeditor.saved") }))} />}
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        title={t("typeeditor.field_remove")}
        message={removing ? (removing.records ? t("typeeditor.field_remove_text", { name: local(removing.field.label, locale), n: removing.records }) : t("typeeditor.field_remove_empty", { name: local(removing.field.label, locale) })) : ""}
        variant="destructive"
        onConfirm={() => {
          const f = removing!.field;
          setRemoving(null);
          void act(async () => (await projectsApi.removeField(type.key, f.key)).type);
        }}
      />
      <ConfirmDialog
        isOpen={stagesOff}
        onClose={() => setStagesOff(false)}
        title={t("typeeditor.use_stages")}
        message={t("typeeditor.stages_off_text", { n: type.records ?? 0 })}
        variant="destructive"
        onConfirm={() => {
          setStagesOff(false);
          void act(() => projectsApi.setStatuses(type.key, []));
        }}
      />
      <ConfirmDialog
        isOpen={deleting}
        onClose={() => setDeleting(false)}
        title={t("typeeditor.delete")}
        message={t("typeeditor.delete_text", { name: local(type.plural, locale) })}
        variant="destructive"
        onConfirm={() => {
          setDeleting(false);
          projectsApi
            .removeType(type.key)
            .then(() => (refreshObjectMenu(), onGone()))
            .catch((err: unknown) => setMsg({ kind: "error", text: errorText(t, err) }));
        }}
      />
    </div>
  );
}

/** The admin page: every type of the company, a new type, and one type's editor (?type=…). */
export function TypeEditorPage() {
  const t = useXT();
  const locale = useLocale();
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [current, setCurrent] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("type")));
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState<{ name: Text; plural: Text }>({ name: { de: "", en: "" }, plural: { de: "", en: "" } });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([
        projectsApi.adminTypes(),
        apiFetch("/api/admin/chat/groups", { credentials: "same-origin", headers: { Accept: "application/json" } })
          .then((x) => (x.ok ? (x.json() as Promise<{ groups: Group[] }>) : { groups: [] }))
          .catch(() => ({ groups: [] })),
      ]);
      setTypes(r.types);
      setGroups(g.groups);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (key: string | null) => {
    setCurrent(key);
    const url = `${window.location.pathname}${key ? `?type=${encodeURIComponent(key)}` : ""}`;
    window.history.pushState(window.history.state, "", url);
  };
  useEffect(() => {
    const onPop = () => setCurrent(new URLSearchParams(window.location.search).get("type"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const type = useMemo(() => types?.find((x) => x.key === current), [types, current]);
  if (!types) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("typeeditor.title")} />;

  if (current && type)
    return (
      <div className="space-y-4">
        <button type="button" className="text-sm text-primary hover:underline" onClick={() => open(null)}>
          ← {t("typeeditor.all")}
        </button>
        <h1 className="text-xl font-semibold">{local(type.plural, locale)}</h1>
        <TypeForm
          key={type.key}
          type={type}
          types={types}
          groups={groups}
          onChanged={(next) => setTypes((cur) => cur?.map((x) => (x.key === next.key ? { ...next, records: x.records } : x)) ?? cur)}
          onGone={() => (open(null), void load())}
        />
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("typeeditor.intro")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {types.map((x) => (
          <li key={x.key}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/50" onClick={() => open(x.key)}>
              <span className="min-w-0 flex-1 truncate font-medium">{local(x.plural, locale)}</span>
              <span className="text-xs text-muted-foreground">
                {t("typeeditor.summary", { fields: x.fields.length, records: x.records ?? 0 })}
                {x.menu.show ? ` · ${t("typeeditor.in_menu")}` : ""}
                {x.archivedAt ? ` · ${t("typeeditor.archived")}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button onClick={() => setCreating(true)}>
        <Plus className="mr-1 h-4 w-4" />
        {t("typeeditor.new")}
      </Button>
      <Modal open={creating} onClose={() => setCreating(false)} title={t("typeeditor.new")}>
        <div className="space-y-3">
          <TextPair label={t("typeeditor.name")} value={newName.name} onChange={(name) => setNewName((n) => ({ ...n, name }))} />
          <TextPair label={t("typeeditor.plural")} value={newName.plural} onChange={(plural) => setNewName((n) => ({ ...n, plural }))} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!(newName.name.en.trim() || newName.name.de.trim()) || !(newName.plural.en.trim() || newName.plural.de.trim())}
              onClick={async () => {
                try {
                  const created = await projectsApi.createType({ ...newName, menu: { show: true, icon: "folder" } });
                  setCreating(false);
                  setNewName({ name: { de: "", en: "" }, plural: { de: "", en: "" } });
                  await load();
                  refreshObjectMenu();
                  open(created.key);
                } catch (err) {
                  setError(errorText(t, err));
                  setCreating(false);
                }
              }}
            >
              {t("typeeditor.create_type")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
