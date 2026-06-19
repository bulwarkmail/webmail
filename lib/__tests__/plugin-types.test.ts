import { describe, it, expect } from 'vitest';
import {
  ALL_PERMISSIONS,
  IMPLICIT_PERMISSIONS,
  MAX_PLUGIN_SIZE,
  MAX_THEME_SIZE,
  ALLOWED_PLUGIN_FILES,
  DISALLOWED_CSS_PATTERNS,
} from '../plugin-types';

describe('plugin-types constants', () => {
  describe('ALL_PERMISSIONS', () => {
    it('contains at least 30 permissions', () => {
      expect(ALL_PERMISSIONS.length).toBeGreaterThanOrEqual(30);
    });

    it('has no duplicates', () => {
      const unique = new Set(ALL_PERMISSIONS);
      expect(unique.size).toBe(ALL_PERMISSIONS.length);
    });

    it('all permissions follow domain:action format', () => {
      for (const perm of ALL_PERMISSIONS) {
        expect(perm).toMatch(/^[a-z]+:[a-z-]+$/);
      }
    });

    it('includes core email/calendar/contacts permissions', () => {
      expect(ALL_PERMISSIONS).toContain('email:read');
      expect(ALL_PERMISSIONS).toContain('email:write');
      expect(ALL_PERMISSIONS).toContain('email:send');
      expect(ALL_PERMISSIONS).toContain('calendar:read');
      expect(ALL_PERMISSIONS).toContain('calendar:write');
      expect(ALL_PERMISSIONS).toContain('contacts:read');
      expect(ALL_PERMISSIONS).toContain('contacts:write');
    });

    it('includes UI permissions for all slot types', () => {
      expect(ALL_PERMISSIONS).toContain('ui:toolbar');
      expect(ALL_PERMISSIONS).toContain('ui:email-banner');
      expect(ALL_PERMISSIONS).toContain('ui:email-footer');
      expect(ALL_PERMISSIONS).toContain('ui:composer-toolbar');
      expect(ALL_PERMISSIONS).toContain('ui:sidebar-widget');
      expect(ALL_PERMISSIONS).toContain('ui:settings-section');
      expect(ALL_PERMISSIONS).toContain('ui:context-menu');
      expect(ALL_PERMISSIONS).toContain('ui:navigation-rail');
    });
  });

  describe('IMPLICIT_PERMISSIONS', () => {
    it('contains ui:observe and app:lifecycle', () => {
      expect(IMPLICIT_PERMISSIONS).toContain('ui:observe');
      expect(IMPLICIT_PERMISSIONS).toContain('app:lifecycle');
    });

    it('has exactly 2 implicit permissions', () => {
      expect(IMPLICIT_PERMISSIONS).toHaveLength(2);
    });

    it('implicit permissions are in ALL_PERMISSIONS', () => {
      for (const perm of IMPLICIT_PERMISSIONS) {
        expect(ALL_PERMISSIONS).toContain(perm);
      }
    });
  });

  describe('size limits', () => {
    it('MAX_PLUGIN_SIZE is 5 MB', () => {
      expect(MAX_PLUGIN_SIZE).toBe(5 * 1024 * 1024);
    });

    it('MAX_THEME_SIZE is 2 MB', () => {
      expect(MAX_THEME_SIZE).toBe(2 * 1024 * 1024);
    });
  });

  describe('ALLOWED_PLUGIN_FILES', () => {
    it('allows JavaScript files', () => {
      expect(ALLOWED_PLUGIN_FILES.has('.js')).toBe(true);
      expect(ALLOWED_PLUGIN_FILES.has('.mjs')).toBe(true);
    });

    it('allows assets', () => {
      expect(ALLOWED_PLUGIN_FILES.has('.css')).toBe(true);
      expect(ALLOWED_PLUGIN_FILES.has('.json')).toBe(true);
      expect(ALLOWED_PLUGIN_FILES.has('.png')).toBe(true);
      expect(ALLOWED_PLUGIN_FILES.has('.svg')).toBe(true);
    });

    it('does not allow executable types', () => {
      expect(ALLOWED_PLUGIN_FILES.has('.exe')).toBe(false);
      expect(ALLOWED_PLUGIN_FILES.has('.sh')).toBe(false);
      expect(ALLOWED_PLUGIN_FILES.has('.bat')).toBe(false);
      expect(ALLOWED_PLUGIN_FILES.has('.html')).toBe(false);
    });
  });

  describe('DISALLOWED_CSS_PATTERNS', () => {
    it('blocks @import', () => {
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test('@import url("evil.css")'));
      expect(match).toBe(true);
    });

    it('blocks external URLs', () => {
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test('background: url("https://evil.com/track.png")'));
      expect(match).toBe(true);
    });

    it('blocks javascript: in CSS', () => {
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test('background: javascript:alert(1)'));
      expect(match).toBe(true);
    });

    it('blocks expression()', () => {
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test('width: expression(document.body.clientWidth)'));
      expect(match).toBe(true);
    });

    it('blocks -moz-binding', () => {
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test('-moz-binding: url("evil.xml#xbl")'));
      expect(match).toBe(true);
    });

    it('blocks behavior:', () => {
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test('behavior: url(evil.htc)'));
      expect(match).toBe(true);
    });

    it('allows safe CSS', () => {
      const safeCSS = ':root { --color-primary: #3b82f6; }';
      const match = DISALLOWED_CSS_PATTERNS.some(p => p.test(safeCSS));
      expect(match).toBe(false);
    });
  });
});
