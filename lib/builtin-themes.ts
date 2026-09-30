import type { InstalledTheme } from './plugin-types';
import { flatFieldsCSS, flatFieldsSkin } from './theme-flat-fields';

const quiCSS = `
:root {
  --color-border: #e4e4e7;
  --color-input: #e4e4e7;
  --color-ring: #3b82f6;
  --color-background: #ffffff;
  --color-foreground: #09090b;
  --color-primary: #3b82f6;
  --color-primary-foreground: #ffffff;
  --color-secondary: #f4f4f5;
  --color-secondary-foreground: #18181b;
  --color-muted: #f4f4f5;
  --color-muted-foreground: #71717a;
  --color-accent: #dbeafe;
  --color-accent-foreground: #1d4ed8;
  --color-destructive: #ef4444;
  --color-destructive-foreground: #ffffff;
  --color-popover: #ffffff;
  --color-popover-foreground: #09090b;
  --color-sidebar: #fafafa;
  --color-sidebar-foreground: #09090b;
  --color-sidebar-border: #e4e4e7;
  --color-sidebar-accent: #f4f4f5;
  --color-sidebar-accent-foreground: #18181b;
  --color-card: #ffffff;
  --color-card-foreground: #09090b;
  --color-success: #22c55e;
  --color-success-foreground: #ffffff;
  --color-warning: #eab308;
  --color-warning-foreground: #ffffff;
  --color-info: #3b82f6;
  --color-info-foreground: #ffffff;
  --color-selection: #dbeafe;
  --color-selection-foreground: #1d4ed8;
  --color-unread: #3b82f6;
  --color-chart-1: #3b82f6;
  --color-chart-2: #22c55e;
  --color-chart-3: #f59e0b;
  --color-chart-4: #ef4444;
  --color-chart-5: #8b5cf6;
}
.dark {
  --color-border: #27272a;
  --color-input: #27272a;
  --color-ring: #3b82f6;
  --color-background: #09090b;
  --color-foreground: #fafafa;
  --color-primary: #3b82f6;
  --color-primary-foreground: #ffffff;
  --color-secondary: #18181b;
  --color-secondary-foreground: #fafafa;
  --color-muted: #18181b;
  --color-muted-foreground: #a1a1aa;
  --color-accent: #172554;
  --color-accent-foreground: #93c5fd;
  --color-destructive: #ef4444;
  --color-destructive-foreground: #fafafa;
  --color-popover: #18181b;
  --color-popover-foreground: #fafafa;
  --color-sidebar: #09090b;
  --color-sidebar-foreground: #fafafa;
  --color-sidebar-border: #27272a;
  --color-sidebar-accent: #18181b;
  --color-sidebar-accent-foreground: #fafafa;
  --color-card: #141414;
  --color-card-foreground: #fafafa;
  --color-success: #16a34a;
  --color-success-foreground: #ffffff;
  --color-warning: #ca8a04;
  --color-warning-foreground: #ffffff;
  --color-info: #60a5fa;
  --color-info-foreground: #ffffff;
  --color-selection: rgba(59, 130, 246, 0.25);
  --color-selection-foreground: #93c5fd;
  --color-unread: #60a5fa;
  --color-chart-1: #60a5fa;
  --color-chart-2: #4ade80;
  --color-chart-3: #fbbf24;
  --color-chart-4: #f87171;
  --color-chart-5: #a78bfa;
}`;

const nordCSS = `
:root {
  --color-border: #d8dee9;
  --color-input: #d8dee9;
  --color-ring: #81a1c1;
  --color-background: #eceff4;
  --color-foreground: #2e3440;
  --color-primary: #5e81ac;
  --color-primary-foreground: #eceff4;
  --color-secondary: #e5e9f0;
  --color-secondary-foreground: #2e3440;
  --color-muted: #d8dee9;
  --color-muted-foreground: #4c566a;
  --color-accent: #81a1c1;
  --color-accent-foreground: #2e3440;
  --color-destructive: #bf616a;
  --color-destructive-foreground: #eceff4;
  --color-popover: #eceff4;
  --color-popover-foreground: #2e3440;
  --color-sidebar: #e5e9f0;
  --color-sidebar-foreground: #2e3440;
  --color-sidebar-border: #d8dee9;
  --color-sidebar-accent: #d8dee9;
  --color-sidebar-accent-foreground: #2e3440;
  --color-card: #eceff4;
  --color-card-foreground: #2e3440;
  --color-success: #a3be8c;
  --color-success-foreground: #2e3440;
  --color-warning: #ebcb8b;
  --color-warning-foreground: #2e3440;
  --color-info: #81a1c1;
  --color-info-foreground: #eceff4;
  --color-selection: #d8dee9;
  --color-selection-foreground: #5e81ac;
  --color-unread: #5e81ac;
  --color-chart-1: #5e81ac;
  --color-chart-2: #a3be8c;
  --color-chart-3: #ebcb8b;
  --color-chart-4: #bf616a;
  --color-chart-5: #b48ead;
}
.dark {
  --color-border: #3b4252;
  --color-input: #3b4252;
  --color-ring: #88c0d0;
  --color-background: #2e3440;
  --color-foreground: #eceff4;
  --color-primary: #88c0d0;
  --color-primary-foreground: #2e3440;
  --color-secondary: #3b4252;
  --color-secondary-foreground: #eceff4;
  --color-muted: #3b4252;
  --color-muted-foreground: #d8dee9;
  --color-accent: #434c5e;
  --color-accent-foreground: #88c0d0;
  --color-destructive: #bf616a;
  --color-destructive-foreground: #eceff4;
  --color-popover: #3b4252;
  --color-popover-foreground: #eceff4;
  --color-sidebar: #2e3440;
  --color-sidebar-foreground: #eceff4;
  --color-sidebar-border: #3b4252;
  --color-sidebar-accent: #3b4252;
  --color-sidebar-accent-foreground: #eceff4;
  --color-card: #3b4252;
  --color-card-foreground: #eceff4;
  --color-success: #a3be8c;
  --color-success-foreground: #2e3440;
  --color-warning: #ebcb8b;
  --color-warning-foreground: #2e3440;
  --color-info: #88c0d0;
  --color-info-foreground: #2e3440;
  --color-selection: rgba(136, 192, 208, 0.2);
  --color-selection-foreground: #88c0d0;
  --color-unread: #88c0d0;
  --color-chart-1: #88c0d0;
  --color-chart-2: #a3be8c;
  --color-chart-3: #ebcb8b;
  --color-chart-4: #bf616a;
  --color-chart-5: #b48ead;
}`;

