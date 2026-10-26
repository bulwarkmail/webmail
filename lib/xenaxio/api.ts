// Client for the xenaxio platform API (served under /api by the platform's BFF).
// The browser never talks to the mail server directly: the session lives in an
// httpOnly cookie that only the BFF can read (spec A1, A4).
import { apiFetch } from "@/lib/browser-navigation";

export class XenaxioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(code);
    this.name = "XenaxioApiError";
  }
}

async function request<T>(method: "GET" | "POST" | "DELETE" | "PUT", path: string, body?: unknown): Promise<T> {
  let res: Response;
  // Step 17: a logo goes up as the raw file; everything else as JSON.
  const raw = typeof Blob !== "undefined" && body instanceof Blob;
  try {
    res = await apiFetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        // CSRF guard of the BFF: a cross-site page cannot send this header.
        "x-xenaxio-csrf": "1",
        ...(body !== undefined ? { "Content-Type": raw ? (body as Blob).type || "application/octet-stream" : "application/json" } : {}),
      },
      ...(body !== undefined ? { body: raw ? (body as Blob) : JSON.stringify(body) } : {}),
    });
  } catch {
    throw new XenaxioApiError(0, "network");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new XenaxioApiError(
      res.status,
      typeof data.error === "string" ? data.error : "internal",
      data.details as Record<string, unknown> | undefined,
      data.issues as { path: string; message: string }[] | undefined,
    );
  }
  return data as T;
}

/** Step 28: one domain of the company by id; the primary one without. */
function domainPath(id?: string): string {
  return id ? `/api/admin/domains/${encodeURIComponent(id)}` : "/api/admin/domain";
}

/** The translation key for an API error: a field-level code if the server sent one. */
export function errorKey(err: unknown): string {
  if (!(err instanceof XenaxioApiError)) return "errors.internal";
  const issue = err.issues?.find((i) => /^[a-z_]+$/.test(i.message));
  return `errors.${issue ? issue.message : err.code}`;
}

/**
 * The error text for the user; names the taken addresses when the server sent
 * them (step 18), and fills in other details (limit, domain, …; step 28).
 */
export function errorText(t: (key: string, values?: Record<string, string | number>) => string, err: unknown): string {
  const details = err instanceof XenaxioApiError ? err.details : undefined;
  const addresses = details?.addresses;
  if (Array.isArray(addresses) && addresses.length > 0) return t("errors.already_exists_list", { addresses: addresses.join(", ") });
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (typeof value === "string" || typeof value === "number") values[key] = value;
    else if (Array.isArray(value)) values[key] = value.join(", ");
  }
  return t(errorKey(err), values);
}

export interface Me {
  user: { id: string; email: string; displayName: string; role: "user" | "admin"; mustChangePassword: boolean };
  tenant: { id: string; name: string; status: "onboarding" | "active" | "blocked" };
  edition: "cloud" | "onprem";
  /** The user's own domain; mail works only once it is "active" (DNS checked). */
  domain?: { name: string; status: "pending" | "active" } | null;
  /** Step 17: the company's portal (address, logo, colour). */
  portal?: PortalInfo;
}

/** Step 29: an account signed in in this browser; `portalUrl` is where it opens. */
export interface BrowserAccount {
  userId: string;
  email: string;
  displayName: string;
  company: string;
  portalUrl: string;
  active: boolean;
}

/** Step 23: settings for mail apps; the password is the one for xenaxio. */
export interface MailAppSettings {
  username: string;
  imap: { host: string; port: number; security: "ssl" };
  smtp: { host: string; port: number; security: "ssl" };
  /** Step 37: shared mailboxes the user may send from, with the same login. */
  sendAs?: { email: string; displayName: string }[];
}

/** Step 17: a company's login portal. */
export interface PortalInfo {
  name: string;
  slug: string | null;
  /** Main address, e.g. https://firma.xenaxio.com. */
  url: string;
  color: string | null;
  colorText: string | null;
  /** Path on this origin (versioned); null = the xenaxio logo. */
  logoUrl: string | null;
  /** Step 38: the app icon made from the logo (versioned path); null = xenaxio's. */
  iconUrl?: string | null;
  /** Step 40: the icon's background behind the logo; null = white. */
  iconBackground?: string | null;
}

/** Step 17: whose address this page was opened on. */
export type PortalState =
  | ({ kind: "tenant" } & PortalInfo)
  | { kind: "app"; portals: boolean; baseDomain: string | null }
  | { kind: "moved"; url: string }
  | { kind: "unknown" };

