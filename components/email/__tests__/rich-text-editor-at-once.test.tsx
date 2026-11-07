import { Profiler } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichTextEditor } from '../rich-text-editor';

// The mail page's composer is client-only, so its editor is built in the
// first render and drawn with it, not one render later.

function commitsOf(renderAtOnce: boolean): { commits: number; editable: boolean } {
  let commits = 0;
  const { container, unmount } = render(
    <Profiler id="editor" onRender={() => { commits++; }}>
      <RichTextEditor renderAtOnce={renderAtOnce} content="<p>Hello</p>" onChange={() => {}} />
    </Profiler>,
  );
  const editable = !!container.querySelector('[contenteditable="true"]');
  unmount();
  return { commits, editable };
}

describe('the composer body editor', () => {
  it('is drawn in its first commit when built at once', () => {
    const atOnce = commitsOf(true);
    const later = commitsOf(false);
    expect(atOnce.editable).toBe(true);
    expect(later.editable).toBe(true);
    expect(atOnce.commits).toBeLessThan(later.commits);
  });
});
