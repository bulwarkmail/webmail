// Client for the xenaxio platform API (served under /api by the platform's BFF).
// The browser never talks to the mail server directly: the session lives in an
// httpOnly cookie that only the BFF can read (spec A1, A4).
import { apiFetch } from "@/lib/browser-navigation";
import type { AssistantDevice, AssistantPositions, AssistantSpot } from "@/lib/xenaxio/assistant-position";
import { tapStats } from "@/lib/xenaxio/stats";

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

/** Step 104: a moving profile picture and which part of it the circle shows (0–100). */
export interface AvatarAnimation {
  url: string;
  focusX: number;
  focusY: number;
}

/** Step 104: the own banner picture: still, moving (if any), and where the 3:1 strip sits on it. */
export interface BannerImage {
  url: string;
  animatedUrl: string | null;
  focusX: number;
  focusY: number;
}

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
  /** Step 96: kind "chat" — a person without a mailbox (XenRooms only). */
  user: { id: string; email: string; displayName: string; role: "user" | "admin"; mustChangePassword: boolean; kind?: "mailbox" | "chat" };
  /** Step 96: product "rooms" — a company without email (XenRooms). */
  tenant: {
    id: string;
    name: string;
    status: "onboarding" | "active" | "blocked";
    product?: "workspace" | "rooms";
    /** Step 103: XenRooms Free or paid (null for Xenaxio). */
    plan?: "free" | "paid" | null;
  };
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
  /** Step 61: where the person put the assistant button, per kind of screen (shares of the window). */
  assistantPosition?: AssistantPositions;
  /** Step 73: a live-demo guest's time and the ways to go on from the demo. */
  demo?: DemoInfo | null;
}

/** Step 73: the live demo (null outside it). */
export interface DemoInfo {
  expiresAt: string;
  extendable: boolean;
  links: { site: string; quote: string; book: string | null };
}

/** Hints of the web client a user can close for good (the platform's list). */
/** Step 64: also "Don't remind me again" on the install and notification cards. */
export type DismissableHint = "welcome" | "pwa-install" | "push-prompt";

/** Step 29: an account signed in in this browser; `portalUrl` is where it opens. */
export interface BrowserAccount {
  userId: string;
  email: string;
  displayName: string;
  company: string;
  portalUrl: string;
  active: boolean;
  /** Step 67: the company's colour and logo for the XenRooms switcher. */
  color?: string | null;
  logoUrl?: string | null;
  /** Step 113: the background the admin chose for the app icon, behind the logo; null = white. */
  iconBackground?: string | null;
}

/** Step 67: unread counts of the browser's other accounts (XenRooms switcher). */
export interface AccountUnread {
  userId: string;
  /** Rooms with anything unread. */
  unread: number;
  /** Mentions and direct messages: the red count. */
  important: number;
  available: boolean;
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
/** Step 103: the Umami website this address counts its visits in (none on-prem). */
export interface PortalStats {
  stats?: { websiteId: string; product: "xenaxio" | "xenrooms" };
}

export type PortalState =
  | ({ kind: "tenant" } & PortalInfo & PortalStats)
  | ({ kind: "app"; portals: boolean; baseDomain: string | null } & PortalStats)
  /** Step 67: XenRooms (only the team chat), one address for every company. */
  | ({ kind: "rooms" } & PortalStats)
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
  /** Step 108: blocked by Xenaxio; the admin cannot lift it. */
  blockedByOperator?: boolean;
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

/** Step 63: a channel of the company as its admin manages it. */
export interface ChatChannelAdmin {
  roomId: string;
  name: string | null;
  topic: string | null;
  isPublic: boolean;
  archived: boolean;
  /** People in the channel (not integrations or the platform). */
  members: number;
  /** False: no active moderator could hand the channel to the platform. */
  managed: boolean;
  external: boolean;
  /** The company's "Alle" (cannot be archived). */
  general: boolean;
  /** Step 109: the channel's background (a code of lib/xenaxio/backgrounds.ts), or none. */
  background?: string | null;
  backgroundImage?: string | null;
}

/** Step 63; step 99 adds description, privacy, who writes and who may @channel; step 109 the background (null removes it). */
export type ChatChannelChange = { name?: string; topic?: string; archived?: boolean; description?: string; isPublic?: boolean; posting?: "everyone" | "managers"; channelMentions?: "everyone" | "managers"; background?: string | null; backgroundImage?: string | null };

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
  /** Step 83: how much the model takes at once, in tokens (absent on older servers). */
  contextTokens?: number;
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
  /** Step 83: steps and input tokens per answer (null: the default); they apply on the Xenacore engine. */
  answers?: AnswerSettings;
  /** Step 84: which model each profile uses (missing: the company's model). */
  profiles?: { map: Partial<Record<ModelProfile, string>>; options: string[]; names: ModelProfile[] };
  /** Step 86: how audio files are transcribed (absent: not on this installation). */
  transcription?: { mode: TranscriptionMode; platformModel: string | null; customModel: string | null; ownServer?: SpeechServerSettings | null };
  users: { id: string; email: string; displayName: string; status: "active" | "disabled"; aiEnabled: boolean; tokens: number }[];
}

/** Step 84: model profiles for flows and agents. */
export type ModelProfile = "fast" | "vision" | "smart";

/** Step 84: a skill of the company or of the user (SKILL.md). */
export interface SkillItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
}
export interface SkillVersionInfo {
  version: number;
  name: string;
  description: string;
  createdAt: string;
}
export interface SkillSummary {
  name: string;
  description: string;
}
export type SkillInput = { name: string; description: string; body: string } | { file: string };
/** The same calls for the company's skills (admin) and the user's own. */
export interface SkillApi {
  base: string;
  get(id: string): Promise<{ skill: SkillItem & { body: string } }>;
  create(input: SkillInput): Promise<{ skill: SkillItem }>;
  update(id: string, input: SkillInput): Promise<{ skill: SkillItem }>;
  setEnabled(id: string, enabled: boolean): Promise<{ skill: SkillItem }>;
  remove(id: string): Promise<{ ok: true }>;
  versions(id: string): Promise<{ versions: SkillVersionInfo[] }>;
  restore(id: string, version: number): Promise<{ skill: SkillItem }>;
  /** Address of the SKILL.md download. */
  fileUrl(id: string): string;
}
function skillApi(base: string): SkillApi {
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    base,
    get: (id) => request("GET", one(id)),
    create: (input) => request("POST", base, input),
    update: (id, input) => request("PUT", one(id), input),
    setEnabled: (id, enabled) => request("POST", `${one(id)}/enabled`, { enabled }),
    remove: (id) => request("DELETE", one(id)),
    versions: (id) => request("GET", `${one(id)}/versions`),
    restore: (id, version) => request("POST", `${one(id)}/restore`, { version }),
    fileUrl: (id) => `${one(id)}/file`,
  };
}
/** Step 86: the platform's speech model, one on the company's own server, or off. */
export type TranscriptionMode = "xenaxio" | "custom" | "own_server" | "off";

