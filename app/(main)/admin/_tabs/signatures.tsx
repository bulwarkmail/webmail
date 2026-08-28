'use client';

import { useEffect, useMemo, useState } from 'react';
import { Save, Loader2, Plus, Trash2, PenLine } from 'lucide-react';
import type { OrgSignaturePolicy, SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_ORG_SIGNATURE_POLICY, DEFAULT_POLICY } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';
import { sanitizeSignatureHtmlForDisplay } from '@/lib/email-sanitization';
import {
  isValidSenderDomain,
  normalizeSenderDomain,
  resolveEffectiveSignature,
  resolveOrgSignatureContent,
  resolveOrgSignatureTemplate,
} from '@/lib/org-signatures';

const SAMPLE_DEFAULTS = {
  name: 'Sample User',
  email: 'sample.user@example.com',
};

export function SignaturesTab() {
  const [policy, setPolicy] = useState<SettingsPolicy>({ ...DEFAULT_POLICY });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sampleName, setSampleName] = useState(SAMPLE_DEFAULTS.name);
  const [sampleEmail, setSampleEmail] = useState(SAMPLE_DEFAULTS.email);
  const [newDomain, setNewDomain] = useState('');
  const [newBrandDomain, setNewBrandDomain] = useState('');
  const [newBrandName, setNewBrandName] = useState('');

  const org = policy.orgSignature ?? { ...DEFAULT_ORG_SIGNATURE_POLICY };
  const brandNames = policy.domainBrandNames ?? {};

  useEffect(() => {
    void fetchPolicy();
  }, []);

  async function fetchPolicy() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/policy');
      if (res.ok) {
        setPolicy(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }

  function patchOrg(patch: Partial<OrgSignaturePolicy>) {
    setPolicy((prev) => ({
      ...prev,
      orgSignature: {
        ...(prev.orgSignature ?? DEFAULT_ORG_SIGNATURE_POLICY),
        ...patch,
      },
    }));
    setDirty(true);
    setMessage(null);
  }

  function patchInstanceTemplate(field: 'htmlTemplate' | 'textTemplate', value: string) {
    patchOrg({
      instance: {
        htmlTemplate: org.instance?.htmlTemplate ?? '',
        textTemplate: org.instance?.textTemplate ?? '',
        [field]: value,
      },
    });
  }

  function setBrandName(domain: string, value: string) {
    const normalized = normalizeSenderDomain(domain);
    setPolicy((prev) => {
      const next = { ...(prev.domainBrandNames ?? {}) };
      if (!value.trim()) delete next[normalized];
      else next[normalized] = value.trim();
      return { ...prev, domainBrandNames: next };
    });
    setDirty(true);
    setMessage(null);
  }

  function addBrandEntry() {
    const domain = normalizeSenderDomain(newBrandDomain);
    const name = newBrandName.trim();
    if (!isValidSenderDomain(domain) || !name) return;
    setBrandName(domain, name);
    setNewBrandDomain('');
    setNewBrandName('');
  }

  function addDomainTemplate() {
    const domain = normalizeSenderDomain(newDomain);
    if (!isValidSenderDomain(domain)) return;
    patchOrg({
      perDomain: {
        ...(org.perDomain ?? {}),
        [domain]: org.perDomain?.[domain] ?? { htmlTemplate: '', textTemplate: '' },
      },
    });
    setNewDomain('');
  }

  function removeDomainTemplate(domain: string) {
    const next = { ...(org.perDomain ?? {}) };
    delete next[domain];
    patchOrg({ perDomain: next });
  }

  function patchDomainTemplate(
    domain: string,
    field: 'htmlTemplate' | 'textTemplate',
    value: string,
  ) {
    const current = org.perDomain?.[domain] ?? { htmlTemplate: '', textTemplate: '' };
    patchOrg({
      perDomain: {
        ...(org.perDomain ?? {}),
        [domain]: { ...current, [field]: value },
      },
    });
  }

  const previewContext = useMemo(
    () => ({ name: sampleName.trim(), email: sampleEmail.trim() }),
    [sampleName, sampleEmail],
  );

  const previewTemplate = useMemo(
    () => resolveOrgSignatureTemplate(org, previewContext.email),
    [org, previewContext.email],
  );

  const previewOrgOnly = useMemo(() => {
    if (!previewTemplate) return null;
    return resolveOrgSignatureContent(previewTemplate, previewContext, brandNames);
  }, [previewTemplate, previewContext, brandNames]);

  const previewMerged = useMemo(() => {
    const sampleUser = {
      htmlSignature: '<p>User signature line</p>',
      textSignature: 'User signature line',
    };
    const merged = resolveEffectiveSignature(sampleUser, previewContext, org, brandNames);
    return merged;
  }, [org, previewContext, brandNames]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      if (res.ok) {
        setDirty(false);
        setMessage({ type: 'success', text: 'Signature policy saved.' });
        await fetchPolicy();
      } else {
        const body = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: body.error || 'Failed to save policy.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save policy.' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin inline-block me-2" />
        Loading signature policy…
      </div>
    );
  }

  const domainTemplates = Object.keys(org.perDomain ?? {}).sort();
  const brandDomains = Object.keys(brandNames).sort();

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Org Signatures</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Enforce HTML/plain signatures at compose time. Templates support placeholders such as{' '}
            <code className="text-xs bg-muted px-1 rounded">{'{{display.name}}'}</code>,{' '}
            <code className="text-xs bg-muted px-1 rounded">{'{{email}}'}</code>, and{' '}
            <code className="text-xs bg-muted px-1 rounded">{'{{brand.name}}'}</code>{' '}
            (from the brand map keyed by sender email domain).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save
        </button>
      </div>

      {message && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            message.type === 'success'
              ? 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
        >
          {message.text}
        </div>
      )}

      <section className="rounded-lg border border-border p-4 space-y-4">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={org.enabled}
            onChange={(e) => patchOrg({ enabled: e.target.checked })}
            className="rounded border-input"
          />
          <span className="text-sm font-medium">Enable org-enforced signatures</span>
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Scope</span>
            <select
              value={org.scope}
              onChange={(e) => patchOrg({ scope: e.target.value as OrgSignaturePolicy['scope'] })}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="instance">Instance-wide (same template for all domains)</option>
              <option value="per_domain">Per sender domain</option>
            </select>
          </label>

          <label className="block text-sm">
            <span className="font-medium">Merge with user signatures</span>
            <select
              value={org.mergeMode}
              onChange={(e) => patchOrg({ mergeMode: e.target.value as OrgSignaturePolicy['mergeMode'] })}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="replace">Org signature only (ignore user signature)</option>
              <option value="append">Append org signature after user signature</option>
              <option value="fallback">Use org signature only when user has none</option>
            </select>
          </label>
        </div>

        {org.mergeMode === 'replace' && (
          <p className="text-xs text-muted-foreground">
            Users cannot edit HTML or plain-text signatures in the identity editor while this mode is active.
          </p>
        )}
      </section>

      {org.scope === 'instance' ? (
        <section className="rounded-lg border border-border p-4 space-y-4">
          <h2 className="text-lg font-medium">Instance-wide template</h2>
          <TemplateEditor
            html={org.instance?.htmlTemplate ?? ''}
            text={org.instance?.textTemplate ?? ''}
            onHtmlChange={(value) => patchInstanceTemplate('htmlTemplate', value)}
            onTextChange={(value) => patchInstanceTemplate('textTemplate', value)}
          />
        </section>
      ) : (
        <section className="rounded-lg border border-border p-4 space-y-4">
          <h2 className="text-lg font-medium">Per-domain templates</h2>
          <p className="text-sm text-muted-foreground">
            Templates apply when the selected identity&apos;s email address matches the domain.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="example.com"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[12rem]"
            />
            <button
              type="button"
              onClick={addDomainTemplate}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-border text-sm hover:bg-muted"
            >
              <Plus className="w-4 h-4" />
              Add domain
            </button>
          </div>
          {domainTemplates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domain templates configured yet.</p>
          ) : (
            domainTemplates.map((domain) => (
              <div key={domain} className="rounded-md border border-border p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm">{domain}</span>
                  <button
                    type="button"
                    onClick={() => removeDomainTemplate(domain)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${domain}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <TemplateEditor
                  html={org.perDomain?.[domain]?.htmlTemplate ?? ''}
                  text={org.perDomain?.[domain]?.textTemplate ?? ''}
                  onHtmlChange={(value) => patchDomainTemplate(domain, 'htmlTemplate', value)}
                  onTextChange={(value) => patchDomainTemplate(domain, 'textTemplate', value)}
                />
              </div>
            ))
          )}
        </section>
      )}

      <section className="rounded-lg border border-border p-4 space-y-4">
        <h2 className="text-lg font-medium">Brand names</h2>
        <p className="text-sm text-muted-foreground">
          Map sender email domains to a display brand for <code className="text-xs bg-muted px-1 rounded">{'{{brand.name}}'}</code>.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={newBrandDomain}
            onChange={(e) => setNewBrandDomain(e.target.value)}
            placeholder="example.com"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[10rem]"
          />
          <input
            type="text"
            value={newBrandName}
            onChange={(e) => setNewBrandName(e.target.value)}
            placeholder="Example Brand"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[12rem]"
          />
          <button
            type="button"
            onClick={addBrandEntry}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-border text-sm hover:bg-muted"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
        {brandDomains.length > 0 && (
          <div className="space-y-2">
            {brandDomains.map((domain) => (
              <div key={domain} className="flex items-center gap-2">
                <span className="font-mono text-sm w-40 shrink-0">{domain}</span>
                <input
                  type="text"
                  value={brandNames[domain] ?? ''}
                  onChange={(e) => setBrandName(domain, e.target.value)}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setBrandName(domain, '')}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove brand for ${domain}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border p-4 space-y-4">
        <h2 className="text-lg font-medium">Reply signature placement</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Position in replies/forwards</span>
            <select
              value={org.replySignaturePosition ?? 'above_quote'}
              onChange={(e) =>
                patchOrg({
                  replySignaturePosition: e.target.value as 'above_quote' | 'below_quote',
                })
              }
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="above_quote">Above quoted text</option>
              <option value="below_quote">Below quoted text</option>
            </select>
          </label>
          <label className="flex items-center gap-3 mt-6 md:mt-8">
            <input
              type="checkbox"
              checked={org.lockReplySignaturePosition ?? false}
              onChange={(e) => patchOrg({ lockReplySignaturePosition: e.target.checked })}
              className="rounded border-input"
            />
            <span className="text-sm">Lock for users (hide composer setting)</span>
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={org.signatureSeparatorEnabled !== false}
              onChange={(e) => patchOrg({ signatureSeparatorEnabled: e.target.checked })}
              className="rounded border-input"
            />
            <span className="text-sm">Include &quot;-- &quot; separator before signature</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={org.lockSignatureSeparator ?? false}
              onChange={(e) => patchOrg({ lockSignatureSeparator: e.target.checked })}
              className="rounded border-input"
            />
            <span className="text-sm">Lock separator setting for users</span>
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-border p-4 space-y-4">
        <div className="flex items-center gap-2">
          <PenLine className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-lg font-medium">Preview (sample identity)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Admins may not have a regular mail identity. Enter a sample sender to preview template output.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Display name</span>
            <input
              type="text"
              value={sampleName}
              onChange={(e) => setSampleName(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Email address</span>
            <input
              type="email"
              value={sampleEmail}
              onChange={(e) => setSampleEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        {!org.enabled ? (
          <p className="text-sm text-muted-foreground">Enable org signatures to see a preview.</p>
        ) : !previewTemplate ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            No template applies to this sample email domain. Add a matching domain template or switch to instance-wide scope.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <PreviewPanel title="Org template only" html={previewOrgOnly?.html} text={previewOrgOnly?.text} />
            <PreviewPanel
              title={`Effective (${org.mergeMode}) with sample user signature`}
              html={previewMerged.htmlSignature ?? undefined}
              text={previewMerged.textSignature ?? undefined}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function TemplateEditor({
  html,
  text,
  onHtmlChange,
  onTextChange,
}: {
  html: string;
  text: string;
  onHtmlChange: (value: string) => void;
  onTextChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="block text-sm">
        <span className="font-medium">HTML template</span>
        <textarea
          value={html}
          onChange={(e) => onHtmlChange(e.target.value)}
          rows={8}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Plain-text template</span>
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          rows={8}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
      </label>
    </div>
  );
}

function PreviewPanel({
  title,
  html,
  text,
}: {
  title: string;
  html?: string;
  text?: string;
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {html ? (
        <div
          className="prose prose-sm dark:prose-invert max-w-none border rounded p-2 bg-muted/40"
          dangerouslySetInnerHTML={{ __html: sanitizeSignatureHtmlForDisplay(html) }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">No HTML output</p>
      )}
      {text ? (
        <pre className="text-xs whitespace-pre-wrap rounded border bg-muted/40 p-2">{text}</pre>
      ) : (
        <p className="text-xs text-muted-foreground">No plain-text output</p>
      )}
    </div>
  );
}