const catppuccinCSS = `
:root {
  --color-border: #ccd0da;
  --color-input: #ccd0da;
  --color-ring: #8839ef;
  --color-background: #eff1f5;
  --color-foreground: #4c4f69;
  --color-primary: #8839ef;
  --color-primary-foreground: #eff1f5;
  --color-secondary: #e6e9ef;
  --color-secondary-foreground: #4c4f69;
  --color-muted: #dce0e8;
  --color-muted-foreground: #6c6f85;
  --color-accent: #8839ef;
  --color-accent-foreground: #eff1f5;
  --color-destructive: #d20f39;
  --color-destructive-foreground: #eff1f5;
  --color-popover: #eff1f5;
  --color-popover-foreground: #4c4f69;
  --color-sidebar: #e6e9ef;
  --color-sidebar-foreground: #4c4f69;
  --color-sidebar-border: #ccd0da;
  --color-sidebar-accent: #dce0e8;
  --color-sidebar-accent-foreground: #4c4f69;
  --color-card: #eff1f5;
  --color-card-foreground: #4c4f69;
  --color-success: #40a02b;
  --color-success-foreground: #eff1f5;
  --color-warning: #df8e1d;
  --color-warning-foreground: #eff1f5;
  --color-info: #1e66f5;
  --color-info-foreground: #eff1f5;
  --color-selection: #dce0e8;
  --color-selection-foreground: #8839ef;
  --color-unread: #8839ef;
  --color-chart-1: #8839ef;
  --color-chart-2: #40a02b;
  --color-chart-3: #df8e1d;
  --color-chart-4: #d20f39;
  --color-chart-5: #1e66f5;
}
.dark {
  --color-border: #45475a;
  --color-input: #45475a;
  --color-ring: #cba6f7;
  --color-background: #1e1e2e;
  --color-foreground: #cdd6f4;
  --color-primary: #cba6f7;
  --color-primary-foreground: #1e1e2e;
  --color-secondary: #313244;
  --color-secondary-foreground: #cdd6f4;
  --color-muted: #313244;
  --color-muted-foreground: #a6adc8;
  --color-accent: #45475a;
  --color-accent-foreground: #cba6f7;
  --color-destructive: #f38ba8;
  --color-destructive-foreground: #1e1e2e;
  --color-popover: #313244;
  --color-popover-foreground: #cdd6f4;
  --color-sidebar: #1e1e2e;
  --color-sidebar-foreground: #cdd6f4;
  --color-sidebar-border: #45475a;
  --color-sidebar-accent: #313244;
  --color-sidebar-accent-foreground: #cdd6f4;
  --color-card: #313244;
  --color-card-foreground: #cdd6f4;
  --color-success: #a6e3a1;
  --color-success-foreground: #1e1e2e;
  --color-warning: #f9e2af;
  --color-warning-foreground: #1e1e2e;
  --color-info: #89b4fa;
  --color-info-foreground: #1e1e2e;
  --color-selection: rgba(203, 166, 247, 0.2);
  --color-selection-foreground: #cba6f7;
  --color-unread: #cba6f7;
  --color-chart-1: #cba6f7;
  --color-chart-2: #a6e3a1;
  --color-chart-3: #f9e2af;
  --color-chart-4: #f38ba8;
  --color-chart-5: #89b4fa;
}`;

