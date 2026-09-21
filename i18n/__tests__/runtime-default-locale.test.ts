import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultLocale, setRuntimeDefaultLocale } from '../runtime-default-locale';
import { routing } from '../routing';

describe('runtime default locale', () => {
  afterEach(() => setRuntimeDefaultLocale(undefined));

  it('starts at the build-time default', () => {
    expect(getDefaultLocale()).toBe(routing.defaultLocale);
  });

  it('follows the server-resolved value once /api/config arrives', () => {
    setRuntimeDefaultLocale('pt');
    expect(getDefaultLocale()).toBe('pt');
  });

  it('drops values that are not shipped locales', () => {
    setRuntimeDefaultLocale('pt-BR');
    expect(getDefaultLocale()).toBe(routing.defaultLocale);
    setRuntimeDefaultLocale(42);
    expect(getDefaultLocale()).toBe(routing.defaultLocale);
  });
});
