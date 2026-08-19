import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-brand/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /**
   * On a phone this dialog is a focused task rather than a quick decision, so it
   * takes the whole screen instead of a bottom sheet. Use for multi-section forms
   * (a treatment plan, a certificate); leave off for confirmations and short forms.
   */
  fullOnMobile?: boolean;
}

/**
 * One dialog, two shapes.
 *
 * Below `sm` every dialog renders as a bottom sheet: full width, anchored to the
 * bottom where the thumb already is, sliding up, capped at 85dvh so the page
 * behind stays visible as context. A centered floating box on a phone is a
 * desktop convention that leaves the primary buttons in the hardest place to
 * reach and fights the keyboard for the middle of the screen.
 *
 * This is done here, once, because 30 call sites use DialogContent — restyling the
 * primitive converts every confirmation, form and picker in the app in one move,
 * and new dialogs inherit the behavior without anyone remembering to ask for it.
 * Desktop is untouched: the centered modal at `sm:` and up is exactly what it was.
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, fullOnMobile, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // shared
        "fixed z-50 grid w-full max-w-lg gap-4 overflow-y-auto border bg-card shadow-modal duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        // phone: a bottom sheet
        "inset-x-0 bottom-0 mx-auto border-b-0 border-x-0 p-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8",
        fullOnMobile
          ? "h-[100dvh] max-h-[100dvh] rounded-none"
          : "max-h-[85dvh] rounded-t-[14px]",
        // desktop: the centered modal, unchanged
        "sm:inset-x-auto sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[90dvh] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-[14px] sm:border sm:p-6 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
        className,
      )}
      {...props}
    >
      {/* The sheet's grab-handle cue. Visual only — dismissal is the overlay, the
          X, or the back gesture; a fake affordance that did nothing would be worse,
          so the sheet also closes on downward overlay taps like any dialog. */}
      {!fullOnMobile && <div aria-hidden className="mx-auto -mb-1 h-1 w-9 rounded-full bg-border sm:hidden" />}
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm p-1 opacity-70 transition-opacity touch-hit hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-left", className)} {...props} />
);
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-h3 font-bold text-brand", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
