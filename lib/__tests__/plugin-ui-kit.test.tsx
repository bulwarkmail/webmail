import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The plugin UI kit (`@plugin-host/ui`): the app's controls for plugin
// iframes. These tests hold it to the app's components, so a restyle of the
// app shows up as a failing test here instead of plugins drifting off.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${Object.values(params).join(',')})` : key,
}));

const kit = await import('../plugin-sandbox/ui-kit');
const { Button: AppButton } = await import('@/components/ui/button');
const { Input: AppInput } = await import('@/components/ui/input');

const ROOT = path.resolve(__dirname, '../..');
const source = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const classesOf = (el: Element) => el.getAttribute('class')!.split(/\s+/).filter((c) => c !== 'bk').sort();

describe('plugin UI kit components', () => {
  it('renders the app\'s own Button and Input', () => {
    render(<>
      <kit.Button variant="secondary" size="sm">Cancel</kit.Button>
      <AppButton variant="outline" size="sm" className="gap-1.5">Cancel app</AppButton>
      <kit.Input placeholder="kit" />
      <AppInput placeholder="app" />
    </>);
    expect(classesOf(screen.getByText('Cancel'))).toEqual(classesOf(screen.getByText('Cancel app')));
    expect(classesOf(screen.getByPlaceholderText('kit'))).toEqual(classesOf(screen.getByPlaceholderText('app')));
  });

  it('maps primary, secondary, ghost and destructive onto the app\'s variants', () => {
    render(<>
      <kit.Button>Primary</kit.Button>
      <kit.Button variant="ghost">Ghost</kit.Button>
      <kit.Button variant="destructive">Delete</kit.Button>
    </>);
    expect(screen.getByText('Primary').className).toContain('bg-primary');
    expect(screen.getByText('Ghost').className).toContain('hover:bg-accent');
    expect(screen.getByText('Delete').className).toContain('bg-destructive');
  });

  it('copies its classes from the app components it stands for', () => {
    // Each kit component that can't reuse an app component copies one; the
    // copy must still be there, word for word.
    const copies: [string, string][] = [
      ['components/settings/settings-section.tsx', 'px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150'],
      ['components/settings/settings-section.tsx', 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150'],
      ['components/settings/settings-section.tsx', 'inline-block h-4 w-4 transform rounded-full bg-background transition-transform duration-150'],
      ['components/settings/settings-section.tsx', 'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 py-3 border-b border-border last:border-0'],
      ['components/settings/settings-section.tsx', 'px-3 py-1.5 text-xs rounded-md transition-colors duration-150'],
      ['components/email/composer-toolbar-menu.tsx', 'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border'],
      ['components/calendar/ical-import-modal.tsx', 'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors'],
      ['components/files/file-empty-state.tsx', 'w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4'],
      ['components/files/file-views.tsx', 'border-b border-border/60'],
      ['components/files/files-header.tsx', 'px-1.5 py-1 rounded-md transition-colors truncate max-w-[16rem]'],
      ['components/email/email-viewer.tsx', 'w-10 h-10 rounded-full'],
      ['components/email/email-viewer.tsx', 'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'],
      ['components/email/email-viewer.tsx', 'inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px]'],
      ['components/identity/identity-form.tsx', 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-all duration-200'],
    ];
    const kitSource = source('lib/plugin-sandbox/ui-kit/components.tsx');
    for (const [file, classes] of copies) {
      expect(source(file), file).toContain(classes);
      for (const word of classes.split(' ')) expect(kitSource, `${word} (from ${file})`).toContain(word);
    }
  });

  it('puts bk on each root, which scopes the reset to kit elements', () => {
    const { container } = render(<>
      <kit.Select options={[{ value: 'a', label: 'A' }]} value="a" />
      <kit.Checkbox checked label="Remember" />
      <kit.EmptyState icon="cloud" title="Nothing yet" />
      <kit.ListRow title="report.pdf" icon="report.pdf" meta={['1 MB']} />
      <kit.Badge tone="success">Sent</kit.Badge>
      <kit.DiffView parts={[{ type: 'same', text: 'Hi' }]} />
    </>);
    for (const child of Array.from(container.children)) expect(child.classList.contains('bk'), child.outerHTML.slice(0, 60)).toBe(true);
  });

  it('marks removed and added words in a change preview', () => {
    const { container } = render(<kit.DiffView parts={[{ type: 'same', text: 'Hi ' }, { type: 'del', text: 'Bob' }, { type: 'add', text: 'Robert' }]} />);
    expect(container.querySelector('del')).toHaveTextContent('Bob');
    expect(container.querySelector('del')!.className).toContain('line-through');
    expect(container.querySelector('ins')).toHaveTextContent('Robert');
    expect(container.textContent).toBe('Hi BobRobert');
  });

  it('takes only #rgb and #rrggbb colours for a colour dot', () => {
    const { container } = render(<>
      <kit.ColorDot color="#3b82f6" label="Work" />
      <kit.ColorDot color="red; background-image: url(https://evil.example/x)" />
      <kit.ColorDot color="url(https://evil.example/x)" />
    </>);
    const dots = container.querySelectorAll('span');
    expect((dots[0] as HTMLElement).style.backgroundColor).toBe('rgb(59, 130, 246)');
    expect(dots[0]).toHaveAttribute('aria-label', 'Work');
    expect((dots[1] as HTMLElement).getAttribute('style')).toBeNull();
    expect(dots[1].className).toContain('bg-muted-foreground');
    expect((dots[2] as HTMLElement).getAttribute('style')).toBeNull();
  });

  it('names the select box of a list row and a checkbox without a visible label', () => {
    render(<>
      <kit.ListRow title="report.pdf" checked={false} onCheck={() => {}} />
      <kit.ListRow title="x" checkLabel="Select invoice" checked onCheck={() => {}} />
      <kit.Checkbox checked={false} ariaLabel="Use for all" />
    </>);
    expect(screen.getByRole('checkbox', { name: 'report.pdf' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select invoice' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Use for all' })).toBeTruthy();
  });

  it('lets fields share a row and shows details as label and value', () => {
    const { container } = render(<>
      <kit.Row fill><kit.Field label="Due"><kit.Input /></kit.Field><kit.Field label="Priority"><kit.Input /></kit.Field></kit.Row>
      <kit.DetailList><kit.DetailRow label="Size">2 MB</kit.DetailRow></kit.DetailList>
    </>);
    expect(container.firstElementChild!.className).toContain('[&>*]:flex-1');
    expect(container.querySelector('dt')).toHaveTextContent('Size');
    expect(container.querySelector('dd')).toHaveTextContent('2 MB');
  });

  it('makes sidebar rows as tall as folder rows on touch screens', () => {
    // The page sets --touch-row-min-h to 44px below lg, where folder rows
    // are max-lg:min-h-[44px]; the frame can't see the page's width itself.
    expect(source('components/layout/sidebar.tsx')).toContain('max-lg:min-h-[44px]');
    expect(source('app/globals.css')).toMatch(/@media \(width < 64rem\) \{\s*:root \{\s*--touch-row-min-h: 44px;/);
    render(<kit.SidebarRow label="Anna" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Anna' }).style.minHeight).toBe('var(--touch-row-min-h, 0px)');
  });

  it('draws a checkbox the user can toggle by its label', () => {
    const onChange = vi.fn();
    render(<kit.Checkbox checked={false} onChange={onChange} label="Send as link" hint="For files over 10 MB" />);
    fireEvent.click(screen.getByText('Send as link'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('checkbox', { name: 'Send as link' })).toHaveAttribute('aria-checked', 'false');
  });

  it('gives a Field\'s control the label', () => {
    render(<kit.Field label="Title" hint="Shown in Paperless"><kit.Input /></kit.Field>);
    expect(screen.getByLabelText('Title')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByText('Shown in Paperless')).toBeTruthy();
  });

  it('is what the sandbox hands a plugin for require("@plugin-host/ui")', async () => {
    const { makePluginRequire } = await import('../plugin-sandbox/runtime');
    const req = makePluginRequire(null);
    expect(req('@plugin-host/ui')).toBe(kit.pluginUiKit);
    expect(kit.KIT_EXPORTS).toEqual(expect.arrayContaining(['Button', 'Input', 'Select', 'Combobox', 'Checkbox', 'Field', 'Tabs', 'List', 'ListRow', 'Badge', 'EmptyState', 'PageHeader', 'Spinner', 'DialogButtons', 'InfoBar', 'Chip']));
    expect(() => req('left-pad')).toThrow(/not available/);
  });
});

describe('DialogButtons', () => {
  it('hands its buttons to the host and runs onClick when the host reports a click', () => {
    const setDialogButtons = vi.fn();
    const onClick = vi.fn();
    const ui = (n: number) => (
      <kit.SlotPropsContext.Provider value={{ setDialogButtons, dialogButtonClick: { id: 'send', n } }}>
        <kit.DialogButtons buttons={[{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'send', label: 'Send', busy: true }]} onClick={onClick} />
      </kit.SlotPropsContext.Provider>
    );
    const { container, rerender } = render(ui(0));
    expect(container.innerHTML).toBe('');
    expect(setDialogButtons).toHaveBeenLastCalledWith([{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'send', label: 'Send', busy: true }]);
    expect(onClick).not.toHaveBeenCalled();
    rerender(ui(1));
    expect(onClick).toHaveBeenCalledWith('send');
    rerender(ui(1));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('draws the buttons itself outside a host dialog', () => {
    const onClick = vi.fn();
    render(<kit.DialogButtons buttons={[{ id: 'ok', label: 'Save' }]} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledWith('ok');
  });
});

describe('plugin dialog footer', () => {
  it('draws the plugin\'s buttons in the app\'s footer and passes clicks back', async () => {
    let slotProps: Record<string, unknown> = {};
    vi.doMock('@/components/plugins/plugin-iframe-slot', () => ({
      PluginIframeSlot: ({ extraProps }: { extraProps: Record<string, unknown> }) => { slotProps = extraProps; return null; },
    }));
    const dialogs = await import('../plugin-sandbox/host-dialog');
    const { PluginDialogHost } = await import('@/components/plugins/plugin-dialog-host');
    render(<PluginDialogHost />);
    let result: unknown;
    act(() => { void dialogs.awaitCustomDialog({ pluginId: 'paperless', title: 'Send to Paperless', slot: 'plugin-dialog' } as never).then((r: unknown) => { result = r; }); });
    expect(screen.getByRole('dialog', { name: 'Send to Paperless' })).toBeTruthy();
    expect(screen.getByText('from_plugin(paperless)')).toBeTruthy();

    act(() => (slotProps.setDialogButtons as (b: unknown) => void)([
      { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      { id: 'send', label: 'Send', disabled: true, icon: 'send' },
      { id: 'bad id!', label: 'Dropped' },
      { id: 'x', label: '' },
    ]));
    const footer = document.querySelector('[data-plugin-dialog-buttons]')!;
    const buttons = Array.from(footer.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Send']);
    expect(buttons[0].className).toContain('border-input');
    expect(buttons[1]).toBeDisabled();
    expect(buttons[1].querySelector('svg')).not.toBeNull();
    expect(buttons[0].querySelector('svg')).toBeNull();

    fireEvent.click(buttons[0]);
    expect(slotProps.dialogButtonClick).toEqual({ id: 'cancel', n: 1 });
    fireEvent.click(buttons[0]);
    expect(slotProps.dialogButtonClick).toEqual({ id: 'cancel', n: 2 });

    act(() => (slotProps.onResult as (v: unknown) => void)(null));
    await act(async () => {});
    expect(result).toBeNull();
    vi.doUnmock('@/components/plugins/plugin-iframe-slot');
  });
});

describe('Combobox', () => {
  const options = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'cherry', label: 'Cherry' },
  ];

  it('renders with placeholder and closed dropdown', () => {
    render(<kit.Combobox options={options} placeholder="Choose fruit" />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('placeholder', 'Choose fruit');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens and filters options on input', () => {
    render(<kit.Combobox options={options} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ban' } });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByText('Banana')).toBeTruthy();
    expect(screen.queryByText('Apple')).toBeNull();
  });

  it('selects option on click', () => {
    const onChange = vi.fn();
    render(<kit.Combobox options={options} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.click(input);
    fireEvent.click(screen.getByText('Cherry'));
    expect(onChange).toHaveBeenCalledWith('cherry');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('navigates with keyboard and selects on Enter', () => {
    const onChange = vi.fn();
    render(<kit.Combobox options={options} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // opens dropdown
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight next
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalled();
  });

  it('clears selection when clear button is clicked without opening dropdown', () => {
    const onChange = vi.fn();
    render(<kit.Combobox options={options} value="banana" onChange={onChange} />);
    const clearBtn = screen.getByLabelText('Clear');
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes dropdown and clears selection if clear button is clicked while open', () => {
    const onChange = vi.fn();
    render(<kit.Combobox options={options} value="banana" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeTruthy();

    const clearBtn = screen.getByLabelText('Clear');
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('supports multiselect mode with chip rendering, toggling and backspace removal', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <kit.Combobox options={options} multiple value={['apple']} onChange={onChange} />
    );
    expect(screen.getByRole('checkbox', { name: 'Apple' })).toBeTruthy();
    expect(screen.getByLabelText('Remove Apple')).toBeTruthy();

    // Clicking remove chip does not open dropdown
    fireEvent.click(screen.getByLabelText('Remove Apple'));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.queryByRole('listbox')).toBeNull();

    // Open dropdown and toggle cherry
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.click(screen.getByText('Cherry'));
    expect(onChange).toHaveBeenCalledWith(['apple', 'cherry']);

    // Backspace on empty input removes last value
    rerender(<kit.Combobox options={options} multiple value={['apple', 'cherry']} onChange={onChange} />);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['apple']);
  });

  it('associates label when wrapped in Field', () => {
    render(<kit.Field label="Fruit"><kit.Combobox options={options} /></kit.Field>);
    expect(screen.getByLabelText('Fruit')).toBeInstanceOf(HTMLInputElement);
  });
});

describe('Combobox floating dropdown bridge', () => {
  const options = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
  ];

  it('delegates dropdown rendering to the host when supported and handles host selection', async () => {
    const bridge = await import('../plugin-sandbox/ui-kit/floating-dropdown-bridge');
    const sentMessages: any[] = [];
    bridge.initFloatingDropdownBridge(
      (msg) => { sentMessages.push(msg); },
      () => true,
    );

    const onChange = vi.fn();
    render(<kit.Combobox options={options} onChange={onChange} id="fruit-picker" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    // Dropdown listbox is NOT rendered inside the component root
    expect(screen.queryByRole('listbox')).toBeNull();

    // Verify open message was sent to host
    expect(sentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'floating-dropdown-open',
          id: 'fruit-picker-listbox',
          options,
        }),
      ]),
    );

    // Host selects banana
    act(() => {
      bridge.dispatchFloatingDropdownEvent('fruit-picker-listbox', {
        type: 'select',
        option: options[1],
      });
    });

    expect(onChange).toHaveBeenCalledWith('banana');

    // Tear down bridge for following tests
    bridge.initFloatingDropdownBridge(null as any, () => false);
  });

  it('supports multiselect toggling and updates host with selected values', async () => {
    const bridge = await import('../plugin-sandbox/ui-kit/floating-dropdown-bridge');
    const sentMessages: any[] = [];
    bridge.initFloatingDropdownBridge(
      (msg) => { sentMessages.push(msg); },
      () => true,
    );

    const onChange = vi.fn();
    render(<kit.Combobox options={options} multiple value={['apple']} onChange={onChange} id="tag-picker" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    expect(screen.queryByRole('listbox')).toBeNull();

    // Host selects banana
    act(() => {
      bridge.dispatchFloatingDropdownEvent('tag-picker-listbox', {
        type: 'select',
        option: options[1],
      });
    });

    expect(onChange).toHaveBeenCalledWith(['apple', 'banana']);

    // Tear down bridge
    bridge.initFloatingDropdownBridge(null as any, () => false);
  });
});

describe('plugin-kit.css', () => {
  it('builds the kit\'s utilities without the global Tailwind reset', async () => {
    const postcss = (await import('postcss')).default;
    const tailwind = (await import('@tailwindcss/postcss')).default;
    const file = path.join(ROOT, 'app/(sandbox)/plugin-kit.css');
    const out = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(file, 'utf8'), { from: file })).css;
    expect(out).toContain('.bg-primary');
    expect(out).toContain('.h-10');
    expect(out).toContain('--color-primary: var(--color-primary)');
    // Preflight would restyle every plugin written before the kit.
    expect(out).not.toMatch(/(^|[\s,}])\*,\s*::after,\s*::before/);
    expect(out).not.toMatch(/(^|\n)\s*html,\s*:host\s*\{/);
    // Only the kit's sources are scanned: an app-only class stays out.
    expect(out).not.toContain('.email-content-wrapper');
    expect(out.length).toBeLessThan(80_000);
    // Kit components whose root is the button itself (SidebarRow, RowAction)
    // get the reset too, not only buttons inside a kit element.
    const reset = out.split('}').find((rule) => /font:\s*inherit/.test(rule)) ?? '';
    expect(reset).toMatch(/button\.bk/);
    expect(reset).toMatch(/\.bk button/);
  }, 60_000);
});
