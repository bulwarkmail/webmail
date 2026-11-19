'use client';

import { useId, useState, type FormEvent } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from '@/components/icons';
import { AdminList, AdminListRow } from '@/components/admin/list';
import { Badge } from '@/components/admin/badge';
import { EmptyState } from '@/components/admin/empty-state';
import { inputClass } from '@/components/admin/config-items';
import { useAdminFeedback } from '@/components/admin/feedback';
import { SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { DEFAULT_LOGIN_FORMAT, type ImapSecurity } from '@/lib/migration/types';
import { cn } from '@/lib/utils';
import { fieldHintClass, fieldLabelClass, postMigration, type PublicSource, type TestOutcome } from './shared';

const SECURITY_LABELS: Record<ImapSecurity, string> = { tls: 'TLS', starttls: 'STARTTLS', none: 'None' };
const DEFAULT_IMAP_PORT: Record<ImapSecurity, string> = { tls: '993', starttls: '143', none: '143' };
const DAV_PLACEHOLDER = 'https://dav.example.com/caldav/';

interface SourceDraft {
  id?: string;
  name: string;
  imapHost: string;
  imapPort: string;
  security: ImapSecurity;
  caldavUrl: string;
  carddavUrl: string;
  sieveHost: string;
  sievePort: string;
  adminUsername: string;
  adminFormat: string;
  adminPassword: string;
  /** The server holds an admin password; the field stays closed until "Change". */
  passwordSaved: boolean;
  changingPassword: boolean;
  allowSelfService: boolean;
}

function emptyDraft(): SourceDraft {
  return {
    name: '',
    imapHost: '',
    imapPort: '993',
    security: 'tls',
    caldavUrl: '',
    carddavUrl: '',
    sieveHost: '',
    sievePort: '4190',
    adminUsername: '',
    adminFormat: DEFAULT_LOGIN_FORMAT,
    adminPassword: '',
    passwordSaved: false,
    changingPassword: false,
    allowSelfService: false,
  };
}

function sourceToDraft(s: PublicSource): SourceDraft {
  return {
    id: s.id,
    name: s.name,
    imapHost: s.imap.host,
    imapPort: String(s.imap.port),
    security: s.imap.security,
    caldavUrl: s.caldavUrl ?? '',
    carddavUrl: s.carddavUrl ?? '',
    sieveHost: s.sieve?.host ?? '',
    sievePort: String(s.sieve?.port ?? 4190),
    adminUsername: s.adminLogin?.username ?? '',
    adminFormat: s.adminLogin?.format ?? DEFAULT_LOGIN_FORMAT,
    adminPassword: '',
    passwordSaved: !!s.adminLogin?.passwordSaved,
    changingPassword: false,
    allowSelfService: s.allowSelfService,
  };
}

/** The endpoints as the API reads them (parseEndpoints), without id, name or login. */
function draftEndpoints(d: SourceDraft) {
  const sieveHost = d.sieveHost.trim();
  return {
    imap: { host: d.imapHost.trim(), port: d.imapPort.trim(), security: d.security },
    caldavUrl: d.caldavUrl.trim(),
    carddavUrl: d.carddavUrl.trim(),
    ...(sieveHost ? { sieve: { host: sieveHost, port: d.sievePort.trim() } } : {}),
  };
}

/** `password` only when typed: absent keeps the saved one. */
function draftToSource(d: SourceDraft) {
  const passwordOpen = !d.passwordSaved || d.changingPassword;
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    ...draftEndpoints(d),
    adminLogin: {
      username: d.adminUsername.trim(),
      format: d.adminFormat.trim() || DEFAULT_LOGIN_FORMAT,
      ...(passwordOpen && d.adminPassword ? { password: d.adminPassword } : {}),
    },
    allowSelfService: d.allowSelfService,
  };
}

function hostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

interface Props {
  sources: PublicSource[];
  onChanged: () => Promise<void> | void;
}

