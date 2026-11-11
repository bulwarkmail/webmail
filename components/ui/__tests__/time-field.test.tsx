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

  it('hands on a time only once it is whole, not each keystroke on the way', () => {
    const onValue = vi.fn();
    render(<Harness initial="10:00" onValue={onValue} />);
    for (const text of ['1', '15', '153', '15:3']) fireEvent.change(input(), { target: { value: text } });
    expect(onValue).not.toHaveBeenCalled();
    expect(value()).toBe('10:00');
    fireEvent.change(input(), { target: { value: '15:30' } });
    expect(onValue.mock.calls).toEqual([['15:30']]);
  });

  it('hands on four digits or an am/pm while typing', () => {
    const onValue = vi.fn();
    render(<Harness initial="10:00" onValue={onValue} />);
    fireEvent.change(input(), { target: { value: '1530' } });
    expect(value()).toBe('15:30');
    fireEvent.change(input(), { target: { value: '2p' } });
    expect(value()).toBe('14:00');
    expect(onValue.mock.calls).toEqual([['15:30'], ['14:00']]);
  });

  it('hands on a half-typed time on blur and on Enter', () => {
    render(<Harness initial="10:00" />);
    fireEvent.change(input(), { target: { value: '9' } });
    expect(value()).toBe('10:00');
    fireEvent.blur(input());
    expect(value()).toBe('09:00');
    expect(input().value).toBe('09:00');
    fireEvent.change(input(), { target: { value: '153' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(value()).toBe('01:53');
    expect(input().value).toBe('01:53');
  });

  it('steps from the last time it handed on while the value lags behind', () => {
    // Quiet hours: the value only changes once the desktop app has answered.
    const onChange = vi.fn();
    render(<><label htmlFor="t">Start</label><TimeField id="t" value="09:00" onChange={onChange} /></>);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(onChange.mock.calls).toEqual([['09:15'], ['09:30']]);
  });

  it('hands on a time typed back to the old value while the value lags behind', () => {
    const onChange = vi.fn();
    render(<><label htmlFor="t">Start</label><TimeField id="t" value="09:00" onChange={onChange} /></>);
    fireEvent.change(input(), { target: { value: '10:00' } });
    fireEvent.change(input(), { target: { value: '09:00' } });
    expect(onChange.mock.calls).toEqual([['10:00'], ['09:00']]);
  });

  it('keeps "2:30 PM" in that order in a right-to-left language', () => {
    render(<Harness initial="14:30" />);
    expect(input()).toHaveAttribute('dir', 'ltr');
  });

  it('greys out the placeholder so it does not read as a time', () => {
    render(<Harness initial="" />);
    expect(input().value).toBe('');
    expect(input().placeholder).toBe('09:00');
    expect(input().className).toContain('placeholder:text-muted-foreground');
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
