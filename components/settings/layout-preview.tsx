"use client";

import { useState, type FocusEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import type { InterfaceLayout, MailLayout } from '@/stores/settings-store';

/*
 * The small drawn screens under the Layout section's choices: Interface
 * layout and Mail layout share one drawing, so each shows the other's
 * current choice around its own. Bars and dots, not screenshots, with the
 * same sample senders in both.
 */

const ROWS = [
  { sender: 'Alice', subject: 'Quarterly roadmap', selected: false },
  { sender: 'Nadia', subject: 'Design sync', selected: true },
  { sender: 'Billing', subject: 'Invoice 1042', selected: false },
];

const ROWS_FULL_WIDTH = [
  ...ROWS,
  { sender: 'Sam', subject: 'Lunch?', selected: false },
  { sender: 'Newsletter', subject: 'Weekly digest', selected: false },
];

const BAR = 'rounded bg-foreground/10';

/**
 * Which option a preview draws: the one under the pointer, else the one with
 * keyboard focus, else the selected one. Spread `handlers` on an element
 * around the option buttons; each button carries `data-option-value`.
 */
export function useOptionPreview<T extends string>(selected: T) {
  const [hovered, setHovered] = useState<T | null>(null);
  const [focused, setFocused] = useState<T | null>(null);
  const optionOf = (target: EventTarget | null): T | null => {
    if (!(target instanceof Element)) return null;
    const value = target.closest<HTMLElement>('[data-option-value]')?.dataset.optionValue;
    return (value as T | undefined) ?? null;
  };
  return {
    shown: hovered ?? focused ?? selected,
    handlers: {
      onPointerOver: (e: PointerEvent) => setHovered(optionOf(e.target)),
      onPointerLeave: () => setHovered(null),
      onFocus: (e: FocusEvent) => setFocused(optionOf(e.target)),
      onBlur: () => setFocused(null),
    },
  };
}

function ListRow({ sender, subject, selected, inline }: { sender: string; subject: string; selected: boolean; inline: boolean }) {
  return (
    <div className={cn('border-b border-border px-2 text-[0.625rem] last:border-b-0', inline ? 'py-1' : 'py-1.5', selected && 'bg-primary/10')}>
      {inline ? (
        <div className="truncate text-foreground">
          <bdi className="font-medium">{sender}</bdi>
          <bdi className="mx-1.5 text-muted-foreground">{subject}</bdi>
        </div>
      ) : (
        <>
          <div className="truncate font-medium text-foreground"><bdi>{sender}</bdi></div>
          <div className="truncate text-muted-foreground"><bdi>{subject}</bdi></div>
        </>
      )}
    </div>
  );
}

/** The open message: a subject bar over a few lines of text. */
function Reader({ short }: { short?: boolean }) {
  return (
    <div className="flex-1 bg-background px-3 py-2" data-part="reader">
      <div className={cn('h-2.5 w-20', BAR)} />
      <div className={cn('mt-2 h-2 w-full', BAR)} />
      <div className={cn('mt-1.5 h-2 w-5/6', BAR)} />
      {!short && <div className={cn('mt-1.5 h-2 w-2/3', BAR)} />}
    </div>
  );
}

/** The default layout's list header: select box, search field, menu. */
function ListHeader() {
  return (
    <div className="flex h-5 shrink-0 items-center gap-1 border-b border-border px-1.5" data-part="search">
      <div className="size-1.5 shrink-0 rounded-sm border border-foreground/30" />
      <div className="h-3 flex-1 rounded border border-border bg-muted/60" />
      <div className="h-1.5 w-0.5 shrink-0 rounded bg-foreground/30" />
    </div>
  );
}

/** Folder rows: the first is the open one. */
function Folders({ pill }: { pill: boolean }) {
  return (
    <div className="mt-1.5 space-y-1">
      {['w-8', 'w-6', 'w-7', 'w-5'].map((width, i) => (
        <div
          key={width}
          className={cn('flex h-2.5 items-center gap-1 px-1', i === 0 && 'bg-primary/15', i === 0 && (pill ? 'rounded-e-full' : 'rounded-sm'))}
        >
          <div className="size-1 shrink-0 rounded-full bg-foreground/30" />
          <div className={cn('h-1', width, BAR, 'bg-foreground/20')} />
        </div>
      ))}
    </div>
  );
}

/** The mail view inside the shell, as each mail layout draws it. */
function MailArea({ mail, header }: { mail: MailLayout; header: boolean }) {
  if (mail === 'split') {
    return (
      <>
        <div className="flex w-24 shrink-0 flex-col border-e border-border bg-background" data-part="list">
          {header && <ListHeader />}
          {ROWS.map((row) => <ListRow key={row.subject} {...row} inline={false} />)}
        </div>
        <Reader />
      </>
    );
  }
  if (mail === 'horizontal') {
    return (
      <div className="flex flex-1 flex-col bg-background" data-part="list">
        {header && <ListHeader />}
        <div className="border-b border-border">
          {ROWS.slice(0, 2).map((row) => <ListRow key={row.subject} {...row} inline />)}
        </div>
        <Reader short />
      </div>
    );
  }
  return (
    <div className="flex-1 bg-background" data-part="list">
      {header && <ListHeader />}
      {ROWS_FULL_WIDTH.map((row) => <ListRow key={row.subject} {...row} inline />)}
    </div>
  );
}

/**
 * A small drawing of the mail screen.
 * - default: the app rail (Mail, Calendar, Contacts, Files), the folder
 *   sidebar with Compose, and the search field heading the list column.
 * - mountain-view: one search bar across the top, the folders with a
 *   Compose pill on the canvas, the list on a card, the side panel's apps.
 */
export function LayoutMock({ shell, mail }: { shell: InterfaceLayout; mail: MailLayout }) {
  if (shell === 'mountain-view') {
    return (
      <div className="flex h-32 flex-col bg-muted/50" data-shell="mountain-view" data-mail={mail}>
        <div className="flex h-6 shrink-0 items-center gap-1.5 px-1.5" data-part="search">
          <div className="h-1.5 w-2 shrink-0 rounded-sm border-y border-foreground/40" />
          <div className={cn('h-1.5 w-7 shrink-0', BAR, 'bg-foreground/25')} />
          <div className="h-3.5 w-1/2 rounded-full bg-foreground/[0.07]" />
          <div className="flex-1" />
          <div className="size-1.5 shrink-0 rounded-full bg-foreground/25" />
          <div className="size-1.5 shrink-0 rounded-full bg-foreground/25" />
          <div className="size-2.5 shrink-0 rounded-full bg-primary/60" />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-16 shrink-0 pe-1" data-part="folders">
            <div className="ms-1 h-3.5 w-10 rounded-md bg-primary/25" />
            <Folders pill />
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-lg border border-b-0 border-border bg-background">
            <div className="flex h-4 shrink-0 items-center gap-1.5 border-b border-border px-2">
              <div className="size-1.5 rounded-sm border border-foreground/30" />
              <div className="size-1.5 rounded-full bg-foreground/20" />
            </div>
            <div className="flex min-h-0 flex-1">
              <MailArea mail={mail} header={false} />
            </div>
          </div>
          <div className="flex w-4 shrink-0 flex-col items-center gap-1.5 pt-2" data-part="apps">
            {[0, 1, 2].map((i) => <div key={i} className="size-1.5 rounded-sm bg-foreground/25" />)}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-32" data-shell="default" data-mail={mail}>
      <div className="flex w-5 shrink-0 flex-col items-center gap-1.5 border-e border-border bg-muted/40 pt-2" data-part="apps">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn('size-2 rounded-sm', i === 0 ? 'bg-primary/60' : 'bg-foreground/20')} />
        ))}
      </div>
      <div className="w-16 shrink-0 border-e border-border bg-muted/20 p-1" data-part="folders">
        <div className="h-3 rounded bg-primary" />
        <Folders pill={false} />
      </div>
      <MailArea mail={mail} header />
    </div>
  );
}

/**
 * The card under a layout choice: the shown option's name, one line on what
 * it does, and the drawing. Screen readers hear only the selected option's
 * name, when it changes; hovering to compare doesn't talk over them.
 */
export function LayoutPreview({
  testId,
  option,
  title,
  description,
  selectedTitle,
  shell,
  mail,
}: {
  testId: string;
  /** The option drawn: see useOptionPreview. */
  option: string;
  title: string;
  description: string;
  selectedTitle: string;
  shell: InterfaceLayout;
  mail: MailLayout;
}) {
  return (
    <>
      <div className="mt-3 rounded-xl border border-border bg-background p-3" data-testid={testId} data-option={option} aria-hidden="true">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{description}</div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/20">
          <LayoutMock shell={shell} mail={mail} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite" data-testid={`${testId}-status`}>{selectedTitle}</p>
    </>
  );
}
