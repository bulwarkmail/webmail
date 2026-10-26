// Step 42: the background under the web client, as in the new Outlook — a
// picture or a colour gradient behind the window, with see-through, blurred
// navigation on top of it. The platform stores only a code (the person's own
// choice and the company's default); this list is the client's.

export type BackgroundKind = "image" | "gradient";

export interface Background {
  id: string;
  kind: BackgroundKind;
  /** Key under `background.names` in lib/xenaxio/messages-*.json. */
  name: string;
  /** Highlight colour that suits the background (#rrggbb), per colour mode. */
  accent: { light: string; dark: string };
  /** CSS `background` of the window, per colour mode. */
  css: { light: string; dark: string };
  /** The same, blurred: under the see-through navigation (frosted glass). */
  soft: { light: string; dark: string };
  /** CSS `background` of a small preview tile, per colour mode. */
  preview: { light: string; dark: string };
}

const IMAGE_DIR = "/xenaxio/backgrounds";

function image(id: string, name: string, accent: Background["accent"]): Background {
  const url = (mode: string, variant = "") => `url("${IMAGE_DIR}/${id}-${mode}${variant}.webp")`;
  return {
    id,
    kind: "image",
    name,
    accent,
    css: { light: `${url("light")} center / cover no-repeat`, dark: `${url("dark")} center / cover no-repeat` },
    soft: { light: `${url("light", "-blur")} center / cover no-repeat`, dark: `${url("dark", "-blur")} center / cover no-repeat` },
    preview: { light: `${url("light", "-thumb")} center / cover no-repeat`, dark: `${url("dark", "-thumb")} center / cover no-repeat` },
  };
}

/** Soft colour clouds over a tinted base, like Outlook's "Colors". */
function gradient(id: string, name: string, accent: Background["accent"], light: [string, string, string, string], dark: [string, string, string, string]): Background {
  const mesh = ([base, a, b, c]: [string, string, string, string]) =>
    [
      `radial-gradient(60% 80% at 12% 18%, ${a} 0%, transparent 70%)`,
      `radial-gradient(55% 75% at 88% 12%, ${b} 0%, transparent 70%)`,
      `radial-gradient(70% 90% at 70% 100%, ${c} 0%, transparent 70%)`,
      base,
    ].join(", ");
  const css = { light: mesh(light), dark: mesh(dark) };
  // Already soft: the gradient is its own frosted copy.
  return { id, kind: "gradient", name, accent, css, soft: css, preview: css };
}

export const BACKGROUNDS: readonly Background[] = [
  image("img-mountains", "mountains", { light: "#3d5a80", dark: "#8fb3e0" }),
  image("img-dunes", "dunes", { light: "#b4612f", dark: "#f0956a" }),
  image("img-sea", "sea", { light: "#1f5fa8", dark: "#9a8cf0" }),
  image("img-aurora", "aurora", { light: "#16866b", dark: "#2fd3a2" }),
  image("img-bloom", "bloom", { light: "#9333ea", dark: "#d48cff" }),
  image("img-hills", "hills", { light: "#2f7048", dark: "#6fc28c" }),
  gradient("grad-blue", "blue", { light: "#2563eb", dark: "#7aa7ff" }, ["#eef4ff", "#b9d3ff", "#c9c3ff", "#a9e4ff"], ["#0a1020", "#1d3a7a", "#33276b", "#0f4a6a"]),
  gradient("grad-violet", "violet", { light: "#7c3aed", dark: "#b794ff" }, ["#f5f0ff", "#d8c4ff", "#f3c1f0", "#bfc8ff"], ["#110a20", "#3d2380", "#5a1f63", "#262f7a"]),
  gradient("grad-pink", "pink", { light: "#db2777", dark: "#ff8cc0" }, ["#fff0f6", "#ffc1dc", "#e8c4ff", "#ffd2c2"], ["#1a0a12", "#6b1d48", "#4a1f6b", "#6b2a24"]),
  gradient("grad-orange", "orange", { light: "#c2410c", dark: "#ffa36a" }, ["#fff5ec", "#ffcfa6", "#ffe3a3", "#ffb8a8"], ["#1a0f08", "#7a3412", "#6b4a10", "#6b1f1f"]),
  gradient("grad-red", "red", { light: "#dc2646", dark: "#ff8a9a" }, ["#fff0f1", "#ffbcc5", "#ffd0b8", "#f4c0e0"], ["#1a080b", "#7a1a2a", "#6b2f14", "#5a1a48"]),
  gradient("grad-green", "green", { light: "#15803d", dark: "#6fdc9a" }, ["#effaf3", "#b8ebcb", "#d3f0b0", "#b0e4e0"], ["#08140d", "#14532d", "#3f5a12", "#0f4a46"]),
];

const BY_ID = new Map(BACKGROUNDS.map((b) => [b.id, b]));

/** The person's choice that means "no background", whatever the company's. */
export const NO_BACKGROUND = "none";

export function findBackground(id: string | null | undefined): Background | null {
  return (id && BY_ID.get(id)) || null;
}

/**
 * The background to show: the person's own choice; without one (or one this
 * client no longer has) the company's default; "none" — none.
 */
export function effectiveBackground(own: string | null | undefined, company: string | null | undefined): Background | null {
  if (own === NO_BACKGROUND) return null;
  return findBackground(own) ?? findBackground(company);
}

// --- CSS ----------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** White or near-black text on `color`, whichever reads better. */
function textOn(color: string): string {
  const l = luminance(color);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0556 ? "#ffffff" : "#111111";
}

/**
 * Stylesheet of the chosen background: the picture or gradient per colour
 * mode, and its highlight colour unless the company has its own (a company
 * colour is the company's identity and stays). Only values of the list above
 * reach it, never text from the server.
 */
export function backgroundCss(bg: Background, companyColor: string | null | undefined): string {
  let css =
    `html:not(.dark){--xenaxio-bg:${bg.css.light};--xenaxio-bg-soft:${bg.soft.light};}` +
    `html.dark{--xenaxio-bg:${bg.css.dark};--xenaxio-bg-soft:${bg.soft.dark};}`;
  if (!(companyColor && HEX.test(companyColor))) {
    // The soft highlight (selected folder, hovered rows) follows the accent too.
    const vars = (c: string) =>
      `--color-primary:${c};--color-primary-foreground:${textOn(c)};--color-ring:${c};` +
      `--color-accent:color-mix(in oklab, ${c} 22%, var(--color-background));--color-accent-foreground:color-mix(in oklab, ${c} 70%, var(--color-foreground));`;
    css += `html:not(.dark){${vars(bg.accent.light)}}html.dark{${vars(bg.accent.dark)}}`;
  }
  return css;
}
