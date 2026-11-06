// IntlProvider's Lite-only assets (components/providers/lite-intl-assets.tsx):
// English and the page skeletons, for drawing a page before it has a catalog.
// Every webpack build but Lite replaces the import with the empty module
// (next.config.ts), and lib/__tests__/boot-import-graph.test.ts follows the
// same swap when it checks what the first page load imports.

/** The request IntlProvider imports them by. */
export const LITE_INTL_ASSETS_REQUEST = /^\.\/lite-intl-assets$/;

/** What the other builds get instead. */
export const LITE_INTL_ASSETS_OFF = './lite-intl-assets.off';