const solarizedCSS = `
:root {
  --color-border: #eee8d5;
  --color-input: #eee8d5;
  --color-ring: #268bd2;
  --color-background: #fdf6e3;
  --color-foreground: #657b83;
  --color-primary: #268bd2;
  --color-primary-foreground: #fdf6e3;
  --color-secondary: #eee8d5;
  --color-secondary-foreground: #586e75;
  --color-muted: #eee8d5;
  --color-muted-foreground: #93a1a1;
  --color-accent: #268bd2;
  --color-accent-foreground: #fdf6e3;
  --color-destructive: #dc322f;
  --color-destructive-foreground: #fdf6e3;
  --color-popover: #fdf6e3;
  --color-popover-foreground: #657b83;
  --color-sidebar: #eee8d5;
  --color-sidebar-foreground: #657b83;
  --color-sidebar-border: #eee8d5;
  --color-sidebar-accent: #eee8d5;
  --color-sidebar-accent-foreground: #586e75;
  --color-card: #fdf6e3;
  --color-card-foreground: #657b83;
  --color-success: #859900;
  --color-success-foreground: #fdf6e3;
  --color-warning: #b58900;
  --color-warning-foreground: #fdf6e3;
  --color-info: #268bd2;
  --color-info-foreground: #fdf6e3;
  --color-selection: #eee8d5;
  --color-selection-foreground: #268bd2;
  --color-unread: #268bd2;
  --color-chart-1: #268bd2;
  --color-chart-2: #859900;
  --color-chart-3: #b58900;
  --color-chart-4: #dc322f;
  --color-chart-5: #6c71c4;
}
.dark {
  --color-border: #073642;
  --color-input: #073642;
  --color-ring: #268bd2;
  --color-background: #002b36;
  --color-foreground: #839496;
  --color-primary: #268bd2;
  --color-primary-foreground: #002b36;
  --color-secondary: #073642;
  --color-secondary-foreground: #93a1a1;
  --color-muted: #073642;
  --color-muted-foreground: #586e75;
  --color-accent: #073642;
  --color-accent-foreground: #268bd2;
  --color-destructive: #dc322f;
  --color-destructive-foreground: #fdf6e3;
  --color-popover: #073642;
  --color-popover-foreground: #93a1a1;
  --color-sidebar: #002b36;
  --color-sidebar-foreground: #839496;
  --color-sidebar-border: #073642;
  --color-sidebar-accent: #073642;
  --color-sidebar-accent-foreground: #93a1a1;
  --color-card: #073642;
  --color-card-foreground: #93a1a1;
  --color-success: #859900;
  --color-success-foreground: #002b36;
  --color-warning: #b58900;
  --color-warning-foreground: #002b36;
  --color-info: #268bd2;
  --color-info-foreground: #002b36;
  --color-selection: rgba(38, 139, 210, 0.2);
  --color-selection-foreground: #268bd2;
  --color-unread: #268bd2;
  --color-chart-1: #268bd2;
  --color-chart-2: #859900;
  --color-chart-3: #b58900;
  --color-chart-4: #dc322f;
  --color-chart-5: #6c71c4;
}`;

// Roundcube "Elastic" skin recreation.
//
// Colour tokens are lifted from skins/elastic/styles/colors.less (CC BY-SA):
//   accent      #37beff   font        #27353a   border  #ddd
//   error       #ff5552   success     #41b849   warning #ffd452
//   task-menu    #2f3a3f (always dark, both modes)
//   list-select  tint(#37beff, 90%) -> #ebf8ff
// Dark mode mirrors @color-dark-* (background #21292c, font #c5d1d3, …).
const elasticCSS = `
:root {
  --color-border: #dddddd;
  --color-input: #ced4da;
  --color-ring: #37beff;
  --color-background: #ffffff;
  --color-foreground: #27353a;
  --color-primary: #37beff;
  --color-primary-foreground: #ffffff;
  --color-secondary: #f4f4f4;
  --color-secondary-foreground: #27353a;
  --color-muted: #f4f4f4;
  --color-muted-foreground: #737677;
  --color-accent: #e6f6ff;
  --color-accent-foreground: #0070a8;
  --color-destructive: #ff5552;
  --color-destructive-foreground: #ffffff;
  --color-popover: #ffffff;
  --color-popover-foreground: #27353a;
  --color-sidebar: #ffffff;
  --color-sidebar-foreground: #27353a;
  --color-sidebar-border: #dddddd;
  --color-sidebar-accent: #ebf8ff;
  --color-sidebar-accent-foreground: #27353a;
  --color-card: #ffffff;
  --color-card-foreground: #27353a;
  --color-success: #41b849;
  --color-success-foreground: #ffffff;
  --color-warning: #ffd452;
  --color-warning-foreground: #27353a;
  --color-info: #37beff;
  --color-info-foreground: #ffffff;
  --color-selection: #ebf8ff;
  --color-selection-foreground: #27353a;
  --color-unread: #ffd452;
  --color-chart-1: #37beff;
  --color-chart-2: #41b849;
  --color-chart-3: #ffd452;
  --color-chart-4: #ff5552;
  --color-chart-5: #9b59b6;
  /* Elastic is a 14px Roboto skin with tighter list rows than Bulwark's default */
  --font-size-base: 14px;
  --list-item-height: 40px;
}
.dark {
  --color-border: #4d6066;
  --color-input: #4d6066;
  --color-ring: #37beff;
  --color-background: #21292c;
  --color-foreground: #ffffff;
  --color-primary: #37beff;
  --color-primary-foreground: #ffffff;
  --color-secondary: #2c373a;
  --color-secondary-foreground: #ffffff;
  --color-muted: #2c373a;
  /* Roundcube keeps most text near the bright font colour, only true hints
     dim out. Bulwark applies muted-foreground far more widely, so brighten it
     toward @color-dark-font (#c5d1d3) to match Elastic's overall brightness. */
  --color-muted-foreground: #b3bec1;
  --color-accent: #374549;
  --color-accent-foreground: #37beff;
  --color-destructive: #ff5552;
  --color-destructive-foreground: #ffffff;
  --color-popover: #161b1d;
  --color-popover-foreground: #ffffff;
  --color-sidebar: #21292c;
  --color-sidebar-foreground: #ffffff;
  --color-sidebar-border: #4d6066;
  --color-sidebar-accent: #374549;
  --color-sidebar-accent-foreground: #c5d1d3;
  --color-card: #1a2225;
  --color-card-foreground: #ffffff;
  --color-success: #41b849;
  --color-success-foreground: #ffffff;
  --color-warning: #ffd452;
  --color-warning-foreground: #21292c;
  --color-info: #37beff;
  --color-info-foreground: #ffffff;
  --color-selection: #374549;
  --color-selection-foreground: #37beff;
  --color-unread: #b88a00;
  --color-chart-1: #37beff;
  --color-chart-2: #41b849;
  --color-chart-3: #ffd452;
  --color-chart-4: #ff5552;
  --color-chart-5: #b48ead;
}`;

