import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContactForm } from '../contact-form';
import { ContactGroupForm } from '../contact-group-form';
import type { ContactCard, ContactMedia } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { findContactPhotoEntry } from '@/stores/contact-store';
import { clearContactPhotoCache } from '@/lib/contact-photo-cache';

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
      expect(screen.getByRole('alert')).toHaveTextContent('name_required');
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  // The browser's own "Please include an '@'" bubble sat over the app's
  // inline message: the form leaves checking to the app.
  it('says an address is wrong itself, with no browser bubble in the way', async () => {
    const onSave = vi.fn();
    render(<ContactForm contact={existingContact} onSave={onSave} onCancel={vi.fn()} />);
    const form = screen.getByText('save').closest('form')!;
    expect(form.noValidate).toBe(true);

    fireEvent.change(screen.getByDisplayValue('alice@example.com'), { target: { value: 'alice@' } });
    // A click on Save, as the user does: the browser checks a form that
    // has no noValidate before it lets the submit through.
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByText('email_invalid')).toBeInTheDocument();
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

  it('adds a category typed without Enter when the contact is saved, in the spelling of an existing one', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm contact={existingContact} allKeywords={['Friends']} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('categories'));
    fireEvent.change(screen.getByPlaceholderText('categories_placeholder'), { target: { value: 'friends, Gym ' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].keywords).toEqual({ Friends: true, Gym: true });
  });

  it('counts a typed category as a change, so leaving asks first', () => {
    const onDirtyChange = vi.fn();
    render(<ContactForm contact={existingContact} onSave={vi.fn()} onCancel={vi.fn()} onDirtyChange={onDirtyChange} />);
    fireEvent.click(screen.getByText('categories'));
    fireEvent.change(screen.getByPlaceholderText('categories_placeholder'), { target: { value: 'Gym' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it.each([
    ['contact form', () => <ContactForm onSave={vi.fn()} onCancel={vi.fn()} />],
    ['group form', () => <ContactGroupForm individuals={[]} onSave={vi.fn()} onCancel={vi.fn()} />],
  ])('keeps toasts off the %s footer by registering it as a bottom bar', (_name, form) => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 0, top: window.innerHeight - 72, width: 600, height: 72, right: 600, bottom: window.innerHeight, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    try {
      const { unmount } = render(form());
      expect(document.documentElement.style.getPropertyValue('--bottom-controls-height')).toBe('72px');
      unmount();
      expect(document.documentElement.style.getPropertyValue('--bottom-controls-height')).toBe('');
    } finally {
      rect.mockRestore();
    }
  });

  describe('photos (P0-3)', () => {
    // The same PHOTO as ContactCard/get returns it on each version.
    const photo0_16_23: ContactMedia = { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/', mediaType: 'image/jpeg' };
    const photo0_16_0: ContactMedia = { kind: 'photo', uri: 'data:base64,/9j/' };
    const photo1_0: ContactMedia = { kind: 'photo', blobId: 'dbcX', mediaType: 'image/jpeg' };
    const logo1_0: ContactMedia = { kind: 'logo', blobId: 'dbcLogo', mediaType: 'image/png' };
    const fetchBlob = vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }));

    beforeEach(() => {
      clearContactPhotoCache();
      fetchBlob.mockClear();
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      useAuthStore.setState({ client: { fetchBlob } as never });
    });

    afterEach(() => {
      useAuthStore.setState({ client: null });
      clearContactPhotoCache();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const withMedia = (media: Record<string, ContactMedia>): ContactCard => ({ ...existingContact, media });

    async function submitPhoneChange(contact: ContactCard) {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<ContactForm contact={contact} onSave={onSave} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByDisplayValue('+33612345678'), { target: { value: '+33699999999' } });
      fireEvent.submit(screen.getByText('save').closest('form')!);
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      return onSave;
    }

    it('leaves media out when only the phone changes on Stalwart 1.0', async () => {
      const onSave = await submitPhoneChange(withMedia({ photo: photo1_0, logo: logo1_0 }));
      expect('media' in onSave.mock.calls[0][0]).toBe(false);
      expect(onSave.mock.calls[0]).toHaveLength(1);
    });

    it.each([
      ['0.16.23', photo0_16_23],
      ['0.16.0', photo0_16_0],
    ])('leaves media out when only the phone changes on Stalwart %s', async (_version, photo) => {
      const onSave = await submitPhoneChange(withMedia({ m0: photo }));
      expect('media' in onSave.mock.calls[0][0]).toBe(false);
    });

    it('shows a Stalwart 1.0 photo in the preview by downloading it', async () => {
      render(<ContactForm contact={withMedia({ photo: photo1_0 })} onSave={vi.fn()} onCancel={vi.fn()} />);

      await waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:preview'));
      expect(fetchBlob).toHaveBeenCalledWith('dbcX', 'photo', 'image/jpeg', undefined);
      expect(screen.getByText('remove_photo')).toBeInTheDocument();
    });

    it('keeps the logo when the Stalwart 1.0 photo is removed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<ContactForm contact={withMedia({ photo: photo1_0, logo: logo1_0 })} onSave={onSave} onCancel={vi.fn()} />);

      fireEvent.click(screen.getByText('remove_photo'));
      fireEvent.submit(screen.getByText('save').closest('form')!);

      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0][0].media).toEqual({ logo: logo1_0 });
    });

    it('sends media: null when the only Stalwart 1.0 photo is removed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<ContactForm contact={withMedia({ photo: photo1_0 })} onSave={onSave} onCancel={vi.fn()} />);

      fireEvent.click(screen.getByText('remove_photo'));
      expect(screen.queryByText('remove_photo')).not.toBeInTheDocument();
      fireEvent.submit(screen.getByText('save').closest('form')!);

      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0][0].media).toBeNull();
    });

    it('puts a new photo under the old key as a data: URI, keeps the logo and names it for the upload', async () => {
      // processImageFile draws the picked file onto a canvas.
      vi.stubGlobal('Image', class {
        width = 1024;
        height = 768;
        onload: (() => void) | null = null;
        set src(_value: string) { setTimeout(() => this.onload?.(), 0); }
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/NEW');
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <ContactForm contact={withMedia({ photo: photo1_0, logo: logo1_0 })} onSave={onSave} onCancel={vi.fn()} />,
      );
      await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview'));

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' })] } });
      await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/NEW'));
      fireEvent.submit(screen.getByText('save').closest('form')!);

      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      const [saved, options] = onSave.mock.calls[0];
      expect(saved.media).toEqual({
        photo: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/NEW', mediaType: 'image/jpeg' },
        logo: logo1_0,
      });
      expect(options).toEqual({ photoKey: 'photo' });
      // The downloaded preview is an object URL; it must never be written back.
      expect(JSON.stringify(saved)).not.toContain('blob:');
    });

    it('gives a first photo a key no other entry uses', async () => {
      vi.stubGlobal('Image', class {
        width = 10;
        height = 10;
        onload: (() => void) | null = null;
        set src(_value: string) { setTimeout(() => this.onload?.(), 0); }
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/NEW');
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <ContactForm contact={withMedia({ photo: logo1_0 })} onSave={onSave} onCancel={vi.fn()} />,
      );

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' })] },
      });
      await waitFor(() => expect(screen.getByText('remove_photo')).toBeInTheDocument());
      fireEvent.submit(screen.getByText('save').closest('form')!);

      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0][0].media).toEqual({
        photo: logo1_0,
        photo1: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/NEW', mediaType: 'image/jpeg' },
      });
      expect(onSave.mock.calls[0][1]).toEqual({ photoKey: 'photo1' });
    });

    /** processImageFile draws the picked file onto a canvas; this stands in for it. */
    function stubImagePipeline() {
      vi.stubGlobal('Image', class {
        width = 10;
        height = 10;
        onload: (() => void) | null = null;
        set src(_value: string) { setTimeout(() => this.onload?.(), 0); }
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/NEW');
    }

    async function pickPhoto(container: HTMLElement) {
      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' })] },
      });
      await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/NEW'));
    }

    describe('on a card with several photos', () => {
      // A card from Apple Contacts or another CardDAV client can carry more
      // than one PHOTO; the one with the lowest pref is the one shown.
      const cardPhotos = {
        '1.0': {
          main: { kind: 'photo', blobId: 'dbcMain', mediaType: 'image/jpeg', pref: 1, label: 'Main', contexts: { work: true } },
          other: { kind: 'photo', blobId: 'dbcOther', mediaType: 'image/jpeg', pref: 5 },
        },
        '0.16': {
          main: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/', mediaType: 'image/jpeg', pref: 1, label: 'Main', contexts: { work: true } },
          other: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/Og==', mediaType: 'image/jpeg', pref: 5 },
        },
      } satisfies Record<string, Record<string, ContactMedia>>;

      it.each(['1.0', '0.16'] as const)('gives a new photo the pref, label and contexts of the one it replaces on Stalwart %s', async (version) => {
        stubImagePipeline();
        const { main, other } = cardPhotos[version];
        const onSave = vi.fn().mockResolvedValue(undefined);
        const { container } = render(
          <ContactForm contact={withMedia({ main, other, logo: logo1_0 })} onSave={onSave} onCancel={vi.fn()} />,
        );

        await pickPhoto(container);
        fireEvent.submit(screen.getByText('save').closest('form')!);

        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        const media = onSave.mock.calls[0][0].media as Record<string, ContactMedia>;
        expect(media).toEqual({
          main: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/NEW', mediaType: 'image/jpeg', pref: 1, label: 'Main', contexts: { work: true } },
          other,
          logo: logo1_0,
        });
        // In the replaced photo's place, and still the one shown.
        expect(Object.keys(media)).toEqual(['main', 'other', 'logo']);
        expect(findContactPhotoEntry({ media })?.[0]).toBe('main');
        expect(onSave.mock.calls[0][1]).toEqual({ photoKey: 'main' });
      });

      it.each(['1.0', '0.16'] as const)('removes every photo, not only the one shown, on Stalwart %s', async (version) => {
        // Removing only the shown photo would bring up the next one after the
        // save, while the form showed none.
        const { main, other } = cardPhotos[version];
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(<ContactForm contact={withMedia({ main, other, logo: logo1_0 })} onSave={onSave} onCancel={vi.fn()} />);

        fireEvent.click(screen.getByText('remove_photo'));
        fireEvent.submit(screen.getByText('save').closest('form')!);

        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        expect(onSave.mock.calls[0][0].media).toEqual({ logo: logo1_0 });
      });
    });

    describe('with the card as the server has it now', () => {
      // The list's copy of the card is older than the server's: the logo was
      // replaced elsewhere, so its old blobId no longer resolves on 1.0.
      const staleLogo: ContactMedia = { kind: 'logo', blobId: 'dbcLogoOld', mediaType: 'image/png' };
      const currentLogo: ContactMedia = { kind: 'logo', blobId: 'dbcLogoNew', mediaType: 'image/png' };

      async function saveNewPhoto(loadCurrentMedia: () => Promise<Pick<ContactCard, 'media'> | null>) {
        stubImagePipeline();
        const onSave = vi.fn().mockResolvedValue(undefined);
        const { container } = render(
          <ContactForm
            contact={withMedia({ photo: photo1_0, logo: staleLogo })}
            onSave={onSave}
            onCancel={vi.fn()}
            loadCurrentMedia={loadCurrentMedia}
          />,
        );
        await pickPhoto(container);
        fireEvent.submit(screen.getByText('save').closest('form')!);
        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        return onSave.mock.calls[0][0].media as Record<string, ContactMedia>;
      }

      it('sends the logo the server has now with a new photo on Stalwart 1.0', async () => {
        const loadCurrentMedia = vi.fn(async () => ({ media: { photo: photo1_0, logo: currentLogo } }));

        const media = await saveNewPhoto(loadCurrentMedia);

        expect(loadCurrentMedia).toHaveBeenCalledOnce();
        expect(media).toEqual({
          photo: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/NEW', mediaType: 'image/jpeg' },
          logo: currentLogo,
        });
      });

      it('keeps a photo added elsewhere since, and drops a logo removed elsewhere, when the photo is removed', async () => {
        const added: ContactMedia = { kind: 'photo', blobId: 'dbcAdded', mediaType: 'image/jpeg' };
        const loadCurrentMedia = vi.fn(async () => ({ media: { photo: photo1_0, added } }));
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
          <ContactForm
            contact={withMedia({ photo: photo1_0, logo: staleLogo })}
            onSave={onSave}
            onCancel={vi.fn()}
            loadCurrentMedia={loadCurrentMedia}
          />,
        );

        fireEvent.click(screen.getByText('remove_photo'));
        fireEvent.submit(screen.getByText('save').closest('form')!);

        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        expect(onSave.mock.calls[0][0].media).toEqual({ added });
      });

      it.each([
        ['cannot be read', async () => null],
        ['fails to load', async () => { throw new Error('Request failed: 503'); }],
      ])('falls back to the form\'s copy when the card %s', async (_why, loadCurrentMedia) => {
        const media = await saveNewPhoto(loadCurrentMedia as () => Promise<null>);

        expect(media).toEqual({
          photo: { kind: 'photo', uri: 'data:image/jpeg;base64,/9j/NEW', mediaType: 'image/jpeg' },
          logo: staleLogo,
        });
      });

      it('reads nothing when the photo did not change', async () => {
        const loadCurrentMedia = vi.fn(async () => ({ media: {} }));
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
          <ContactForm
            contact={withMedia({ photo: photo1_0, logo: staleLogo })}
            onSave={onSave}
            onCancel={vi.fn()}
            loadCurrentMedia={loadCurrentMedia}
          />,
        );
        fireEvent.change(screen.getByDisplayValue('+33612345678'), { target: { value: '+33699999999' } });
        fireEvent.submit(screen.getByText('save').closest('form')!);

        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        expect(loadCurrentMedia).not.toHaveBeenCalled();
        expect('media' in onSave.mock.calls[0][0]).toBe(false);
      });
    });
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

  it('sets name.full from the name components so exported vCards carry FN (#430)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('given_name'), { target: { value: 'ABTest' } });
    fireEvent.change(screen.getByPlaceholderText('surname'), { target: { value: 'Web' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });

    expect(onSave.mock.calls[0][0].name.full).toBe('ABTest Web');
  });

  it('saves an organization-only card when the organization type is selected', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('type_organization'));
    fireEvent.change(screen.getByPlaceholderText('organization_placeholder'), { target: { value: 'Acme Corp' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });

    const savedData = onSave.mock.calls[0][0];
    expect(savedData.kind).toBe('org');
    expect(savedData.organizations.o0.name).toBe('Acme Corp');
    // No personal name components; the org name carries the display name instead.
    expect(savedData.name.components).toBeUndefined();
    expect(savedData.name.full).toBe('Acme Corp');
  });

  it('hides the personal name fields in organization mode', () => {
    render(<ContactForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByPlaceholderText('given_name')).toBeInTheDocument();

    fireEvent.click(screen.getByText('type_organization'));

    expect(screen.queryByPlaceholderText('given_name')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('surname')).not.toBeInTheDocument();
    // The organization field moves into the identity section, so it appears once.
    expect(screen.getAllByPlaceholderText('organization_placeholder')).toHaveLength(1);
  });

  it('still requires a name in organization mode', async () => {
    const onSave = vi.fn();
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('type_organization'));
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('name_required');
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('accepts an organization instead of a personal name in person mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('section_work'));
    fireEvent.change(screen.getByPlaceholderText('organization_placeholder'), { target: { value: 'Acme Corp' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });
    expect(onSave.mock.calls[0][0].name.full).toBe('Acme Corp');
  });

  it('opens an existing org card in organization mode', () => {
    const orgContact: ContactCard = {
      id: '2',
      addressBookIds: {},
      kind: 'org',
      name: { full: 'Acme Corp' },
      organizations: { o0: { name: 'Acme Corp' } },
    };
    render(<ContactForm contact={orgContact} onSave={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByPlaceholderText('given_name')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme Corp')).toBeInTheDocument();
  });

  it('switches an org card back to a person', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const orgContact: ContactCard = {
      id: '2',
      addressBookIds: {},
      kind: 'org',
      name: { full: 'Acme Corp' },
      organizations: { o0: { name: 'Acme Corp' } },
    };
    render(<ContactForm contact={orgContact} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByText('type_person'));
    fireEvent.change(screen.getByPlaceholderText('given_name'), { target: { value: 'Jane' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });
    expect(onSave.mock.calls[0][0].kind).toBe('individual');
  });

  it("names the account of an address book once, not twice", () => {
    const books = [
      { id: 'b1', name: 'Stalwart Address Book (usera@example.org)', accountName: 'usera@example.org', isDefault: true },
      { id: 'b2', name: 'Team', accountName: 'userb@example.org', isShared: true },
    ] as never;
    render(<ContactForm addressBooks={books} onSave={vi.fn()} onCancel={vi.fn()} />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Stalwart Address Book (usera@example.org)');
    expect(options).toContain('Team (userb@example.org)');
  });
});

// pim-4: saving never rewrites what the user didn't touch.
describe('ContactForm keeps what was not edited', () => {
  // As a card with a structured German address comes from ContactCard/get.
  const home = {
    '@type': 'Address',
    contexts: { private: true },
    countryCode: 'DE',
    full: 'Hauptstraße 1, 3. OG, 10000 Berlin',
    isOrdered: true,
    defaultSeparator: ', ',
    components: [
      { kind: 'name', value: 'Hauptstraße' },
      { kind: 'separator', value: ' ' },
      { kind: 'number', value: '1' },
      { kind: 'apartment', value: '3. OG' },
      { kind: 'postcode', value: '10000' },
      { kind: 'locality', value: 'Berlin' },
      { kind: 'country', value: 'Germany' },
    ],
  };
  const office = {
    components: [
      { kind: 'number', value: '1' },
      { kind: 'name', value: 'Main Street' },
      { kind: 'locality', value: 'Springfield' },
      { kind: 'region', value: 'IL' },
      { kind: 'postcode', value: '62701' },
      { kind: 'country', value: 'USA' },
    ],
    contexts: { work: true },
  };
  const card: ContactCard = {
    ...existingContact,
    nicknames: { nick: { name: 'Ali', contexts: { private: true } } },
    emails: { home: { address: 'alice@example.com', pref: 1, label: 'main' }, w: { address: 'alice@work.example', contexts: { work: true } } },
    addresses: { home, office } as ContactCard['addresses'],
  };

  async function save(change: () => void) {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm contact={card} onSave={onSave} onCancel={vi.fn()} />);
    change();
    fireEvent.submit(screen.getByText('save').closest('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    return onSave.mock.calls[0][0] as Partial<ContactCard>;
  }

  it('sends only the nickname when only the nickname changed', async () => {
    const data = await save(() => fireEvent.change(screen.getByDisplayValue('Ali'), { target: { value: 'Lissy' } }));
    expect(Object.keys(data)).toEqual(['nicknames']);
    // The nickname keeps its key and its contexts.
    expect(data.nicknames).toEqual({ nick: { name: 'Lissy', contexts: { private: true } } });
  });

  it("shows street and number in the address's own order, German fields as Street, Postcode + City", () => {
    render(<ContactForm contact={card} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByDisplayValue('Hauptstraße 1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1 Main Street')).toBeInTheDocument();
    const berlin = screen.getByDisplayValue('Berlin');
    const postcode = screen.getByDisplayValue('10000');
    // Postcode comes before the city for Germany, after it for the US.
    expect(postcode.compareDocumentPosition(berlin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const springfield = screen.getByDisplayValue('Springfield');
    const zip = screen.getByDisplayValue('62701');
    expect(springfield.compareDocumentPosition(zip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps an untouched address exactly as stored when another address is edited', async () => {
    const data = await save(() => fireEvent.change(screen.getByDisplayValue('62701'), { target: { value: '62702' } }));
    expect(data.addresses!.home).toBe(home);
    expect(data.addresses!.office.components!.find(c => c.kind === 'postcode')!.value).toBe('62702');
    expect('emails' in data).toBe(false);
  });

  // An address with only parts the form has no field for shows as empty rows.
  // Editing another address dropped it from the save.
  it('keeps an address the form cannot show when another address is edited', async () => {
    const box = { components: [{ kind: 'postOfficeBox', value: 'Postfach 12 34' }], contexts: { work: true } };
    const textOnly = { full: 'c/o Example GmbH, somewhere' };
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm contact={{ ...card, addresses: { home, office, box, textOnly } as ContactCard['addresses'] }} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('62701'), { target: { value: '62702' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const data = onSave.mock.calls[0][0] as Partial<ContactCard>;
    expect(data.addresses!.box).toBe(box);
    expect(data.addresses!.textOnly).toBe(textOnly);
  });

  it('saves an edited German address in German order and keeps the parts the form does not show', async () => {
    const data = await save(() => fireEvent.change(screen.getByDisplayValue('Hauptstraße 1'), { target: { value: 'Hauptstraße 12a' } }));
    const saved = data.addresses!.home;
    expect(saved.components!.map(c => `${c.kind}:${c.value}`)).toEqual([
      'name:Hauptstraße', 'separator: ', 'number:12a', 'apartment:3. OG', 'postcode:10000', 'separator: ', 'locality:Berlin', 'country:Germany',
    ]);
    expect(saved).toMatchObject({ '@type': 'Address', countryCode: 'DE', contexts: { private: true }, isOrdered: true, defaultSeparator: ', ' });
    // The old one-line text would contradict the new parts.
    expect(saved.full).toBeUndefined();
    expect(data.addresses!.office).toBe(office);
  });

  it('keeps an untouched email with its key, pref and label when another is edited', async () => {
    const data = await save(() => fireEvent.change(screen.getByDisplayValue('alice@work.example'), { target: { value: 'alice@new.example' } }));
    expect(data.emails!.home).toBe(card.emails!.home);
    expect(data.emails!.w).toEqual({ address: 'alice@new.example', contexts: { work: true } });
  });

  it('still sends every field of a new contact, its address in the order of the country typed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('given_name'), { target: { value: 'Jane' } });
    fireEvent.click(screen.getByText('addresses'));
    fireEvent.click(screen.getByText('add_address'));
    fireEvent.change(screen.getByPlaceholderText('street'), { target: { value: 'Hauptstraße 5' } });
    fireEvent.change(screen.getByPlaceholderText('country'), { target: { value: 'Deutschland' } });
    fireEvent.submit(screen.getByText('save').closest('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const data = onSave.mock.calls[0][0] as Partial<ContactCard>;
    expect('emails' in data && 'notes' in data && 'name' in data).toBe(true);
    expect(data.addresses!.a0).toMatchObject({ countryCode: 'DE' });
    expect(data.addresses!.a0.components!.map(c => `${c.kind}:${c.value}`)).toEqual(['name:Hauptstraße', 'separator: ', 'number:5', 'country:Deutschland']);
  });
});
