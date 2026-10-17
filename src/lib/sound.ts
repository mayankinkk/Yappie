let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function blip(freq: number, start: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const c = ensureCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + dur + 0.05);
}

export function soundEnabled(): boolean {
  return localStorage.getItem("sofa.sound") !== "off";
}

export function setSoundEnabled(on: boolean): void {
  localStorage.setItem("sofa.sound", on ? "on" : "off");
}

export function playSound(kind: "message" | "reaction" | "join" | "leave" | "control"): void {
  if (!soundEnabled()) return;
  try {
    if (kind === "message") {
      blip(523, 0, 0.12, 0.06);
      blip(659, 0.07, 0.14, 0.05);
    } else if (kind === "reaction") {
      blip(880, 0, 0.09, 0.05, "triangle");
    } else if (kind === "join") {
      blip(440, 0, 0.1, 0.05);
      blip(554, 0.08, 0.1, 0.05);
      blip(659, 0.16, 0.16, 0.05);
    } else if (kind === "leave") {
      blip(659, 0, 0.1, 0.04);
      blip(440, 0.08, 0.16, 0.04);
    } else {
      blip(392, 0, 0.08, 0.04, "triangle");
      blip(523, 0.06, 0.1, 0.04, "triangle");
    }
  } catch {
    /* audio unavailable */
  }
}
