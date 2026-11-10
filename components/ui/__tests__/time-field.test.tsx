import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeField } from '../time-field';
import { useSettingsStore } from '@/stores/settings-store';

function Harness({ initial, onValue }: { initial: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="t">Start</label>
      <TimeField id="t" value={value} onChange={(v) => { setValue(v); onValue?.(v); }} />
      <output data-testid="value">{value}</output>
    </>
  );
}

const input = () => screen.getByLabelText('Start') as HTMLInputElement;
const value = () => screen.getByTestId('value').textContent;

afterEach(() => useSettingsStore.setState({ timeFormat: '24h' }));

describe('TimeField (#1616)', () => {
  it('shows the time in the app setting, not the browser language', () => {
    useSettingsStore.setState({ timeFormat: '24h' });
    const { unmount } = render(<Harness initial="16:00" />);
    expect(input().value).toBe('16:00');
    unmount();
    useSettingsStore.setState({ timeFormat: '12h' });
    render(<Harness initial="16:00" />);
    expect(input().value).toBe('4:00 PM');
  });

  it('is a text field, so the browser cannot put its own clock on it', () => {
    render(<Harness initial="16:00" />);
    expect(input().type).toBe('text');
  });

  it('keeps what is typed and hands on the time as HH:mm', () => {
    const onValue = vi.fn();
    render(<Harness initial="09:00" onValue={onValue} />);
    fireEvent.change(input(), { target: { value: '1745' } });
    expect(input().value).toBe('1745');
    expect(value()).toBe('17:45');
    fireEvent.blur(input());
    expect(input().value).toBe('17:45');
    expect(onValue).toHaveBeenLastCalledWith('17:45');
  });

  it('marks text that is no time and goes back to the last time on blur', () => {
    render(<Harness initial="09:00" />);
    fireEvent.change(input(), { target: { value: 'soon' } });
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(value()).toBe('09:00');
    fireEvent.blur(input());
    expect(input().value).toBe('09:00');
    expect(input()).not.toHaveAttribute('aria-invalid');
  });

  it('moves the time with the arrow keys', () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    render(<Harness initial="11:50" />);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(value()).toBe('12:00');
    expect(input().value).toBe('12:00 PM');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(value()).toBe('11:45');
  });
});
