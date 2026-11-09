import type { ImportSummary } from './boot';
import { steps as adminSteps } from './import/admin';
import { steps as authSteps } from './import/auth';
import { steps as dataSteps } from './import/data';
import { steps as extSteps } from './import/ext';

/**
 * Copy an existing single-instance install's local files into an
 * uninitialised shared store (#1066). Every store brings its own steps (in
 * lib/shared-store/import/<part>.ts); each step reads that store's local
 * files exactly as local mode would and writes only what the store doesn't
 * hold yet (put with ifVersion: null), so running it again changes nothing.
 * It never changes or deletes a local file. Returns how many items it wrote.
 */
export interface ImportStep {
  name: string;
  run(): Promise<number>;
}

/** In this order: config first (admin, then plugins, themes, branding), then state, then user data. */
const STEPS: ImportStep[] = [...adminSteps, ...extSteps, ...authSteps, ...dataSteps];

export async function importLocalData(steps: ImportStep[] = STEPS): Promise<ImportSummary> {
  const imported: Record<string, number> = {};
  for (const step of steps) imported[step.name] = await step.run();
  return { imported };
}
