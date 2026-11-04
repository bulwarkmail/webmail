/**
 * The scripts' breakpoints follow the browser's default text size, as the
 * CSS breakpoints (Tailwind's rem) do. With a 32px default a 1100px window is
 * about 34rem wide: the CSS draws the phone layout, so the scripts must pick
 * it too, or the mail screen showed only the reading pane with no list (LV-11).
 *
 * The layout classes: a phone below 600px, a compact desktop (the folder
 * sidebar folded to icons) up to 1024px, the full desktop above. A window
 * snapped to half a screen and a laptop at 150 % (911px) are desktops
 * (usability test 2026-11-04, mail-28 and settings-16).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import {
  useIsMobile, useIsDesktop, useIsFullDesktop, useDeviceDetection,
  classifyWidth, narrowerThan, atLeast,
} from '../use-media-query';
import { useSplitPanesFit } from '../use-split-panes-fit';
import { PaneSizeContext } from '../use-pane-size';

/** A window `px` wide whose default text size is `rootPx`. */
function viewport(px: number, rootPx = 16) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /\(width (<|>=) ([\d.]+)rem\)/.exec(query);
    const matches = m ? (m[1] === '<' ? px < Number(m[2]) * rootPx : px >= Number(m[2]) * rootPx) : false;
    return { matches, media: query, addEventListener() {}, removeEventListener() {} };
  });
}

/** Renders inside a Pro pane `width` px wide. */
const inPane = (width: number) => ({ children }: { children: ReactNode }) =>
  createElement(PaneSizeContext.Provider, { value: width }, children);

afterEach(() => vi.unstubAllGlobals());

describe('breakpoints', () => {
  it('writes the queries in rem, as Tailwind does', () => {
    expect(narrowerThan(600)).toBe('(width < 37.5rem)');
    expect(atLeast(1024)).toBe('(width >= 64rem)');
  });

  it('is a desktop at 1440px with the default 16px text', () => {
    viewport(1440);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(true);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });

  it('is a phone at 1100px when the browser text size is 32px', () => {
    viewport(1100, 32);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(false);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
  });
});

describe('classifyWidth', () => {
  it('draws the phone layout only below 600px', () => {
    expect(classifyWidth(390)).toEqual({ isMobile: true, isCompact: false, isDesktop: false });
    expect(classifyWidth(599)).toEqual({ isMobile: true, isCompact: false, isDesktop: false });
    expect(classifyWidth(600)).toEqual({ isMobile: false, isCompact: true, isDesktop: true });
  });

  it('draws a compact desktop up to the full desktop at 1024px', () => {
    for (const w of [640, 800, 853, 911, 1023]) {
      expect(classifyWidth(w)).toEqual({ isMobile: false, isCompact: true, isDesktop: true });
    }
    expect(classifyWidth(1024)).toEqual({ isMobile: false, isCompact: false, isDesktop: true });
    expect(classifyWidth(1366)).toEqual({ isMobile: false, isCompact: false, isDesktop: true });
  });
});

describe('the window', () => {
  it('is a desktop at half a screen and at 150 % on a 1366px laptop', () => {
    for (const w of [640, 800, 911]) {
      viewport(w);
      expect(renderHook(() => useIsDesktop()).result.current).toBe(true);
      expect(renderHook(() => useIsMobile()).result.current).toBe(false);
      expect(renderHook(() => useIsFullDesktop()).result.current).toBe(false);
    }
  });

  it('is a phone below 600px', () => {
    viewport(599);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(false);
  });

  it('puts the list beside the reader from 840px', () => {
    viewport(839);
    expect(renderHook(() => useSplitPanesFit()).result.current).toBe(false);
    viewport(911);
    expect(renderHook(() => useSplitPanesFit()).result.current).toBe(true);
  });
});

describe('a Pro pane', () => {
  it('classifies by its own width, not the window', () => {
    viewport(1920);
    expect(renderHook(() => useDeviceDetection(), { wrapper: inPane(500) }).result.current)
      .toEqual({ isMobile: true, isCompact: false, isDesktop: false });
    expect(renderHook(() => useDeviceDetection(), { wrapper: inPane(700) }).result.current)
      .toEqual({ isMobile: false, isCompact: true, isDesktop: true });
    expect(renderHook(() => useDeviceDetection(), { wrapper: inPane(1100) }).result.current)
      .toEqual({ isMobile: false, isCompact: false, isDesktop: true });
  });

  it('answers the single hooks by its width too', () => {
    viewport(1920);
    expect(renderHook(() => useIsMobile(), { wrapper: inPane(599) }).result.current).toBe(true);
    expect(renderHook(() => useIsDesktop(), { wrapper: inPane(600) }).result.current).toBe(true);
    expect(renderHook(() => useIsFullDesktop(), { wrapper: inPane(900) }).result.current).toBe(false);
    expect(renderHook(() => useSplitPanesFit(), { wrapper: inPane(800) }).result.current).toBe(false);
  });
});
