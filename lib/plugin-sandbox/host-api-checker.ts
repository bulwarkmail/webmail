// Host side of the text checker calls. See checkers.ts.
//
// A checker the host sends text to while the user types needs compose:check:
// it reads every message being written, without the user pointing it at
// one. A checker that checks only when the user asks (an assistant's "check
// spelling" button, with the composer id that click hands over) needs no
// more than compose:read, like the plugin's other reads of that message.
//
//   composer.registerChecker(data)                               background frame only
//   composer.updateChecker(checkerId, patch)
//   composer.recheck(checkerId)
//   composer.unregisterChecker(checkerId)
//   composer.getCheckText(composerId, checkerId)                  on-demand checks
//   composer.setAnnotations(composerId, checkerId, revision, annotations)

import type { InstalledPlugin } from '../plugin-types';
import {
  checkCheckerData, checkCheckerPatch, checkTarget, getChecker, recheckPluginChecker,
  removePluginChecker, setPluginChecker, updatePluginChecker, type CheckerSpec,
} from './checkers';
import { readId, withinRate } from './host-api-input';
import { MAX_ANNOTATIONS } from '@/lib/proofreading/annotations';
import { pluginHasPermission } from './permissions';

const CALLS_PER_MINUTE = 60;
const MAX_PUSHED = 2 * MAX_ANNOTATIONS;

function rate(method: string, plugin: InstalledPlugin): void {
  if (!withinRate('composer-check', plugin.id, CALLS_PER_MINUTE)) throw new Error(`${method}: at most ${CALLS_PER_MINUTE} calls a minute`);
}

/** compose:check, or for a checker that checks only when asked, compose:read. */
function requirePermission(method: string, plugin: InstalledPlugin, mode: 'typing' | 'on-demand'): void {
  if (pluginHasPermission(plugin, 'compose:check')) return;
  if (mode === 'on-demand' && pluginHasPermission(plugin, 'compose:read')) return;
  throw new Error(`Plugin "${plugin.id}" lacks permission "compose:check"${mode === 'on-demand' ? ' or "compose:read"' : ''} for ${method}`);
}

function checkerOf(method: string, plugin: InstalledPlugin, checkerId: unknown): CheckerSpec {
  const spec = getChecker(plugin.id, checkerId);
  if (!spec) throw new Error(`${method}: no checker "${String(checkerId)}" registered by this plugin`);
  // Checked again on every call, in case the permission went since.
  requirePermission(method, plugin, spec.mode);
  return spec;
}

export function doRegisterChecker(plugin: InstalledPlugin, data: unknown, frame: 'background' | 'slot' | undefined): true {
  // The host calls a checker in the plugin's background frame; a slot
  // frame comes and goes with the screen.
  if (frame === 'slot') throw new Error('composer.registerChecker: register checkers from activate(), not from a slot');
  const checked = checkCheckerData(data);
  requirePermission('composer.registerChecker', plugin, checked.mode);
  rate('composer.registerChecker', plugin);
  setPluginChecker(plugin.id, plugin.name, checked);
  return true;
}

export function doUpdateChecker(plugin: InstalledPlugin, checkerId: unknown, patch: unknown): true {
  const spec = checkerOf('composer.updateChecker', plugin, checkerId);
  rate('composer.updateChecker', plugin);
  updatePluginChecker(plugin.id, spec.id, checkCheckerPatch(patch));
  return true;
}

export function doRecheck(plugin: InstalledPlugin, checkerId: unknown): true {
  const spec = checkerOf('composer.recheck', plugin, checkerId);
  rate('composer.recheck', plugin);
  recheckPluginChecker(plugin.id, spec.id);
  return true;
}

export function doUnregisterChecker(plugin: InstalledPlugin, checkerId: unknown): true {
  removePluginChecker(plugin.id, checkerOf('composer.unregisterChecker', plugin, checkerId).id);
  return true;
}

/** The whole text of a composer the plugin was handed, for an on-demand check. */
export function doGetCheckText(plugin: InstalledPlugin, composerId: unknown, checkerId: unknown): unknown {
  const method = 'composer.getCheckText';
  const id = readId(composerId, method, 'composerId');
  const spec = checkerOf(method, plugin, checkerId);
  const target = checkTarget(id);
  if (!target) throw new Error(`${method}: that composer is not open any more`);
  rate(method, plugin);
  const request = target.getCheckText(spec);
  if (!request) throw new Error('checking_off');
  return request;
}

export function doSetAnnotations(plugin: InstalledPlugin, composerId: unknown, checkerId: unknown, revision: unknown, annotations: unknown): number {
  const method = 'composer.setAnnotations';
  const id = readId(composerId, method, 'composerId');
  const spec = checkerOf(method, plugin, checkerId);
  const rev = readId(revision, method, 'revision');
  if (!Array.isArray(annotations)) throw new Error(`${method}: annotations must be a list`);
  if (annotations.length > MAX_PUSHED) throw new Error(`${method}: at most ${MAX_PUSHED} annotations`);
  const target = checkTarget(id);
  if (!target) throw new Error(`${method}: that composer is not open any more`);
  rate(method, plugin);
  return target.setAnnotations(spec, rev, annotations);
}
