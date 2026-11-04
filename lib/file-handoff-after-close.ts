import { historySettled } from '@/hooks/use-close-on-back';
import { handOffFiles, type HandoffKind } from '@/lib/launch-handoff';

/**
 * Hands files to another app (contacts or calendar import) from a layer that is
 * closing, such as the Files preview. Closing it takes its history entry back
 * with a Back that lands later; the handoff's move to /contacts or /calendar,
 * started before that, was undone by it and left the user in Files (pim-p2-7).
 * So: let the close commit, wait for that Back, then hand off.
 */
export async function handOffFilesAfterClose(files: File[], kind: HandoffKind): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await historySettled();
  handOffFiles(files, kind);
}
