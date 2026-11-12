// A slot callback that sets host state checks what the plugin's frame hands it.
import { describe, expect, it, vi } from 'vitest';
import { textCallback } from '../plugin-sandbox/slot-callbacks';

describe('a text callback handed to a slot', () => {
  it('passes a string on', () => {
    const set = vi.fn();
    textCallback(set, 2000)('https://meet.jit.si/planning');
    expect(set).toHaveBeenCalledWith('https://meet.jit.si/planning');
  });

  it('cuts a string at its limit', () => {
    const set = vi.fn();
    textCallback(set, 2000)(`https://meet.example/${'x'.repeat(5000)}`);
    expect(set.mock.calls[0][0]).toHaveLength(2000);
  });

  it.each([
    ['an object', { not: 'a link' }],
    ['a number', 42],
    ['nothing', undefined],
    ['null', null],
    ['an array', ['https://meet.example/a']],
  ])('ignores %s', (_, value) => {
    const set = vi.fn();
    textCallback(set, 2000)(value);
    expect(set).not.toHaveBeenCalled();
  });
});
