import { describe, it, expect } from 'vitest';
import { serverMegabytes } from '@/components/mail-transfer/transfer-progress';

describe('serverMegabytes', () => {
  it('names Stalwart\'s upload quota as the server does', () => {
    expect(serverMegabytes(50_000_000)).toBe('50 MB');
  });
});
