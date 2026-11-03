import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore, listPaneCssSize, COMPOSER_PANE_MIN_HEIGHT } from '../ui-store';

describe('ui-store', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeView: 'list',
      sidebarOpen: false,
      tabletListVisible: true,
      isMobile: false,
      isTablet: false,
      isDesktop: true,
      sidebarWidth: 256,
      emailListWidth: 384,
      sidebarCollapsed: false,
    });
    localStorage.clear();
  });

  describe('listPaneCssSize', () => {
    it('keeps the saved size only while the reading pane keeps its minimum', () => {
      expect(listPaneCssSize(600, 240, 320)).toBe('clamp(240px, calc(100% - 320px), 600px)');
    });

    it('never puts the lower limit above a saved size smaller than it', () => {
      expect(listPaneCssSize(220, 240, 320)).toBe('clamp(220px, calc(100% - 320px), 220px)');
    });

    it('reserves a text-relative height for a composer below the list', () => {
      expect(listPaneCssSize(320, 160, COMPOSER_PANE_MIN_HEIGHT)).toBe('clamp(160px, calc(100% - 30rem), 320px)');
    });
  });

  describe('setSidebarWidth', () => {
    it('should clamp to minimum', () => {
      useUIStore.getState().setSidebarWidth(50);
      expect(useUIStore.getState().sidebarWidth).toBe(180);
    });

    it('should clamp to maximum', () => {
      useUIStore.getState().setSidebarWidth(999);
      expect(useUIStore.getState().sidebarWidth).toBe(400);
    });

    it('should accept values within range', () => {
      useUIStore.getState().setSidebarWidth(300);
      expect(useUIStore.getState().sidebarWidth).toBe(300);
    });
  });

  describe('setEmailListWidth', () => {
    it('should clamp to minimum', () => {
      useUIStore.getState().setEmailListWidth(100);
      expect(useUIStore.getState().emailListWidth).toBe(240);
    });

    it('should clamp to maximum', () => {
      useUIStore.getState().setEmailListWidth(1000);
      expect(useUIStore.getState().emailListWidth).toBe(600);
    });

    it('should accept values within range', () => {
      useUIStore.getState().setEmailListWidth(450);
      expect(useUIStore.getState().emailListWidth).toBe(450);
    });
  });

  describe('resetSidebarWidth', () => {
    it('should reset to default (256)', () => {
      useUIStore.getState().setSidebarWidth(350);
      useUIStore.getState().resetSidebarWidth();
      expect(useUIStore.getState().sidebarWidth).toBe(256);
    });

    it('should persist to localStorage', () => {
      useUIStore.getState().setSidebarWidth(350);
      useUIStore.getState().setEmailListWidth(500);
      useUIStore.getState().resetSidebarWidth();
      const stored = JSON.parse(localStorage.getItem('column-widths')!);
      expect(stored.sidebarWidth).toBe(256);
      expect(stored.emailListWidth).toBe(500);
    });
  });

  describe('resetEmailListWidth', () => {
    it('should reset to default (384)', () => {
      useUIStore.getState().setEmailListWidth(550);
      useUIStore.getState().resetEmailListWidth();
      expect(useUIStore.getState().emailListWidth).toBe(384);
    });

    it('should persist to localStorage', () => {
      useUIStore.getState().setSidebarWidth(300);
      useUIStore.getState().setEmailListWidth(550);
      useUIStore.getState().resetEmailListWidth();
      const stored = JSON.parse(localStorage.getItem('column-widths')!);
      expect(stored.sidebarWidth).toBe(300);
      expect(stored.emailListWidth).toBe(384);
    });
  });

  describe('persistColumnWidths', () => {
    it('should save current widths to localStorage', () => {
      useUIStore.getState().setSidebarWidth(280);
      useUIStore.getState().setEmailListWidth(420);
      useUIStore.getState().persistColumnWidths();
      const stored = JSON.parse(localStorage.getItem('column-widths')!);
      expect(stored.sidebarWidth).toBe(280);
      expect(stored.emailListWidth).toBe(420);
    });
  });

  describe('sidebarCollapsed', () => {
    it('should toggle collapsed state', () => {
      expect(useUIStore.getState().sidebarCollapsed).toBe(false);
      useUIStore.getState().toggleSidebarCollapsed();
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
      useUIStore.getState().toggleSidebarCollapsed();
      expect(useUIStore.getState().sidebarCollapsed).toBe(false);
    });

    it('should set collapsed directly', () => {
      useUIStore.getState().setSidebarCollapsed(true);
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });
  });
});
