// React's onFocus/onBlur listen to focusin/focusout — RTL's fireEvent fires both.
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { SearchBox } from '../search-box';
import { useEmailStore } from '@/stores/email-store';
import { useSearchHistoryStore } from '@/stores/search-history-store';

vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ name, email }: { name?: string; email?: string }) => (
    React.createElement('span', { 'data-testid': 'avatar' }, name || email)
  ),
}));

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    recentRecipients: [],
    directoryPrincipals: [],
    getAutocomplete: (query: string) => {
      const all = [
        { name: 'Mustafa Kemal', email: 'mustafa@example.com' },
        { name: 'Mustafa Sandal', email: 'sandal@example.com' },
        { name: 'Marketing', email: '', group: { id: 'g1', memberCount: 3 } },
        { name: 'Alice Doe', email: 'alice@example.com' },
      ];
      const q = query.toLowerCase();
      return all.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
    },
  };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

function Harness(props: Partial<React.ComponentProps<typeof SearchBox>> & { initial?: string }) {
  const [value, setValue] = React.useState(props.initial ?? '');
  return (
    <SearchBox
      value={value}
      onChange={(v) => { setValue(v); props.onChange?.(v); }}
      onSubmit={props.onSubmit ?? (() => {})}
      onClear={props.onClear ?? (() => {})}
      onSelectContact={props.onSelectContact ?? (() => {})}
      disabled={props.disabled}
    />
  );
}

function input() {
  return screen.getByRole('combobox') as HTMLInputElement;
}

