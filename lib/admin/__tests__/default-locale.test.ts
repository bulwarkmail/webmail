import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../config-manager', () => ({ configManager: { get } }));

import { resolveDefaultLocale } from '../default-locale';
import { routing } from '@/i18n/routing';

describe('resolveDefaultLocale', () => {
  beforeEach(() => get.mockReset());

  it('uses the configured locale when it is one we ship', () => {
    get.mockReturnValue('pt');
    expect(resolveDefaultLocale()).toBe('pt');
    expect(get).toHaveBeenCalledWith('defaultLocale', '');
  });

  it('falls back to the build-time default when unset', () => {
    get.mockReturnValue('');
    expect(resolveDefaultLocale()).toBe(routing.defaultLocale);
  });

  it('survives a malformed config.json value instead of throwing per request', () => {
    get.mockReturnValue(null);
    expect(resolveDefaultLocale()).toBe(routing.defaultLocale);
    get.mockReturnValue(42);
    expect(resolveDefaultLocale()).toBe(routing.defaultLocale);
  });

  it('ignores a locale we do not ship (regional tags are not catalogues)', () => {
    get.mockReturnValue('pt-BR');
    expect(resolveDefaultLocale()).toBe(routing.defaultLocale);
    get.mockReturnValue(' xx ');
    expect(resolveDefaultLocale()).toBe(routing.defaultLocale);
  });
});
