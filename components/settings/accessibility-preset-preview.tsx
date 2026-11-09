"use client";

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { BellRinging, Ellipsis, Image as ImageIcon, Pause, Pointer, Volume2, VolumeOff, X } from '@/components/icons';
import type { AccessibilityPresetId } from '@/lib/accessibility-presets';

/*
 * A small drawing of the mail view on each preset card that shows what the
 * preset changes before it is applied. Sizes are in px so the drawing keeps
 * its proportions whatever text size the user has set, and it is hidden
 * from screen readers: the card's description says the same in words.
 */

function Bar({ width, strong, className }: { width: number | string; strong?: boolean; className?: string }) {
  return (
    <span
      className={cn('block h-[3px] rounded-full shrink-0', strong ? 'bg-foreground/70' : 'bg-muted-foreground/35', className)}
      style={{ width }}
    />
  );
}

function Avatar({ size = 8 }: { size?: number }) {
  return <span className="block rounded-full bg-primary/40 shrink-0" style={{ width: size, height: size }} />;
}

function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('relative flex w-[104px] h-[68px] shrink-0 overflow-hidden rounded border border-border bg-background', className)}>
      {children}
    </span>
  );
}

/** A message row: avatar, sender, and optionally the preview line. */
function Row({ preview = true, avatar = true, className }: { preview?: boolean; avatar?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-1.5 px-1.5 py-[3px]', className)}>
      {avatar && <Avatar />}
      <span className="flex flex-col gap-[3px] min-w-0 flex-1">
        <Bar width="60%" strong />
        {preview && <Bar width="90%" />}
      </span>
    </span>
  );
}

function ScreenReaderPreview() {
  // One column, no reading pane, and the focused row read out.
  return (
    <Frame className="flex-col py-1">
      <Row className="bg-primary/10" />
      <Row />
      <Row />
      <Row />
      <Volume2 className="absolute top-1 end-1 w-3.5 h-3.5 text-primary" stroke={2.25} />
    </Frame>
  );
}

function LowVisionPreview() {
  // Big, high-contrast text, a thick focus outline, an underlined link, a big pointer.
  return (
    <Frame className="flex-col gap-1.5 p-1.5">
      <span className="text-[1.25rem] leading-none font-bold text-foreground">Aa</span>
      <span className="flex items-center gap-1.5 rounded-sm px-1 py-1 outline outline-[2.5px] outline-primary">
        <Avatar size={10} />
        <Bar width={40} strong className="h-[4px]" />
      </span>
      <span className="block w-[44px] border-b-2 border-primary pb-[1px]">
        <Bar width="100%" className="bg-primary/70 h-[4px]" />
      </span>
      <Pointer className="absolute bottom-0.5 end-1 w-6 h-6 text-foreground fill-background" stroke={2} />
    </Frame>
  );
}

function DyslexiaPreview() {
  // A clearer font, more room between letters, words and lines, a narrower column.
  const lines = [[14, 9, 18, 10], [8, 16, 12], [12, 10, 15, 6], [16, 11]];
  return (
    <Frame className="justify-center">
      <span className="flex flex-col gap-[6px] w-[64px] py-1.5">
        <span
          className="text-[0.875rem] leading-none text-foreground tracking-[0.12em]"
          style={{ fontFamily: '"Atkinson Hyperlegible Next", sans-serif' }}
        >
          Abc
        </span>
        {lines.map((words, i) => (
          <span key={i} className="flex gap-[4px]">
            {words.map((width, j) => <Bar key={j} width={width} />)}
          </span>
        ))}
      </span>
    </Frame>
  );
}

function FocusPreview() {
  // A plain list: no pictures, no preview lines, a dot instead of a count.
  return (
    <Frame>
      <span className="flex flex-col gap-[7px] w-[30px] border-e border-border bg-muted/40 p-1.5">
        <span className="flex items-center justify-between">
          <Bar width={13} strong />
          <span className="block w-[5px] h-[5px] rounded-full bg-primary" />
        </span>
        <Bar width={15} />
        <Bar width={11} />
      </span>
      <span className="flex flex-col gap-[9px] flex-1 p-2">
        <Bar width="55%" strong />
        <Bar width="70%" />
        <Bar width="45%" />
        <Bar width="60%" />
      </span>
    </Frame>
  );
}

function MotorPreview() {
  // Tall rows, an actions button on each, a thick outline on the focused one.
  return (
    <Frame className="flex-col gap-[3px] p-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            'flex items-center gap-1.5 h-[18px] rounded-sm px-1',
            i === 0 && 'outline outline-2 -outline-offset-2 outline-primary',
          )}
        >
          <Avatar size={9} />
          <Bar width={34} strong className="flex-1" />
          <span className="flex items-center justify-center w-[18px] h-[13px] rounded-sm border border-border bg-muted">
            <Ellipsis className="w-3 h-3 text-muted-foreground" />
          </span>
        </span>
      ))}
    </Frame>
  );
}

function MotionPreview() {
  // A paused animated image on a solid panel, with no movement anywhere.
  return (
    <Frame className="flex-col gap-1.5 p-1.5">
      <span className="relative flex items-center justify-center h-[34px] rounded-sm bg-muted">
        <ImageIcon className="w-5 h-5 text-muted-foreground/60" />
        <span className="absolute bottom-[3px] end-[3px] flex items-center justify-center w-[14px] h-[14px] rounded-full bg-foreground/80">
          <Pause className="w-2.5 h-2.5 text-background" stroke={3} />
        </span>
      </span>
      <Bar width="80%" strong />
      <Bar width="60%" />
    </Frame>
  );
}

function HearingPreview() {
  // The tab title lights up instead of a sound, and the notification stays until
  // closed. No ring around the frame: that reads as the card being selected.
  return (
    <Frame className="flex-col">
      <span className="flex items-end justify-between h-[14px] ps-1.5 pe-1 bg-muted/60 border-b border-border">
        <span className="flex items-center w-[46px] h-[9px] rounded-t-sm bg-primary/25 px-1">
          <Bar width="100%" className="bg-primary" />
        </span>
        <VolumeOff className="self-center w-3 h-3 text-muted-foreground" />
      </span>
      <span className="flex flex-col gap-[5px] p-1.5">
        <Bar width="55%" strong />
        <Bar width="75%" />
      </span>
      <span className="absolute bottom-1.5 inset-x-1.5 flex items-center gap-1 rounded-sm border border-border bg-muted px-1 py-[3px] shadow-sm">
        <BellRinging className="w-3 h-3 text-primary shrink-0" stroke={2.25} />
        <Bar width="100%" strong className="flex-1" />
        <X className="w-2.5 h-2.5 text-muted-foreground shrink-0" stroke={2.5} />
      </span>
    </Frame>
  );
}

const PREVIEWS: Record<AccessibilityPresetId, () => ReactNode> = {
  'screen-reader': ScreenReaderPreview,
  'low-vision': LowVisionPreview,
  dyslexia: DyslexiaPreview,
  focus: FocusPreview,
  motor: MotorPreview,
  motion: MotionPreview,
  hearing: HearingPreview,
};

export function AccessibilityPresetPreview({ id }: { id: AccessibilityPresetId }) {
  const Preview = PREVIEWS[id];
  return (
    <span aria-hidden="true" data-testid={`preset-preview-${id}`} className="block pointer-events-none select-none">
      <Preview />
    </span>
  );
}