describe('SearchBox suggestions (#845)', () => {
  beforeEach(() => {
    useSearchHistoryStore.setState({ recentSearches: [] });
  });

  it('shows nothing on focus when there is no history and no query', () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows recent searches on focus with an empty query', () => {
    useSearchHistoryStore.setState({ recentSearches: ['invoice', 'q3 report'] });
    render(<Harness />);
    fireEvent.focus(input());
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['invoice', 'q3 report']);
    expect(screen.getByText('suggestions_recent')).toBeInTheDocument();
  });

  it('lists matching contacts while typing, without groups, with the match highlighted', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'musta' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Mustafa Kemal');
    expect(options[0]).toHaveTextContent('<mustafa@example.com>');
    expect(options[1]).toHaveTextContent('Mustafa Sandal');
    expect(screen.queryByText(/Marketing/)).toBeNull();
    const marks = options[0].querySelectorAll('mark');
    // "Musta" in the name and "musta" in the address are both emphasised.
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['Musta', 'musta']);
    expect(screen.getByText('suggestions_people')).toBeInTheDocument();
  });

  it('clicking a contact runs a from: search and closes the dropdown', () => {
    const onSelectContact = vi.fn();
    render(<Harness onSelectContact={onSelectContact} />);
    fireEvent.change(input(), { target: { value: 'sandal' } });
    fireEvent.mouseDown(screen.getByRole('option'));
    expect(onSelectContact).toHaveBeenCalledWith({ name: 'Mustafa Sandal', email: 'sandal@example.com' }, 'from');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('the "to" action runs a to: search for the contact', () => {
    const onSelectContact = vi.fn();
    render(<Harness onSelectContact={onSelectContact} />);
    fireEvent.change(input(), { target: { value: 'alice' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'suggestions_to' }));
    expect(onSelectContact).toHaveBeenCalledWith({ name: 'Alice Doe', email: 'alice@example.com' }, 'to');
  });

  it('navigates with the arrow keys and picks with Enter', () => {
    const onSelectContact = vi.fn();
    const onSubmit = vi.fn();
    useSearchHistoryStore.setState({ recentSearches: ['mustafa invoice'] });
    render(<Harness onSelectContact={onSelectContact} onSubmit={onSubmit} />);
    const el = input();
    fireEvent.change(el, { target: { value: 'musta' } });
    // recent, Mustafa Kemal, Mustafa Sandal
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(el).toHaveAttribute('aria-expanded', 'true');
    expect(el).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(el, { key: 'ArrowDown' });
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(el).toHaveAttribute('aria-activedescendant', options[1].id);

    // Does not run past the last entry.
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(el, { key: 'ArrowUp' });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSelectContact).toHaveBeenCalledWith({ name: 'Mustafa Kemal', email: 'mustafa@example.com' }, 'from');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter with a highlighted recent search submits that query', () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    useSearchHistoryStore.setState({ recentSearches: ['mustafa invoice'] });
    render(<Harness onSubmit={onSubmit} onChange={onChange} />);
    const el = input();
    fireEvent.change(el, { target: { value: 'musta' } });
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('mustafa invoice');
    expect(onSubmit).toHaveBeenCalledWith('mustafa invoice');
    expect(el.value).toBe('mustafa invoice');
  });

  it('Enter with nothing highlighted submits the typed text', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const el = input();
    fireEvent.change(el, { target: { value: 'musta' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.submit(el.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('musta');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes the dropdown and ArrowDown reopens it', () => {
    render(<Harness />);
    const el = input();
    fireEvent.change(el, { target: { value: 'musta' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(el).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('blur closes the dropdown', () => {
    render(<Harness />);
    const el = input();
    fireEvent.change(el, { target: { value: 'musta' } });
    fireEvent.blur(el, { relatedTarget: null });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('removing a recent search updates the list without closing it', () => {
    useSearchHistoryStore.setState({ recentSearches: ['invoice', 'q3 report'] });
    render(<Harness />);
    fireEvent.focus(input());
    const remove = screen.getAllByRole('button', { name: 'suggestions_remove_recent' });
    act(() => { fireEvent.mouseDown(remove[0]); });
    expect(useSearchHistoryStore.getState().recentSearches).toEqual(['q3 report']);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['q3 report']);
  });

  it('never opens while disabled', () => {
    useSearchHistoryStore.setState({ recentSearches: ['invoice'] });
    render(<Harness disabled />);
    fireEvent.focus(input());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('SearchBox and password managers', () => {
  it('is a search field, which Bitwarden never offers to fill', () => {
    // data-bwignore only works when the user opted in to it in Bitwarden.
    render(<Harness />);
    expect(input()).toHaveAttribute('type', 'search');
  });
});

describe('SearchBox draft', () => {
  beforeEach(() => {
    useSearchHistoryStore.setState({ recentSearches: [] });
  });

  it('keeps the typed text to itself until it is submitted', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onChange={onChange} onSubmit={onSubmit} />);
    fireEvent.change(input(), { target: { value: 'i' } });
    fireEvent.change(input(), { target: { value: 'in' } });
    fireEvent.change(input(), { target: { value: 'invoice' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('invoice');

    fireEvent.submit(input().closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('invoice');
  });

  it('hands the typed text over when focus leaves the box', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'invoice' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith('invoice');
  });

  it('leaves the search on Enter in an emptied box, like the clear button', () => {
    const onClear = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness initial="invoice" onClear={onClear} onSubmit={onSubmit} />);
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.submit(input().closest('form')!);

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does nothing on Enter in an empty box when no search is in force', () => {
    const onClear = vi.fn();
    render(<Harness onClear={onClear} />);
    fireEvent.submit(input().closest('form')!);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('shows a query set from outside', () => {
    function Outside() {
      const [value, setValue] = React.useState('');
      return (
        <>
          <button onClick={() => setValue('from:alice')}>set</button>
          <SearchBox value={value} onChange={setValue} onSubmit={() => {}} onClear={() => {}} onSelectContact={() => {}} />
        </>
      );
    }
    render(<Outside />);
    fireEvent.click(screen.getByText('set'));
    expect(input().value).toBe('from:alice');
  });
});

// At 1440 the list column cut "Search mail... (press /)" to "Search mail...
// (pres". The placeholder is short now; the "/" shortcut shows as a key cap
// at the end of the empty field and is named for assistive tech.
describe('SearchBox shortcut hint', () => {
  it('keeps the placeholder short and shows the / key apart', () => {
    const { container } = render(<Harness />);
    expect(input().getAttribute('placeholder')).toBe('search_placeholder');
    expect(input().getAttribute('aria-keyshortcuts')).toBe('/');
    const kbd = container.querySelector('kbd');
    expect(kbd?.textContent).toBe('/');
    expect(kbd?.getAttribute('aria-hidden')).toBe('true');
  });

  it('drops the key cap once something is typed', () => {
    const { container } = render(<Harness initial="invoice" />);
    expect(container.querySelector('kbd')).toBeNull();
  });
});

describe('SearchBox end controls', () => {
  it('keeps the clear button inside the field, where the wrapper places it', () => {
    render(<SearchBox value="test" onChange={() => {}} onSubmit={() => {}} onClear={() => {}} onSelectContact={() => {}} />);
    const clear = screen.getByTestId('search-clear');
    // The touch hit area's `relative` once overrode the button's `absolute`,
    // dropping it under the input and stretching the field.
    expect(clear.className.split(/\s+/)).not.toContain('absolute');
    expect(clear.closest('.absolute')?.closest('form')).toBeTruthy();
  });

  it('shows the trailing control next to the clear button', () => {
    render(<SearchBox value="test" onChange={() => {}} onSubmit={() => {}} onClear={() => {}} onSelectContact={() => {}} trailing={<button>filters</button>} />);
    expect(screen.getByText('filters').parentElement).toBe(screen.getByTestId('search-clear').parentElement);
  });
});

// mail-16: an account with no matching contact still gets suggestions from
// the senders of the mail on screen.
describe('SearchBox suggestions from the list', () => {
  beforeEach(() => {
    useSearchHistoryStore.setState({ recentSearches: [] });
  });
  afterEach(() => {
    useEmailStore.setState({ emails: [] });
  });

  it('offers senders of loaded mail that match what is typed', () => {
    useEmailStore.setState({
      emails: [
        { id: '1', from: [{ name: 'Greta Sørensen', email: 'greta@example.com' }] },
        { id: '2', from: [{ name: 'Greta Sørensen', email: 'greta@example.com' }] },
        { id: '3', from: [{ name: 'Tobias Brenner', email: 'tobias@example.com' }] },
      ] as never,
    });
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'greta' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('greta@example.com');
  });
});
