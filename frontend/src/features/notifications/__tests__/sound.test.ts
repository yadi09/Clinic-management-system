// Sound for live notifications. What must hold: sound is on unless this user turned
// it off (per user, remembered on the device, and a blocked storage never breaks it);
// the chime is two notes through Web Audio, quietly skipped where there is none; the
// sentence is spoken in an English voice after the chime; and of several open tabs
// only the first to claim a notification announces it, with old claims forgotten
// after a day. Web Audio and speech are stubbed; only setTimeout and Date are faked.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Sound = typeof import("@/features/notifications/sound");
/** A fresh copy of the module, so its cached AudioContext starts empty. */
async function load(): Promise<Sound> {
  vi.resetModules();
  return import("@/features/notifications/sound");
}

function fakeAudio(state = "suspended") {
  const oscs: { type: string; frequency: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const made = { count: 0 };
  const resume = vi.fn(() => Promise.resolve());
  class AC {
    state = state;
    currentTime = 5;
    destination = {};
    resume = resume;
    constructor() { made.count++; }
    createOscillator() {
      const gain = this.createGain();
      const o = { type: "", frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), connect: vi.fn(() => gain) };
      oscs.push(o);
      return o;
    }
    createGain() {
      return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    }
  }
  return { AC, oscs, made, resume };
}

function fakeSpeech(voices: { lang: string; localService: boolean; name: string }[]) {
  const speak = vi.fn();
  vi.stubGlobal("speechSynthesis", { speak, getVoices: () => voices });
  vi.stubGlobal("SpeechSynthesisUtterance", class { voice: unknown = null; rate = 1; volume = 0; constructor(public text: string) {} });
  return speak;
}

describe("REG-FE-NOTIFSOUND live sound", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("REG-FE-NOTIFSOUND-001 sound is on by default, per user, and remembered", async () => {
    const s = await load();
    expect(s.soundOn("usr_a")).toBe(true);
    s.setSoundOn("usr_a", false);
    expect(s.soundOn("usr_a")).toBe(false);
    expect(s.soundOn("usr_b")).toBe(true);
    s.setSoundOn("usr_a", true);
    expect(s.soundOn("usr_a")).toBe(true);
  });

  test("REG-FE-NOTIFSOUND-002 blocked storage: sound stays on and setting it does not throw", async () => {
    const s = await load();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(s.soundOn("usr_a")).toBe(true);
    expect(() => s.setSoundOn("usr_a", false)).not.toThrow();
  });

  test("REG-FE-NOTIFSOUND-003 chime: two rising notes, one shared audio context, resumed when suspended", async () => {
    const a = fakeAudio();
    vi.stubGlobal("AudioContext", a.AC);
    const s = await load();
    s.chime();
    expect(a.oscs.map((o) => o.frequency.value)).toEqual([659.25, 880]);
    expect(a.oscs.every((o) => o.type === "sine")).toBe(true);
    expect(a.oscs[0].start).toHaveBeenCalledWith(5);
    expect(a.oscs[1].start).toHaveBeenCalledWith(5.16);
    expect(a.resume).toHaveBeenCalled();
    s.chime();
    expect(a.made.count).toBe(1);
    expect(a.oscs).toHaveLength(4);
  });

  test("REG-FE-NOTIFSOUND-004 chime: the webkit-prefixed context is used when it is the only one", async () => {
    const a = fakeAudio("running");
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", a.AC);
    const s = await load();
    s.chime();
    expect(a.oscs).toHaveLength(2);
    expect(a.resume).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFSOUND-005 chime: no Web Audio, or one that throws, is silent and safe", async () => {
    vi.stubGlobal("AudioContext", undefined);
    let s = await load();
    expect(() => s.chime()).not.toThrow();
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("not allowed"); } });
    s = await load();
    expect(() => s.chime()).not.toThrow();
  });

  test("REG-FE-NOTIFSOUND-006 speak: an on-device English voice, slightly slow, full volume", async () => {
    const speak = fakeSpeech([
      { lang: "am-ET", localService: true, name: "Amharic" },
      { lang: "en-US", localService: false, name: "Cloud" },
      { lang: "en-GB", localService: true, name: "Local" },
    ]);
    const s = await load();
    expect(s.canSpeak()).toBe(true);
    s.speak("Selam is waiting for you.");
    const u = speak.mock.calls[0][0];
    expect(u).toMatchObject({ text: "Selam is waiting for you.", rate: 0.95, volume: 1 });
    expect(u.voice.name).toBe("Local");
  });

  test("REG-FE-NOTIFSOUND-007 speak: any English voice if none is on-device; none at all still speaks", async () => {
    let speak = fakeSpeech([{ lang: "en-US", localService: false, name: "Cloud" }]);
    let s = await load();
    s.speak("hi");
    expect(speak.mock.calls[0][0].voice.name).toBe("Cloud");
    speak = fakeSpeech([{ lang: "am-ET", localService: true, name: "Amharic" }]);
    s = await load();
    s.speak("hi");
    expect(speak.mock.calls[0][0].voice).toBeNull();
  });

  test("REG-FE-NOTIFSOUND-008 speak: no speech on this device, or a speech engine that throws, is safe", async () => {
    const s = await load();
    expect(s.canSpeak()).toBe(false);
    expect(() => s.speak("hi")).not.toThrow();
    vi.stubGlobal("speechSynthesis", { speak: () => { throw new Error("no voice"); }, getVoices: () => [] });
    vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
    expect(() => s.speak("hi")).not.toThrow();
  });

  test("REG-FE-NOTIFSOUND-009 announce: the chime now, the sentence after it", async () => {
    // Keep whatever "now" this run is pinned to (FAKE_NOW fakes Date already).
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(now);
    const a = fakeAudio("running");
    vi.stubGlobal("AudioContext", a.AC);
    const speak = fakeSpeech([]);
    const s = await load();
    s.announce("Selam is waiting for you.");
    expect(a.oscs).toHaveLength(2);
    expect(speak).not.toHaveBeenCalled();
    vi.advanceTimersByTime(650);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toBe("Selam is waiting for you.");
  });

  test("REG-FE-NOTIFSOUND-010 claim: the first tab to claim announces, the rest stay quiet", async () => {
    const s = await load();
    expect(s.claim("ntf_1")).toBe(true);
    expect(s.claim("ntf_1")).toBe(false);
    expect(s.claim("ntf_2")).toBe(true);
  });

  test("REG-FE-NOTIFSOUND-011 claim: markers older than a day are forgotten, others kept", async () => {
    const s = await load();
    const now = Date.now();
    localStorage.setItem("clinicos.notifications.announced.old", String(now - 86_400_001));
    localStorage.setItem("clinicos.notifications.announced.recent", String(now - 60_000));
    localStorage.setItem("unrelated", "1");
    expect(s.claim("ntf_new")).toBe(true);
    expect(localStorage.getItem("clinicos.notifications.announced.old")).toBeNull();
    expect(localStorage.getItem("clinicos.notifications.announced.recent")).not.toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("1");
    expect(s.claim("recent")).toBe(false);
    expect(s.claim("old")).toBe(true);
  });

  test("REG-FE-NOTIFSOUND-012 claim: blocked storage lets this tab announce", async () => {
    const s = await load();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(s.claim("ntf_1")).toBe(true);
  });
});
