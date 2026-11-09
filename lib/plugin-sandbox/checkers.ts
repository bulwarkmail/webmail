// Text checkers that plugins register (api.composer.registerChecker).
//
// A checker is a plugin function that gets the text the user writes and
// answers with things to underline (spelling, grammar, style). Unlike every
// other api.composer method, the host calls it for each open composer where
// checking is on, without the user pointing the plugin at that composer.
// That is what the compose:check permission grants.
//
// The functions stay in the plugin's background frame; the host keeps only
// the data below and calls them through a dispatcher the loader sets
// (`checker:<id>` and `checker-action:<id>` hooks). Composers that check
// register a target here, so a plugin can also push results for a composer
// it was handed (on-demand checkers such as an assistant's "check" button).

import { CHECK_KINDS, type CheckKind } from '@/lib/proofreading/annotations';

export const MAX_CHECKERS_PER_PLUGIN = 4;
export const MIN_DEBOUNCE_MS = 300;
export const MAX_DEBOUNCE_MS = 5000;
export const DEFAULT_DEBOUNCE_MS = 800;
const MAX_LANGUAGES = 100;

export type CheckerMode = 'typing' | 'on-demand';

export interface CheckerData {
  id: string;
  label: string;
  kinds: CheckKind[];
  debounceMs: number;
  languages: string[];
  mode: CheckerMode;
  /** Ask the user before sending while this checker has open issues. */
  warnBeforeSend: boolean;
}

export interface CheckerSpec extends CheckerData {
  pluginId: string;
  pluginName: string;
  /** Bumped by recheck(): composers send their whole text again. */
  epoch: number;
  /** Registration order; the first checker wins where underlines overlap. */
  order: number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

function fail(msg: string): never {
  throw new Error(`composer.registerChecker: ${msg}`);
}

function readKinds(v: unknown, method: string): CheckKind[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${method}: kinds must list one or more of ${CHECK_KINDS.join(', ')}`);
  const out: CheckKind[] = [];
  for (const k of v) {
    if (typeof k !== 'string' || !(CHECK_KINDS as readonly string[]).includes(k)) throw new Error(`${method}: unknown kind "${String(k)}"`);
    if (!out.includes(k as CheckKind)) out.push(k as CheckKind);
  }
  return out;
}

function readLabel(v: unknown, method: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 60) throw new Error(`${method}: label must be 1 to 60 characters`);
  return v.trim();
}

function readDebounce(v: unknown, method: string): number {
  if (v === undefined) return DEFAULT_DEBOUNCE_MS;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${method}: debounceMs must be a number`);
  return Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, Math.round(v)));
}

/** A registration as the plugin sent it, checked. */
export function checkCheckerData(raw: unknown): CheckerData {
  const method = 'composer.registerChecker';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('needs an object');
  const r = raw as Record<string, unknown>;
  const known = new Set(['id', 'label', 'kinds', 'debounceMs', 'languages', 'mode', 'warnBeforeSend']);
  for (const key of Object.keys(r)) if (!known.has(key)) fail(`unknown field "${key}"`);
  if (typeof r.id !== 'string' || !ID.test(r.id)) fail('id must be 1 to 40 lowercase letters, digits or dashes');
  const languages: string[] = [];
  if (r.languages !== undefined) {
    if (!Array.isArray(r.languages) || r.languages.length > MAX_LANGUAGES) fail(`languages must be a list of at most ${MAX_LANGUAGES} language tags`);
    for (const l of r.languages) {
      if (typeof l !== 'string' || !LANG.test(l)) fail(`"${String(l)}" is not a language tag`);
      if (!languages.includes(l)) languages.push(l);
    }
  }
  if (r.mode !== undefined && r.mode !== 'typing' && r.mode !== 'on-demand') fail('mode must be "typing" or "on-demand"');
  if (r.warnBeforeSend !== undefined && typeof r.warnBeforeSend !== 'boolean') fail('warnBeforeSend must be true or false');
  return {
    id: r.id as string,
    label: readLabel(r.label, method),
    kinds: readKinds(r.kinds, method),
    debounceMs: readDebounce(r.debounceMs, method),
    languages,
    mode: (r.mode as CheckerMode | undefined) ?? 'typing',
    warnBeforeSend: r.warnBeforeSend === true,
  };
}

/** The fields update() may change, checked. */
export function checkCheckerPatch(raw: unknown): Partial<Pick<CheckerData, 'label' | 'kinds' | 'debounceMs' | 'warnBeforeSend'>> {
  const method = 'composer.updateChecker';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${method}: needs an object`);
  const r = raw as Record<string, unknown>;
  const out: Partial<Pick<CheckerData, 'label' | 'kinds' | 'debounceMs' | 'warnBeforeSend'>> = {};
  for (const key of Object.keys(r)) {
    switch (key) {
      case 'label': out.label = readLabel(r.label, method); break;
      case 'kinds': out.kinds = readKinds(r.kinds, method); break;
      case 'debounceMs': out.debounceMs = readDebounce(r.debounceMs, method); break;
      case 'warnBeforeSend':
        if (typeof r.warnBeforeSend !== 'boolean') throw new Error(`${method}: warnBeforeSend must be true or false`);
        out.warnBeforeSend = r.warnBeforeSend;
        break;
      default: throw new Error(`${method}: "${key}" can't be changed`);
    }
  }
  return out;
}

