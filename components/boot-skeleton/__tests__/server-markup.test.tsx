import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { render } from '@testing-library/react';
import { ServerMarkup } from '../server-markup';
import { MailSkeleton } from '../mail-skeleton';

// A page skeleton is thousands of elements that only stand there until the
// page is ready. The client keeps the server's markup as it is instead of
// hydrating it, and takes it away with the element when the page is ready.

afterEach(() => { document.body.innerHTML = ''; });

let draws = 0;
function Shape() {
  draws++;
  return <span className="sk-shape">shape</span>;
}

function Page({ ready }: { ready: boolean }) {
  return <main>{ready ? <p>loaded</p> : <ServerMarkup><Shape /><Shape /></ServerMarkup>}</main>;
}

describe('ServerMarkup', () => {
  it("keeps the server's skeleton without drawing it again while hydrating, then takes it away", async () => {
    draws = 0;
    const html = renderToString(<Page ready={false} />);
    expect(draws).toBe(2);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
    let setReady: (ready: boolean) => void = () => {};
    function App() {
      const [ready, set] = useState(false);
      setReady = set;
      return <Page ready={ready} />;
    }
    await act(async () => { hydrateRoot(container, <App />, { onRecoverableError: (e) => { errors.push(e); } }); });
    spy.mockRestore();
    expect(errors).toEqual([]);
    expect(draws).toBe(2);
    expect(container.innerHTML).toBe(html);
    expect(container.querySelectorAll('.sk-shape')).toHaveLength(2);
    await act(async () => { setReady(true); });
    expect(container.querySelector('.sk-shape')).toBeNull();
    expect(container.textContent).toBe('loaded');
  });

  it('draws the skeleton itself where the client renders the page on its own', () => {
    draws = 0;
    const { container } = render(<Page ready={false} />);
    expect(draws).toBe(2);
    expect(container.querySelectorAll('.sk-shape')).toHaveLength(2);
  });

  it('adds no box around the mail skeleton', () => {
    const html = renderToString(<MailSkeleton label="Loading" />);
    const wrapper = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild as HTMLElement;
    expect(wrapper.hasAttribute('data-server-markup')).toBe(true);
    expect(wrapper.style.display).toBe('contents');
    expect(wrapper.querySelector('[data-boot-skeleton="mail"]')).not.toBeNull();
  });
});
