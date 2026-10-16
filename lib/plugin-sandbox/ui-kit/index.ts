// `@plugin-host/ui`: the module plugins require for the app's controls.
// See components.tsx. Adding an export is a plugin API change: list it in
// KIT_EXPORTS below (the plugins repo's docs and fake API read that list).

import * as components from './components';
import { DialogButtons, useSlotProps } from './dialog-buttons';

export * from './components';
export { DialogButtons, SlotPropsContext, useSlotProps } from './dialog-buttons';
export type { DialogButtonSpec } from './dialog-buttons';

/** Bumped when a component is added or its props change in a way plugins can see. */
export const KIT_VERSION = 2;

export const pluginUiKit = Object.freeze({
  ...components,
  DialogButtons,
  useSlotProps,
  KIT_VERSION,
});

export const KIT_EXPORTS = Object.freeze(Object.keys(pluginUiKit).sort());