// Component-level overrides that the colour tokens alone can't express:
// Roboto typography and Elastic's signature dark "task menu" rail (which is
// dark in both light and dark mode). Scoped under the skin body attribute so
// it cleanly detaches when the theme is switched off.
const elasticSkin = `
body[data-theme-skin="builtin-roundcube-elastic"] {
  font-family: Roboto, "Helvetica Neue", "Segoe UI", Arial, "Noto Sans", sans-serif;
}

/* ── Task menu (left navigation rail) ─────────────────────────── */
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary {
  background-color: #2f3a3f !important;
  border-right: 1px solid rgba(0, 0, 0, 0.25) !important;
}
/* In dark mode the black hairline vanishes against the dark canvas - use a
   light one so the rail still reads as a distinct column. (.dark lives on
   <html>, so it must be an ancestor of the skinned <body>.) */
.dark body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary {
  border-right-color: rgba(255, 255, 255, 0.1) !important;
}
/* Light icons + labels on the dark rail */
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary a,
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary button,
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary .text-muted-foreground {
  color: #e7edee !important;
}
/* Hover slab */
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary a:hover,
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary button:hover {
  background-color: #41525a !important;
  color: #ffffff !important;
}
/* Selected task: brighter slab, accent-blue glyph (matches Elastic) */
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary .bg-primary\\/10 {
  background-color: #41525a !important;
}
body[data-theme-skin="builtin-roundcube-elastic"] .w-14.bg-secondary .text-primary {
  color: #37beff !important;
}

/* ── Flatten Bulwark's soft radii to Elastic's Bootstrap-flat look ── */
/* Elastic uses ~4px corners on buttons/inputs/cards; rounded-full (pills,
   avatars, toggles) is intentionally left alone. */
body[data-theme-skin="builtin-roundcube-elastic"] .rounded-md,
body[data-theme-skin="builtin-roundcube-elastic"] .rounded-lg,
body[data-theme-skin="builtin-roundcube-elastic"] .rounded-xl,
body[data-theme-skin="builtin-roundcube-elastic"] .rounded-2xl,
body[data-theme-skin="builtin-roundcube-elastic"] .rounded-3xl,
body[data-theme-skin="builtin-roundcube-elastic"] input,
body[data-theme-skin="builtin-roundcube-elastic"] textarea,
body[data-theme-skin="builtin-roundcube-elastic"] button:not(.rounded-full) {
  border-radius: 4px !important;
}

/* ── Unify panel backgrounds like Roundcube ───────────────────── */
/* In Elastic the folder list, message list and content pane all share one
   canvas (white / dark); only the narrow task rail is dark. Bulwark's folder
   sidebar uses \`bg-secondary\` (a grey panel), so repaint it with the main
   background. The folder sidebar carries the \`border-r\` class; the dark task
   rail uses \`bg-secondary\` WITHOUT it (inline-styled border), so this
   qualifier leaves the rail dark. */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r {
  background-color: var(--color-background) !important;
}
/* The empty "No conversation selected" pane uses a muted diagonal gradient;
   flatten it to the plain canvas so the content area is one solid colour. */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-gradient-to-br.from-muted\\/30.to-muted\\/50 {
  background: var(--color-background) !important;
}

/* The message-viewer body sits on a faint muted backing (bg-muted/30); flatten
   it to the plain canvas so the whole content pane - search bar, action
   toolbar, mail header and body - is one uniform background colour. The
   search/toolbar/header are bordered \`bg-background\` strips, so they already
   match once we leave them untinted. */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-muted\\/30 {
  background-color: var(--color-background) !important;
}

/* ── Elastic primary buttons (.btn-primary) ──────────────────── */
/* Solid accent fill, white label + icon, hairline border, focus halo. Light
   = @color-main (#37beff); dark = @color-dark-main (darken 30% -> #006a9d)
   with the bright #37beff outline, exactly like the on-switch. */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-primary.text-primary-foreground {
  background-color: #37beff !important;
  border: 1px solid #37beff !important;
  color: #ffffff !important;
}
body[data-theme-skin="builtin-roundcube-elastic"] .bg-primary.text-primary-foreground:hover {
  background-color: #19b6fe !important;
  border-color: #0bb0ff !important;
}
body[data-theme-skin="builtin-roundcube-elastic"] .bg-primary.text-primary-foreground:focus-visible {
  box-shadow: 0 0 0 0.2rem rgba(55, 190, 255, 0.3) !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] .bg-primary.text-primary-foreground {
  background-color: #006a9d !important;
  border-color: #37beff !important;
  color: #ffffff !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] .bg-primary.text-primary-foreground:hover {
  background-color: #0079b3 !important;
}

/* ── Elastic on/off switch (.custom-switch) ──────────────────── */
/* Track + knob restyled to the Bootstrap-derived Elastic switch. The toggle
   is a [role="switch"] button with a single inner <span> knob. */
body[data-theme-skin="builtin-roundcube-elastic"] [role="switch"] {
  background-color: #ced4da !important;
  border: 1px solid #b8c0c8 !important;
}
body[data-theme-skin="builtin-roundcube-elastic"] [role="switch"] > span {
  background-color: #ffffff !important;
}
body[data-theme-skin="builtin-roundcube-elastic"] [role="switch"][aria-checked="true"] {
  background-color: #37beff !important;
  border-color: #37beff !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] [role="switch"] {
  background-color: #4d6066 !important;
  border-color: #5d7077 !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] [role="switch"] > span {
  background-color: #c5d1d3 !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] [role="switch"][aria-checked="true"] {
  background-color: #006a9d !important;
  border-color: #37beff !important;
}

/* ── Recipient name/email rendered as links (like Roundcube) ──── */
/* Sender + recipient triggers (RecipientPopover) sit at \`text-foreground\`
   and only turn blue on hover; Elastic shows them link-blue at rest
   (@color-link #00acff, brighter in dark). The three-class combo is unique
   to these recipient buttons. */
body[data-theme-skin="builtin-roundcube-elastic"] button.hover\\:text-primary.hover\\:underline.cursor-pointer {
  color: #00acff !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] button.hover\\:text-primary.hover\\:underline.cursor-pointer {
  color: #37beff !important;
}
/* The sender's email address printed under the name is muted grey; Roundcube
   shows it link-blue too. It's the div immediately after the name row
   (.flex.items-center.flex-wrap), which the contact-card org line is not, so
   this sibling selector scopes it to the sender email only. */
body[data-theme-skin="builtin-roundcube-elastic"] .flex.items-center.flex-wrap + div.text-muted-foreground.truncate {
  color: #00acff !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] .flex.items-center.flex-wrap + div.text-muted-foreground.truncate {
  color: #37beff !important;
}

/* ── Elastic context / popup menus ───────────────────────────── */
/* Roundcube highlights the hovered menu entry with a solid accent fill and
   white text (@color-menu-hover-background: @color-main, @color-menu-hover:
   #fff) - the same in light and dark. */
body[data-theme-skin="builtin-roundcube-elastic"] [role="menu"] [role="menuitem"]:hover,
body[data-theme-skin="builtin-roundcube-elastic"] [role="menu"] [role="menuitem"]:focus,
body[data-theme-skin="builtin-roundcube-elastic"] [role="menu"] [role="menuitem"]:focus-visible {
  background-color: #37beff !important;
  color: #ffffff !important;
}
/* Icons (currentColor) and muted accessories (shortcuts, submenu chevron)
   follow the white text on hover. */
body[data-theme-skin="builtin-roundcube-elastic"] [role="menu"] [role="menuitem"]:hover svg,
body[data-theme-skin="builtin-roundcube-elastic"] [role="menu"] [role="menuitem"]:focus svg,
body[data-theme-skin="builtin-roundcube-elastic"] [role="menu"] [role="menuitem"]:hover .text-muted-foreground {
  color: #ffffff !important;
}

/* ── Elastic folder list: unread count as a rounded pill ─────── */
/* Roundcube shows the unread count in a small grey pill on the right, and no
   badge at all when a folder has nothing unread. Bulwark renders plain
   "unread / total" text; the counts container is
   span.ml-2.flex-shrink-0.gap-1.items-baseline holding an unread span
   (.font-semibold), an optional "/" (.text-muted-foreground/60) and the total
   (.text-muted-foreground). Reshape it into a pill, drop the total + slash,
   and hide the whole badge when there's no unread span. */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline {
  align-items: center !important;
  justify-content: center;
  min-width: 1.6rem;
  height: 1.2rem;
  padding: 0 0.45rem;
  border-radius: 0.75rem;
  background-color: #e4e8ea;
}
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline > span.text-muted-foreground,
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline > span.text-muted-foreground\\/60 {
  display: none !important;
}
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline > span {
  color: #5e6b70 !important;
  font-weight: 600 !important;
}
/* No unread span -> no badge (matches Sent/Drafts in Roundcube). */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline:not(:has(span.font-semibold)) {
  display: none !important;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline {
  background-color: #3f4e55;
}
.dark body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r span.ml-2.flex-shrink-0.gap-1.items-baseline > span {
  color: #c9d3d5 !important;
}

/* A slightly bolder accent bar on the selected folder, like Elastic. */
body[data-theme-skin="builtin-roundcube-elastic"] .bg-secondary.border-r .border-l-2.border-primary {
  border-left-width: 3px !important;
}`;

