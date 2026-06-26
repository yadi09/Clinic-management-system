import { useRef, useState } from "react";
import { Mic, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { transcribe } from "@/features/clinical/api";

// Record-then-transcribe voice dictation: hold a recording, then send to the
// backend (Deepgram) and hand the transcript to the caller (e.g. append to a
// note field). Shared by the doctor's SOAP fields and the triage Notes field.
export function DictateButton({ onText, size = "sm" }: { onText: (text: string) => void; size?: "sm" | "default" }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [busy, setBusy] = useState(false);
  const chunks = useRef<Blob[]>([]);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("Voice recording isn't supported in this browser");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
        setBusy(true);
        try {
          const text = await transcribe(blob);
          if (text.trim()) onText(text.trim());
          else toast.message("No speech detected");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not transcribe");
        } finally {
          setBusy(false);
        }
      };
      r.start();
      setRec(r);
    } catch {
      toast.error("Microphone permission denied");
    }
  };
  const stop = () => { rec?.stop(); setRec(null); };

  if (busy) return <Button type="button" size={size} variant="ghost" loading disabled>Transcribing…</Button>;
  if (rec)
    return (
      <Button type="button" size={size} variant="ghost" className="animate-pulse text-destructive" onClick={stop}>
        <Square className="h-3.5 w-3.5 fill-current" /> Stop
      </Button>
    );
  return (
    <Button type="button" size={size} variant="ghost" className="text-muted-foreground" onClick={start}>
      <Mic className="h-3.5 w-3.5" /> Dictate
    </Button>
  );
}
