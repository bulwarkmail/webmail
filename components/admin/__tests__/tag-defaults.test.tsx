import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PolicyDefaultsSection } from '@/components/admin/policy/user-settings-policy';
import { EVERYONE, useOrgScopeStore } from '@/components/admin/org/use-org-policy-draft';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { otherDefaultKeys } from '@/lib/admin/policy-settings';

// #1612: the tags new users start with, set on the admin Defaults page.

let latest: SettingsPolicy;

function Harness({ initial }: { initial: SettingsPolicy }) {
  const [policy, setPolicy] = useState(initial);
  latest = policy;
  return (
    <PolicyDefaultsSection
      policy={policy}
      onChange={(change) => setPolicy((p) => {
        const next = change(p);
        latest = next;
        return next;
      })}
    />
  );
}

function policyWith(patch: Partial<SettingsPolicy> = {}): SettingsPolicy {
  return { ...DEFAULT_POLICY, defaults: {}, ...patch };
}

const block = () => within(screen.getByTestId('defaults-tags'));
const rows = () => block().queryAllByTestId('tag-default-row');
const tags = () => latest.defaults.emailKeywords;
const SEVEN = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink'];

function openPicker() {
  fireEvent.click(block().getByRole('button', { name: 'Add colour tags' }));
  return within(block().getByRole('group', { name: 'Colour tags to add' }));
}

