import { Profiler } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextMenu, ContextMenuItem } from '../context-menu';

// A closed menu comes with every message row's hover actions, the rail and
// the toolbars. Mounting one must not cost a render pass of its own: the perf
// guard counted two extra passes on every message open for the row's ⋮ menu.
describe('a closed context menu', () => {
  it('mounts in the same render pass as what it comes with', () => {
    const commits: string[] = [];
    render(
      <Profiler id="row" onRender={(_id, phase) => commits.push(phase)}>
        <ContextMenu isOpen={false} position={{ x: 0, y: 0 }} onClose={() => {}}>
          <ContextMenuItem label="Reply" onClick={() => {}} />
        </ContextMenu>
      </Profiler>,
    );
    expect(commits).toEqual(['mount']);
  });

  it('still opens on its first render once it is asked to', () => {
    function Host({ open }: { open: boolean }) {
      return (
        <ContextMenu isOpen={open} position={{ x: 10, y: 10 }} onClose={() => {}}>
          <ContextMenuItem label="Reply" onClick={() => {}} />
        </ContextMenu>
      );
    }
    const { rerender } = render(<Host open={false} />);
    expect(screen.queryByRole('menu')).toBeNull();
    rerender(<Host open />);
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  });
});