/** Step 90, part F: the installation's models as the operator sees them (the deploy's values in fromConfig). */
export interface InstallationModels {
  platformKey: boolean;
  chat: { model: string; models: string[]; fromConfig: { model: string; models: string[] } };
  speech:
    | { source: "mistral"; model: string; fromConfig: string }
    | { source: "own"; baseUrl: string; profile: "openai" | "mistral"; model: string; hasKey: boolean; fromConfig: string };
  updatedAt: string | null;
}

/** Step 90, part E: the company's own speech server (its own connection, not the chat model's). */
export interface SpeechServerCheck {
  ok: boolean;
  error: "address_not_allowed" | "unreachable" | "timeout" | "unauthorized" | "model_not_found" | "bad_response" | null;
  status: number | null;
  ms: number | null;
  text: string | null;
}
export interface SpeechServerSettings {
  baseUrl: string;
  profile: "openai" | "mistral";
  model: string;
  hasKey: boolean;
  check: SpeechServerCheck | null;
  checkedAt: string | null;
}

export const companySkills = skillApi("/api/admin/ai/skills");
export const ownSkills = skillApi("/api/ai/skills");

/** Step 83: how far the assistant may go in one answer. */
export interface AnswerSettings {
  engine: "classic" | "xenacore";
  maxToolCalls: number | null;
  inputTokens: number | null;
  defaults: { toolCalls: number; inputTokens: number };
  caps: { toolCalls: { min: number; max: number }; inputTokens: { min: number; max: number } };
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

/** Step 100: what one run of a task did (companies on Xenacore): outcome, tools, counts; no content. */
export interface ScheduleRun {
  startedAt: string;
  endedAt: string | null;
  status: "running" | "waiting" | "done" | "failed";
  waitingFor?: string;
  tools: string[];
  confirmed: number;
  declined: number;
  inputTokens: number;
  outputTokens: number;
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
  /** Step 96/97: a company without email (XenRooms) and its plan. */
  product?: "workspace" | "rooms";
  plan?: "free" | "paid" | null;
  /** Free: chat with other companies opens then (null: open). */
  federationAfter?: string | null;
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
  /** Step 82: the agent engine of the company's assistant. */
  aiEngine?: "classic" | "xenacore";
  /** Step 17: the company's subdomain and portal. */
  slug: string | null;
  portalUrl: string | null;
  hostname: string | null;
  /** Step 78: meetings allowed, and the company's own limits (null: the installation's default). */
  meetingsAllowed?: boolean;
  meetingsMaxParticipants?: number | null;
  meetingsMaxHours?: number | null;
  /** Step 79: webinars (only on a media server of its own) and their viewers (null: the installation's default). */
  webinarsAllowed?: boolean;
  /** Step 90: recording meetings allowed for the company. */
  meetingsRecordingAllowed?: boolean;
  webinarsMaxViewers?: number | null;
  /** Step F1: Xenaxio Agent Flows switched on by the operator. */
  flowsEnabled?: boolean;
}

export interface OperatorReport {
  month: string;
  tenants: { id: string; name: string; domain: string | null; status: string; mailUsers: number; aiWorkspaceUsers: number; aiTokens: number }[];
}

/** Step 108: the people of the installation for the operator console. */
export interface OperatorPeopleSummary {
  people: number;
  accounts: number;
  workspacePeople: number;
  roomsPeople: number;
  new7: number;
  new30: number;
  active7: number;
  active30: number;
  neverSignedIn: number;
  disabledAccounts: number;
  /** Step 108: blocked by the operator. */
  operatorBlockedAccounts?: number;
  companies: number;
  workspaceCompanies: number;
  roomsFreeCompanies: number;
  roomsPaidCompanies: number;
  freeSignups7: number;
  freeSignups30: number;
}

export interface OperatorPersonAccount {
  userId: string;
  tenantId: string;
  company: string;
  slug: string | null;
  product: "workspace" | "rooms";
  plan: "free" | "paid" | null;
  companyStatus: string;
  role: "user" | "admin";
  kind: "mailbox" | "chat";
  status: "active" | "disabled";
  invited: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  /** Step 108, part B: blocked by the operator, with the reason. */
  operatorBlockedAt?: string | null;
  operatorBlockReason?: string | null;
}

export interface OperatorPersonRow {
  email: string;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  accounts: OperatorPersonAccount[];
}

export interface OperatorPerson {
  email: string;
  name: string;
  accounts: OperatorPersonAccount[];
  devices: { company: string; browser: string | null; os: string | null; signedInAt: string; lastSeenAt: string }[];
  lastLogin: { at: string; ip: string | null; country: string | null } | null;
  /** Step 108, part B: the address (or its domain) may not sign up or be invited. */
  signupBlocked?: boolean;
}

/** Step 108, part B: an address or mail domain that may not sign up or be invited. */
export interface BlockedSignup {
  id: string;
  kind: "email" | "domain";
  value: string;
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Step 108, part D: what the operator did. */
export interface OperatorAction {
  id: string;
  operator: string;
  action: "person_blocked" | "person_unblocked" | "signup_blocked" | "signup_allowed" | string;
  email: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorPeopleFilter {
  q?: string;
  product?: "workspace" | "rooms";
  plan?: "free" | "paid";
  role?: "user" | "admin";
  status?: "active" | "disabled" | "operator_blocked";
  inactiveDays?: number;
  sort?: "created" | "seen" | "name" | "email";
  page?: number;
}

/** Query string of a filter of the operator console (empty values left out). */
export function peopleQuery(f: OperatorPeopleFilter | GalleryFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(f as Record<string, unknown>)) if (value !== undefined && value !== "" && value !== null) params.set(key, String(value));
  const q = params.toString();
  return q ? `?${q}` : "";
}

/** Step 108, part C: a picture people upload that others see. */
export type GalleryKind = "avatar" | "banner" | "logo" | "meeting_background" | "emoji";

export interface GalleryImage {
  kind: GalleryKind;
  ref: string;
  tenantId: string;
  company: string;
  slug: string | null;
  product: "workspace" | "rooms";
  plan: "free" | "paid" | null;
  owner: { userId: string | null; email: string | null; name: string | null; kind: "person" | "shared_mailbox" | "resource" | "company" };
  contentType: string;
  animated: boolean;
  version: string;
  reviewed: boolean;
  /** Part C3: our model's score of this version (0–1), when it ran. */
  score?: number | null;
}

export interface HiddenImage {
  id: string;
  kind: GalleryKind;
  ref: string;
  tenantId: string;
  company: string;
  ownerEmail: string | null;
  contentType: string;
  reason: string;
  hiddenAt: string;
  hiddenBy: string | null;
  deletesAt: string;
}

export interface GalleryFilter {
  status?: "new" | "all";
  kind?: GalleryKind;
  plan?: "free" | "paid";
  product?: "workspace" | "rooms";
  q?: string;
  page?: number;
  /** Part C3: the likely problems first. */
  sort?: "new" | "score";
}

/** Step 108, part C3: a chat picture our own model flagged: only a preview, the company and the time. */
export interface ChatImageFlag {
  id: string;
  tenantId: string;
  company: string;
  plan: "free" | "paid" | null;
  product: "workspace" | "rooms";
  score: number;
  createdAt: string;
  /** The message is known and can be removed for everyone. */
  removable: boolean;
}

export function chatImagePreviewUrl(id: string): string {
  return `/api/operator/chat-images/${encodeURIComponent(id)}/preview`;
}

/** The picture for the operator's eyes (the platform answers only to the operator). */
export function galleryImageUrl(kind: GalleryKind, ref: string, animated = false): string {
  return `/api/operator/images/${kind}/content?ref=${encodeURIComponent(ref)}${animated ? "&animated=1" : ""}`;
}

export function hiddenImageUrl(id: string, animated = false): string {
  return `/api/operator/images/hidden/${encodeURIComponent(id)}/content${animated ? "?animated=1" : ""}`;
}

/** Step 96: a person of a company without email (XenRooms). */
export interface RoomsPerson {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  /** Invited, no password set yet. */
  invited: boolean;
  chatAddress: string | null;
  createdAt: string;
  /** Step 108: blocked by Xenaxio; the admin cannot lift it. */
  blockedByOperator?: boolean;
  /** Step 110: the AI for this person (paid XenRooms). */
  aiEnabled?: boolean;
}

/** Step 97: XenRooms Free or paid, the limits and the space used. */
export interface RoomsPlanInfo {
  plan: "free" | "paid" | null;
  maxPeople: number | null;
  storageBytes: number | null;
  usedBytes: number;
  federationAfter: string | null;
}

/** Step 96: an invitation or password reset link of XenRooms. */
export interface RoomsLinkInfo {
  status: "valid" | "used" | "expired" | "unknown";
  email?: string;
  company?: string;
  displayName?: string;
  /** Step 96, part D: "mailbox" when the company moved to Xenaxio (sign-in with mail afterwards). */
  kind?: "mailbox" | "chat";
}

export interface Invitation {
  id: string;
  /** Step 96: "rooms" — a company without email (XenRooms). */
  product?: "workspace" | "rooms";
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt?: string | null;
  tenantName: string | null;
}

/** Step 85: what the AI may do with a tool (like the per-tool permissions in Claude). */
export type ToolLevel = "allow" | "ask" | "deny";

/** Step 85: one row of the page "KI-Berechtigungen". */
export interface ToolPermission {
  name: string;
  group: string;
  kind: "read" | "write-safe" | "write-confirm" | "send";
  /** Offered in the side panel (and scheduled tasks), to outside AI chats, or both. */
  where: "panel" | "mcp" | "both";
  choices: ToolLevel[];
  defaultLevel: ToolLevel;
  choice: ToolLevel | null;
  /** The company's limit; null: none. */
  ceiling: ToolLevel | null;
  level: ToolLevel;
}

export interface ToolPermissionPage {
  tools: ToolPermission[];
  groups: string[];
  /** Who confirms "ask" tools for outside AI chats: the AI chat itself or the user in Xenaxio. */
  externalConfirm: "client" | "app";
}

export interface ToolCeilingPage {
  groups: string[];
  tools: { name: string; kind: ToolPermission["kind"]; where: ToolPermission["where"]; group: string }[];
  ceilings: { scope: string; level: "ask" | "deny" }[];
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

/** Step 36: a note the assistant keeps about the user. Step 91: a fact it keeps itself (Xenacore). */
export interface MemoryNote {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** Step 91: who or what it is about; absent: the user. */
  subject?: string;
  kind?: "person" | "work" | "episode";
  /** user: the person said it; data: taken from an email, file or chat. */
  trust?: "user" | "data";
  source?: { type: "chat" | "mail" | "file" | "run" | "page"; id?: string };
  /** Last day it holds (YYYY-MM-DD). */
  validUntil?: string;
  level?: "user" | "company";
}

/** Step 91: what the user or the admin writes as a fact. */
export interface MemoryInput {
  text: string;
  subject?: string;
  validUntil?: string | null;
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
  /** Step 91: the company's facts, read-only for staff (absent on older servers). */
  company?: MemoryNote[];
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
/** Step F1.1: flows of the employee. */
const FLOW = "/api/flows";

/** Step F1: Xenaxio Agent Flows. */
export type FlowTexts = string | Record<string, string>;
export interface FlowParamDef {
  type: string;
  default?: unknown;
  values?: string[];
  required?: boolean;
  label?: FlowTexts;
  note?: FlowTexts;
}
export interface FlowDirectoryDef {
  label?: FlowTexts;
  fields: Record<string, unknown>;
  key?: string;
}
export interface FlowTemplateInfo {
  flow: string;
  version: number;
  title?: FlowTexts;
  description?: FlowTexts;
  params: Record<string, FlowParamDef>;
  directories: Record<string, FlowDirectoryDef>;
}
/** Step F1.1: an employee of the company (owner or person of a flow). */
export interface FlowEmployee {
  id: string;
  name: string;
  email: string;
}
export interface FlowInstallation {
  id: string;
  flow: string;
  version: number;
  /** The name its owners gave it. */
  title: string;
  templateTitle: FlowTexts | null;
  params: Record<string, unknown>;
  paramDefs: Record<string, FlowParamDef>;
  directories: Record<string, FlowDirectoryDef>;
  language: string;
  status: "active" | "paused";
  sendsPerHour: number;
  botName: string | null;
  hasBot: boolean;
  createdAt: string;
  owners: FlowEmployee[];
}
/** Step F1.1: a person of one flow — an employee (userId) or someone only in Telegram. */
export interface FlowPerson {
  id: string;
  name: string;
  language: string | null;
  userId: string | null;
  linked: boolean;
}
/** Stage E2 (B1): a connection to an outside API the template names; the key is never sent back. */
export interface FlowConnection {
  name: string;
  label: FlowTexts | null;
  note: FlowTexts | null;
  hosts: string[];
  /** Stage E2 (B2): an outside API, or an MCP server whose tools the flow calls. */
  kind: "http" | "mcp";
  auth: "none" | "api_key" | "basic" | "bearer" | "oauth2";
  baseUrl: string | null;
  hasSecret: boolean;
}
export interface FlowDetail extends FlowInstallation {
  people: FlowPerson[];
  connections: FlowConnection[];
}
export interface FlowRunSummary {
  id: string;
  number: string;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  result: string | null;
  step: string;
  waiting: string | null;
  /** Stage E2, part C: the run (or one of its branches) waits for my decision or confirmation. */
  waitingForMe?: boolean;
  /** Started by me or waiting for me. */
  mine?: boolean;
  initiator: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Stage E2, part C: a document of a run (an invoice, a photo from Telegram). */
export interface FlowFile {
  n: number;
  name: string;
  mimeType: string;
  size: number | null;
}
export interface FlowRunDetail extends FlowRunSummary {
  flowId: string;
  card: Record<string, unknown>;
  branches: (FlowRunSummary & { card: Record<string, unknown> })[];
  journal: FlowJournalEntry[];
  files: FlowFile[];
}
/** Stage E2, part C: a decision or confirmation waiting for me ("Wartet auf mich"). */
export interface FlowTask {
  key: string;
  flowId: string;
  flowTitle: string;
  runId: string;
  runNumber: string;
  kind: "decide" | "confirm";
  title: string;
  text: string;
  show: Record<string, unknown>;
  /** `comment`: the option needs a text (a question back, a correction). */
  options: { id: string; label: string; comment: boolean }[];
  askedAt: string;
}
export interface FlowJournalEntry {
  runId: string;
  at: string;
  step?: string;
  actor: { kind: "engine" | "person" | "rule" | "model"; id?: string };
  what: string;
  detail?: Record<string, unknown>;
}
/** Step F1.1: the Flows section of an employee (the admin may ask for all flows of the company). */
export interface FlowsOverview {
  enabled: boolean;
  admin: boolean;
  templates: FlowTemplateInfo[];
  installations: FlowInstallation[];
  /** Stage E2, part C: flows I work in as a person (their runs, not their settings). */
  working?: { id: string; flow: string; title: string; status: "active" | "paused" }[];
  employees: FlowEmployee[];
  /** Shared mailboxes this employee may send from: the only ones their flows may write from. */
  mailboxes: { id: string; email: string }[];
}
/** The admin's page: how long journals stay, and every flow of the company. */
export interface FlowsAdminOverview {
  enabled: boolean;
  journalYears: number;
  installations: FlowInstallation[];
}

/** Step 86: the text of an audio file. */
export interface FileTranscript {
  text: string;
  language: string | null;
  manual: boolean;
  model: string;
  audioSeconds: number;
  updatedAt: string;
}

/** Why this person cannot transcribe now. */
export type TranscriptionUnavailable = "ai_disabled" | "transcription_off" | "ai_not_configured" | "transcription_model_missing" | "speech_server_missing" | "ai_limit_reached";

export interface TranscriptLookup {
  available: boolean;
  reason?: TranscriptionUnavailable;
  maxBytes: number;
  /** By file id; colleagues' files as "<account>:<id>". */
  transcripts: Record<string, FileTranscript>;
}

export const xenaxio = {
  me: () => request<Me>("GET", "/api/me"),
  lookupTranscripts: (files: { id: string; accountId?: string }[]) => request<TranscriptLookup>("POST", "/api/files/transcripts/lookup", { files }),
  transcribe: (file: { id: string; accountId?: string; language?: string }) => request<{ id: string; transcript: FileTranscript }>("POST", "/api/files/transcripts", file),
  /** Step 73: a demo company for this guest (or the one this browser already has). */
  demoStart: (locale: string) => request<Me & { portalUrl: string; demo: DemoInfo }>("POST", "/api/demo/start", { locale: locale === "de" ? "de" : "en" }),
  demoExtend: () => request<DemoInfo>("POST", "/api/demo/extend"),
  demoEnd: () => request<{ ok: true; links: DemoInfo["links"] }>("POST", "/api/demo/end"),
  /** Step 73c: "keep in touch" before the demo ends (a lead for our sales). */
  demoLead: (lead: { first_name: string; last_name: string; email: string; company: string; message?: string; consent: boolean }) =>
    request<{ ok: true }>("POST", "/api/demo/lead", lead),
  dismissHint: (hint: DismissableHint) => request<{ dismissedHints: string[] }>("POST", `/api/me/hints/${hint}`),
  /** Step 61: the assistant button moved on this kind of screen; null puts it back. */
  setAssistantPosition: (device: AssistantDevice, spot: AssistantSpot | null) =>
    request<{ assistantPosition: AssistantPositions }>("POST", "/api/me/assistant-position", spot ? { device, x: spot.x, y: spot.y } : { device, reset: true }),
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
  // Step 104: a moving picture over the still one (sent just before); x, y — the part shown.
  uploadAvatarAnimation: (target: AvatarTarget, image: Blob, focus: { x: number; y: number }) =>
    request<{ animation: AvatarAnimation }>("PUT", `${avatarPath(target)}/animated?x=${Math.round(focus.x)}&y=${Math.round(focus.y)}`, image),
  // Step 104: the own banner picture; the admin removes an employee's.
  uploadBanner: (image: Blob) => request<{ bannerImage: BannerImage }>("PUT", "/api/me/banner", image),
  uploadBannerAnimation: (image: Blob, focus: { x: number; y: number }) =>
    request<{ bannerImage: BannerImage }>("PUT", `/api/me/banner/animated?x=${Math.round(focus.x)}&y=${Math.round(focus.y)}`, image),
  removeBanner: () => request<{ bannerImage: null }>("DELETE", "/api/me/banner"),
  removeUserBanner: (userId: string) => request<{ bannerImage: null }>("DELETE", `/api/admin/users/${encodeURIComponent(userId)}/banner`),
  delivery: (emailId: string) => request<{ recipients: RecipientDelivery[] }>("GET", `/api/delivery?emailId=${encodeURIComponent(emailId)}`),
  mailApps: () => request<MailAppSettings>("GET", "/api/me/mail-apps"),
  memories: () => request<MemoryState>("GET", "/api/ai/memories"),
  addMemory: (input: MemoryInput) => request<{ note: MemoryNote }>("POST", "/api/ai/memories", input),
  updateMemory: (id: string, input: MemoryInput) => request<{ note: MemoryNote }>("PUT", `/api/ai/memories/${encodeURIComponent(id)}`, input),
  // Step 91: the company's facts ("Firmenwissen"), admin only.
  companyMemories: () => request<{ notes: MemoryNote[]; maxNotes: number; maxLength: number }>("GET", "/api/admin/ai/memories"),
  addCompanyMemory: (input: MemoryInput) => request<{ note: MemoryNote }>("POST", "/api/admin/ai/memories", input),
  updateCompanyMemory: (id: string, input: MemoryInput) => request<{ note: MemoryNote }>("PUT", `/api/admin/ai/memories/${encodeURIComponent(id)}`, input),
  deleteCompanyMemory: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/ai/memories/${encodeURIComponent(id)}`),
  deleteMemory: (id: string) => request<{ ok: true }>("DELETE", `/api/ai/memories/${encodeURIComponent(id)}`),
  deleteAllMemories: () => request<{ ok: true }>("DELETE", "/api/ai/memories"),
  setMemoryEnabled: (enabled: boolean) => request<{ enabled: boolean }>("POST", "/api/ai/memories/settings", { enabled }),
  schedules: () => request<ScheduleList>("GET", "/api/ai/schedules"),
  pauseSchedule: (id: string) => request<{ schedule: ScheduleInfo }>("POST", `/api/ai/schedules/${encodeURIComponent(id)}/pause`),
  resumeSchedule: (id: string) => request<{ schedule: ScheduleInfo }>("POST", `/api/ai/schedules/${encodeURIComponent(id)}/resume`),
  runSchedule: (id: string) => request<{ started: true; conversationId: string }>("POST", `/api/ai/schedules/${encodeURIComponent(id)}/run`),
  /** Step 100: the last runs of a task. */
  scheduleRuns: (id: string) => request<{ runs: ScheduleRun[] }>("GET", `/api/ai/schedules/${encodeURIComponent(id)}/runs`),
  deleteSchedule: (id: string) => request<{ ok: true }>("DELETE", `/api/ai/schedules/${encodeURIComponent(id)}`),
  // Step 85: per-tool permissions of the AI, and the company's ceiling.
  toolPermissions: () => request<ToolPermissionPage>("GET", "/api/ai/permissions"),
  setToolPermission: (tool: string, level: ToolLevel | null) => request<ToolPermissionPage>("PUT", `/api/ai/permissions/tools/${encodeURIComponent(tool)}`, { level }),
  setExternalConfirm: (confirm: "client" | "app") => request<ToolPermissionPage>("PUT", "/api/ai/permissions/external", { confirm }),
  resetToolPermissions: () => request<ToolPermissionPage>("DELETE", "/api/ai/permissions"),
  toolCeilings: () => request<ToolCeilingPage>("GET", "/api/admin/ai/permissions"),
  setToolCeiling: (scope: string, level: "ask" | "deny" | null) => request<ToolCeilingPage>("PUT", "/api/admin/ai/permissions", { scope, level }),
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
    }).then(tapStats("sign-in")),
  /** Step 17: whose address this is (no sign-in needed). */
  portal: () => request<PortalState>("GET", "/api/portal"),
  /** Step 17: a one-time link that moves the session to the company portal (or `next` when already there). */
  handoff: (next: string) => request<{ url: string }>("POST", "/api/auth/handoff", { next }),
  /** Step 29: the next account takes over at `url` (null when nobody is left); `all` signs everyone out. */
  logout: (opts: { all?: boolean; next?: string } = {}) => request<{ ok: true; url: string | null }>("POST", "/api/auth/logout", opts).then(tapStats("sign-out")),
  /** Step 29: the accounts signed in in this browser, the active one first. */
  accounts: () => request<{ accounts: BrowserAccount[]; max: number }>("GET", "/api/auth/accounts"),
  switchAccount: (userId: string, next: string) => request<{ url: string }>("POST", "/api/auth/switch", { userId, next }).then(tapStats("account-switch")),
  forgetAccount: (userId: string) => request<{ ok: true }>("POST", "/api/auth/forget", { userId }),
  /** Step 67: unread counts of the other accounts of this browser. */
  accountsUnread: () => request<{ accounts: AccountUnread[] }>("GET", "/api/chat/accounts/unread"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("POST", "/api/me/password", { currentPassword, newPassword }),

  // --- Step 96: XenRooms without email ---
  roomsInvitation: (token: string) =>
    request<{ status: "valid" | "used" | "expired" | "unknown"; product: "workspace" | "rooms" | null; domain: string | null }>("GET", `/api/rooms/onboarding?token=${encodeURIComponent(token)}`),
  roomsSlug: (token: string, q: { name?: string; slug?: string }) => {
    const params = new URLSearchParams({ token });
    if (q.name) params.set("name", q.name);
    if (q.slug !== undefined) params.set("slug", q.slug);
    return request<{ domain: string; suggestion: string | null; slug?: string; problem?: SlugProblem | null }>("GET", `/api/rooms/onboarding/slug?${params}`);
  },
  roomsOnboard: (input: { token: string; companyName: string; slug: string; adminName: string; email: string; password: string; locale: "de" | "en"; chatDomain?: string }) =>
    request<Me>("POST", "/api/rooms/onboarding", input).then(tapStats("invitation-accepted")),
  roomsLink: (kind: "invite" | "reset", token: string) => request<RoomsLinkInfo>("GET", `/api/rooms/link?kind=${kind}&token=${encodeURIComponent(token)}`),
  roomsUseLink: (kind: "invite" | "reset", token: string, password: string, locale?: string) =>
    request<Me>("POST", "/api/rooms/link", { kind, token, password, ...(locale === "de" || locale === "en" ? { locale } : {}) }).then(kind === "invite" ? tapStats("invitation-accepted") : (me) => me),
  roomsForgot: (email: string) => request<{ ok: true }>("POST", "/api/rooms/password/forgot", { email }),
  roomsPeople: () => request<{ people: RoomsPerson[]; limit: number | null; chatDomain: string | null; plan?: RoomsPlanInfo | null }>("GET", "/api/admin/rooms/people"),
  // --- Step 97: sign-up without the operator (XenRooms Free) ---
  roomsSignupOpen: () => request<{ open: boolean; domain: string | null }>("GET", "/api/rooms/signup"),
  roomsSignupSlug: (q: { name?: string; slug?: string }) => {
    const params = new URLSearchParams();
    if (q.name) params.set("name", q.name);
    if (q.slug !== undefined) params.set("slug", q.slug);
    return request<{ domain: string; suggestion: string | null; slug?: string; problem?: SlugProblem | null }>("GET", `/api/rooms/signup/slug?${params}`);
  },
  roomsSignup: (input: { displayName: string; email: string; companyName: string; slug: string; password: string; locale: "de" | "en"; homepage?: string }) =>
    request<{ ok: true }>("POST", "/api/rooms/signup", input).then(tapStats("signup-start")),
  roomsSignupInfo: (token: string) =>
    request<{ status: "valid" | "used" | "expired" | "unknown"; email?: string; company?: string }>("GET", `/api/rooms/signup/confirm?token=${encodeURIComponent(token)}`).then(
      (info) => (info.status === "valid" ? tapStats<typeof info>("signup-verified")(info) : info),
    ),
  roomsSignupConfirm: (token: string) => request<Me>("POST", "/api/rooms/signup/confirm", { token }).then(tapStats("signup-done")),
  roomsInvite: (input: { email: string; displayName: string; role?: "user" | "admin" }) => request<RoomsPerson>("POST", "/api/admin/rooms/people", input),
  roomsResend: (id: string) => request<{ ok: true }>("POST", `/api/admin/rooms/people/${encodeURIComponent(id)}/resend`, {}),
  roomsSetStatus: (id: string, status: "active" | "disabled") => request<RoomsPerson>("POST", `/api/admin/rooms/people/${encodeURIComponent(id)}/status`, { status }),
  roomsRemove: (id: string) => request<{ ok: true }>("DELETE", `/api/admin/rooms/people/${encodeURIComponent(id)}`),

  /** Step 108, part C3: pictures in the company's chat checked by Xenaxio's own model. */
  imageCheck: () => request<{ enabled: boolean; forced: boolean; available: boolean }>("GET", "/api/admin/image-check"),
  setImageCheck: (enabled: boolean) => request<{ enabled: boolean; forced: boolean; available: boolean }>("PUT", "/api/admin/image-check", { enabled }),

  invitationStatus: (token: string) =>
    request<{ status: "valid" | "used" | "expired" | "unknown" }>("GET", `/api/onboarding/invitation?token=${encodeURIComponent(token)}`),
  onboard: (input: { token: string; companyName: string; domain: string; adminName: string; adminLocalPart: string; password: string; slug?: string }) =>
    request<Me & { portalUrl: string }>("POST", "/api/onboarding", input).then(tapStats("invitation-accepted")),
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
  /** Step 101: the person's own name (portal, colleagues, Rooms, sender name). */
  setMyName: (displayName: string) => request<{ displayName: string }>("POST", "/api/me/name", { displayName }),
  /** Step 101: the company's admin changes an employee's (or a XenRooms person's) name. */
  setUserName: (userId: string, displayName: string) => request<{ id: string; displayName: string }>("POST", `/api/admin/users/${encodeURIComponent(userId)}/name`, { displayName }),
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
  /** Step 63: every channel of the company, and changing one as the company admin. */
  chatChannels: () => request<{ channels: ChatChannelAdmin[] }>("GET", "/api/admin/chat/channels"),
  changeChatChannel: (roomId: string, change: ChatChannelChange) => request<ChatChannelAdmin>("PATCH", `/api/admin/chat/channels/${encodeURIComponent(roomId)}`, change),
  aiAdmin: () => request<AiAdmin>("GET", "/api/admin/ai"),
  setAiAdmin: (change: { enabled?: boolean; model?: string; provider?: AiProvider }) => request<{ ok: true }>("POST", "/api/admin/ai", change),
  setTranscription: (change: { mode: TranscriptionMode; model?: string | null }) =>
    request<{ mode: TranscriptionMode; customModel: string | null }>("PUT", "/api/admin/ai/transcription", change),
  // Step 90, part E: the own speech server; a key left out keeps the stored one.
  saveSpeechServer: (input: { baseUrl: string; profile: "openai" | "mistral"; model: string; apiKey?: string | null }) =>
    request<SpeechServerSettings>("PUT", "/api/admin/ai/speech-server", input),
  testSpeechServer: () => request<{ result: SpeechServerCheck; settings: SpeechServerSettings }>("POST", "/api/admin/ai/speech-server/test"),
  removeSpeechServer: () => request<{ ok: true }>("DELETE", "/api/admin/ai/speech-server"),
  saveCustomModel: (input: CustomModelInput) => request<{ custom: CustomModel }>("PUT", "/api/admin/ai/custom", input),
  testCustomModel: (model?: string) => request<{ check: CustomModelCheck; custom: CustomModel | null }>("POST", "/api/admin/ai/custom/test", model ? { model } : {}),
  setActiveCustomModel: (model: string) => request<{ custom: CustomModel }>("POST", "/api/admin/ai/custom/active", { model }),
  setCustomModelFallback: (enabled: boolean) => request<{ custom: CustomModel }>("POST", "/api/admin/ai/custom/fallback", { enabled }),
  removeCustomModel: () => request<{ ok: true }>("DELETE", "/api/admin/ai/custom"),
  // Step 84: skills and model profiles.
  adminSkills: () => request<{ company: SkillItem[]; platform: (SkillSummary & { enabled: boolean })[]; max: number }>("GET", "/api/admin/ai/skills"),
  setPlatformSkill: (name: string, enabled: boolean) => request<{ platform: (SkillSummary & { enabled: boolean })[] }>("PUT", `/api/admin/ai/platform-skills/${encodeURIComponent(name)}`, { enabled }),
  mySkills: () => request<{ own: SkillItem[]; company: SkillSummary[]; platform: SkillSummary[]; max: number }>("GET", "/api/ai/skills"),
  saveModelProfiles: (map: Partial<Record<ModelProfile, string | null>>) => request<{ map: Partial<Record<ModelProfile, string>> }>("PUT", "/api/admin/ai/profiles", map),
  saveAnswerSettings: (settings: { maxToolCalls: number | null; inputTokens: number | null }) => request<{ maxToolCalls: number | null; inputTokens: number | null }>("PUT", "/api/admin/ai/answers", settings),
  setCustomModelContext: (contextTokens: number | null) => request<{ custom: CustomModel }>("PUT", "/api/admin/ai/custom/context", { contextTokens }),
  saveScheduleSettings: (settings: ScheduleSettings) => request<{ paused: number; schedules: ScheduleSettingsInfo }>("PUT", "/api/admin/ai/schedules", settings),
  flows: {
    status: () => request<{ enabled: boolean }>("GET", "/api/flows/status"),
    overview: (all = false) => request<FlowsOverview>("GET", `/api/flows${all ? "?all=1" : ""}`),
    flow: (id: string) => request<FlowDetail>("GET", `${FLOW}/${encodeURIComponent(id)}`),
    install: (flow: string, language: string, title?: string) => request<FlowDetail>("POST", "/api/flows", { flow, language, ...(title ? { title } : {}) }),
    update: (id: string, body: { title?: string; params?: Record<string, unknown>; language?: string; status?: "active" | "paused"; sendsPerHour?: number }) =>
      request<FlowDetail>("PUT", `${FLOW}/${encodeURIComponent(id)}`, body),
    remove: (id: string) => request<{ ok: true }>("DELETE", `${FLOW}/${encodeURIComponent(id)}`),
    addOwner: (id: string, userId: string) => request<FlowDetail>("POST", `${FLOW}/${encodeURIComponent(id)}/owners`, { userId }),
    removeOwner: (id: string, userId: string) => request<FlowDetail>("DELETE", `${FLOW}/${encodeURIComponent(id)}/owners/${encodeURIComponent(userId)}`),
    addPerson: (id: string, person: { name?: string; userId?: string; language?: string | null }) => request<FlowPerson>("POST", `${FLOW}/${encodeURIComponent(id)}/people`, person),
    removePerson: (id: string, personId: string) => request<{ ok: boolean }>("DELETE", `${FLOW}/${encodeURIComponent(id)}/people/${encodeURIComponent(personId)}`),
    personCode: (id: string, personId: string) =>
      request<{ code: string; link: string | null }>("POST", `${FLOW}/${encodeURIComponent(id)}/people/${encodeURIComponent(personId)}/code`, {}),
    directory: (id: string, directory: string) => request<{ rows: Record<string, unknown>[] }>("GET", `${FLOW}/${encodeURIComponent(id)}/directories/${encodeURIComponent(directory)}`),
    importDirectory: (id: string, directory: string, csv: string) =>
      request<{ rows: number }>("PUT", `${FLOW}/${encodeURIComponent(id)}/directories/${encodeURIComponent(directory)}`, { csv }),
    connectTelegram: (id: string, token: string) => request<{ botName: string }>("PUT", `${FLOW}/${encodeURIComponent(id)}/telegram`, { token }),
    disconnectTelegram: (id: string) => request<{ ok: true }>("DELETE", `${FLOW}/${encodeURIComponent(id)}/telegram`),
    runs: (id: string, mine = false) => request<{ runs: FlowRunSummary[] }>("GET", `${FLOW}/${encodeURIComponent(id)}/runs${mine ? "?mine=1" : ""}`),
    run: (id: string) => request<FlowRunDetail>("GET", `${FLOW}/runs/${encodeURIComponent(id)}`),
    fileUrl: (runId: string, n: number) => `${FLOW}/runs/${encodeURIComponent(runId)}/files/${n}`,
    // Stage E2, part C: decisions and confirmations waiting for me; whoever answers first decides.
    tasks: () => request<{ tasks: FlowTask[]; count: number }>("GET", `${FLOW}/tasks`),
    answerTask: (key: string, option: string, comment?: string) =>
      request<{ ok: true }>("POST", `${FLOW}/tasks/${encodeURIComponent(key)}/answer`, { option, ...(comment ? { comment } : {}) }),
    // Stage E2 (B1): connections to outside APIs; without `secret` the stored key stays.
    setConnection: (id: string, name: string, body: { baseUrl: string; secret?: Record<string, string> }) =>
      request<FlowDetail>("PUT", `${FLOW}/${encodeURIComponent(id)}/connections/${encodeURIComponent(name)}`, body),
    removeConnection: (id: string, name: string) => request<FlowDetail>("DELETE", `${FLOW}/${encodeURIComponent(id)}/connections/${encodeURIComponent(name)}`),
    // Stage E2: flows sending letters in my name.
    sendAs: () => request<{ on: boolean; expiresAt: string | null }>("GET", `${FLOW}/send-as`),
    setSendAs: (on: boolean) => request<{ on: boolean; expiresAt: string | null }>("PUT", `${FLOW}/send-as`, { on }),
    // The admin of the company.
    adminOverview: () => request<FlowsAdminOverview>("GET", "/api/admin/flows"),
    setJournalYears: (journalYears: number) => request<{ ok: true }>("PUT", "/api/admin/flows/settings", { journalYears }),
  },

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
        aiEngine?: "classic" | "xenacore";
        meetingsAllowed?: boolean;
        meetingsMaxParticipants?: number | null;
        meetingsMaxHours?: number | null;
        webinarsAllowed?: boolean;
        meetingsRecordingAllowed?: boolean;
        webinarsMaxViewers?: number | null;
        flowsEnabled?: boolean;
      },
    ) => request<{ ok: true }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/limits`, limits),
    report: (month?: string) => request<OperatorReport>("GET", `/api/operator/report${month ? `?month=${encodeURIComponent(month)}` : ""}`),
    // Step 108: every person, which companies they are in, their activity.
    peopleSummary: () => request<OperatorPeopleSummary>("GET", "/api/operator/people/summary"),
    people: (f: OperatorPeopleFilter) =>
      request<{ people: OperatorPersonRow[]; total: number; page: number; pageSize: number }>("GET", `/api/operator/people${peopleQuery(f)}`),
    person: (email: string) => request<OperatorPerson>("GET", `/api/operator/person?email=${encodeURIComponent(email)}`),
    // Step 108, part B: blocks, addresses that may not sign up, the operator's log.
    blockPerson: (input: { email: string; userId?: string; reason: string; blockSignup: boolean; blockDomain: boolean; notify: boolean }) =>
      request<{ blocked: number }>("POST", "/api/operator/people/block", input),
    unblockPerson: (input: { email: string; userId?: string }) => request<{ unblocked: number }>("POST", "/api/operator/people/unblock", input),
    blockedSignups: () => request<{ blocked: BlockedSignup[] }>("GET", "/api/operator/blocked-signups").then((r) => r.blocked),
    addBlockedSignup: (kind: "email" | "domain", value: string, reason?: string) =>
      request<{ blocked: BlockedSignup[] }>("POST", "/api/operator/blocked-signups", { kind, value, ...(reason ? { reason } : {}) }).then((r) => r.blocked),
    removeBlockedSignup: (id: string) => request<{ blocked: BlockedSignup[] }>("DELETE", `/api/operator/blocked-signups/${encodeURIComponent(id)}`).then((r) => r.blocked),
    actions: (email?: string) => request<{ actions: OperatorAction[] }>("GET", `/api/operator/actions${email ? `?email=${encodeURIComponent(email)}` : ""}`).then((r) => r.actions),
    // Step 108, part C: the pictures people upload that others see.
    images: (f: GalleryFilter) =>
      request<{ images: GalleryImage[]; total: number; newCount: number; page: number; pageSize: number }>("GET", `/api/operator/images${peopleQuery(f)}`),
    reviewImages: (items: { kind: GalleryKind; ref: string; version: string }[]) => request<{ ok: true }>("POST", "/api/operator/images/review", { items }),
    removeImage: (kind: GalleryKind, ref: string, reason: string, mode: "hide" | "delete") => request<{ ok: true }>("POST", "/api/operator/images/remove", { kind, ref, reason, mode }),
    hiddenImages: () => request<{ hidden: HiddenImage[] }>("GET", "/api/operator/images/hidden").then((r) => r.hidden),
    restoreImage: (id: string) => request<{ hidden: HiddenImage[] }>("POST", `/api/operator/images/hidden/${encodeURIComponent(id)}/restore`, {}).then((r) => r.hidden),
    // Step 108, part C3: chat pictures our own model flagged (only those, only a preview) and the threshold.
    imageCheckSettings: () => request<{ available: boolean; threshold: number | null }>("GET", "/api/operator/image-check"),
    setImageCheckThreshold: (threshold: number) => request<{ available: boolean; threshold: number }>("PUT", "/api/operator/image-check", { threshold }),
    chatImages: () => request<{ flags: ChatImageFlag[]; available: boolean }>("GET", "/api/operator/chat-images"),
    dismissChatImage: (id: string) => request<{ flags: ChatImageFlag[] }>("POST", `/api/operator/chat-images/${encodeURIComponent(id)}/dismiss`, {}).then((r) => r.flags),
    removeChatImage: (id: string, reason: string) => request<{ flags: ChatImageFlag[] }>("POST", `/api/operator/chat-images/${encodeURIComponent(id)}/remove`, { reason }).then((r) => r.flags),
    blockFromChatImage: (id: string, target: "person" | "company", reason: string) =>
      request<{ flags: ChatImageFlag[] }>("POST", `/api/operator/chat-images/${encodeURIComponent(id)}/block`, { target, reason }).then((r) => r.flags),
    purgeImage: (id: string) => request<{ hidden: HiddenImage[] }>("DELETE", `/api/operator/images/hidden/${encodeURIComponent(id)}`).then((r) => r.hidden),
    // Step 90, part F: the installation's models.
    models: () => request<InstallationModels>("GET", "/api/operator/models"),
    availableModels: () => request<{ models: string[] }>("GET", "/api/operator/models/available").then((r) => r.models),
    saveModels: (change: {
      chatModel?: string | null;
      models?: string[] | null;
      speech?: { source: "mistral"; model?: string | null } | { source: "own"; baseUrl: string; profile: "openai" | "mistral"; model: string; apiKey?: string | null };
    }) => request<InstallationModels>("PUT", "/api/operator/models", change),
    testModels: (kind: "chat" | "speech", model?: string) => request<{ ok: boolean; error: string | null; ms: number | null }>("POST", "/api/operator/models/test", { kind, ...(model ? { model } : {}) }),
    setTenantSlug: (id: string, slug: string) => request<{ id: string; slug: string }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/slug`, { slug }),
    revokeInvitation: (id: string) => request<{ id: string; revokedAt: string }>("POST", `/api/operator/invitations/${encodeURIComponent(id)}/revoke`, {}),
    /** Step 97: XenRooms Free or paid; "reviewed" opens chat with other companies. */
    setTenantPlan: (id: string, plan: "free" | "paid") => request<RoomsPlanInfo>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/plan`, { plan }),
    reviewTenant: (id: string) => request<RoomsPlanInfo>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/review`, {}),
    toWorkspace: (id: string, domain: string) => request<{ moved: number }>("POST", `/api/operator/tenants/${encodeURIComponent(id)}/to-workspace`, { domain }),
    createInvitation: (note: string, locale: "de" | "en", product: "workspace" | "rooms" = "workspace") =>
      request<{ id: string; url: string; expiresAt: string }>("POST", "/api/operator/invitations", { note: note || undefined, locale, product }),
  },
};
