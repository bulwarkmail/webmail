// The names `require('@plugin-host/ui')` hands a plugin, and the kit's
// version. Kept apart from the components so a background frame
// (background-kit.ts) can offer the same names without loading them;
// plugin-ui-kit.test.ts checks this list against the kit.

/** Bumped when a component is added or its props change in a way plugins can see. */
export const KIT_VERSION = 3;

export const KIT_NAMES: readonly string[] = Object.freeze([
  'Alert', 'Badge', 'BarButton', 'Breadcrumbs', 'Button', 'Card', 'Checkbox', 'Chip', 'ColorDot', 'Combobox',
  'DetailHeading', 'DetailList', 'DetailRow', 'DialogButtons', 'DiffView', 'Divider', 'EmptyState', 'Field',
  'FileIcon', 'Heading', 'Icon', 'InfoBar', 'Input', 'KIT_VERSION', 'Link', 'LinkButton', 'List', 'ListRow',
  'Loading', 'Page', 'PageHeader', 'Panel', 'ProgressBar', 'Row', 'RowAction', 'SearchInput', 'Section',
  'Segmented', 'Select', 'SettingRow', 'SidebarEmpty', 'SidebarRow', 'Spinner', 'Stack', 'Switch', 'Table', 'Tabs',
  'Text', 'Textarea', 'Toolbar', 'ToolbarButton', 'ToolbarSpacer', 'useSlotProps',
]);