// pluginId → checkerId → spec
const registry = new Map<string, Map<string, CheckerSpec>>();
const listeners = new Set<() => void>();
let snapshot: CheckerSpec[] | null = null;
let nextOrder = 0;

function changed(): void {
  snapshot = null;
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribeCheckers(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Every registered checker, in registration order; the same array until something changes. */
export function allCheckers(): CheckerSpec[] {
  if (snapshot) return snapshot;
  const out: CheckerSpec[] = [];
  for (const checkers of registry.values()) out.push(...checkers.values());
  out.sort((a, b) => a.order - b.order);
  snapshot = out;
  return out;
}

export function getChecker(pluginId: string, checkerId: unknown): CheckerSpec | null {
  return typeof checkerId === 'string' ? registry.get(pluginId)?.get(checkerId) ?? null : null;
}

/** Register a checker, or replace one with the same id (keeping its place). */
export function setPluginChecker(pluginId: string, pluginName: string, data: CheckerData): void {
  let checkers = registry.get(pluginId);
  if (!checkers) {
    checkers = new Map();
    registry.set(pluginId, checkers);
  }
  const old = checkers.get(data.id);
  if (!old && checkers.size >= MAX_CHECKERS_PER_PLUGIN) fail(`at most ${MAX_CHECKERS_PER_PLUGIN} checkers per plugin`);
  checkers.set(data.id, { ...data, pluginId, pluginName, epoch: (old?.epoch ?? 0) + 1, order: old?.order ?? nextOrder++ });
  changed();
}

export function updatePluginChecker(pluginId: string, checkerId: string, patch: ReturnType<typeof checkCheckerPatch>): void {
  const spec = getChecker(pluginId, checkerId);
  if (!spec) throw new Error('composer.updateChecker: no checker with that id');
  registry.get(pluginId)!.set(checkerId, { ...spec, ...patch });
  changed();
}

/** Forget what composers sent: each sends its whole text again. */
export function recheckPluginChecker(pluginId: string, checkerId: string): void {
  const spec = getChecker(pluginId, checkerId);
  if (!spec) throw new Error('composer.recheck: no checker with that id');
  registry.get(pluginId)!.set(checkerId, { ...spec, epoch: spec.epoch + 1 });
  changed();
}

export function removePluginChecker(pluginId: string, checkerId: string): void {
  const checkers = registry.get(pluginId);
  if (checkers?.delete(checkerId)) {
    if (checkers.size === 0) registry.delete(pluginId);
    changed();
  }
}

/** Drop everything a plugin registered (it was turned off or removed). */
export function clearPluginCheckers(pluginId: string): void {
  if (registry.delete(pluginId)) changed();
}

/** Test helper. */
export function resetCheckers(): void {
  registry.clear();
  targets.clear();
  nextOrder = 0;
  changed();
}

// ─── Calls into the plugin ────────────────────────────────────

export interface CheckerDispatcher {
  check(pluginId: string, checkerId: string, request: unknown): Promise<unknown>;
  action(pluginId: string, checkerId: string, payload: unknown): Promise<unknown>;
}

let dispatcher: CheckerDispatcher | null = null;

/** Set by the loader, which owns the running plugins. */
export function setCheckerDispatcher(next: CheckerDispatcher | null): void {
  dispatcher = next;
}

export function dispatchCheck(spec: CheckerSpec, request: unknown): Promise<unknown> {
  if (!dispatcher) return Promise.reject(new Error('plugins are not running'));
  return dispatcher.check(spec.pluginId, spec.id, request);
}

export function dispatchCheckerAction(spec: CheckerSpec, payload: unknown): Promise<unknown> {
  if (!dispatcher) return Promise.reject(new Error('plugins are not running'));
  return dispatcher.action(spec.pluginId, spec.id, payload);
}

// ─── Composers that check ─────────────────────────────────────

export interface CheckTarget {
  /** The whole text for an on-demand check, or null when checking is off for this checker here. */
  getCheckText(spec: CheckerSpec): unknown | null;
  /** Results a plugin pushed; returns how many annotations were kept. */
  setAnnotations(spec: CheckerSpec, revision: string, annotations: unknown): number;
}

const targets = new Map<string, CheckTarget>();

export function registerCheckTarget(composerId: string, target: CheckTarget): () => void {
  targets.set(composerId, target);
  return () => { if (targets.get(composerId) === target) targets.delete(composerId); };
}

export function checkTarget(composerId: unknown): CheckTarget | null {
  return typeof composerId === 'string' ? targets.get(composerId) ?? null : null;
}
