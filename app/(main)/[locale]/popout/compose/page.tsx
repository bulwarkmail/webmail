import { PopoutComposeApp } from "@/components/popout/popout-compose-app";

// The composer in a window of its own (lib/popout). Not in Lite: scripts/lite
// removes this tree, and "Open in new window" isn't offered there.
export default function PopoutComposePage() {
  return <PopoutComposeApp />;
}