// "Aurora Glass" - an ultra-modern glassmorphism skin. Vibrant indigo→cyan
// accents float over a fixed gradient-mesh canvas; every structural surface
// (nav rail, folder sidebar, cards, popovers, menus, dialogs, toolbars) is a
// translucent frosted pane with heavy backdrop-blur + saturation, hairline
// luminous borders and soft glow on the primary action.
//
// The colour tokens stay near-solid for legible text contrast; the frosted
// translucency + blur all live in the skin, where a single selector can pair
// an rgba background with the matching backdrop-filter.
const auroraCSS = `
:root {
  --color-border: rgba(13, 18, 45, 0.10);
  --color-input: rgba(13, 18, 45, 0.12);
  --color-ring: #6d5cff;
  --color-background: #eef1fb;
  --color-foreground: #14162e;
  --color-primary: #6d5cff;
  --color-primary-foreground: #ffffff;
  --color-secondary: #e3e7f7;
  --color-secondary-foreground: #14162e;
  --color-muted: #e7eaf6;
  --color-muted-foreground: #5b6080;
  --color-accent: #e0e7ff;
  --color-accent-foreground: #4338ca;
  --color-destructive: #f43f5e;
  --color-destructive-foreground: #ffffff;
  --color-popover: #ffffff;
  --color-popover-foreground: #14162e;
  --color-sidebar: #eef1fb;
  --color-sidebar-foreground: #14162e;
  --color-sidebar-border: rgba(13, 18, 45, 0.08);
  --color-sidebar-accent: rgba(109, 92, 255, 0.10);
  --color-sidebar-accent-foreground: #4338ca;
  --color-card: #ffffff;
  --color-card-foreground: #14162e;
  --color-success: #10b981;
  --color-success-foreground: #ffffff;
  --color-warning: #f59e0b;
  --color-warning-foreground: #14162e;
  --color-info: #06b6d4;
  --color-info-foreground: #ffffff;
  --color-selection: rgba(109, 92, 255, 0.14);
  --color-selection-foreground: #4338ca;
  --color-unread: #6d5cff;
  --color-chart-1: #6d5cff;
  --color-chart-2: #06b6d4;
  --color-chart-3: #ec4899;
  --color-chart-4: #f59e0b;
  --color-chart-5: #10b981;
}
.dark {
  --color-border: rgba(255, 255, 255, 0.08);
  --color-input: rgba(255, 255, 255, 0.10);
  --color-ring: #8b7bff;
  --color-background: #06070f;
  --color-foreground: #eef0ff;
  --color-primary: #8b7bff;
  --color-primary-foreground: #ffffff;
  --color-secondary: rgba(255, 255, 255, 0.06);
  --color-secondary-foreground: #eef0ff;
  --color-muted: rgba(255, 255, 255, 0.05);
  --color-muted-foreground: #9aa0c4;
  --color-accent: rgba(139, 123, 255, 0.16);
  --color-accent-foreground: #c4bbff;
  --color-destructive: #fb7185;
  --color-destructive-foreground: #1a0b10;
  --color-popover: #12132a;
  --color-popover-foreground: #eef0ff;
  --color-sidebar: #08091a;
  --color-sidebar-foreground: #eef0ff;
  --color-sidebar-border: rgba(255, 255, 255, 0.07);
  --color-sidebar-accent: rgba(139, 123, 255, 0.18);
  --color-sidebar-accent-foreground: #c4bbff;
  --color-card: rgba(255, 255, 255, 0.04);
  --color-card-foreground: #eef0ff;
  --color-success: #34d399;
  --color-success-foreground: #052e1f;
  --color-warning: #fbbf24;
  --color-warning-foreground: #1a1405;
  --color-info: #22d3ee;
  --color-info-foreground: #04222a;
  --color-selection: rgba(139, 123, 255, 0.22);
  --color-selection-foreground: #c4bbff;
  --color-unread: #8b7bff;
  --color-chart-1: #8b7bff;
  --color-chart-2: #22d3ee;
  --color-chart-3: #f472b6;
  --color-chart-4: #fbbf24;
  --color-chart-5: #34d399;
}`;