export type SlugProblem = "invalid" | "reserved" | "taken";

export interface AdminPortal extends PortalInfo {
  baseDomain: string | null;
  /** Null when own hostnames are not offered on this installation. */
  customHostnames: { target: string } | null;
  hostname: { hostname: string; status: "pending" | "active" | "failed"; primary: boolean; error: string | null; checkedAt: string | null } | null;
}

export type DnsState = "ok" | "missing" | "mismatch" | "error";

export interface DnsRecord {
  purpose: "mx" | "spf" | "dkim" | "dmarc" | "autodiscover";
  type: "MX" | "TXT" | "CNAME";
  name: string;
  value: string;
  priority?: number;
}

export interface DnsReport {
  checkedAt: string;
  mailReady: boolean;
  records: (Omit<DnsRecord, "value"> & { expected: string; state: DnsState; found: string[] })[];
}

/** Step 28: one of the company's mail domains. */
export interface WorkspaceDomain {
  id: string;
  name: string;
  status: "pending" | "active";
  /** The first domain: cannot be removed. */
  primary: boolean;
  mailboxes: number;
}

export interface DomainInfo {
  domain: { id: string; name: string; status: "pending" | "active" };
  records: DnsRecord[];
  lastCheck: DnsReport | null;
  /** While not connected: where DNS is edited and whether mail of the domain lives elsewhere. */
  context?: { nameservers: string[]; provider: string | null; currentMx: string[]; otherMail: boolean } | null;
}

export interface WorkspaceUser {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  quotaBytes: number;
  mustChangePassword: boolean;
  /** Step 28: the domain of the mailbox. */
  domainId: string;
  /** Full addresses, on any domain of the company (step 28). */
  aliases: string[];
  usedBytes?: number | null;
}

/** Step 31: a meeting room, car or piece of equipment; everyone books it by inviting it. */
export interface WorkspaceResource {
  id: string;
  email: string;
  displayName: string;
  type: "room" | "vehicle" | "equipment";
  /** Employees who see and change its bookings. */
  managers: string[];
}

/** Step 31: a shared mailbox (info@) and who may use it. */
export interface SharedMailbox {
  id: string;
  email: string;
  domainId: string;
  displayName: string;
  quotaBytes: number;
  aliases: string[];
  /** canSend false: reads and sorts mail; true: also sends from its addresses. */
  access: { userId: string; canSend: boolean }[];
  usedBytes?: number | null;
}

/** Step 27: the mailbox that receives mail to unknown addresses of the domain. */
export interface CatchAll {
  /** Step 37: an employee's mailbox (`userId`) or a shared one (`sharedMailboxId`). */
  userId?: string;
  sharedMailboxId?: string;
  email: string;
  displayName: string;
}

/** Step 37: whom to send mail to unknown addresses to; `null` turns it off. */
export type CatchAllTarget = { userId: string } | { sharedMailboxId: string } | null;

export interface AiAdmin {
  configured: boolean;
  companyEnabled: boolean;
  model: string;
  models: string[];
  month: string;
  limits: { userMonthlyTokens: number; tenantMonthlyTokens: number };
  warnShare: number;
  tenantTokens: number;
  users: { id: string; email: string; displayName: string; status: "active" | "disabled"; aiEnabled: boolean; tokens: number }[];
}

