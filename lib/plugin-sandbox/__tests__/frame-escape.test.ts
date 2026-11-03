import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameEscapeListener } from '../frame-escape';

// Real key events can't be made in a test (isTrusted is false on anything
// dispatched from script), so the listener gets plain events. `defaultPrevented`
// changes as it would while the browser walks the rest of the listeners.
const press = (over: Partial<KeyboardEvent> = {}) => ({ key: 'Escape', isTrusted: true, defaultPrevented: false, ...over });

describe('frameEscapeListener', () => {
  const send = vi.fn();
  beforeEach(() => { vi.useFakeTimers(); send.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tells the host about an Escape nothing in the frame wanted, once the event is over', () => {
    frameEscapeListener(send)(press());
    expect(send).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when a listener before it prevented the default', () => {
    frameEscapeListener(send)(press({ defaultPrevented: true }));
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });

  it('stays quiet when a listener after it prevents the default', () => {
    const event = press();
    frameEscapeListener(send)(event);
    // A plugin's own window listener: added from an effect, so it runs later.
    event.defaultPrevented = true;
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores an Escape made by script', () => {
    frameEscapeListener(send)(press({ isTrusted: false }));
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    frameEscapeListener(send)(press({ key: 'Enter' }));
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });
});
