// Host side of the text checker calls (compose:check). See checkers.ts.
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

const CALLS_PER_MINUTE = 60;

function rate(method: string, plugin: InstalledPlugin): void {
  if (!withinRate('composer-check', plugin.id, CALLS_PER_MINUTE)) throw new Error(`${method}: at most ${CALLS_PER_MINUTE} calls a minute`);
}

function checkerOf(method: string, plugin: InstalledPlugin, checkerId: unknown): CheckerSpec {
  const spec = getChecker(plugin.id, checkerId);
  if (!spec) throw new Error(`${method}: no checker "${String(checkerId)}" registered by this plugin`);
  return spec;
}

export function doRegisterChecker(plugin: InstalledPlugin, data: unknown, frame: 'background' | 'slot' | undefined): true {
  // The host calls a checker in the plugin's background frame; a slot
  // frame comes and goes with the screen.
  if (frame === 'slot') throw new Error('composer.registerChecker: register checkers from activate(), not from a slot');
  rate('composer.registerChecker', plugin);
  setPluginChecker(plugin.id, plugin.name, checkCheckerData(data));
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
  const target = checkTarget(id);
  if (!target) throw new Error(`${method}: that composer is not open any more`);
  rate(method, plugin);
  return target.setAnnotations(spec, rev, annotations);
}