// Glassmorphism skin: the frosted translucency, backdrop-blur, gradient-mesh
// canvas, luminous borders and glow that the colour tokens alone can't carry.
// Scoped under the skin body attribute so it detaches cleanly on switch-off.
const auroraSkin = `
body[data-theme-skin="builtin-aurora-glass"] {
  font-family: "Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif;
  letter-spacing: -0.01em;
}

/* ── Gradient-mesh canvas ──────────────────────────────────────── */
/* A multi-stop radial mesh painted onto the app-shell root (the unique
   .bg-background.overflow-hidden container) so the frosted panes have
   something luminous to blur. Painting it directly on the shell - rather than
   a fixed body::before with z-indexed children - avoids creating stacking
   contexts on portaled popups/dialogs (Radix portals render as direct <body>
   children), which would otherwise break their layering. */
body[data-theme-skin="builtin-aurora-glass"] .bg-background.overflow-hidden {
  background-color: var(--color-background);
  background-image:
    radial-gradient(60rem 60rem at 12% -10%, rgba(109, 92, 255, 0.22), transparent 60%),
    radial-gradient(50rem 50rem at 105% 5%, rgba(6, 182, 212, 0.18), transparent 55%),
    radial-gradient(55rem 55rem at 80% 110%, rgba(236, 72, 153, 0.16), transparent 60%),
    radial-gradient(45rem 45rem at -5% 95%, rgba(16, 185, 129, 0.12), transparent 55%);
}
.dark body[data-theme-skin="builtin-aurora-glass"] .bg-background.overflow-hidden {
  background-image:
    radial-gradient(60rem 60rem at 12% -10%, rgba(109, 92, 255, 0.16), transparent 58%),
    radial-gradient(50rem 50rem at 105% 5%, rgba(6, 182, 212, 0.11), transparent 52%),
    radial-gradient(55rem 55rem at 80% 110%, rgba(236, 72, 153, 0.10), transparent 58%),
    radial-gradient(45rem 45rem at -5% 95%, rgba(16, 185, 129, 0.07), transparent 52%);
}

/* ── Pill-soft radii everywhere ───────────────────────────────── */
body[data-theme-skin="builtin-aurora-glass"] .rounded-md,
body[data-theme-skin="builtin-aurora-glass"] .rounded-lg {
  border-radius: 0.85rem !important;
}
body[data-theme-skin="builtin-aurora-glass"] .rounded-xl,
body[data-theme-skin="builtin-aurora-glass"] .rounded-2xl {
  border-radius: 1.25rem !important;
}

/* ── Frosted panes: the shared glass recipe ───────────────────── */
/* Nav rail, folder sidebar, content backing, cards, popovers, dialogs and
   menus all share one frosted treatment - translucent fill + heavy backdrop
   blur + saturation so the mesh and neighbours bleed through softly. */
body[data-theme-skin="builtin-aurora-glass"] .w-14.bg-secondary,
body[data-theme-skin="builtin-aurora-glass"] .bg-secondary.border-r {
  background-color: rgba(255, 255, 255, 0.55) !important;
  backdrop-filter: blur(26px) saturate(180%);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  border-color: rgba(13, 18, 45, 0.08) !important;
}
.dark body[data-theme-skin="builtin-aurora-glass"] .w-14.bg-secondary,
.dark body[data-theme-skin="builtin-aurora-glass"] .bg-secondary.border-r {
  background-color: rgba(8, 9, 22, 0.82) !important;
  border-color: rgba(255, 255, 255, 0.07) !important;
}

/* The "no conversation selected" empty pane sits inside an opaque
   bg-background column, so it can't inherit the shell mesh - paint the same
   gradient mesh directly onto it so the placeholder reads as glass too. */
body[data-theme-skin="builtin-aurora-glass"] .bg-gradient-to-br.from-muted\\/30.to-muted\\/50 {
  background-color: var(--color-background) !important;
  background-image:
    radial-gradient(50rem 50rem at 15% 0%, rgba(109, 92, 255, 0.22), transparent 60%),
    radial-gradient(45rem 45rem at 100% 10%, rgba(6, 182, 212, 0.18), transparent 55%),
    radial-gradient(50rem 50rem at 85% 105%, rgba(236, 72, 153, 0.16), transparent 60%) !important;
}
.dark body[data-theme-skin="builtin-aurora-glass"] .bg-gradient-to-br.from-muted\\/30.to-muted\\/50 {
  background-image:
    radial-gradient(50rem 50rem at 15% 0%, rgba(109, 92, 255, 0.18), transparent 58%),
    radial-gradient(45rem 45rem at 100% 10%, rgba(6, 182, 212, 0.12), transparent 52%),
    radial-gradient(50rem 50rem at 85% 105%, rgba(236, 72, 153, 0.11), transparent 58%) !important;
}
/* The reading-pane message backing goes clear glass so the frosted panes and
   gradient bleed through softly. */
body[data-theme-skin="builtin-aurora-glass"] .bg-muted\\/30 {
  background: transparent !important;
}

/* Cards, popovers and dialogs: brighter frosted glass with a luminous edge. */
body[data-theme-skin="builtin-aurora-glass"] .bg-card,
body[data-theme-skin="builtin-aurora-glass"] .bg-popover,
body[data-theme-skin="builtin-aurora-glass"] [role="menu"],
body[data-theme-skin="builtin-aurora-glass"] [role="dialog"],
body[data-theme-skin="builtin-aurora-glass"] [role="listbox"] {
  background-color: rgba(255, 255, 255, 0.72) !important;
  backdrop-filter: blur(28px) saturate(190%);
  -webkit-backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid rgba(255, 255, 255, 0.6) !important;
  box-shadow: 0 12px 40px -12px rgba(20, 22, 46, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.7) !important;
}
.dark body[data-theme-skin="builtin-aurora-glass"] .bg-card,
.dark body[data-theme-skin="builtin-aurora-glass"] .bg-popover,
.dark body[data-theme-skin="builtin-aurora-glass"] [role="menu"],
.dark body[data-theme-skin="builtin-aurora-glass"] [role="dialog"],
.dark body[data-theme-skin="builtin-aurora-glass"] [role="listbox"] {
  background-color: rgba(16, 17, 38, 0.86) !important;
  border: 1px solid rgba(255, 255, 255, 0.10) !important;
  box-shadow: 0 16px 48px -12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
}

/* ── Primary action: gradient fill + glow ─────────────────────── */
body[data-theme-skin="builtin-aurora-glass"] .bg-primary.text-primary-foreground {
  background-image: linear-gradient(135deg, #7c5cff 0%, #6d5cff 45%, #4f9bff 100%) !important;
  border: none !important;
  color: #ffffff !important;
  box-shadow: 0 6px 20px -4px rgba(109, 92, 255, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35) !important;
  transition: box-shadow 160ms ease, filter 160ms ease;
}
body[data-theme-skin="builtin-aurora-glass"] .bg-primary.text-primary-foreground:hover {
  filter: brightness(1.08);
  box-shadow: 0 10px 30px -4px rgba(109, 92, 255, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.4) !important;
}
.dark body[data-theme-skin="builtin-aurora-glass"] .bg-primary.text-primary-foreground {
  background-image: linear-gradient(135deg, #8b7bff 0%, #6d5cff 50%, #22d3ee 130%) !important;
  box-shadow: 0 6px 24px -4px rgba(139, 123, 255, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
}

/* ── Selected folder / row: soft tinted glass + accent bar ────── */
body[data-theme-skin="builtin-aurora-glass"] .bg-secondary.border-r .border-l-2.border-primary {
  border-left-width: 3px !important;
}

/* ── On/off switch: gradient when active ──────────────────────── */
body[data-theme-skin="builtin-aurora-glass"] [role="switch"][aria-checked="true"] {
  background-image: linear-gradient(135deg, #7c5cff, #4f9bff) !important;
  border-color: transparent !important;
  box-shadow: 0 2px 10px -1px rgba(109, 92, 255, 0.6) !important;
}
.dark body[data-theme-skin="builtin-aurora-glass"] [role="switch"][aria-checked="true"] {
  background-image: linear-gradient(135deg, #8b7bff, #22d3ee) !important;
}

/* ── Menu hover: tinted accent slab (keeps glass legible) ─────── */
body[data-theme-skin="builtin-aurora-glass"] [role="menu"] [role="menuitem"]:hover,
body[data-theme-skin="builtin-aurora-glass"] [role="menu"] [role="menuitem"]:focus,
body[data-theme-skin="builtin-aurora-glass"] [role="menu"] [role="menuitem"]:focus-visible {
  background-color: rgba(109, 92, 255, 0.14) !important;
  color: var(--color-foreground) !important;
}
.dark body[data-theme-skin="builtin-aurora-glass"] [role="menu"] [role="menuitem"]:hover,
.dark body[data-theme-skin="builtin-aurora-glass"] [role="menu"] [role="menuitem"]:focus,
.dark body[data-theme-skin="builtin-aurora-glass"] [role="menu"] [role="menuitem"]:focus-visible {
  background-color: rgba(139, 123, 255, 0.22) !important;
}`;

