import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withStableHandlers } from '../with-stable-handlers';

// The mail page hands the rail and the pane handles new inline handlers on
// every render. Wrapped, they draw again only when another prop changes, and
// a click still reaches the handler of the latest render.

let renders = 0;
function Button({ label, onPress }: { label: string; onPress?: () => void }) {
  renders++;
  return <button onClick={onPress}>{label}</button>;
}
const StableButton = withStableHandlers(Button);

describe('withStableHandlers', () => {
  it('skips renders that only bring new handlers, and calls the latest one', () => {
    const seen: number[] = [];
    const { rerender } = render(<StableButton label="Mail" onPress={() => seen.push(1)} />);
    const first = renders;
    rerender(<StableButton label="Mail" onPress={() => seen.push(2)} />);
    expect(renders).toBe(first);
    fireEvent.click(screen.getByText('Mail'));
    expect(seen).toEqual([2]);
    rerender(<StableButton label="Inbox" onPress={() => seen.push(3)} />);
    expect(renders).toBe(first + 1);
    expect(screen.getByText('Inbox')).toBeTruthy();
  });
});
