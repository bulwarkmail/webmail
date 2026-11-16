export interface Rgba { r: number; g: number; b: number; a: number }

export interface EmailDarkModeEngineOptions {
  canvas?: Rgba | string;
  remoteContentAllowed?: boolean;
}

export interface EmailDarkModeEngine {
  parseComputedColor(value: string): Rgba | null;
  parseColor(value: string, doc?: Document): Rgba | null;
  formatColor(color: Rgba): string;
  contrastRatio(x: Rgba, y: Rgba): number;
  darkenBackground(color: Rgba, canvas?: Rgba): Rgba;
  adaptTextColor(color: Rgba, bg: Rgba, bgOriginal: Rgba): Rgba;
  readSurfaceColor(el: Element, fallback?: Rgba): Rgba;
  judgeImagePixels(data: Uint8ClampedArray, bg: Rgba): 'flip' | 'fine';
  flipFilterMatrix(canvas: Rgba): number[];
  hasImage(backgroundImage: string): boolean;
  apply(doc: Document, options?: EmailDarkModeEngineOptions): Promise<void>;
}

declare const createEmailDarkModeEngine: () => EmailDarkModeEngine;
export default createEmailDarkModeEngine;