export function MigrationSourcesSection({ sources, onChanged }: Props) {
  const setMessage = useAdminFeedback();
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PublicSource | null>(null);
  const [testing, setTesting] = useState<{ label: string; target: Record<string, unknown> } | null>(null);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    try {
      const result = await postMigration({ action: 'save-source', source: draftToSource(draft) });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setMessage({ type: 'success', text: draft.id ? 'Source server saved.' : 'Source server added.' });
      setDraft(null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove(source: PublicSource): Promise<void> {
    const result = await postMigration({ action: 'delete-source', id: source.id });
    if (!result.ok) {
      setMessage({ type: 'error', text: `Couldn't remove ${source.name}: ${result.error}` });
      return;
    }
    setMessage({ type: 'success', text: `${source.name} removed.` });
    if (draft?.id === source.id) setDraft(null);
    await onChanged();
  }

  function open(next: SourceDraft) {
    setFormError(null);
    setDraft(next);
  }

  return (
    <SettingsSection
      id="sources"
      title="Source servers"
      description="The old servers mailboxes are moved from: Open-Xchange, Kopano or any IMAP server, with CalDAV, CardDAV and ManageSieve where it has them."
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => open(emptyDraft())} disabled={draft !== null && !draft.id}>
          <Plus className="h-3.5 w-3.5" />
          Add source
        </Button>
      </div>

      {sources.length === 0 && !draft && (
        <EmptyState title="No source servers yet" hint="Add the old server to move mailboxes from." />
      )}

      {sources.length > 0 && (
        <AdminList>
          {sources.map((s) => (
            <AdminListRow
              key={s.id}
              data-testid="migration-source-row"
              title={<span className="break-all">{s.name}</span>}
              titleExtra={s.allowSelfService ? <Badge tone="accent">Users may move their own mailbox</Badge> : undefined}
              description={(
                <span className="block truncate font-mono" title={hostPort(s.imap.host, s.imap.port)}>
                  IMAP {hostPort(s.imap.host, s.imap.port)} {SECURITY_LABELS[s.imap.security]}
                </span>
              )}
              meta={(
                <span className="flex flex-wrap gap-1">
                  {s.caldavUrl && <Badge>CalDAV</Badge>}
                  {s.carddavUrl && <Badge>CardDAV</Badge>}
                  {s.sieve && <Badge>ManageSieve</Badge>}
                  {s.adminLogin && <Badge>Admin login</Badge>}
                </span>
              )}
              wideControl
              control={(
                <>
                  <Button type="button" variant="outline" size="sm" onClick={() => setTesting({ label: s.name, target: { id: s.id } })}>
                    Test
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => open(sourceToDraft(s))}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="gap-1.5 hover:text-destructive" onClick={() => setRemoving(s)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                </>
              )}
            />
          ))}
        </AdminList>
      )}

      {draft && (
        <SourceForm
          draft={draft}
          saving={saving}
          error={formError}
          onChange={(patch) => setDraft((d) => (d ? { ...d, ...patch } : d))}
          onSave={() => void save()}
          onCancel={() => { setDraft(null); setFormError(null); }}
          onTest={() => setTesting({ label: draft.name.trim() || 'this server', target: { source: draftEndpoints(draft) } })}
        />
      )}

      <TestSourceDialog
        open={testing !== null}
        label={testing?.label ?? ''}
        target={testing?.target ?? {}}
        onClose={() => setTesting(null)}
      />

      <ConfirmDialog
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => { const s = removing; setRemoving(null); if (s) void remove(s); }}
        title="Remove this source server?"
        message={removing ? `${removing.name} and its saved admin login are removed. Migrations already started from it keep their report.` : ''}
        confirmText="Remove"
        variant="destructive"
      />
    </SettingsSection>
  );
}

interface SourceFormProps {
  draft: SourceDraft;
  saving: boolean;
  error: string | null;
  onChange: (patch: Partial<SourceDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  onTest: () => void;
}

function SourceForm({ draft: d, saving, error, onChange, onSave, onCancel, onTest }: SourceFormProps) {
  const idBase = useId();
  const fid = (key: string) => `${idBase}-${key}`;
  const fieldClass = cn(inputClass, 'w-full min-w-0');
  const passwordOpen = !d.passwordSaved || d.changingPassword;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave();
  }

