import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ContactForm } from '../contact-form';
import type { ContactCard } from '@/lib/jmap/types';

const existingContact: ContactCard = {
  id: '1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
  phones: { p0: { number: '+33612345678' } },
  organizations: { o0: { name: 'Acme Corp' } },
  notes: { n0: { note: 'VIP' } },
};

describe('ContactForm', () => {
  it('renders create form with empty fields', () => {
    render(<ContactForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('create_title')).toBeInTheDocument();
    const inputs = screen.getAllByRole('textbox');
    const emptyInputs = inputs.filter(i => (i as HTMLInputElement).value === '');
    expect(emptyInputs.length).toBeGreaterThan(0);
  });

  it('renders edit form with pre-populated data', () => {
    render(<ContactForm contact={existingContact} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('edit_title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Smith')).toBeInTheDocument();
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<ContactForm onSave={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows error on submit with empty name', async () => {
    const onSave = vi.fn();
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.submit(screen.getByText('save').closest('form')!);
    await waitFor(() => {
      expect(screen.getByText('name_required')).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('adds email entry when add button is clicked', () => {
    render(<ContactForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const emailInputsBefore = screen.getAllByPlaceholderText('email_placeholder');
    fireEvent.click(screen.getByText('add_email'));
    const emailInputsAfter = screen.getAllByPlaceholderText('email_placeholder');
    expect(emailInputsAfter.length).toBe(emailInputsBefore.length + 1);
  });

  it('adds phone entry when add button is clicked', () => {
    render(<ContactForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const phoneBefore = screen.queryAllByPlaceholderText('phone_placeholder');
    fireEvent.click(screen.getByText('add_phone'));
    const phoneAfter = screen.getAllByPlaceholderText('phone_placeholder');
    expect(phoneAfter.length).toBe(phoneBefore.length + 1);
  });

  it('sends media: null when an existing photo is removed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const contactWithPhoto: ContactCard = {
      ...existingContact,
      media: {
        photo: { kind: 'photo', uri: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
      },
    };
    render(<ContactForm contact={contactWithPhoto} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('remove_photo'));
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });

    const savedData = onSave.mock.calls[0][0];
    expect(savedData.media).toBeNull();
  });

  it('submits form data correctly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);

    const _inputs = screen.getAllByRole('textbox');
    const givenNameInput = screen.getByPlaceholderText('given_name');
    fireEvent.change(givenNameInput, { target: { value: 'Jane' } });

    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });

    const savedData = onSave.mock.calls[0][0];
    expect(savedData.name.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'given', value: 'Jane' })])
    );
  });
});
