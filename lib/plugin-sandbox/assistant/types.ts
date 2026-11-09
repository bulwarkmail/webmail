// The assistant's host API areas, merged: permissions and api.host.features
// flags (see README.md). Pure: plugin-types.ts imports this.

import { PERMISSIONS as B } from './b.types';
import { PERMISSIONS as C } from './c.types';
import { PERMISSIONS as D } from './d.types';
import { PERMISSIONS as F } from './f.types';
import type { AreaHostFeaturesB } from './b.types';
import type { AreaHostFeaturesC } from './c.types';
import type { AreaHostFeaturesD } from './d.types';
import type { AreaHostFeaturesF } from './f.types';

export const ASSISTANT_PERMISSIONS = [...B, ...C, ...D, ...F] as const;

export interface AssistantHostFeatures extends AreaHostFeaturesB, AreaHostFeaturesC, AreaHostFeaturesD, AreaHostFeaturesF {}
