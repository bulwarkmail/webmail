/**
 * A size as a percentage in the language's own style: "87.5%" in English, "87,5 %" in
 * German. Settings showed four styles side by side ("87.5%", "88 %", "12 px", "14px");
 * percentages come from here, pixel sizes from the "{size} px" string (settings-p3-20).
 */
export function percentLabel(fraction: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(fraction);
  } catch {
    return `${Math.round(fraction * 1000) / 10}%`;
  }
}