beforeEach(() => {
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Tags defaults', () => {
  it('sits above Other settings and offers to set default tags when none are set', () => {
    render(<Harness initial={policyWith()} />);
    const tagsBlock = screen.getByTestId('defaults-tags');
    expect(tagsBlock.compareDocumentPosition(screen.getByText('Other settings')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block().getByText('Built-in: the seven colour tags')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);

    fireEvent.click(block().getByRole('button', { name: 'Set default tags' }));
    expect(tags()).toEqual([]);
    expect(block().getByText('set')).toBeInTheDocument();
    expect(block().getByRole('button', { name: 'Add tag' })).toBeInTheDocument();
  });

  it('adds a tag named by the admin, with an id from its name and the next unused colour', () => {
    render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'red', label: 'Red', color: 'red' }] } })} />);
    fireEvent.click(block().getByRole('button', { name: 'Add tag' }));
    expect(rows()).toHaveLength(2);
    // An empty name is not written yet.
    expect(block().getByText('Give this tag a name.')).toBeInTheDocument();
    expect(tags()).toEqual([{ id: 'red', label: 'Red', color: 'red' }]);

    fireEvent.change(block().getAllByRole('textbox', { name: 'Tag name' })[1], { target: { value: 'Big Clients' } });
    expect(block().queryByText('Give this tag a name.')).toBeNull();
    expect(tags()).toEqual([
      { id: 'red', label: 'Red', color: 'red' },
      { id: 'big-clients', label: 'Big Clients', color: 'orange' },
    ]);
  });

  it('keeps the id of a saved tag when its name changes, and sets its colour', () => {
    render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'clients', label: 'Clients', color: 'teal' }] } })} />);
    fireEvent.change(block().getByRole('textbox', { name: 'Tag name' }), { target: { value: 'Customers' } });
    fireEvent.change(block().getByRole('combobox', { name: 'Colour' }), { target: { value: 'blue-dark' } });
    expect(tags()).toEqual([{ id: 'clients', label: 'Customers', color: 'blue-dark' }]);
  });

  it('offers every palette colour in the picker order', () => {
    render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'a', label: 'A', color: 'red' }] } })} />);
    const options = within(block().getByRole('combobox', { name: 'Colour' })).getAllByRole('option');
    expect(options).toHaveLength(39);
    expect(options[0]).toHaveValue('red-light');
    expect(options[13]).toHaveValue('red');
    expect(options[38]).toHaveValue('gray-dark');
  });

  it('refuses a second tag with the same name until it is renamed', () => {
    render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } })} />);
    fireEvent.click(block().getByRole('button', { name: 'Add tag' }));
    fireEvent.change(block().getAllByRole('textbox', { name: 'Tag name' })[1], { target: { value: 'work' } });
    expect(block().getByText('Another tag has this name.')).toBeInTheDocument();
    expect(tags()).toEqual([{ id: 'work', label: 'Work', color: 'blue' }]);

    fireEvent.change(block().getAllByRole('textbox', { name: 'Tag name' })[1], { target: { value: 'Home' } });
    expect(block().queryByText('Another tag has this name.')).toBeNull();
    expect(tags()).toEqual([{ id: 'work', label: 'Work', color: 'blue' }, { id: 'home', label: 'Home', color: 'red' }]);
  });

  it('flags a tag whose id another tag already has', () => {
    render(<Harness initial={policyWith({
      defaults: { emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }, { id: 'WORK', label: 'Office', color: 'red' }] },
    })} />);
    expect(block().getByText('Another tag has this name.')).toBeInTheDocument();
  });

  it('removes a tag', () => {
    render(<Harness initial={policyWith({
      defaults: { emailKeywords: [{ id: 'a', label: 'A', color: 'red' }, { id: 'b', label: 'B', color: 'blue' }] },
    })} />);
    fireEvent.click(block().getAllByRole('button', { name: 'Remove tag' })[0]);
    expect(tags()).toEqual([{ id: 'b', label: 'B', color: 'blue' }]);
  });

  it('removes the default with the revert button', () => {
    render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'a', label: 'A', color: 'red' }] } })} />);
    fireEvent.click(block().getByRole('button', { name: 'Remove the default' }));
    expect('emailKeywords' in latest.defaults).toBe(false);
    expect(block().getByText('Built-in: the seven colour tags')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it('is not listed under Other settings', () => {
    const policy = policyWith({ defaults: { emailKeywords: [], dateFormat: 'iso' } });
    expect(otherDefaultKeys(policy, EVERYONE)).toEqual(['dateFormat']);
  });

  it('sets, inherits and reverts the tags of a scope', () => {
    useOrgScopeStore.setState({ scopeId: 'team' });
    render(<Harness initial={policyWith({
      defaults: { emailKeywords: [{ id: 'a', label: 'A', color: 'red' }, { id: 'b', label: 'B', color: 'blue' }] },
      scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: {} }],
    })} />);
    expect(block().getByText('From Everyone: 2 tags')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);

    fireEvent.click(block().getByRole('button', { name: 'Set default tags' }));
    fireEvent.click(block().getByRole('button', { name: 'Add tag' }));
    fireEvent.change(block().getByRole('textbox', { name: 'Tag name' }), { target: { value: 'Team' } });
    expect(latest.scopes![0].policy.defaults).toEqual({ emailKeywords: [{ id: 'team', label: 'Team', color: 'red' }] });
    expect(latest.defaults.emailKeywords).toHaveLength(2);

    fireEvent.click(block().getByRole('button', { name: "Use Everyone's value" }));
    expect(latest.scopes![0].policy.defaults).toEqual({});
    expect(block().getByText('From Everyone: 2 tags')).toBeInTheDocument();

    // Back to Everyone: its own list shows.
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(block().getAllByRole('textbox', { name: 'Tag name' }).map((input) => (input as HTMLInputElement).value)).toEqual(['A', 'B']);
  });

  describe('Add colour tags', () => {
    it('lists the seven built-in tags with nothing checked and Add selected disabled', () => {
      render(<Harness initial={policyWith({ defaults: { emailKeywords: [] } })} />);
      const picker = openPicker();
      const boxes = picker.getAllByRole('checkbox');
      expect(boxes.map((box) => box.closest('label')!.textContent)).toEqual(SEVEN);
      boxes.forEach((box) => expect(box).not.toBeChecked());
      expect(picker.getByRole('button', { name: 'Add selected' })).toBeDisabled();
      expect(block().queryByRole('button', { name: /all/i })).toBeNull();
    });

    it('adds one picked tag with its built-in id', () => {
      render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'work', label: 'Work', color: 'teal' }] } })} />);
      const picker = openPicker();
      fireEvent.click(picker.getByRole('checkbox', { name: 'Green' }));
      fireEvent.click(picker.getByRole('button', { name: 'Add selected' }));
      expect(tags()).toEqual([{ id: 'work', label: 'Work', color: 'teal' }, { id: 'green', label: 'Green', color: 'green' }]);
      expect(block().queryByRole('group', { name: 'Colour tags to add' })).toBeNull();
    });

    it('adds several picked tags in the order shown', () => {
      render(<Harness initial={policyWith({ defaults: { emailKeywords: [] } })} />);
      const picker = openPicker();
      fireEvent.click(picker.getByRole('checkbox', { name: 'Pink' }));
      fireEvent.click(picker.getByRole('checkbox', { name: 'Red' }));
      fireEvent.click(picker.getByRole('checkbox', { name: 'Blue' }));
      fireEvent.click(picker.getByRole('button', { name: 'Add selected' }));
      expect(tags()).toEqual([
        { id: 'red', label: 'Red', color: 'red' },
        { id: 'blue', label: 'Blue', color: 'blue' },
        { id: 'pink', label: 'Pink', color: 'pink' },
      ]);
    });

    it('leaves out tags already in the list, matched by id without case', () => {
      render(<Harness initial={policyWith({
        defaults: { emailKeywords: [{ id: 'RED', label: 'Urgent', color: 'red-dark' }, { id: 'blue', label: 'Blue', color: 'blue' }] },
      })} />);
      const picker = openPicker();
      expect(picker.getAllByRole('checkbox').map((box) => box.closest('label')!.textContent))
        .toEqual(['Orange', 'Yellow', 'Green', 'Purple', 'Pink']);
    });

    it('changes nothing on Cancel', () => {
      render(<Harness initial={policyWith({ defaults: { emailKeywords: [{ id: 'a', label: 'A', color: 'red' }] } })} />);
      const before = latest;
      const picker = openPicker();
      fireEvent.click(picker.getByRole('checkbox', { name: 'Orange' }));
      fireEvent.click(picker.getByRole('button', { name: 'Cancel' }));
      expect(block().queryByRole('group', { name: 'Colour tags to add' })).toBeNull();
      expect(latest).toBe(before);

      // Opened again, nothing is checked.
      expect(openPicker().getByRole('checkbox', { name: 'Orange' })).not.toBeChecked();
    });

    it('closes with Escape', () => {
      render(<Harness initial={policyWith({ defaults: { emailKeywords: [] } })} />);
      const picker = openPicker();
      fireEvent.keyDown(picker.getByRole('checkbox', { name: 'Red' }), { key: 'Escape' });
      expect(block().queryByRole('group', { name: 'Colour tags to add' })).toBeNull();
    });

    it('is disabled once all seven are in the list', () => {
      render(<Harness initial={policyWith({ defaults: { emailKeywords: [] } })} />);
      const picker = openPicker();
      picker.getAllByRole('checkbox').forEach((box) => fireEvent.click(box));
      fireEvent.click(picker.getByRole('button', { name: 'Add selected' }));
      expect((tags() as { label: string }[]).map((tag) => tag.label)).toEqual(SEVEN);
      const button = block().getByRole('button', { name: 'Add colour tags' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'All colour tags are already in the list');
    });
  });
});
