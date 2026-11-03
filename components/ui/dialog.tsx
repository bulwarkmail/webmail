"use client";

import { useId, useRef, type ReactNode, type RefObject, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { IconButton } from "@/components/ui/icon-button";
import { X } from "@/components/icons";
import { cn } from "@/lib/utils";

export type DialogSize = "sm" | "md" | "lg" | "full-on-phone";

export interface DialogProps {
  isOpen: boolean;
  /** Called by Escape, the close X and an outside click. Ask about unsaved input here (R5). */
  onClose: () => void;
  title: ReactNode;
  /** One line under the title; becomes the dialog's description. */
  description?: ReactNode;
  /** The body, under the title and description. */
  children?: ReactNode;
  /** The buttons: Cancel (outline) first, then the primary. Laid out at the end. */
  footer?: ReactNode;
  /** `alertdialog` for confirmations. */
  role?: "dialog" | "alertdialog";
  /** sm 384px, md 448px (default), lg 672px; full-on-phone fills a phone screen and is lg above. */
  size?: DialogSize;
  /** Drawn before the title, e.g. the warning icon of a destructive confirm. */
  icon?: ReactNode;
  /** The close X at the top end. Default true. */
  showClose?: boolean;
  /** Ignore clicks outside, e.g. while the dialog holds unsaved input. */
  preventOutsideClose?: boolean;
  /** Same as preventOutsideClose: the dialog holds unsaved input. */
  dirty?: boolean;
  /** Where the focus goes on open. Default: the first field, else the first control. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Wraps body and footer in a form, so Enter in a field submits. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** Extra classes for the panel. */
  className?: string;
  /** Extra classes for the body. */
  bodyClassName?: string;
  /** Test hook on the panel. */
  testId?: string;
}

const SIZES: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  "full-on-phone":
    "max-w-2xl max-sm:max-w-none max-sm:h-full max-sm:max-h-none max-sm:rounded-none max-sm:border-0",
};

// A field out of the tab order (the hidden input behind a file drop zone)
// can't take the focus: picking it left the focus on the page behind.
const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([tabindex="-1"]):not(:disabled), textarea:not([tabindex="-1"]):not(:disabled), select:not([tabindex="-1"]):not(:disabled), [contenteditable="true"]';

/**
 * The one dialog shell (R4): a portal on <body> at z-[60] over a dimmed
 * backdrop, labelled by its title, focus moved in and given back, Escape
 * from anywhere inside, outside click closes unless `dirty`.
 *
 * ```tsx
 * <Dialog isOpen={open} onClose={close} title={t("rename")}
 *   footer={<><Button variant="outline" onClick={close}>{t("cancel")}</Button><Button onClick={save}>{t("save")}</Button></>}>
 *   <Input ... />
 * </Dialog>
 * ```
 */
export function Dialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  role = "dialog",
  size = "md",
  icon,
  showClose = true,
  preventOutsideClose = false,
  dirty = false,
  initialFocus,
  onSubmit,
  className,
  bodyClassName,
  testId,
}: DialogProps) {
  const tCommon = useTranslations("common");
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  // The focus starts on an explicit target, else the first field, else
  // the first control.
  const panelRef = useFocusTrap({
    isActive: isOpen,
    onEscape: onClose,
    restoreFocus: true,
    initialFocus: () => initialFocus?.current ?? panelRef.current?.querySelector<HTMLElement>(FIELD_SELECTOR),
  });
  // A press that started on the backdrop, so a text selection dragged out of
  // a field and released outside doesn't count as an outside click.
  const pressedOnBackdrop = useRef(false);

  if (!isOpen || typeof document === "undefined") return null;

  const blockOutside = preventOutsideClose || dirty;

  const heading = (
    <>
      <h2 id={titleId} className={cn("text-lg font-semibold text-foreground", showClose && "pe-8")}>
        {title}
      </h2>
      {description && (
        <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">
          {description}
        </p>
      )}
    </>
  );

  const footerRow = footer && (
    <div className="flex items-center justify-end gap-3 px-6 pb-6 shrink-0">{footer}</div>
  );

  // With an icon the title, text and body sit in one column beside it (a
  // destructive confirm). Without one, the title stays put while a long
  // body scrolls under it. The spacing is the same either way.
  const body = icon ? (
    <>
      <div className={cn("p-6 overflow-y-auto min-h-0", size === "full-on-phone" && "max-sm:flex-1", bodyClassName)}>
        <div className="flex items-start gap-4">
          {icon}
          <div className="flex-1 min-w-0">
            {heading}
            {children}
          </div>
        </div>
      </div>
      {footerRow}
    </>
  ) : (
    <>
      <div className="px-6 pt-6 shrink-0">{heading}</div>
      <div className={cn("px-6 pb-6 overflow-y-auto min-h-0", size === "full-on-phone" && "max-sm:flex-1", bodyClassName)}>
        {children}
      </div>
      {footerRow}
    </>
  );

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 pt-[calc(1rem+var(--titlebar-inset))] animate-in fade-in duration-150",
        size === "full-on-phone" && "max-sm:p-0 max-sm:pt-[var(--titlebar-inset)]"
      )}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const outside = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (outside && !blockOutside) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-testid={testId}
        className={cn(
          "relative flex flex-col max-h-full bg-background border border-border rounded-lg shadow-xl w-full outline-none animate-in zoom-in-95 duration-200",
          SIZES[size],
          className
        )}
      >
        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex flex-col min-h-0 flex-1">
            {body}
          </form>
        ) : (
          body
        )}
        {showClose && (
          // Last in the tab order, so the focus starts in the content.
          <IconButton label={tCommon("close")} onClick={onClose} className="absolute top-3 end-3">
            <X className="w-4 h-4" />
          </IconButton>
        )}
      </div>
    </div>,
    document.body
  );
}
