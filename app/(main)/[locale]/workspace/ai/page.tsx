"use client";

// AI settings of the company (C2, I8, scenario 8): switch AI on or off for
// everyone, pick the model, see this month's usage per person against the limits.
// Step 44 (I9): or connect the company's own model (any OpenAI-compatible server).
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Plus, Trash2 } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice, PasswordField, Spinner, TextField } from "@/components/xenaxio/ui";
import { CustomModelCheckResult } from "@/components/xenaxio/custom-model-check";
import { CustomModelList } from "@/components/xenaxio/custom-model-list";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { type AiAdmin, type AiProvider, type CustomModel, type CustomModelCheck, errorText, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

function Bar({ share, warnShare }: { share: number; warnShare: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div
        className={cn("h-full rounded-full", share >= 1 ? "bg-destructive" : share >= warnShare ? "bg-amber-500" : "bg-primary")}
        style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
      />
    </div>
  );
}

interface HeaderRow {
  name: string;
  value: string;
  /** Stored on the server: an empty value keeps it. */
  stored: boolean;
}

function OwnModel({ custom, egressIps, onChanged }: { custom: CustomModel | null; egressIps: string[]; onChanged: (reset: boolean) => Promise<void> }) {
  const t = useXT();
  const [baseUrl, setBaseUrl] = useState(custom?.baseUrl ?? "");
  const [profile, setProfile] = useState<CustomModel["profile"]>(custom?.profile ?? "openai");
  // Step 45: up to five models; the first stays active unless the list below says otherwise.
  const [models, setModels] = useState<string[]>(custom?.models.length ? custom.models.map((m) => m.name) : [""]);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>(custom?.headers.map((h) => ({ name: h.name, value: "", stored: true })) ?? []);
  const [busy, setBusy] = useState<"test" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<CustomModelCheck | null>(null);
  const [tested, setTested] = useState("");
  // Model names the server listed in any test: suggestions for the fields.
  const known = [...new Set(custom?.models.flatMap((m) => m.check?.models ?? []) ?? [])];

  const setHeader = (i: number, change: Partial<HeaderRow>) => setHeaders((hs) => hs.map((h, j) => (j === i ? { ...h, ...change, ...(change.name !== undefined && change.name !== h.name ? { stored: false } : {}) } : h)));

  const saveAndTest = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("test");
    setError(null);
    setCheck(null);
    try {
      const names = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
      const saved = await xenaxio.saveCustomModel({
        baseUrl: baseUrl.trim(),
        profile,
        models: names,
        ...(custom && names.includes(custom.model) ? { model: custom.model } : {}),
        ...(removeKey ? { apiKey: null } : apiKey ? { apiKey } : {}),
        headers: headers.filter((h) => h.name.trim()).map((h) => (h.value ? { name: h.name.trim(), value: h.value } : { name: h.name.trim() })),
      });
      setApiKey("");
      setRemoveKey(false);
      const res = await xenaxio.testCustomModel(saved.custom.model);
      setCheck(res.check);
      setTested(saved.custom.model);
      setHeaders((hs) => hs.filter((h) => h.name.trim()).map((h) => ({ ...h, value: "", stored: true })));
      setModels(saved.custom.models.map((m) => m.name));
      // The form stays as it is, with the test result under it.
      await onChanged(false);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("aiadmin.remove_confirm"))) return;
    setBusy("remove");
    setError(null);
    try {
      await xenaxio.removeCustomModel();
      await onChanged(true);
    } catch (err) {
      setError(errorText(t, err));
      setBusy(null);
    }
  };

  const keyHint = removeKey ? t("aiadmin.api_key_removed") : custom?.apiKeySet ? t("aiadmin.api_key_stored") : t("aiadmin.api_key_hint");

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="space-y-1">
        <h2 className="font-medium">{t("aiadmin.custom_title")}</h2>
        <p className="text-sm text-muted-foreground">{t("aiadmin.custom_intro")}</p>
        <Link href="/workspace/ai/own-model" className="text-sm text-primary underline underline-offset-4">
          {t("aiadmin.custom_guide")}
        </Link>
      </div>
      <form onSubmit={saveAndTest} className="space-y-4">
        <TextField
          label={t("aiadmin.base_url")}
          hint={t("aiadmin.base_url_hint")}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://llm.ihre-firma.de/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
        />
        <div className="space-y-1">
          <label htmlFor="ai-profile" className="text-sm font-medium">
            {t("aiadmin.profile")}
          </label>
          <select
            id="ai-profile"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={profile}
            onChange={(e) => setProfile(e.target.value as CustomModel["profile"])}
          >
            <option value="openai">{t("aiadmin.profile_openai")}</option>
            <option value="mistral">{t("aiadmin.profile_mistral")}</option>
          </select>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("aiadmin.models")}</legend>
          <p className="text-xs text-muted-foreground">{t("aiadmin.models_hint")}</p>
          {models.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                aria-label={t("aiadmin.model_name")}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                placeholder="qwen3.6:35b-a3b"
                autoComplete="off"
                spellCheck={false}
                list="ai-model-list"
                value={m}
                required={i === 0}
                onChange={(e) => setModels((ms) => ms.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {models.length > 1 && (
                <Button type="button" variant="ghost" size="sm" aria-label={t("aiadmin.model_remove")} onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {models.length < 5 && (
            <Button type="button" variant="outline" size="sm" onClick={() => setModels((ms) => [...ms, ""])}>
              <Plus className="mr-1 h-4 w-4" />
              {t("aiadmin.model_add")}
            </Button>
          )}
          {known.length > 0 && (
            <datalist id="ai-model-list">
              {known.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
        </fieldset>
        <div className="space-y-1">
          <PasswordField label={t("aiadmin.api_key")} hint={keyHint} autoComplete="off" value={apiKey} disabled={removeKey} onChange={(e) => setApiKey(e.target.value)} />
          {custom?.apiKeySet && !removeKey && (
            <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setRemoveKey(true)}>
              {t("aiadmin.api_key_remove")}
            </button>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("aiadmin.headers")}</legend>
          <p className="text-xs text-muted-foreground">{t("aiadmin.headers_hint")}</p>
          {headers.map((h, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <input
                aria-label={t("aiadmin.header_name")}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="CF-Access-Client-Id"
                autoComplete="off"
                spellCheck={false}
                value={h.name}
                onChange={(e) => setHeader(i, { name: e.target.value })}
              />
              <input
                aria-label={t("aiadmin.header_value")}
                type="password"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={h.stored ? t("aiadmin.header_value_stored") : t("aiadmin.header_value")}
                autoComplete="off"
                value={h.value}
                onChange={(e) => setHeader(i, { value: e.target.value })}
              />
              <Button type="button" variant="ghost" size="sm" aria-label={t("aiadmin.header_remove")} onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {headers.length < 3 && (
            <Button type="button" variant="outline" size="sm" onClick={() => setHeaders((hs) => [...hs, { name: "", value: "", stored: false }])}>
              <Plus className="mr-1 h-4 w-4" />
              {t("aiadmin.header_add")}
            </Button>
          )}
        </fieldset>

        {error && <Notice kind="error">{error}</Notice>}
        {busy === "test" && (
          <p className="text-sm text-muted-foreground" role="status">
            {t("aiadmin.testing")}
          </p>
        )}
        {check && <CustomModelCheckResult check={check} model={tested} />}
        {egressIps.length > 0 && <p className="text-xs text-muted-foreground">{t("aiadmin.egress", { ips: egressIps.join(", ") })}</p>}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy !== null}>
            {t("aiadmin.save_test")}
          </Button>
          {custom && (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={remove}>
              {t("aiadmin.remove")}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function ProviderChoice({ data, busy, onPick }: { data: AiAdmin; busy: boolean; onPick: (p: AiProvider) => void }) {
  const t = useXT();
  const customReady = data.custom?.check?.ok === true;
  const options: { value: AiProvider; title: string; desc: string; disabled: boolean; note?: string }[] = [
    {
      value: "xenaxio",
      title: t("aiadmin.provider_xenaxio"),
      desc: t("aiadmin.provider_xenaxio_desc"),
      disabled: false,
      ...(data.platformConfigured ? {} : { note: t("aiadmin.provider_xenaxio_off") }),
    },
    {
      value: "custom",
      title: t("aiadmin.provider_custom"),
      desc: t("aiadmin.provider_custom_desc"),
      disabled: !customReady && data.provider !== "custom",
      ...(customReady ? {} : { note: t("aiadmin.provider_custom_untested") }),
    },
  ];
  return (
    <section role="radiogroup" aria-labelledby="ai-provider-title" className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 id="ai-provider-title" className="font-medium">
        {t("aiadmin.provider")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("aiadmin.provider_hint")}</p>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-md border border-border p-3",
            data.provider === o.value && "border-primary bg-accent/40",
            (o.disabled || busy) && "cursor-not-allowed opacity-60",
          )}
        >
          <input
            type="radio"
            name="ai-provider"
            className="mt-1"
            checked={data.provider === o.value}
            disabled={o.disabled || busy}
            onChange={() => onPick(o.value)}
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">{o.title}</span>
            <span className="block text-xs text-muted-foreground">{o.desc}</span>
            {o.note && <span className="block text-xs text-amber-700 dark:text-amber-400">{o.note}</span>}
          </span>
        </label>
      ))}
    </section>
  );
}

function AiSettings() {
  const t = useXT();
  const locale = useLocale();
  const [data, setData] = useState<AiAdmin | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  // Remounts the form with empty settings after the own model is removed.
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.aiAdmin());
    } catch (err) {
      setMessage({ kind: "error", text: errorText(t, err) });
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const change = async (c: { enabled?: boolean; model?: string; provider?: AiProvider }) => {
    setBusy(true);
    setMessage(null);
    try {
      await xenaxio.setAiAdmin(c);
      setMessage({ kind: "success", text: t("aiadmin.saved") });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  if (!data) return message ? <Notice kind="error">{message.text}</Notice> : <Spinner label={t("common.loading")} />;

  const n = (v: number) => v.toLocaleString(locale);
  const month = new Date(`${data.month}-01T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric" });
  const companyShare = data.tenantTokens / data.limits.tenantMonthlyTokens;
  const own = data.provider === "custom";

  return (
    <div className="max-w-2xl space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {!data.configured && <Notice kind="info">{t("aiadmin.not_configured")}</Notice>}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("aiadmin.company")}</h2>
        <p className="text-sm text-muted-foreground">{data.companyEnabled ? t("aiadmin.company_on") : t("aiadmin.company_off")}</p>
        <Button variant={data.companyEnabled ? "outline" : "default"} disabled={busy} onClick={() => change({ enabled: !data.companyEnabled })}>
          {data.companyEnabled ? t("aiadmin.switch_off") : t("aiadmin.switch_on")}
        </Button>
      </section>

      <ProviderChoice data={data} busy={busy} onPick={(provider) => provider !== data.provider && change({ provider })} />

      {!own && data.platformConfigured && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-4">
          <label htmlFor="ai-model" className="font-medium">
            {t("aiadmin.model")}
          </label>
          <p className="text-sm text-muted-foreground">{t("aiadmin.model_hint")}</p>
          <select
            id="ai-model"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={data.model}
            disabled={busy}
            onChange={(e) => change({ model: e.target.value })}
          >
            {data.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </section>
      )}

      <OwnModel
        key={formKey}
        custom={data.custom}
        egressIps={data.egressIps}
        onChanged={async (reset) => {
          await load();
          if (reset) setFormKey((k) => k + 1);
        }}
      />
      {data.custom && <CustomModelList custom={data.custom} platformConfigured={data.platformConfigured} onChanged={load} />}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("aiadmin.usage", { month })}</h2>
        {own ? (
          <p className="text-sm">{t("aiadmin.usage_custom", { used: n(data.tenantTokens) })}</p>
        ) : (
          <div className="space-y-1">
            <p className="text-sm">{t("aiadmin.usage_company", { used: n(data.tenantTokens), limit: n(data.limits.tenantMonthlyTokens) })}</p>
            <Bar share={companyShare} warnShare={data.warnShare} />
            {companyShare >= 1 ? (
              <p className="text-xs text-destructive">{t("aiadmin.limit_reached")}</p>
            ) : companyShare >= data.warnShare ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t("aiadmin.limit_warning")}</p>
            ) : null}
          </div>
        )}
        <ul className="divide-y divide-border">
          {data.users
            .filter((u) => u.aiEnabled || u.tokens > 0)
            .map((u) => {
              const share = u.tokens / data.limits.userMonthlyTokens;
              return (
                <li key={u.id} className="space-y-1 py-2">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{u.displayName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {own ? t("aiadmin.usage_custom_person", { used: n(u.tokens) }) : t("aiadmin.usage_person", { used: n(u.tokens), limit: n(data.limits.userMonthlyTokens) })}
                    </span>
                  </div>
                  {!own && <Bar share={share} warnShare={data.warnShare} />}
                </li>
              );
            })}
        </ul>
        {!own && <p className="text-xs text-muted-foreground">{t("aiadmin.limit_note")}</p>}
      </section>
    </div>
  );
}

export default function AiAdminPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("aiadmin.title")} backHref="/workspace" requireAdmin>
      <AiSettings />
    </WorkspaceShell>
  );
}
