// Asking before doing something that cannot be casually undone.
//
// This replaces window.confirm and window.prompt, which were being used for actions
// as serious as voiding a medical certificate and writing off a fee. Those dialogs
// are the browser's, not the product's: unstyled, untranslatable, impossible to fit
// with a loading state, and — worst for a required reason — window.prompt accepts an
// empty string on Enter, so "say why" was one keypress from being skipped.
//
// The shape here is deliberately narrow: a question, the consequence spelled out, an
// optional reason that is genuinely required when asked for, and one confirming verb
// that names the act rather than saying "OK".
import { useCallback, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ConfirmRequest {
  title: string;
  /** What will actually happen. Say the consequence, not "are you sure". */
  description?: ReactNode;
  /** Ask for a reason. When required, the confirm button stays disabled until given. */
  reason?: { label: string; placeholder?: string; required?: boolean; multiline?: boolean };
  /** Names the act: "Void certificate", "Write off", "Switch visit". Never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Imperative confirm that still renders a real component.
 *
 *   const { ask, dialog } = useConfirmDialog();
 *   ask({ title: "Void MC-2026-0001?", reason: { label: "Why?", required: true } },
 *       (why) => voidIt.mutate(why));
 *   ...
 *   {dialog}
 *
 * The callback may return a promise; the button shows a pending state until it
 * settles, so a slow request cannot be double-submitted.
 */
export function useConfirmDialog() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const [onOk, setOnOk] = useState<{ fn: (reason: string) => void | Promise<unknown> } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const ask = useCallback((request: ConfirmRequest, fn: (reason: string) => void | Promise<unknown>) => {
    setReq(request);
    setOnOk({ fn });      // wrapped: setState would otherwise call the function
    setReason("");
    setBusy(false);
  }, []);

  const close = () => { setReq(null); setOnOk(null); setReason(""); setBusy(false); };

  const blocked = !!req?.reason?.required && reason.trim() === "";

  const confirm = async () => {
    if (blocked || !onOk) return;
    setBusy(true);
    try {
      await onOk.fn(reason.trim());
      close();
    } finally {
      setBusy(false);
    }
  };

  const dialog = req ? (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className={cn("flex items-center gap-2", req.destructive && "text-destructive")}>
            {req.destructive && <AlertTriangle className="h-4 w-4 shrink-0" />}
            {req.title}
          </DialogTitle>
        </DialogHeader>
        {req.description && <div className="text-sm text-muted-foreground">{req.description}</div>}
        {req.reason && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-reason" className="text-xs">
              {req.reason.label}
              {req.reason.required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            {req.reason.multiline ? (
              <Textarea id="confirm-reason" rows={2} autoFocus value={reason}
                onChange={(e) => setReason(e.target.value)} placeholder={req.reason.placeholder} />
            ) : (
              <Input id="confirm-reason" autoFocus value={reason}
                onChange={(e) => setReason(e.target.value)} placeholder={req.reason.placeholder}
                onKeyDown={(e) => { if (e.key === "Enter" && !blocked) void confirm(); }} />
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>{req.cancelLabel ?? "Cancel"}</Button>
          <Button variant={req.destructive ? "destructive" : "default"}
            disabled={blocked} loading={busy} onClick={() => void confirm()}>
            {req.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  return { ask, dialog };
}
