/**
 * The sign-in page as it loads: the card with logo, heading, the user name
 * and password fields, the 2FA link and the button, and the version line
 * under it (app/(main)/[locale]/login/page.tsx, the default form). Class
 * lists mirror the page's, so the form takes the card's place without a
 * jump.
 *
 * What the card holds depends on /api/config, which arrives after the first
 * paint: SSO-only, demo and dev mode, a server list, the remember-me and
 * token switches, a hidden heading or subtitle and a custom logo size give a
 * card of a different height. This draws the default form.
 *
 * Signed-in pages draw it too, for a visitor with nothing stored that could
 * sign them back in (AppShellSkeleton, data-boot-auth="out").
 */
import { cn } from "@/lib/cn";
import { LoginFrame } from "@/components/auth/login-frame";
import { Bar, Block, SkeletonRegion } from "./kit";

/**
 * A placeholder for one line of text in `className`'s font: exactly as tall
 * as that line (a zero-width space sets it), with a bar across `w`
 * of it. Give it a width class where it sits in a flex row.
 */
export function TextLine({ className, w, bar }: { className?: string; w: string; bar?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative block", className)}>
      {"\u200b"}
      <Bar className={cn("absolute top-1/2 -translate-y-1/2", bar)} w={w} />
    </span>
  );
}

const CENTERED = "inset-x-0 mx-auto";

/** An empty text field with its label, as the login form draws them. */
function Field({ label }: { label: string }) {
  return (
    <div className="space-y-1.5">
      <TextLine className="text-sm font-medium" w={label} />
      <span aria-hidden="true" className="block h-10 rounded-md border border-input bg-background" />
    </div>
  );
}

export interface LoginSkeletonProps {
  /** common.loading */
  label?: string;
  /**
   * Draw the accessibility button the login page has in its corner. The
   * login page itself renders the real one (AccessibilityQuickPanelHost);
   * a signed-in page drawing the card for a signed-out visitor doesn't.
   */
  accessibilityButton?: boolean;
  className?: string;
}

export function LoginSkeleton({ label, accessibilityButton = false, className }: LoginSkeletonProps) {
  return (
    <SkeletonRegion surface="login" label={label} className={className}>
      <LoginFrame
        before={
          <>
            {/* The theme menu button in the corner. */}
            <div aria-hidden="true" data-window-beside-controls="" className="absolute top-5 end-5">
              <span className="flex items-center justify-center w-9 h-9 rounded-md border border-border bg-background">
                <Block className="w-4 h-4 rounded" />
              </span>
            </div>

            {accessibilityButton ? (
              <span
                aria-hidden="true"
                className="fixed bottom-4 end-4 z-40 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm"
                style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
              >
                <Block className="w-4 h-4 rounded" />
                <TextLine className="w-[4.625rem]" w="100%" />
              </span>
            ) : null}
          </>
        }
        footer={<TextLine className="text-xs w-12" w="100%" />}
      >
        <div className="px-8 pt-10 pb-6 text-center">
          <div aria-hidden="true" className="inline-flex items-center justify-center mb-5 w-16 h-16">
            <Block className="w-16 h-16 rounded-lg" />
          </div>
          <TextLine className="text-2xl font-semibold tracking-tight" w="9rem" bar={cn("h-6", CENTERED)} />
          <TextLine className="text-sm mt-1.5" w="11rem" bar={CENTERED} />
        </div>

        <div className="px-8 pb-8">
          <div className="space-y-5">
            <div className="space-y-4">
              <Field label="3rem" />
              <Field label="4.5rem" />
              {/* "I have a 2FA code": its icon and a line of small text. */}
              <span aria-hidden="true" className="flex items-center gap-1.5 text-xs">
                <Block className="w-3.5 h-3.5 rounded" />
                <TextLine className="w-24" w="100%" />
              </span>
            </div>
            <Block className="w-full h-10 rounded-md" />
          </div>
        </div>
      </LoginFrame>
    </SkeletonRegion>
  );
}

/**
 * The admin sign-in page (app/(main)/admin/login/page.tsx): no card, the
 * logo, the fixed English heading and line, one password field and the
 * button. The page itself renders in full on the server; this is for
 * the places that draw a page by its surface.
 */
export function AdminLoginSkeleton({ label, className }: LoginSkeletonProps) {
  return (
    <SkeletonRegion
      surface="admin-login"
      label={label}
      className={cn("min-h-screen flex items-center justify-center bg-background px-4", className)}
    >
      <div aria-hidden="true" className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Block className="w-12 h-12 rounded-xl mb-4" />
          <span className="text-xl font-semibold text-foreground">Admin Dashboard</span>
          <span className="text-sm text-muted-foreground mt-1">Enter your admin password to continue</span>
        </div>
        <div className="space-y-4">
          <div>
            <span className="block text-sm font-medium text-foreground mb-1.5">Password</span>
            <span className="block h-10 w-full rounded-md border border-input bg-background" />
          </div>
          <Block className="w-full h-10" />
        </div>
      </div>
    </SkeletonRegion>
  );
}
