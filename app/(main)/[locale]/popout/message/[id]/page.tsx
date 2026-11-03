import { PopoutMessageApp } from "@/components/popout/popout-message-app";

// One message in a window of its own (lib/popout). Not in Lite: scripts/lite
// removes this tree, since a static export can't list every message id.
export default async function PopoutMessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PopoutMessageApp id={decodeURIComponent(id)} />;
}
