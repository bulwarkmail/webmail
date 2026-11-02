import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame"

export function Pattern() {
  return (
    <Frame className="w-full">
      <FrameHeader>
        <FrameTitle>Section header</FrameTitle>
        <FrameDescription>Description for the section</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <h2 className="text-sm font-semibold">Section title</h2>
        <p className="text-muted-foreground text-sm">Section description</p>
      </FramePanel>
      <FrameFooter>
        <p className="text-muted-foreground text-sm">Section footer</p>
      </FrameFooter>
    </Frame>
  )
}