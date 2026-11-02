import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilePreviewModal } from '../file-preview-modal';
import { ImagePreviewModal } from '../image-preview-modal';
import {PreviewShell} from '../preview-shell';

vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));

describe('one preview frame for images and other files', () => {
  it('has the same header buttons in both, and ←/→ go to the next and previous file', async () => {
    const onGo = vi.fn();
    const neighbours = { previous: 'a.txt', next: 'c.png', onGo };
    const { unmount } = render(
      <FilePreviewModal name="b.txt" onClose={vi.fn()} onDownload={vi.fn()} getFileContent={() => new Promise(() => {})} neighbours={neighbours} />,
    );
    const textButtons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onGo).toHaveBeenLastCalledWith('c.png');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onGo).toHaveBeenLastCalledWith('a.txt');
    unmount();

    render(<ImagePreviewModal name="c.png" onClose={vi.fn()} onDownload={async () => {}} getImageUrl={() => new Promise(() => {})} neighbours={neighbours} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(textButtons);
  });
});


it('leaves native select and composition/modified arrows to the content',()=>{
  const onGo=vi.fn();
  render(<PreviewShell name="notes.txt" onClose={vi.fn()} neighbours={{previous:'a.txt',next:'c.txt',onGo}}>
    <select aria-label="Document setting"><option>One</option><option>Two</option></select>
  </PreviewShell>);
  const select=screen.getByRole('combobox');
  fireEvent.keyDown(select,{key:'ArrowRight'});
  fireEvent.keyDown(window,{key:'ArrowRight',isComposing:true});
  fireEvent.keyDown(window,{key:'ArrowRight',shiftKey:true});
  expect(onGo).not.toHaveBeenCalled();
  fireEvent.keyDown(window,{key:'ArrowRight'});expect(onGo).toHaveBeenCalledWith('c.txt');
});
