/**
 * Matching a colour a server gives us to the closest tag colour we have.
 *
 * A tag's colour lives in this browser, as a key of `KEYWORD_PALETTE`. Some
 * servers keep a colour of their own for the same tag - a Gmail bridge does,
 * because a Gmail label carries the colour the user picked in Gmail - and they
 * express it the only way a server can: a hex value. This turns one into the
 * other, so a recovered tag comes back looking like the tag the user made
 * rather than a hash-picked hue.
 *
 * The match is made in hue and lightness rather than by distance in RGB.
 * Distance in RGB reads a pale blue as very nearly a pale grey - they differ
 * by less than a third of what separates two greens - and Gmail's label
 * palette is mostly pale. Hue first, then the row whose lightness is nearest,
 * keeps `#b6cff5` a light blue instead of losing it to grey.
 */
import { KEYWORD_PALETTE } from "@/stores/settings-store";

/** The hex behind each palette key: Tailwind 300 (light row), 500 (base), 700 (dark). */
const PALETTE_HEX: Record<string, [string, string, string]> = {
  red: ["#fca5a5", "#ef4444", "#b91c1c"],
  orange: ["#fdba74", "#f97316", "#c2410c"],
  amber: ["#fcd34d", "#f59e0b", "#b45309"],
  yellow: ["#fde047", "#eab308", "#a16207"],
  lime: ["#bef264", "#84cc16", "#4d7c0f"],
  green: ["#86efac", "#22c55e", "#15803d"],
  teal: ["#5eead4", "#14b8a6", "#0f766e"],
  cyan: ["#67e8f9", "#06b6d4", "#0e7490"],
  blue: ["#93c5fd", "#3b82f6", "#1d4ed8"],
  indigo: ["#a5b4fc", "#6366f1", "#4338ca"],
  purple: ["#d8b4fe", "#a855f7", "#7e22ce"],
  pink: ["#f9a8d4", "#ec4899", "#be185d"],
  gray: ["#d1d5db", "#6b7280", "#374151"],
};
/** Suffix of each row of `PALETTE_HEX`, in the same order. */
const ROWS = ["-light", "", "-dark"] as const;
/** Below this saturation a colour is a shade of grey, whatever hue the arithmetic finds in it. */
const GRAY_SATURATION = 0.15;

interface HSL {
  hue: number;
  saturation: number;
  lightness: number;
}

/** `#rgb` or `#rrggbb` as hue (degrees), saturation and lightness, or null for anything else. */
function parseHsl(color: string): HSL | null {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const span = max - min;
  if (span === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = span / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r
      ? 60 * (((g - b) / span + 6) % 6)
      : max === g
        ? 60 * ((b - r) / span + 2)
        : 60 * ((r - g) / span + 4);
  return { hue, saturation, lightness };
}

/** Degrees between two hues the short way round the circle. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The palette key closest to `color`, or null if it is not a hex colour this
 * can read - in which case the caller should fall back to its own suggestion
 * rather than pretend the server said something.
 */
export function nearestKeywordColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const target = parseHsl(color);
  if (!target) return null;

  // Hue: the named colour whose own base shade sits closest round the circle.
  // A colour with no hue worth speaking of is grey, however the arithmetic
  // happened to land.
  let hue = "gray";
  if (target.saturation >= GRAY_SATURATION) {
    let best = Infinity;
    for (const [name, shades] of Object.entries(PALETTE_HEX)) {
      if (name === "gray") continue;
      const base = parseHsl(shades[1]);
      if (!base) continue;
      const d = hueDistance(target.hue, base.hue);
      if (d < best) {
        best = d;
        hue = name;
      }
    }
  }

  // Row: of that hue's three shades, the one this colour is as light as.
  let row = 1;
  let best = Infinity;
  PALETTE_HEX[hue].forEach((shade, index) => {
    const candidate = parseHsl(shade);
    if (!candidate) return;
    const d = Math.abs(candidate.lightness - target.lightness);
    if (d < best) {
      best = d;
      row = index;
    }
  });

  const key = hue + ROWS[row];
  return key in KEYWORD_PALETTE ? key : null;
}
