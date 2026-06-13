import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
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

export { toast } from "sonner";
