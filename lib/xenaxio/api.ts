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

async function request<T>(method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T> {
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

/** Step 41: whose picture: one's own (null), or someone of the company (admin). */
export type AvatarTarget = null | { kind: "users" | "shared-mailboxes" | "resources"; id: string };

// Whole paths, so the Lite build check (scripts/lite/lib.mjs) sees each one.
const AVATAR_BASES = {
  users: "/api/admin/users",
  "shared-mailboxes": "/api/admin/shared-mailboxes",
  resources: "/api/admin/resources",
} as const;

function avatarPath(target: AvatarTarget): string {
  return target ? `${AVATAR_BASES[target.kind]}/${encodeURIComponent(target.id)}/avatar` : "/api/me/avatar";
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
  /** Step 41: the user's own picture (versioned path); null = initials. */
  avatarUrl?: string | null;
  /** Step 42: the person's own background (null = the company's, "none" = none). */
  background?: string | null;
  /** Hints the user has closed for good (kept by the platform, the same on every device). */
  dismissedHints?: string[];
}

/** Hints of the web client a user can close for good (the platform's list). */
export type DismissableHint = "welcome";

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
  /** Step 42: the company's default background under the web client; null = none. */
  background?: string | null;
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
  /** Step 41: picture (versioned path); null = initials. */
  avatarUrl?: string | null;
}

/** Step 31: a meeting room, car or piece of equipment; everyone books it by inviting it. */
export interface WorkspaceResource {
  id: string;
  email: string;
  displayName: string;
  type: "room" | "vehicle" | "equipment";
  /** Employees who see and change its bookings. */
  managers: string[];
  avatarUrl?: string | null;
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
  avatarUrl?: string | null;
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

/** Step 43: the company's chat as the admin sees it. */
export interface ChatAdmin {
  available: boolean;
  state: "off" | "provisioning" | "active" | "disabled" | "error";
  serverName: string | null;
  candidate: { name: string; status: string } | null;
  error: string | null;
  /** Step 54: the assistant (side panel, scheduled tasks, connected AI chats) may read the chat. */
  aiAccess: boolean;
}

/** Step 44: result of the connection test of a company's own model. */
export interface CustomModelCheck {
  ok: boolean;
  models: string[] | null;
  stream: boolean;
  tools: boolean;
  usage: boolean;
  firstTokenMs: number | null;
  error: "address_not_allowed" | "unreachable" | "timeout" | "unauthorized" | "model_not_found" | "bad_response" | null;
  status: number | null;
}

/** Step 45: one of the company's models and its last connection test. */
export interface CustomModelEntry {
  name: string;
  check: CustomModelCheck | null;
  checkedAt: string | null;
}

/** Step 44: the company's own model; the key and header values are never sent back. */
export interface CustomModel {
  baseUrl: string;
  profile: "openai" | "mistral";
  /** The active model. */
  model: string;
  /** Step 45: up to five models. */
  models: CustomModelEntry[];
  apiKeySet: boolean;
  headers: { name: string }[];
  /** Step 45: the AI by xenaxio answers while the own model is down. */
  fallback: boolean;
  check: CustomModelCheck | null;
  checkedAt: string | null;
  /** Step 45: availability, checked every 15 minutes. */
  health: { status: "ok" | "down" | null; since: string | null; error: CustomModelCheck["error"]; checkedAt: string | null };
}

export interface CustomModelInput {
  baseUrl: string;
  profile: "openai" | "mistral";
  /** Step 45: 1–5 models. */
  models: string[];
  /** The active one (default: the current one, else the first). */
  model?: string;
  /** Omitted or "" keeps the stored key, null removes it. */
  apiKey?: string | null;
  /** A header without value keeps the stored value. */
  headers: { name: string; value?: string }[];
}

export type AiProvider = "xenaxio" | "custom";

export interface AiAdmin {
  configured: boolean;
  /** Step 44: the platform's model (Mistral) is set up on this server. */
  platformConfigured: boolean;
  provider: AiProvider;
  custom: CustomModel | null;
  /** Addresses our requests to the own model come from (for a firewall). */
  egressIps: string[];
  companyEnabled: boolean;
  model: string;
  models: string[];
  month: string;
  limits: { userMonthlyTokens: number; tenantMonthlyTokens: number };
  warnShare: number;
  tenantTokens: number;
  /** Step 50: what the company allows for scheduled tasks (absent on older servers). */
  schedules?: ScheduleSettingsInfo;
  users: { id: string; email: string; displayName: string; status: "active" | "disabled"; aiEnabled: boolean; tokens: number }[];
}

/** Step 50: the company's settings for the assistant's scheduled tasks. */
export interface ScheduleSettings {
  enabled: boolean;
  sendAllowed: boolean;
  /** Active tasks per person. */
  maxPerUser: number;
  /** Runs per person and day, all tasks together. */
  runsPerDay: number;
  minIntervalMinutes: number;
}

export interface ScheduleSettingsInfo extends ScheduleSettings {
  /** The platform's ceilings. */
  caps: { maxPerUser: number; runsPerDay: number; minIntervalMinutes: number };
  active: number;
  paused: number;
}

/** GET /api/ai/schedules: the user's tasks and the company's limits (step 50). */
export interface ScheduleList {
  timeZone: string;
  schedules: ScheduleInfo[];
  maxSchedules: number;
  maxRunsPerDay: number;
  minIntervalMinutes?: number;
  enabled?: boolean;
  sendAllowed?: boolean;
}

export interface AuditEntry {
  id: number;
  createdAt: string;
  userEmail: string | null;
  source: "panel" | "mcp" | "admin" | "chat";
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
  source?: "panel" | "mcp" | "admin" | "chat";
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
  /** Step 51: the address an AI chat connected to; null for a token made by hand. */
  address?: string | null;
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

/** Step 49: a task the assistant carries out on a schedule (the user's page "Geplante Aufgaben"). */
export interface ScheduleInfo {
  id: string;
  title: string;
  instruction: string;
  when: string;
  timeZone: string;
  status: "active" | "paused" | "ended";
  pausedReason?: "no_access" | "ai_off" | "failures" | string;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: "done" | "failed" | "skipped" | null;
  emailCopy: boolean;
  maySend: boolean;
  sendTo: string[];
  conversationId: string | null;
  createdAt: string;
}

export interface MemoryState {
  enabled: boolean;
  notes: MemoryNote[];
  maxNotes: number;
  maxLength: number;
}

/** Step 48: an outside calendar (Google, Outlook, any .ics link) the platform keeps in a calendar here. */
export interface CalendarSubscription {
  id: string;
  name: string;
  color: string | null;
  /** Only the host: the full address may carry a secret. */
  host: string;
  calendarId: string;
  refreshedAt: string | null;
  /** "feed_http_error:404", "events_failed:3", … */
  error: string | null;
  failures: number;
  /** Stopped after many failures; "Aktualisieren" starts it again. */
  paused: boolean;
}

/** Step 48: the secret link to one of the user's calendars, for Google or Outlook. */
export interface CalendarFeed {
  calendarId: string;
  mode: "full" | "busy";
  url: string;
  createdAt: string;
  lastFetchedAt: string | null;
}

// Whole paths, so the Lite build check (scripts/lite/lib.mjs) sees each one.
const CALENDAR_SUBSCRIPTIONS = "/api/calendar/subscriptions";
const CALENDAR_FEEDS = "/api/calendar/feeds";

export const xenaxio = {
  me: () => request<Me>("GET", "/api/me"),
  dismissHint: (hint: DismissableHint) => request<{ dismissedHints: string[] }>("POST", `/api/me/hints/${hint}`),
  // Step 48: calendars from Google, Outlook and others by link, both ways.
  calendarSubscriptions: () => request<{ subscriptions: CalendarSubscription[] }>("GET", CALENDAR_SUBSCRIPTIONS),
  addCalendarSubscription: (input: { url: string; name: string; color?: string | null }) =>
    request<{ subscription: CalendarSubscription }>("POST", CALENDAR_SUBSCRIPTIONS, input),
  updateCalendarSubscription: (id: string, patch: { name?: string; color?: string | null }) =>
    request<{ subscription: CalendarSubscription }>("PATCH", `${CALENDAR_SUBSCRIPTIONS}/${encodeURIComponent(id)}`, patch),
  removeCalendarSubscription: (id: string) => request<{ ok: true }>("DELETE", `${CALENDAR_SUBSCRIPTIONS}/${encodeURIComponent(id)}`),
  refreshCalendarSubscription: (id: string) => request<{ subscription: CalendarSubscription }>("POST", `${CALENDAR_SUBSCRIPTIONS}/${encodeURIComponent(id)}/refresh`),
  calendarFeeds: () => request<{ feeds: CalendarFeed[] }>("GET", CALENDAR_FEEDS),
  setCalendarFeed: (calendarId: string, mode: "full" | "busy") => request<{ feed: CalendarFeed }>("PUT", `${CALENDAR_FEEDS}/${encodeURIComponent(calendarId)}`, { mode }),
  rotateCalendarFeed: (calendarId: string) => request<{ feed: CalendarFeed }>("POST", `${CALENDAR_FEEDS}/${encodeURIComponent(calendarId)}/rotate`),
  removeCalendarFeed: (calendarId: string) => request<{ ok: true }>("DELETE", `${CALENDAR_FEEDS}/${encodeURIComponent(calendarId)}`),
  // Step 41: pictures. `kind` null = the signed-in person's own.
  avatars: () => request<{ avatars: { email: string; url: string }[] }>("GET", "/api/avatars"),
  uploadAvatar: (target: AvatarTarget, image: Blob) => request<{ avatarUrl: string }>("PUT", avatarPath(target), image),
  removeAvatar: (target: AvatarTarget) => request<{ avatarUrl: null }>("DELETE", avatarPath(target)),
  delivery: (emailId: string) => request<{ recipients: RecipientDelivery[] }>("GET", `/api/delivery?emailId=${encodeURIComponent(emailId)}`),
  mailApps: () => request<MailAppSettings>("GET", "/api/me/mail-apps"),
  memories: () => request<MemoryState>("GET", "/api/ai/memories"),
  addMemory: (text: string) => request<{ note: MemoryNote }>("POST", "/api/ai/memories", { text }),
  updateMemory: (id: string, text: string) => request<{ note: MemoryNote }>("PUT", `/api/ai/memories/${encodeURIComponent(id)}`, { text }),
  deleteMemory: (id: string) => request<{ ok: true }>("DELETE", `/api/ai/memories/${encodeURIComponent(id)}`),
  deleteAllMemories: () => request<{ ok: true }>("DELETE", "/api/ai/memories"),
  setMemoryEnabled: (enabled: boolean) => request<{ enabled: boolean }>("POST", "/api/ai/memories/settings", { enabled }),
  schedules: () => request<ScheduleList>("GET", "/api/ai/schedules"),
  pauseSchedule: (id: string) => request<{ schedule: ScheduleInfo }>("POST", `/api/ai/schedules/${encodeURIComponent(id)}/pause`),
  resumeSchedule: (id: string) => request<{ schedule: ScheduleInfo }>("POST", `/api/ai/schedules/${encodeURIComponent(id)}/resume`),
  runSchedule: (id: string) => request<{ started: true; conversationId: string }>("POST", `/api/ai/schedules/${encodeURIComponent(id)}/run`),
  deleteSchedule: (id: string) => request<{ ok: true }>("DELETE", `/api/ai/schedules/${encodeURIComponent(id)}`),
  /** Step 51: `mcpUrl` is the company's own address; `sharedMcpUrl` the shared one. */
  mcpTokens: () => request<{ mcpUrl: string; sharedMcpUrl?: string; enabled: boolean; tokens: McpTokenInfo[] }>("GET", "/api/me/mcp-tokens"),
  createMcpToken: (name: string, days: number) => request<{ token: string; mcpUrl: string; info: McpTokenInfo }>("POST", "/api/me/mcp-tokens", { name, days }),
  revokeMcpToken: (id: string) => request<{ ok: true }>("DELETE", `/api/me/mcp-tokens/${encodeURIComponent(id)}`),
  /** Step 9: consent screen for an AI chat connecting by OAuth; `query` is the authorization request. */
  oauthRequest: (query: string) =>
    request<{ clientName: string; redirectHost: string; loopback: boolean; address?: string }>("GET", `/api/oauth/authorize/info?${query.replace(/^\?/, "")}`),
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
  /** Step 42: the company's default background for everyone who has not picked their own. */
  setCompanyBackground: (background: string | null) => request<AdminPortal>("POST", "/api/admin/portal/background", { background }),
  /** Step 42: the person's own background; null follows the company's. */
  setMyBackground: (background: string | null) => request<{ background: string | null }>("POST", "/api/me/background", { background }),
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
  chatAdmin: () => request<ChatAdmin>("GET", "/api/admin/chat"),
  setChatAdmin: (enabled: boolean) => request<ChatAdmin>("PUT", "/api/admin/chat", { enabled }),
  setChatAi: (enabled: boolean) => request<ChatAdmin>("PUT", "/api/admin/chat/ai", { enabled }),
  aiAdmin: () => request<AiAdmin>("GET", "/api/admin/ai"),
  setAiAdmin: (change: { enabled?: boolean; model?: string; provider?: AiProvider }) => request<{ ok: true }>("POST", "/api/admin/ai", change),
  saveCustomModel: (input: CustomModelInput) => request<{ custom: CustomModel }>("PUT", "/api/admin/ai/custom", input),
  testCustomModel: (model?: string) => request<{ check: CustomModelCheck; custom: CustomModel | null }>("POST", "/api/admin/ai/custom/test", model ? { model } : {}),
  setActiveCustomModel: (model: string) => request<{ custom: CustomModel }>("POST", "/api/admin/ai/custom/active", { model }),
  setCustomModelFallback: (enabled: boolean) => request<{ custom: CustomModel }>("POST", "/api/admin/ai/custom/fallback", { enabled }),
  removeCustomModel: () => request<{ ok: true }>("DELETE", "/api/admin/ai/custom"),
  saveScheduleSettings: (settings: ScheduleSettings) => request<{ paused: number; schedules: ScheduleSettingsInfo }>("PUT", "/api/admin/ai/schedules", settings),
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
