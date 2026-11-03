/**
 * The setup wizard as it loads (app/(main)/setup/page.tsx): the header, the
 * seven-step progress bar and the card with the welcome step, which a fresh
 * install opens on. The wizard asks /api/setup/status first; a wizard
 * session that already passed the token goes on to a later step, whose card
 * is taller.
 *
 * The page passes its translated strings, so the frame is drawn for real;
 * without them (a connector link to /setup) it is drawn in bars.
 */
import { cn } from "@/lib/cn";
import { SETUP_STEPS } from "@/lib/setup/steps";
import { SkeletonRegion, repeat } from "./kit";
import { TextLine } from "./login-skeleton";

export interface SetupSkeletonStrings {
  title: string;
  subtitle: string;
  /** One label per step, in order. */
  steps: readonly string[];
  welcomeTitle: string;
  welcomeBody: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  continueLabel: string;
}

export interface SetupSkeletonProps {
  /** common.loading */
  label?: string;
  strings?: SetupSkeletonStrings;
  className?: string;
}

const CENTERED = "inset-x-0 mx-auto";

export function SetupSkeleton({ label, strings, className }: SetupSkeletonProps) {
  return (
    <SkeletonRegion
      surface="setup"
      label={label}
      className={cn("min-h-screen flex items-center justify-center px-4 py-8", className)}
    >
      <div aria-hidden="true" className="w-full max-w-2xl">
        <div className="text-center mb-6">
          {strings ? (
            <>
              <span className="block text-2xl font-semibold">{strings.title}</span>
              <span className="block text-sm text-muted-foreground mt-1">{strings.subtitle}</span>
            </>
          ) : (
            <>
              <TextLine className="text-2xl font-semibold" w="16rem" bar={cn("h-6", CENTERED)} />
              <TextLine className="text-sm mt-1" w="20rem" bar={CENTERED} />
            </>
          )}
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-1.5 text-xs">
            {repeat(SETUP_STEPS.length, (i) => (
              <div className="flex-1">
                <div className={cn("h-1 rounded-full", i === 0 ? "bg-primary/60" : "bg-muted")} />
                {strings?.steps[i] ? (
                  <div className={cn("mt-1.5 text-center", i === 0 ? "text-foreground font-medium" : "text-muted-foreground")}>
                    {strings.steps[i]}
                  </div>
                ) : (
                  <TextLine className="mt-1.5" w="60%" bar={CENTERED} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <div className="space-y-4">
            {strings ? (
              <>
                <span className="block text-lg font-semibold">{strings.welcomeTitle}</span>
                <span className="block text-sm text-muted-foreground">{strings.welcomeBody}</span>
                <div>
                  <span className="block text-sm font-medium mb-1">{strings.tokenLabel}</span>
                  <span className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
                    {strings.tokenPlaceholder}
                  </span>
                </div>
                {/* Disabled until a token is typed in, as on the page. */}
                <span className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium opacity-50">
                  {strings.continueLabel}
                </span>
              </>
            ) : (
              <>
                <TextLine className="text-lg font-semibold" w="6rem" />
                <TextLine className="text-sm" w="85%" />
                <div>
                  <TextLine className="text-sm font-medium mb-1" w="6rem" />
                  <span className="block h-10 w-full rounded-md border border-input bg-background" />
                </div>
                <TextLine className="text-sm w-24" w="100%" bar="h-9 rounded-md" />
              </>
            )}
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}
