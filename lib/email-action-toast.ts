import { toast } from "@/stores/toast-store";
import { useEmailStore } from "@/stores/email-store";

/**
 * Runs a bulk email-store action and toasts the outcome. Most batch actions
 * report failure through `state.error` instead of throwing (batchArchive does
 * both), so a resolved promise alone does not mean the mail moved.
 */
export async function runBatchEmailAction(
  run: () => Promise<void>,
  messages: { success: string; error: string; describeError?: (error: unknown) => string | undefined },
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(messages.error, error);
    const detail = messages.describeError?.(error) ?? (error instanceof Error ? error.message : undefined);
    toast.error(messages.error, detail);
    return;
  }
  const storeError = useEmailStore.getState().error;
  if (storeError) {
    toast.error(messages.error, storeError);
  } else {
    toast.success(messages.success);
  }
}