export interface AuditEntry {
  id: number;
  createdAt: string;
  userEmail: string | null;
  source: "panel" | "mcp";
  tokenName: string | null;
  action: string;
  objectIds: string[];
  status: "ok" | "error" | "denied";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface AuditFilter {
  userId?: string;
  tool?: string;
  source?: "panel" | "mcp";
  from?: string;
  to?: string;
  before?: number;
}

export function auditQuery(f: AuditFilter): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export interface OperatorTenant {
  id: string;
  name: string;
  /** Step 26: "inactive" = deactivated, the domain is off the mail server. */
  status: "onboarding" | "active" | "blocked" | "inactive";
  deactivatedAt?: string | null;
  domain: string | null;
  domainStatus: string | null;
  /** Step 28: all domains of the company, the primary one first. */
  domains?: { name: string; status: string }[];
  createdAt: string;
  maxMailboxes: number;
  maxDomains?: number;
  /** Step 31: shared mailboxes, outside the employee seats. */
  maxSharedMailboxes?: number;
  sharedMailboxes?: number;
  maxResources?: number;
  resources?: number;
  mailboxQuotaBytes: number;
  mailboxes: number;
  usedBytes: number;
  aiEnabled: boolean;
  aiUsers: number;
  aiTokens: number;
  aiUserMonthlyTokens: number | null;
  aiTenantMonthlyTokens: number | null;
  /** Step 17: the company's subdomain and portal. */
  slug: string | null;
  portalUrl: string | null;
  hostname: string | null;
}

export interface OperatorReport {
  month: string;
  tenants: { id: string; name: string; domain: string | null; status: string; mailUsers: number; aiWorkspaceUsers: number; aiTokens: number }[];
}

export interface Invitation {
  id: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt?: string | null;
  tenantName: string | null;
}

export interface McpTokenInfo {
  id: string;
  /** "oauth": an AI chat connected by signing in; "token": created by hand. */
  kind: "token" | "oauth";
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** Step 15: what happened to one recipient of a sent message. */
export interface RecipientDelivery {
  address: string;
  state: "delivered" | "queued" | "deferred" | "failed" | "unknown";
  at?: string;
  nextRetry?: string;
  expires?: string;
  /** The receiving server's reply or the error, as sent. */
  reply?: string;
  reason?: "no_mailbox" | "no_domain" | "mailbox_full" | "sender_not_verified" | "rejected_as_spam" | "unreachable" | "other";
  /** The server that answered; "local" is a mailbox on this server. */
  server?: string;
}

/** Step 36: a note the assistant keeps about the user. */
export interface MemoryNote {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryState {
  enabled: boolean;
  notes: MemoryNote[];
  maxNotes: number;
  maxLength: number;
}

export const xenaxio = {
  me: () => request<Me>("GET", "/api/me"),
  delivery: (emailId: string) => request<{ recipients: RecipientDelivery[] }>("GET", `/api/delivery?emailId=${encodeURIComponent(emailId)}`),
  mailApps: () => request<MailAppSettings>("GET", "/api/me/mail-apps"),
  memories: () => request<MemoryState>("GET", "/api/ai/memories"),
  addMemory: (text: string) => request<{ note: MemoryNote }>("POST", "/api/ai/memories", { text }),
  updateMemory: (id: string, text: string) => request<{ note: MemoryNote }>("PUT", `/api/ai/memories/${encodeURIComponent(id)}`, { text }),
  deleteMemory: (id: string) => request<{ ok: true }>("DELETE", `/api/ai/memories/${encodeURIComponent(id)}`),
  deleteAllMemories: () => request<{ ok: true }>("DELETE", "/api/ai/memories"),
  setMemoryEnabled: (enabled: boolean) => request<{ enabled: boolean }>("POST", "/api/ai/memories/settings", { enabled }),
  mcpTokens: () => request<{ mcpUrl: string; enabled: boolean; tokens: McpTokenInfo[] }>("GET", "/api/me/mcp-tokens"),
  createMcpToken: (name: string, days: number) => request<{ token: string; mcpUrl: string; info: McpTokenInfo }>("POST", "/api/me/mcp-tokens", { name, days }),
  revokeMcpToken: (id: string) => request<{ ok: true }>("DELETE", `/api/me/mcp-tokens/${encodeURIComponent(id)}`),
  /** Step 9: consent screen for an AI chat connecting by OAuth; `query` is the authorization request. */
  oauthRequest: (query: string) =>
    request<{ clientName: string; redirectHost: string; loopback: boolean }>("GET", `/api/oauth/authorize/info?${query.replace(/^\?/, "")}`),
  oauthDecision: (query: string, approve: boolean) => request<{ redirect: string }>("POST", "/api/oauth/authorize/decision", { query, approve }),
  /** Step 29: `add` keeps the accounts signed in here; `url` says where the added one opens. */
  login: (email: string, password: string, locale?: string, add?: { next: string }) =>
    request<Me & { portalUrl: string; url?: string }>("POST", "/api/auth/login", {
      email,
      password,
      ...(locale === "de" || locale === "en" ? { locale } : {}),
      ...(add ? { add: true, next: add.next } : {}),
    }),
  /** Step 17: whose address this is (no sign-in needed). */
  portal: () => request<PortalState>("GET", "/api/portal"),
  /** Step 17: a one-time link that moves the session to the company portal (or `next` when already there). */
  handoff: (next: string) => request<{ url: string }>("POST", "/api/auth/handoff", { next }),
  /** Step 29: the next account takes over at `url` (null when nobody is left); `all` signs everyone out. */
  logout: (opts: { all?: boolean; next?: string } = {}) => request<{ ok: true; url: string | null }>("POST", "/api/auth/logout", opts),
  /** Step 29: the accounts signed in in this browser, the active one first. */
  accounts: () => request<{ accounts: BrowserAccount[]; max: number }>("GET", "/api/auth/accounts"),
  switchAccount: (userId: string, next: string) => request<{ url: string }>("POST", "/api/auth/switch", { userId, next }),
  forgetAccount: (userId: string) => request<{ ok: true }>("POST", "/api/auth/forget", { userId }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("POST", "/api/me/password", { currentPassword, newPassword }),

  invitationStatus: (token: string) =>
    request<{ status: "valid" | "used" | "expired" | "unknown" }>("GET", `/api/onboarding/invitation?token=${encodeURIComponent(token)}`),
  onboard: (input: { token: string; companyName: string; domain: string; adminName: string; adminLocalPart: string; password: string; slug?: string }) =>
    request<Me & { portalUrl: string }>("POST", "/api/onboarding", input),
  /** Step 17: suggestion from the company name and whether a typed address is free. */
  onboardingSlug: (token: string, q: { name?: string; slug?: string }) => {
    const params = new URLSearchParams({ token });
    if (q.name) params.set("name", q.name);
    if (q.slug !== undefined) params.set("slug", q.slug);
    return request<{ baseDomain: string; suggestion: string | null; slug?: string; problem?: SlugProblem | null }>("GET", `/api/onboarding/slug?${params}`);
  },

  adminPortal: () => request<AdminPortal>("GET", "/api/admin/portal"),
  checkSlug: (slug: string) => request<{ slug: string; problem: SlugProblem | null }>("GET", `/api/admin/portal/slug?slug=${encodeURIComponent(slug)}`),
  setSlug: (slug: string, next: string) => request<AdminPortal & { handoffUrl: string | null }>("POST", "/api/admin/portal/slug", { slug, next }),
  uploadLogo: (file: Blob) => request<AdminPortal>("PUT", "/api/admin/portal/logo", file),
  removeLogo: () => request<AdminPortal>("DELETE", "/api/admin/portal/logo"),
  setColor: (color: string | null) => request<AdminPortal>("POST", "/api/admin/portal/color", { color }),
  setIconBackground: (color: string | null) => request<AdminPortal>("POST", "/api/admin/portal/icon-background", { color }),
  addHostname: (hostname: string) => request<AdminPortal>("POST", "/api/admin/portal/hostname", { hostname }),
  checkHostname: () => request<AdminPortal>("POST", "/api/admin/portal/hostname/check", {}),
  setHostnamePrimary: (primary: boolean) => request<AdminPortal>("POST", "/api/admin/portal/hostname/primary", { primary }),
  removeHostname: () => request<AdminPortal>("DELETE", "/api/admin/portal/hostname"),

  // Step 28: without an id, the primary domain.
  domains: () => request<{ domains: WorkspaceDomain[]; limits: { maxDomains: number } }>("GET", "/api/admin/domains"),
  addDomain: (name: string) => request<DomainInfo["domain"]>("POST", "/api/admin/domains", { name }),
  deleteDomain: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/domains/${encodeURIComponent(id)}`),
  domain: (id?: string) => request<DomainInfo>("GET", domainPath(id)),
  checkDomain: (id?: string) => request<{ domain: DomainInfo["domain"]; report: DnsReport }>("POST", `${domainPath(id)}/check`, {}),
  catchAll: (id?: string) => request<{ catchAll: CatchAll | null }>("GET", `${domainPath(id)}/catch-all`),
  setCatchAll: (target: CatchAllTarget, id?: string) =>
    request<{ catchAll: CatchAll | null }>("PUT", `${domainPath(id)}/catch-all`, target ?? { userId: null }),
  users: () => request<{ users: WorkspaceUser[]; limits: { maxMailboxes: number; mailboxQuotaBytes: number } }>("GET", "/api/admin/users"),
  createUser: (input: { localPart: string; displayName: string; password: string; domainId?: string }) =>
    request<WorkspaceUser>("POST", "/api/admin/users", input),
  resetPassword: (userId: string, password: string) =>
    request<{ ok: true }>("POST", `/api/admin/users/${encodeURIComponent(userId)}/password`, { password }),
  setUserStatus: (userId: string, status: "active" | "disabled") =>
    request<WorkspaceUser>("POST", `/api/admin/users/${encodeURIComponent(userId)}/status`, { status }),
  deleteUser: (userId: string) => request<{ ok: true }>("DELETE", `/api/admin/users/${encodeURIComponent(userId)}`),
  setAliases: (userId: string, aliases: string[]) => request<WorkspaceUser>("POST", `/api/admin/users/${encodeURIComponent(userId)}/aliases`, { aliases }),
  setQuota: (userId: string, quotaMb: number) => request<WorkspaceUser>("POST", `/api/admin/users/${encodeURIComponent(userId)}/quota`, { quotaMb }),
  sharedMailboxes: () =>
    request<{ sharedMailboxes: SharedMailbox[]; limits: { maxSharedMailboxes: number; mailboxQuotaBytes: number } }>("GET", "/api/admin/shared-mailboxes"),
  createSharedMailbox: (input: { localPart: string; displayName: string; domainId?: string }) =>
    request<SharedMailbox>("POST", "/api/admin/shared-mailboxes", input),
  setSharedMailboxAccess: (id: string, access: SharedMailbox["access"]) =>
    request<SharedMailbox>("PUT", `/api/admin/shared-mailboxes/${encodeURIComponent(id)}/access`, { access }),
  setSharedMailboxAliases: (id: string, aliases: string[]) =>
    request<SharedMailbox>("POST", `/api/admin/shared-mailboxes/${encodeURIComponent(id)}/aliases`, { aliases }),
  setSharedMailboxQuota: (id: string, quotaMb: number) =>
    request<SharedMailbox>("POST", `/api/admin/shared-mailboxes/${encodeURIComponent(id)}/quota`, { quotaMb }),
  deleteSharedMailbox: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/shared-mailboxes/${encodeURIComponent(id)}`),
  resources: () => request<{ resources: WorkspaceResource[]; limits: { maxResources: number } }>("GET", "/api/admin/resources"),
  createResource: (input: { localPart: string; displayName: string; type: WorkspaceResource["type"]; domainId?: string }) =>
    request<WorkspaceResource>("POST", "/api/admin/resources", input),
  setResourceManagers: (id: string, userIds: string[]) =>
    request<{ managers: string[] }>("PUT", `/api/admin/resources/${encodeURIComponent(id)}/managers`, { userIds }),
  deleteResource: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/resources/${encodeURIComponent(id)}`),
  setUserAi: (userId: string, enabled: boolean) => request<{ ok: true }>("POST", `/api/admin/users/${encodeURIComponent(userId)}/ai`, { enabled }),
  aiAdmin: () => request<AiAdmin>("GET", "/api/admin/ai"),
  setAiAdmin: (change: { enabled?: boolean; model?: string }) => request<{ ok: true }>("POST", "/api/admin/ai", change),
  audit: (f: AuditFilter) => request<{ entries: AuditEntry[]; next: number | null }>("GET", `/api/admin/audit${auditQuery(f)}`),

  operator: {
    me: () => request<{ operator: { id: string; email: string } }>("GET", "/api/operator/me"),
    login: (email: string, password: string) => request<{ operator: { id: string; email: string } }>("POST", "/api/operator/auth/login", { email, password }),
    logout: () => request<{ ok: true }>("POST", "/api/operator/auth/logout", {}),
    invitations: () => request<{ invitations: Invitation[] }>("GET", "/api/operator/invitations"),
    tenants: () =>
      request<{ defaults: { aiUserMonthlyTokens: number; aiTenantMonthlyTokens: number | null }; tenants: OperatorTenant[]; baseDomain?: string | null }>("GET", "/api/operator/tenants"),
    setTenantBlocked: (id: string, blocked: boolean) => request<{ id: string; status: string }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/status`, { blocked }),
    deactivateTenant: (id: string) => request<{ id: string; status: string }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/deactivate`, {}),
    reactivateTenant: (id: string) => request<{ id: string; status: string }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/reactivate`, {}),
    setTenantLimits: (
      id: string,
      limits: {
        maxMailboxes?: number;
        maxDomains?: number;
        maxSharedMailboxes?: number;
        maxResources?: number;
        mailboxQuotaMb?: number;
        aiUserMonthlyTokens?: number | null;
        aiTenantMonthlyTokens?: number | null;
      },
    ) => request<{ ok: true }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/limits`, limits),
    report: (month?: string) => request<OperatorReport>("GET", `/api/operator/report${month ? `?month=${encodeURIComponent(month)}` : ""}`),
    setTenantSlug: (id: string, slug: string) => request<{ id: string; slug: string }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/slug`, { slug }),
    revokeInvitation: (id: string) => request<{ id: string; revokedAt: string }>("POST", `/api/operator/invitations/${encodeURIComponent(id)}/revoke`, {}),
    createInvitation: (note: string, locale: "de" | "en") =>
      request<{ id: string; url: string; expiresAt: string }>("POST", "/api/operator/invitations", { note: note || undefined, locale }),
  },
};
