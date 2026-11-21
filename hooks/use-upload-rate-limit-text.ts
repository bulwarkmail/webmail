import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { retryAfterMinutes, uploadRateLimit } from "@/lib/jmap/upload-errors";

/**
 * The line that explains an upload the server refused with HTTP 429 (too
 * many uploads), with the wait the server asked for when it said; undefined
 * for any other error.
 */
export function useUploadRateLimitText(): (error: unknown) => string | undefined {
  const t = useTranslations("upload_rate_limit");
  return useCallback((error: unknown) => {
    const limit = uploadRateLimit(error);
    if (!limit) return undefined;
    return limit.retryAfterMs !== undefined
      ? t("retry_in", { minutes: retryAfterMinutes(limit.retryAfterMs) })
      : t("retry_later");
  }, [t]);
}
