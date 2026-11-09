/**
 * Answers a JMAP request from the local store: the store acting as a server
 * toward the UI. Every call gets its own answer, in order, as a server would:
 * one the store can't answer gets a per-call error and the rest still work.
 */

import { MethodError, type MethodContext, type MethodHandler, type MethodResult, type StoreArea } from '../area';
import type { JmapResponse, MethodCall, MethodResponse } from './transport';

class BadReference extends Error {}

/** RFC 8620 §3.7 result references, with the `*` array step. */
export function resolvePointer(value: unknown, path: string): unknown {
  const steps = path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const walk = (node: unknown, i: number): unknown => {
    if (i === steps.length) return node;
    const step = steps[i];
    if (step === '*') {
      if (!Array.isArray(node)) throw new BadReference();
      return node.flatMap((item) => {
        const out = walk(item, i + 1);
        return Array.isArray(out) ? out : [out];
      });
    }
    if (node === null || typeof node !== 'object') throw new BadReference();
    return walk((node as Record<string, unknown>)[step], i + 1);
  };
  return walk(value, 0);
}

function resolveArgs(args: Record<string, unknown>, done: readonly MethodResponse[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith('#')) {
      out[key] = value;
      continue;
    }
    const ref = value as { resultOf?: string; name?: string; path?: string };
    const source = done.find(([name, , id]) => id === ref.resultOf && name === ref.name);
    if (!source || typeof ref.path !== 'string') throw new BadReference();
    out[key.slice(1)] = resolvePointer(source[1], ref.path);
  }
  return out;
}

export function buildMethodTable(areas: readonly StoreArea[]): Map<string, MethodHandler> {
  const table = new Map<string, MethodHandler>();
  for (const area of areas) {
    for (const [name, handler] of Object.entries(area.methods)) {
      if (table.has(name)) throw new Error(`Two store areas answer ${name}`);
      table.set(name, handler);
    }
  }
  return table;
}

/** Answers are copied by structured clone on the way to the page, so callers can't mutate stored objects. */
export async function answerRequest(
  ctx: Omit<MethodContext, 'createdIds' | 'calls'>,
  methods: ReadonlyMap<string, MethodHandler>,
  calls: readonly MethodCall[],
): Promise<JmapResponse | null> {
  const done: MethodResponse[] = [];
  const full: MethodContext = { ...ctx, createdIds: new Map(), calls };
  let answered = 0;
  for (const call of calls) {
    const [name, rawArgs, callId] = call;
    const handler = methods.get(name);
    if (!handler) {
      done.push(['error', { type: 'serverUnavailable', description: `${name} needs the server` }, callId]);
      continue;
    }
    try {
      const args = resolveArgs(rawArgs, done);
      const result: MethodResult = await handler(full, args, call);
      done.push([name, result, callId]);
      answered += 1;
    } catch (error) {
      if (error instanceof BadReference) {
        done.push(['error', { type: 'invalidResultReference' }, callId]);
      } else if (error instanceof MethodError) {
        done.push(['error', { type: error.type, description: error.description }, callId]);
      } else {
        throw error;
      }
    }
  }
  return answered === 0 ? null : { methodResponses: done };
}
