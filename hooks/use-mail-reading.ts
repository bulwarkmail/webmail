"use client";

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/stores/settings-store";
import { useThemeStore } from "@/stores/theme-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  appFontFamilyName,
  collectFontFaces,
  mailFrameCss,
  mailOverrideActive,
  mailTextFactor,
  plainBodyFontSize,
  readingCardWidth,
  resolveSystemToggle,
  type MailOverride,
} from "@/lib/mail-reading";

/**
 * The reading settings as they apply to the message open right now: "follow
 * the system" values resolved against the OS, and the values the body frame
 * and the plain-text body need. Shared by the reader and the conversation
 * view so a message reads the same in both.
 */
export interface MailReading {
  /** Multiplier on the mail's text sizes. */
  textFactor: number;
  /** Smallest text size in the body, CSS px; 0 = none. */
  minFontSize: number;
  /** Windows contrast themes and the like: the browser picks the colours. */
  forcedColors: boolean;
  /** Reduce motion, resolved: stop animations inside the mail too. */
  reduceMotion: boolean;
  /** Show animated images as a still frame with a Play button. */
  pauseImages: boolean;
  /** The sender's fonts, sizes and colours give way to the app's. */
  overrideStyles: boolean;
  /** Reading width "comfortable": lines of about 80 characters. */
  comfortableWidth: boolean;
  /** The message reads as a card on the pane: comfortable width on a wide screen. */
  card: boolean;
  /** Widest the message card gets (CSS length). */
  cardWidth: string;
  /** Scale mail wider than the pane down to fit, on any screen. */
  fitWidth: boolean;
  /** Font size for a plain-text body of `basePx` at 100 %. */
  plainFontSize: (basePx: number) => string;
  /** CSS appended to the mail document for the settings above; may be empty. */
  frameCss: string;
  /** Folders of app fonts the mail document may load (its CSP font-src). */
  fontSources: string[];
  /** Changes whenever the body frame has to be built again. */
  frameKey: string;
}

/**
 * The app's colours and font right now, read from the page's own styles. The
 * background is the surface the message sits on: the card's, on a card.
 */
function readAppTheme(card: boolean): Pick<MailOverride, 'fontFamily' | 'foreground' | 'background' | 'link'> {
  if (typeof document === 'undefined') return { fontFamily: '', foreground: '', background: '', link: '' };
  const root = getComputedStyle(document.documentElement);
  const body = document.body ? getComputedStyle(document.body) : null;
  return {
    fontFamily: body?.fontFamily || root.getPropertyValue('--font-sans'),
    foreground: root.getPropertyValue('--color-foreground') || body?.color || '',
    background: root.getPropertyValue(card ? '--color-card' : '--color-background') || '',
    link: root.getPropertyValue('--color-primary') || '',
  };
}

/** `wide`: the message is shown on a wide screen, where comfortable width puts it on a card. */
export function useMailReading({ wide = false }: { wide?: boolean } = {}): MailReading {
  const s = useSettingsStore(useShallow((state) => ({
    fontSize: state.fontSize,
    mailTextScale: state.mailTextScale,
    mailMinFontSize: state.mailMinFontSize,
    reduceMotion: state.reduceMotion,
    mailOverrideStyles: state.mailOverrideStyles,
    contrast: state.contrast,
    appFont: state.appFont,
    lineSpacing: state.lineSpacing,
    letterSpacing: state.letterSpacing,
    wordSpacing: state.wordSpacing,
    paragraphSpacing: state.paragraphSpacing,
    underlineLinks: state.underlineLinks,
    readingWidth: state.readingWidth,
    mailFitWidth: state.mailFitWidth,
    pauseAnimatedImages: state.pauseAnimatedImages,
  })));
  // The theme's colours are read from the page, so a theme change re-reads them.
  const theme = useThemeStore((state) => `${state.resolvedTheme}/${state.activeThemeId ?? ''}`);
  const forcedColors = useMediaQuery("(forced-colors: active)");
  const systemReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const systemMoreContrast = useMediaQuery("(prefers-contrast: more)");

  return useMemo(() => {
    const textFactor = mailTextFactor(s.mailTextScale, s.fontSize);
    const minFontSize = s.mailMinFontSize || 0;
    const reduceMotion = resolveSystemToggle(s.reduceMotion, systemReducedMotion);
    // "System" follows reduce motion, which itself may follow the OS.
    const pauseImages = resolveSystemToggle(s.pauseAnimatedImages, reduceMotion);
    const overrideStyles = mailOverrideActive(s.mailOverrideStyles, s.contrast, systemMoreContrast);
    const comfortableWidth = s.readingWidth === 'comfortable';
    const card = comfortableWidth && wide;
    let override: MailOverride | null = null;
    let fontFaces = { css: '', sources: [] as string[] };
    if (overrideStyles) {
      override = {
        ...readAppTheme(card),
        lineSpacing: s.lineSpacing,
        letterSpacing: s.letterSpacing,
        wordSpacing: s.wordSpacing,
        paragraphSpacing: s.paragraphSpacing,
        textFactor,
        minPx: minFontSize,
      };
      const family = appFontFamilyName(s.appFont);
      if (family && typeof document !== 'undefined') fontFaces = collectFontFaces(document, family);
    }
    return {
      textFactor,
      minFontSize,
      comfortableWidth,
      card,
      cardWidth: readingCardWidth(s.mailTextScale, s.fontSize, minFontSize),
      fitWidth: s.mailFitWidth,
      forcedColors,
      reduceMotion,
      pauseImages,
      overrideStyles,
      plainFontSize: (basePx: number) => plainBodyFontSize(basePx, s.mailTextScale, s.fontSize, minFontSize),
      frameCss: mailFrameCss({ reduceMotion, underlineLinks: s.underlineLinks, comfortableWidth, override, fontFaceCss: fontFaces.css }),
      fontSources: fontFaces.sources,
      frameKey: `${textFactor}/${minFontSize}${overrideStyles ? '/o' : ''}${s.mailFitWidth ? '/f' : ''}${pauseImages ? '/p' : ''}`,
    };
    // `theme` only marks that the page's colours changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, wide, forcedColors, systemReducedMotion, systemMoreContrast, theme]);
}
