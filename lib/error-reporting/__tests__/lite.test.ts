// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { liteErrorReporting } from '../lite';

const DSN = 'https://6f0b9c79ed3a4315b76595bc2536ac40@errors.example.org/3';

// Bulwark Lite has no server: policy.json carries the error reporting address.
describe('Lite error reporting from policy.json', () => {
  it('is off without a valid DSN', () => {
    expect(liteErrorReporting({})).toBeNull();
    expect(liteErrorReporting(null)).toBeNull();
    expect(liteErrorReporting({ errorReporting: { dsn: 'not a dsn' } })).toBeNull();
  });

  it('reads the DSN, sample rate and environment, and never asks for server-side counting', () => {
    expect(liteErrorReporting({ errorReporting: { dsn: DSN, sampleRate: 0.25, environment: 'lite-prod' } }))
      .toEqual({ dsn: DSN, sampleRate: 0.25, environment: 'lite-prod', collect: false });
    expect(liteErrorReporting({ errorReporting: { dsn: DSN, sampleRate: 7, environment: 'bad env!' } }))
      .toEqual({ dsn: DSN, sampleRate: 1, environment: 'production', collect: false });
  });
});
