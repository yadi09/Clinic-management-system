/** Sound for live notifications: a soft two-note chime, then the sentence spoken by
 *  the browser's own voice. Nothing is downloaded and nothing leaves the device.
 *
 *  Browsers only allow sound once the person has interacted with the page. After
 *  signing in that is already true; after a reload the first alert may be silent
 *  until the next click or key press, and the pop-up still shows regardless. */

function key(userId: string) {
  return `clinicos.notifications.sound.${userId}`;
}

/** On unless the person turned it off. */
export function soundOn(userId: string): boolean {
  try {
    return window.localStorage.getItem(key(userId)) !== "off";
  } catch {
    return true;
  }
}

export function setSoundOn(userId: string, on: boolean) {
  try {
    window.localStorage.setItem(key(userId), on ? "on" : "off");
  } catch {
    /* the setting simply won't be remembered */
  }
}

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Two short rising notes, quiet and rounded: noticeable without being an alarm. */
export function chime() {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  [[659.25, 0], [880, 0.16]].forEach(([freq, at]) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.5);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.55);
  });
}

function englishVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang.startsWith("en") && v.localService) ?? voices.find((v) => v.lang.startsWith("en"));
}

/** Speak after the chime has had its moment. Sentences queue rather than overlap. */
export function speak(text: string) {
  if (!canSpeak()) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = englishVoice();
    if (v) u.voice = v;
    u.rate = 0.95;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* no voice on this device: the pop-up is still there */
  }
}

export function announce(text: string) {
  chime();
  window.setTimeout(() => speak(text), 650);
}

/** Several tabs open for the same person must not all speak. The first tab to
 *  claim a notification announces it; the rest stay quiet. */
const CLAIM = "clinicos.notifications.announced.";

export function claim(id: string): boolean {
  try {
    const ls = window.localStorage;
    // Forget claims older than a day, so these markers never pile up.
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k?.startsWith(CLAIM) && Date.now() - Number(ls.getItem(k)) > 86_400_000) ls.removeItem(k);
    }
    if (ls.getItem(CLAIM + id)) return false;
    ls.setItem(CLAIM + id, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}
