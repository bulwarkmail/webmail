"use client";

// Step 17: the company's address, logo and colour, and its own hostname
// (e.g. mail.firma.de). Only the company admin sees this page.
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExternalLink, RefreshCw, Trash2, Upload } from "@/components/icons";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { Field, Notice } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { type AdminPortal, errorKey, type SlugProblem, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { withBasePath } from "@/lib/browser-navigation";
import { contrastRatio } from "@/lib/xenaxio/portal";
import { cn } from "@/lib/utils";

const LOGO_MAX_BYTES = 256 * 1024;
const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#3b82f6";
const WHITE = "#ffffff";

const STATUS_STYLE = {
  active: "bg-green-600/15 text-green-700 dark:text-green-400",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  failed: "bg-destructive/15 text-destructive",
} as const;

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function AppearanceView() {
  const t = useXT();
  const locale = useLocale();
  const [portal, setPortal] = useState<AdminPortal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Address
  const [slug, setSlug] = useState("");
  const [slugProblem, setSlugProblem] = useState<SlugProblem | null>(null);
  // Colour
  const [color, setColor] = useState(DEFAULT_COLOR);
  // Step 40: the app icon's background
  const [iconBg, setIconBg] = useState(WHITE);
  // Own hostname
  const [hostname, setHostname] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const apply = (p: AdminPortal) => {
    setPortal(p);
    setSlug(p.slug ?? "");
    setSlugProblem(null);
    setColor(p.color ?? DEFAULT_COLOR);
    setIconBg(p.iconBackground ?? WHITE);
  };

  useEffect(() => {
    xenaxio
      .adminPortal()
      .then(apply)
      .catch((err) => setError(t(errorKey(err))));
  }, [t]);

  // Is the typed address free?
  useEffect(() => {
    if (!portal || slug === portal.slug) return setSlugProblem(null);
    if (!slug) return setSlugProblem("invalid");
    const timer = setTimeout(() => {
      xenaxio
        .checkSlug(slug)
        .then((r) => setSlugProblem(r.problem))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [slug, portal]);

  const run = async (what: string, action: () => Promise<AdminPortal | void>, done?: string) => {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result) apply(result);
      if (done) setNotice(done);
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(null);
    }
  };

  if (!portal) return error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

  const saveSlug = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm(t("appearance.address_confirm", { old: portal.url }))) return;
    await run("slug", async () => {
      const result = await xenaxio.setSlug(slug, `/${locale}/workspace/appearance/`);
      // The old address now forwards; continue on the new one without signing in again.
      if (result.handoffUrl) {
        window.location.assign(result.handoffUrl);
        return;
      }
      return result;
    });
  };

  const uploadLogo = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) return setError(t("errors.logo_too_large"));
    if (!["image/png", "image/webp"].includes(file.type)) return setError(t("errors.logo_invalid_type"));
    await run("logo", () => xenaxio.uploadLogo(file), t("appearance.saved_reload"));
  };

  const validColor = HEX.test(color);
  const validIconBg = HEX.test(iconBg);
  const savedIconBg = portal.iconBackground ?? WHITE;
  const previewText = validColor && contrastRatio(color, "#ffffff") >= contrastRatio(color, "#111111") ? "#ffffff" : "#111111";
  const own = portal.hostname;
  const baseHost = portal.slug && portal.baseDomain ? `${portal.slug}.${portal.baseDomain}` : null;

  return (
    <div className="space-y-5">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      {portal.baseDomain && (
        <Section title={t("appearance.address_title")} description={t("appearance.address_intro")}>
          <a href={portal.url} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline break-all">
            {portal.url.replace(/^https:\/\//, "")}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
          <form onSubmit={saveSlug} className="space-y-3">
            <Field
              label={t("appearance.address_label")}
              htmlFor="slug"
              hint={slugProblem ? undefined : t("appearance.address_hint")}
              error={slugProblem ? t(`errors.slug_${slugProblem}`) : undefined}
            >
              <div className="flex items-center gap-2">
                <Input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40))}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="flex-1 min-w-0"
                  aria-invalid={slugProblem ? true : undefined}
                />
                <span className="text-sm text-muted-foreground truncate max-w-[55%]">.{portal.baseDomain}</span>
              </div>
            </Field>
            <Button type="submit" disabled={busy !== null || slug === portal.slug || !!slugProblem || !slug}>
              {busy === "slug" ? t("appearance.saving") : t("appearance.address_save")}
            </Button>
          </form>
        </Section>
      )}

      <Section title={t("appearance.logo_title")} description={t("appearance.logo_intro")}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-48 items-center justify-center rounded-md border border-dashed border-border bg-background p-2">
            {portal.logoUrl ? (
              <img src={withBasePath(portal.logoUrl)} alt={portal.name} className="max-h-16 max-w-full object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">{t("appearance.logo_none")}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept="image/png,image/webp" className="hidden" onChange={uploadLogo} />
            <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
              <Upload className="mr-1.5 h-4 w-4" />
              {busy === "logo" ? t("appearance.saving") : portal.logoUrl ? t("appearance.logo_replace") : t("appearance.logo_upload")}
            </Button>
            {portal.logoUrl && (
              <Button type="button" variant="ghost" onClick={() => run("logo", () => xenaxio.removeLogo(), t("appearance.saved_reload"))} disabled={busy !== null}>
                <Trash2 className="mr-1.5 h-4 w-4" />
                {t("appearance.logo_remove")}
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("appearance.logo_hint")}</p>
      </Section>

      {portal.logoUrl && (
        <Section title={t("appearance.icon_title")} description={t("appearance.icon_intro")}>
          {portal.iconUrl ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border shadow-sm"
                  style={{ backgroundColor: validIconBg ? iconBg : savedIconBg }}
                  aria-label={t("appearance.icon_preview")}
                  role="img"
                >
                  <img src={withBasePath(portal.logoUrl)} alt="" className="max-h-[80%] max-w-[80%] object-contain" />
                </div>
                <input
                  type="color"
                  value={validIconBg ? iconBg : WHITE}
                  onChange={(e) => setIconBg(e.target.value)}
                  aria-label={t("appearance.icon_title")}
                  className="h-10 w-14 cursor-pointer rounded border border-border bg-background p-1"
                />
                <Input value={iconBg} onChange={(e) => setIconBg(e.target.value.trim())} className="w-28 font-mono" spellCheck={false} aria-invalid={validIconBg ? undefined : true} />
                {portal.color && portal.color !== iconBg.toLowerCase() && (
                  <Button type="button" variant="outline" onClick={() => setIconBg(portal.color!)} disabled={busy !== null}>
                    <span className="mr-1.5 inline-block h-3 w-3 rounded-full border border-border" style={{ backgroundColor: portal.color }} aria-hidden />
                    {t("appearance.icon_use_brand")}
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => run("icon", () => xenaxio.setIconBackground(iconBg.toLowerCase() === WHITE ? null : iconBg.toLowerCase()), t("appearance.icon_saved"))}
                  disabled={busy !== null || !validIconBg || iconBg.toLowerCase() === savedIconBg}
                >
                  {busy === "icon" ? t("appearance.saving") : t("appearance.icon_save")}
                </Button>
                {portal.iconBackground && (
                  <Button type="button" variant="ghost" onClick={() => run("icon", () => xenaxio.setIconBackground(null), t("appearance.icon_saved"))} disabled={busy !== null}>
                    {t("appearance.icon_reset")}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("appearance.icon_no_png")}</p>
          )}
        </Section>
      )}

      <Section title={t("appearance.color_title")} description={t("appearance.color_intro")}>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="color"
            value={validColor ? color : DEFAULT_COLOR}
            onChange={(e) => setColor(e.target.value)}
            aria-label={t("appearance.color_title")}
            className="h-10 w-14 cursor-pointer rounded border border-border bg-background p-1"
          />
          <Input value={color} onChange={(e) => setColor(e.target.value.trim())} className="w-28 font-mono" spellCheck={false} aria-invalid={validColor ? undefined : true} />
          <span
            className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
            style={validColor ? { backgroundColor: color, color: previewText } : undefined}
            aria-hidden
          >
            {t("appearance.color_preview")}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => run("color", () => xenaxio.setColor(color.toLowerCase()), t("appearance.saved_reload"))}
            disabled={busy !== null || !validColor || color.toLowerCase() === portal.color}
          >
            {busy === "color" ? t("appearance.saving") : t("appearance.color_save")}
          </Button>
          {portal.color && (
            <Button type="button" variant="ghost" onClick={() => run("color", () => xenaxio.setColor(null), t("appearance.saved_reload"))} disabled={busy !== null}>
              {t("appearance.color_reset")}
            </Button>
          )}
        </div>
      </Section>

      {portal.customHostnames && (
        <Section title={t("appearance.own_title")} description={t("appearance.own_intro")}>
          {!own ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run("own", () => xenaxio.addHostname(hostname.trim().toLowerCase()));
              }}
            >
              <Field label={t("appearance.own_label")} htmlFor="own-host" hint={t("appearance.own_hint")}>
                <Input id="own-host" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="mail.firma.de" autoCapitalize="none" spellCheck={false} inputMode="url" />
              </Field>
              <Button type="submit" disabled={busy !== null || !hostname.trim()}>
                {busy === "own" ? t("appearance.saving") : t("appearance.own_add")}
              </Button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-medium break-all">{own.hostname}</span>
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_STYLE[own.status])}>{t(`appearance.own_status_${own.status}`)}</span>
                {own.primary && own.status === "active" && <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">{t("appearance.own_primary")}</span>}
              </div>
              {own.status !== "active" && (
                <div className="space-y-2 text-sm">
                  <p>{t("appearance.own_record_intro")}</p>
                  <div className="rounded-lg border border-border p-3 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">{t("appearance.col_type")}</span>
                      <code className="flex-1 font-mono text-xs">CNAME</code>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">{t("domain.col_name")}</span>
                      <code className="flex-1 min-w-0 break-all font-mono text-xs">{own.hostname}</code>
                      <CopyButton value={own.hostname} />
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">{t("domain.col_value")}</span>
                      <code className="flex-1 min-w-0 break-all font-mono text-xs">{portal.customHostnames.target}</code>
                      <CopyButton value={portal.customHostnames.target} />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("appearance.own_wait")}</p>
                  {own.error && <p className="text-xs text-muted-foreground break-all">{t("appearance.own_provider_says", { message: own.error })}</p>}
                </div>
              )}
              {own.status === "active" && (
                <div className="space-y-2 text-sm">
                  <a href={`https://${own.hostname}`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline break-all">
                    https://{own.hostname}
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={own.primary}
                      disabled={busy !== null}
                      onChange={(e) => void run("own", () => xenaxio.setHostnamePrimary(e.target.checked))}
                    />
                    <span>
                      {t("appearance.own_make_primary")}
                      <span className="block text-xs text-muted-foreground">{t("appearance.own_make_primary_hint", { base: baseHost ?? "" })}</span>
                    </span>
                  </label>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {own.status !== "active" && (
                  <Button type="button" onClick={() => run("own", () => xenaxio.checkHostname())} disabled={busy !== null}>
                    <RefreshCw className={cn("mr-1.5 h-4 w-4", busy === "own" && "animate-spin")} />
                    {t("appearance.own_check")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(t("appearance.own_remove_confirm", { host: own.hostname }))) void run("own", () => xenaxio.removeHostname());
                  }}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  {t("appearance.own_remove")}
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

export default function AppearancePage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("appearance.title")} backHref="/workspace" requireAdmin>
      <AppearanceView />
    </WorkspaceShell>
  );
}