  function setSecurity(security: ImapSecurity) {
    // A port still at the old default follows the new one.
    const port = d.imapPort.trim() === '' || d.imapPort === DEFAULT_IMAP_PORT[d.security] ? DEFAULT_IMAP_PORT[security] : d.imapPort;
    onChange({ security, imapPort: port });
  }

  return (
    <form onSubmit={submit} data-testid="migration-source-form" className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
      <h4 className="text-sm font-medium text-foreground">{d.id ? 'Edit source server' : 'Add source server'}</h4>

      <div>
        <label htmlFor={fid('name')} className={fieldLabelClass}>Name</label>
        <input id={fid('name')} type="text" value={d.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Old mail server" maxLength={100} className={fieldClass} />
        <p className={fieldHintClass}>Shown to users, e.g. Old mail server.</p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        <div className="sm:col-span-6">
          <label htmlFor={fid('imap-host')} className={fieldLabelClass}>IMAP host</label>
          <input id={fid('imap-host')} type="text" value={d.imapHost} onChange={(e) => onChange({ imapHost: e.target.value })} placeholder="imap.example.com" autoComplete="off" spellCheck={false} className={fieldClass} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={fid('imap-port')} className={fieldLabelClass}>Port</label>
          <input id={fid('imap-port')} type="number" min={1} max={65535} value={d.imapPort} onChange={(e) => onChange({ imapPort: e.target.value })} className={fieldClass} />
        </div>
        <div className="sm:col-span-4">
          <label htmlFor={fid('imap-security')} className={fieldLabelClass}>Security</label>
          <select id={fid('imap-security')} value={d.security} onChange={(e) => setSecurity(e.target.value as ImapSecurity)} className={cn(fieldClass, 'pe-8 cursor-pointer')}>
            {(Object.keys(SECURITY_LABELS) as ImapSecurity[]).map((s) => <option key={s} value={s}>{SECURITY_LABELS[s]}</option>)}
          </select>
        </div>
        <p className={cn(fieldHintClass, 'sm:col-span-12 mt-0')}>None only for hosts on your intranet: the login goes over the network unencrypted.</p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={fid('caldav')} className={fieldLabelClass}>CalDAV URL (optional)</label>
          <input id={fid('caldav')} type="url" value={d.caldavUrl} onChange={(e) => onChange({ caldavUrl: e.target.value })} placeholder={DAV_PLACEHOLDER} autoComplete="off" spellCheck={false} className={fieldClass} />
        </div>
        <div className="min-w-0">
          <label htmlFor={fid('carddav')} className={fieldLabelClass}>CardDAV URL (optional)</label>
          <input id={fid('carddav')} type="url" value={d.carddavUrl} onChange={(e) => onChange({ carddavUrl: e.target.value })} placeholder={DAV_PLACEHOLDER} autoComplete="off" spellCheck={false} className={fieldClass} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        <div className="sm:col-span-8">
          <label htmlFor={fid('sieve-host')} className={fieldLabelClass}>ManageSieve host (optional)</label>
          <input id={fid('sieve-host')} type="text" value={d.sieveHost} onChange={(e) => onChange({ sieveHost: e.target.value })} placeholder="imap.example.com" autoComplete="off" spellCheck={false} className={fieldClass} />
        </div>
        <div className="sm:col-span-4">
          <label htmlFor={fid('sieve-port')} className={fieldLabelClass}>Port</label>
          <input id={fid('sieve-port')} type="number" min={1} max={65535} value={d.sievePort} onChange={(e) => onChange({ sievePort: e.target.value })} className={fieldClass} />
        </div>
        <p className={cn(fieldHintClass, 'sm:col-span-12 mt-0')}>Filters are copied over ManageSieve with STARTTLS.</p>
      </div>

      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-medium text-foreground">Admin login (optional)</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor={fid('admin-user')} className={fieldLabelClass}>Username</label>
            <input id={fid('admin-user')} type="text" value={d.adminUsername} onChange={(e) => onChange({ adminUsername: e.target.value })} autoComplete="off" spellCheck={false} className={fieldClass} />
          </div>
          <div className="min-w-0">
            <label htmlFor={fid('admin-password')} className={fieldLabelClass}>Password</label>
            {passwordOpen ? (
              <input
                id={fid('admin-password')}
                type="password"
                value={d.adminPassword}
                onChange={(e) => onChange({ adminPassword: e.target.value })}
                autoComplete="new-password"
                className={fieldClass}
              />
            ) : (
              <div className="flex h-9 items-center gap-2">
                <span id={fid('admin-password')} className="text-sm text-foreground">Saved</span>
                <Button type="button" variant="outline" size="xs" onClick={() => onChange({ changingPassword: true, adminPassword: '' })}>
                  Change
                </Button>
              </div>
            )}
          </div>
        </div>
        <div>
          <label htmlFor={fid('admin-format')} className={fieldLabelClass}>Login format</label>
          <input id={fid('admin-format')} type="text" value={d.adminFormat} onChange={(e) => onChange({ adminFormat: e.target.value })} placeholder={DEFAULT_LOGIN_FORMAT} autoComplete="off" spellCheck={false} className={cn(fieldClass, 'font-mono')} />
          <p className={fieldHintClass}>
            {'{user}'} and {'{admin}'} are replaced. Dovecot master user syntax, used by most Open-Xchange setups. Only bulk migrations use the admin login.
          </p>
        </div>
      </fieldset>

      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-sm text-foreground">Allow users to move their own mailbox from this server</span>
        <ToggleSwitch
          checked={d.allowSelfService}
          onChange={(checked) => onChange({ allowSelfService: checked })}
          ariaLabel="Allow users to move their own mailbox from this server"
        />
      </div>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onTest}>Test</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" size="sm" className="gap-2" disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}

const PROTOCOL_LABELS: Record<TestOutcome['protocol'], string> = { imap: 'IMAP', carddav: 'CardDAV', caldav: 'CalDAV', sieve: 'ManageSieve' };
const PROTOCOL_ORDER: TestOutcome['protocol'][] = ['imap', 'carddav', 'caldav', 'sieve'];

interface TestSourceDialogProps {
  open: boolean;
  label: string;
  /** `{ id }` for a saved source, `{ source }` for the form as it stands. */
  target: Record<string, unknown>;
  onClose: () => void;
}

/** A login typed in for the test only: neither stored nor logged. */
function TestSourceDialog({ open, label, target, onClose }: TestSourceDialogProps) {
  const idBase = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<TestOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setUsername('');
    setPassword('');
    setResults(null);
    setError(null);
    onClose();
  }

  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResults(null);
    setError(null);
    try {
      const result = await postMigration<{ results: TestOutcome[] }>({ action: 'test-source', ...target, username, password });
      if (result.ok) setResults([...result.data.results].sort((a, b) => PROTOCOL_ORDER.indexOf(a.protocol) - PROTOCOL_ORDER.indexOf(b.protocol)));
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  const fieldClass = cn(inputClass, 'w-full min-w-0');
  return (
    <Dialog
      isOpen={open}
      onClose={close}
      title={`Test ${label}`}
      description="Log in with a mailbox on the old server. The login is used for this test only and is not stored."
      onSubmit={(e) => void run(e)}
      footer={(
        <>
          <Button type="button" variant="outline" onClick={close}>Close</Button>
          <Button type="submit" className="gap-2" disabled={busy || !username.trim() || !password}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Test
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div>
          <label htmlFor={`${idBase}-user`} className={fieldLabelClass}>Username</label>
          <input id={`${idBase}-user`} type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} className={fieldClass} />
        </div>
        <div>
          <label htmlFor={`${idBase}-password`} className={fieldLabelClass}>Password</label>
          <input id={`${idBase}-password`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" className={fieldClass} />
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {results && (
          <ul data-testid="migration-test-results" className="divide-y divide-border rounded-md border border-border text-sm">
            {results.map((r) => (
              <li key={r.protocol} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="font-medium text-foreground">{PROTOCOL_LABELS[r.protocol]}</span>
                {r.ok ? <Badge tone="success">OK</Badge> : <span className="text-destructive">{r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
