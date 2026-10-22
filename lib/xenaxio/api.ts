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

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        // CSRF guard of the BFF: a cross-site page cannot send this header.
        "x-xenaxio-csrf": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

/** The translation key for an API error: a field-level code if the server sent one. */
export function errorKey(err: unknown): string {
  if (!(err instanceof XenaxioApiError)) return "errors.internal";
  const issue = err.issues?.find((i) => /^[a-z_]+$/.test(i.message));
  return `errors.${issue ? issue.message : err.code}`;
}

export interface Me {
  user: { id: string; email: string; displayName: string; role: "user" | "admin"; mustChangePassword: boolean };
  tenant: { id: string; name: string; status: "onboarding" | "active" | "blocked" };
  edition: "cloud" | "onprem";
  /** The company's domain; mail works only once it is "active" (DNS checked). */
  domain?: { name: string; status: "pending" | "active" } | null;
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

export interface DomainInfo {
  domain: { name: string; status: "pending" | "active" };
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
  aliases: string[];
  usedBytes?: number | null;
}

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
  status: "onboarding" | "active" | "blocked";
  domain: string | null;
  domainStatus: string | null;
  createdAt: string;
  maxMailboxes: number;
  mailboxQuotaBytes: number;
  mailboxes: number;
  usedBytes: number;
  aiEnabled: boolean;
  aiUsers: number;
  aiTokens: number;
  aiUserMonthlyTokens: number | null;
  aiTenantMonthlyTokens: number | null;
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
}

export const xenaxio = {
  me: () => request<Me>("GET", "/api/me"),
  delivery: (emailId: string) => request<{ recipients: RecipientDelivery[] }>("GET", `/api/delivery?emailId=${encodeURIComponent(emailId)}`),
  mcpTokens: () => request<{ mcpUrl: string; enabled: boolean; tokens: McpTokenInfo[] }>("GET", "/api/me/mcp-tokens"),
  createMcpToken: (name: string, days: number) => request<{ token: string; mcpUrl: string; info: McpTokenInfo }>("POST", "/api/me/mcp-tokens", { name, days }),
  revokeMcpToken: (id: string) => request<{ ok: true }>("DELETE", `/api/me/mcp-tokens/${encodeURIComponent(id)}`),
  /** Step 9: consent screen for an AI chat connecting by OAuth; `query` is the authorization request. */
  oauthRequest: (query: string) =>
    request<{ clientName: string; redirectHost: string; loopback: boolean }>("GET", `/api/oauth/authorize/info?${query.replace(/^\?/, "")}`),
  oauthDecision: (query: string, approve: boolean) => request<{ redirect: string }>("POST", "/api/oauth/authorize/decision", { query, approve }),
  login: (email: string, password: string, locale?: string) =>
    request<Me>("POST", "/api/auth/login", { email, password, ...(locale === "de" || locale === "en" ? { locale } : {}) }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("POST", "/api/me/password", { currentPassword, newPassword }),

  invitationStatus: (token: string) =>
    request<{ status: "valid" | "used" | "expired" | "unknown" }>("GET", `/api/onboarding/invitation?token=${encodeURIComponent(token)}`),
  onboard: (input: { token: string; companyName: string; domain: string; adminName: string; adminLocalPart: string; password: string }) =>
    request<Me>("POST", "/api/onboarding", input),

  domain: () => request<DomainInfo>("GET", "/api/admin/domain"),
  checkDomain: () => request<{ domain: DomainInfo["domain"]; report: DnsReport }>("POST", "/api/admin/domain/check", {}),
  users: () => request<{ users: WorkspaceUser[]; limits: { maxMailboxes: number; mailboxQuotaBytes: number } }>("GET", "/api/admin/users"),
  createUser: (input: { localPart: string; displayName: string; password: string }) =>
    request<WorkspaceUser>("POST", "/api/admin/users", input),
  resetPassword: (userId: string, password: string) =>
    request<{ ok: true }>("POST", `/api/admin/users/${encodeURIComponent(userId)}/password`, { password }),
  setUserStatus: (userId: string, status: "active" | "disabled") =>
    request<WorkspaceUser>("POST", `/api/admin/users/${encodeURIComponent(userId)}/status`, { status }),
  setAliases: (userId: string, aliases: string[]) => request<WorkspaceUser>("POST", `/api/admin/users/${encodeURIComponent(userId)}/aliases`, { aliases }),
  setQuota: (userId: string, quotaMb: number) => request<WorkspaceUser>("POST", `/api/admin/users/${encodeURIComponent(userId)}/quota`, { quotaMb }),
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
      request<{ defaults: { aiUserMonthlyTokens: number; aiTenantMonthlyTokens: number | null }; tenants: OperatorTenant[] }>("GET", "/api/operator/tenants"),
    setTenantBlocked: (id: string, blocked: boolean) => request<{ id: string; status: string }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/status`, { blocked }),
    setTenantLimits: (
      id: string,
      limits: { maxMailboxes?: number; mailboxQuotaMb?: number; aiUserMonthlyTokens?: number | null; aiTenantMonthlyTokens?: number | null },
    ) => request<{ ok: true }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/limits`, limits),
    report: (month?: string) => request<OperatorReport>("GET", `/api/operator/report${month ? `?month=${encodeURIComponent(month)}` : ""}`),
    createInvitation: (note: string, locale: "de" | "en") =>
      request<{ id: string; url: string; expiresAt: string }>("POST", "/api/operator/invitations", { note: note || undefined, locale }),
  },
};
