"use client";

// Frame for the signed-in workspace pages: loads the current user, sends
// unauthenticated visitors to sign-in and users with a temporary password to
// the password page, and renders a simple header with the way back to mail.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { ChevronLeft, LogOut, Mail } from "@/components/icons";
import { useXT } from "@/lib/xenaxio/i18n";
import { type Me, xenaxio, XenaxioApiError } from "@/lib/xenaxio/api";
import { Spinner } from "./ui";

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside WorkspaceShell");
  return me;
}

export function WorkspaceShell({
  title,
  backHref,
  requireAdmin = false,
  allowTemporaryPassword = false,
  children,
}: {
  title: string;
  backHref?: string;
  requireAdmin?: boolean;
  /** Only the password page itself may be shown before the temporary password is changed. */
  allowTemporaryPassword?: boolean;
  children: ReactNode;
}) {
  const t = useXT();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    xenaxio
      .me()
      .then((data) => {
        if (cancelled) return;
        if (data.user.mustChangePassword && !allowTemporaryPassword) return router.replace("/workspace/password");
        if (requireAdmin && data.user.role !== "admin") return router.replace("/workspace");
        setMe(data);
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof XenaxioApiError && err.status === 401) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router, requireAdmin, allowTemporaryPassword]);

  if (!me) return <Spinner label={t("common.loading")} />;

  // The way back to the mail app; not while a temporary password must still be changed.
  const toMail = !me.user.mustChangePassword;

  const signOut = async () => {
    await xenaxio.logout().catch(() => {});
    router.replace("/login");
  };

  return (
    <MeContext.Provider value={me}>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="border-b border-border">
          <div className="mx-auto max-w-4xl px-4 h-14 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {toMail ? (
                <Link href="/" className="text-sm font-semibold text-primary hover:underline">
                  {t("common.app_name")}
                </Link>
              ) : (
                <span className="text-sm font-semibold text-primary">{t("common.app_name")}</span>
              )}
              <span className="text-sm text-muted-foreground truncate">· {me.tenant.name}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {toMail && (
                // A link styled like the ghost button next to it (Button has no asChild).
                <Link
                  href="/"
                  className="inline-flex items-center justify-center rounded-md font-medium h-9 px-3 text-sm transition-all duration-200 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Mail className="w-4 h-4 mr-1.5" />
                  {t("common.to_mail")}
                </Link>
              )}
              <Button variant="ghost" size="sm" onClick={signOut}>
                <LogOut className="w-4 h-4 mr-1.5" />
                {t("common.sign_out")}
              </Button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-6">
          {backHref && (
            <Link href={backHref} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-3">
              <ChevronLeft className="w-4 h-4 mr-1" />
              {t("common.back")}
            </Link>
          )}
          <h1 className="text-2xl font-semibold mb-6">{title}</h1>
          {children}
        </main>
      </div>
    </MeContext.Provider>
  );
}
