import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      mobileOffset={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
      toastOptions={{
        classNames: {
          toast: "group rounded-md border bg-card text-card-foreground shadow-popover",
          description: "text-muted-foreground",
          actionButton: "bg-primary text-primary-foreground",
          cancelButton: "bg-muted text-muted-foreground",
          error: "border-destructive/30",
          success: "border-primary/30",
        },
      }}
    />
  );
}

/** A second stack, top centre, just for live notifications (a patient waiting).
 *  Kept apart from the ordinary messages above so those stay where people expect
 *  them; a toast reaches this stack only when sent with `toasterId: LIVE_TOASTER`. */
export const LIVE_TOASTER = "live";

export function LiveToaster() {
  return (
    <Sonner
      id={LIVE_TOASTER}
      position="top-center"
      // Just below the 64px top bar, so the bell and search stay uncovered.
      offset={{ top: "76px" }}
      mobileOffset={{ top: "calc(72px + env(safe-area-inset-top))", left: "12px", right: "12px" }}
      visibleToasts={3}
      gap={10}
      containerAriaLabel="Patients waiting"
      toastOptions={{ unstyled: true }}
      // The slot is as wide as the pop-up, so it is centred rather than hanging
      // off one side of the library's default 356px.
      style={{ ["--width" as string]: "min(28rem, calc(100vw - 24px))" }}
    />
  );
}

export { toast } from "sonner";