export const BUILTIN_THEMES: InstalledTheme[] = [
  {
    id: 'builtin-flat-fields',
    name: 'Flat fields',
    version: '1.0.0',
    author: 'Built-in',
    description: 'The bulwarkmail.org design system: neutral grounds, square panes, Hanken Grotesk, and raspberry only as a small mark',
    css: flatFieldsCSS,
    skin: flatFieldsSkin,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-qui',
    name: 'Qui',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Clean, modern zinc-and-blue theme inspired by autobrr/qui',
    css: quiCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-nord',
    name: 'Nord',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Arctic, north-bluish color palette inspired by nordtheme.com',
    css: nordCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-catppuccin',
    name: 'Catppuccin',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Soothing pastel theme with Latte (light) and Mocha (dark) variants',
    css: catppuccinCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-solarized',
    name: 'Solarized',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Precision colors for machines and people by Ethan Schoonover',
    css: solarizedCSS,
    variants: ['light', 'dark'],
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-roundcube-elastic',
    name: 'Roundcube Elastic',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Faithful recreation of Roundcube\'s Elastic skin - Roboto, the #37beff blue, and the dark task-menu rail',
    css: elasticCSS,
    skin: elasticSkin,
    variants: ['light', 'dark'],
    typography: { fontSans: 'Roboto, "Helvetica Neue", Arial, sans-serif', baseFontSize: '14px' },
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-aurora-glass',
    name: 'Aurora Glass',
    version: '1.0.0',
    author: 'Built-in',
    description: 'Ultra-modern glassmorphism - frosted blurred panes floating over a vibrant indigo→cyan gradient mesh, with glowing gradient actions',
    css: auroraCSS,
    skin: auroraSkin,
    variants: ['light', 'dark'],
    typography: { fontSans: '"Inter", "SF Pro Display", "Segoe UI", system-ui, sans-serif' },
    enabled: true,
    builtIn: true,
  },
];
