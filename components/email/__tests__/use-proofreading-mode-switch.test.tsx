import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useProofreading } from '../proofreading/use-proofreading';

// Switching to plain text keeps the text, so no new check runs and nothing
// else tells the hook to read the issues again: they were read while the
// textarea wasn't there, which showed "no issues" until the next key press.

vi.mock('@/lib/plugin-sandbox/checkers', () => {
  const checker = [{ pluginId: 'p', id: 'c', label: 'C', mode: 'typing', kinds: [] }];
  return {
    allCheckers: () => checker,
    subscribeCheckers: () => () => {},
    registerCheckTarget: () => () => {},
    dispatchCheck: vi.fn(),
    dispatchCheckerAction: vi.fn(),
  };
});
vi.mock('@/lib/proofreading/composer-proofreader', () => ({
  ComposerProofreader: class {
    constructor(private deps: { readSegments: () => Array<{ id: string; text: string; start: number }> }) {}
    issues() { return this.deps.readSegments().map((s) => ({ key: s.id, from: s.start, to: s.start + 1, kind: 'spelling', annotation: { message: '', replacements: [] } })); }
    status() { return { available: true }; }
    browserSpellcheck() { return true; }
    edited() {}
    sync() {}
    gateChanged() {}
    dispose() {}
  },
}));

const NO_OWN = { current: {} };

function Composer({ plain }: { plain: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { issues } = useProofreading({ composerId: 'c1', sessionKey: 'k1', editor: null, textareaRef, plainTextMode: plain, ownOptions: NO_OWN } as never);
  return (
    <>
      <output data-testid="count">{issues.length}</output>
      {plain && <textarea ref={textareaRef} defaultValue="I will recieve it" />}
    </>
  );
}

describe('useProofreading on a switch to plain text', () => {
  it('reads the issues again once the textarea is there', () => {
    const { rerender } = render(<Composer plain={false} />);
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    act(() => { rerender(<Composer plain />); });
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });
});
