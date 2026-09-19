let ctx;

function context() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function beep({ freq, duration, type = "sine", gain = 0.06, slide = 0 }) {
  const audio = context();
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audio.currentTime);
  if (slide) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, freq + slide),
      audio.currentTime + duration
    );
  }
  amp.gain.setValueAtTime(gain, audio.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
  osc.connect(amp);
  amp.connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duration);
}

export function tickSound(n) {
  beep({ freq: n === 1 ? 660 : 420, duration: 0.12, type: "square", gain: 0.045 });
}

export function revealSound() {
  beep({ freq: 220, duration: 0.28, type: "sawtooth", gain: 0.05, slide: 420 });
  setTimeout(() => beep({ freq: 880, duration: 0.18, type: "triangle", gain: 0.04 }), 80);
}

export function unlockAudio() {
  try {
    context();
  } catch {
    /* ignore */
  }
}
