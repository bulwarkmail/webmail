import { describe, expect, it } from 'vitest';
import config from '../../next.config';

describe('webpack build worker', () => {
  // Next turns the workers off for a config with a webpack hook unless the
  // option is set, and the Docker build then runs out of heap (#1510).
  it('stays on although next-intl adds a webpack hook', () => {
    expect(config.webpack).toBeTypeOf('function');
    expect(config.experimental?.webpackBuildWorker).toBe(true);
  });
});
