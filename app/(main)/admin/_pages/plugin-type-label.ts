/**
 * What a plugin's manifest type means, for the admin pages: the raw values
 * (`ui-extension`, `hook`) are developer words.
 */
export function pluginTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'ui-extension': return 'Adds to the interface';
    case 'hook': return 'Works in the background';
    case 'sidebar-app': return 'Adds an app to the sidebar';
    case 'theme': return 'Theme';
    default: return 'Plugin';
  }
}
