/**
 * Built-in sound cues, synthesised with the Web Audio API: no audio files, no
 * licensing, identical on every device. One shared AudioContext; browsers keep
 * it suspended until the page has been clicked once (autoplay rule).
 */
import type { SoundId } from '@patchbay/core';
import { useSyncExternalStore } from 'react';

type Synth = (ctx: BaseAudioContext, out: AudioNode, t: number) => number;

/** Schedules a tone with a fast attack and an exponential decay; returns its end time. */
function tone(
  ctx: BaseAudioContext,
  out: AudioNode,
  {
    type = 'sine',
    freq,
    at,
    attack = 0.004,
    decay,
    peak = 1,
    glideTo,
  }: {
    type?: OscillatorType;
    freq: number;
    at: number;
    attack?: number;
    decay: number;
    peak?: number;
    glideTo?: number;
  },
): number {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + decay);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + attack + decay + 0.02);
  return at + attack + decay;
}

/** Inharmonic partials are what make a struck metal sound like a bell rather than a beep. */
function strike(ctx: BaseAudioContext, out: AudioNode, at: number, base: number, decay: number, peak = 1) {
  const partials: [number, number][] = [
    [1, 1],
    [2.76, 0.45],
    [5.4, 0.22],
    [8.93, 0.08],
  ];
  let end = at;
  for (const [ratio, level] of partials) {
    end = Math.max(
      end,
      tone(ctx, out, { freq: base * ratio, at, decay: decay / ratio ** 0.4, peak: peak * level }),
    );
  }
  return end;
}

function noiseBurst(
  ctx: BaseAudioContext,
  out: AudioNode,
  at: number,
  duration: number,
  freq: number,
  peak: number,
) {
  const length = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const gain = ctx.createGain();
  gain.gain.value = peak;
  src.connect(filter).connect(gain).connect(out);
  src.start(at);
  return at + duration;
}

const SYNTHS: Record<SoundId, Synth> = {
  // Shop-door bell: the clapper hits twice in quick succession.
  bell: (ctx, out, t) => {
    strike(ctx, out, t, 1568, 0.9, 0.5);
    return strike(ctx, out, t + 0.14, 1568, 1.1, 0.4);
  },
  chime: (ctx, out, t) => {
    tone(ctx, out, { type: 'triangle', freq: 659.25, at: t, decay: 0.45, peak: 0.6 });
    return tone(ctx, out, { type: 'triangle', freq: 987.77, at: t + 0.16, decay: 0.7, peak: 0.6 });
  },
  ding: (ctx, out, t) => tone(ctx, out, { freq: 880, at: t, attack: 0.008, decay: 0.9, peak: 0.55 }),
  // "Ka" is the drawer's mechanical click, "ching" the bell on top of the register.
  cash: (ctx, out, t) => {
    noiseBurst(ctx, out, t, 0.06, 2500, 0.9);
    noiseBurst(ctx, out, t + 0.07, 0.05, 1800, 0.6);
    strike(ctx, out, t + 0.1, 2093, 0.7, 0.35);
    return strike(ctx, out, t + 0.16, 2637, 0.9, 0.3);
  },
  pop: (ctx, out, t) =>
    tone(ctx, out, { freq: 900, glideTo: 220, at: t, attack: 0.002, decay: 0.06, peak: 0.7 }),
  // Square waves cut through a noisy room; the lowpass keeps them from being shrill.
  alert: (ctx, out, t) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    filter.connect(out);
    let end = t;
    for (let i = 0; i < 3; i++) {
      end = tone(ctx, filter, {
        type: 'square',
        freq: 988,
        at: t + i * 0.2,
        attack: 0.005,
        decay: 0.12,
        peak: 0.35,
      });
    }
    return end;
  },
};

export const SOUND_LABELS: Record<SoundId, string> = {
  bell: 'Bell',
  chime: 'Chime',
  ding: 'Ding',
  cash: 'Cash register',
  pop: 'Pop',
  alert: 'Alert',
};

/** Schedules a sound on any context (also an OfflineAudioContext for tests); returns its end time. */
export function renderSound(
  ctx: BaseAudioContext,
  out: AudioNode,
  id: SoundId,
  volume: number,
  at = ctx.currentTime,
) {
  const master = ctx.createGain();
  master.gain.value = Math.min(Math.max(volume, 0), 1);
  master.connect(out);
  return SYNTHS[id](ctx, master, at + 0.01);
}

// ---- Shared context, unlock and mute -------------------------------------------------------------

const MUTE_KEY = 'patchbay:sound-muted';
/** Ten widgets firing together make one sound, not a cacophony. */
const GLOBAL_THROTTLE_MS = 1500;

let context: AudioContext | null = null;
let lastCueAt = Number.NEGATIVE_INFINITY;
let muted = readMuted();
let unlocked = false;
const listeners = new Set<() => void>();
let snapshot = { muted, unlocked };

function readMuted() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function emit() {
  snapshot = { muted, unlocked };
  for (const l of listeners) l();
}

function audioContext(): AudioContext | null {
  if (context) return context;
  const Ctor = typeof window === 'undefined' ? undefined : window.AudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  context.addEventListener('statechange', () => {
    unlocked = context?.state === 'running';
    emit();
  });
  unlocked = context.state === 'running';
  return context;
}

/** Must run inside a user gesture (click, key press) to satisfy the autoplay rule. */
export async function unlockAudio() {
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  unlocked = ctx.state === 'running';
  emit();
  return unlocked;
}

/**
 * While a dashboard with sounds is shown, the first click or key press anywhere unlocks audio,
 * so the explicit "Enable sound" button is only needed on screens nobody touches.
 */
export function armAutoUnlock(): () => void {
  if (unlocked) return () => {};
  const onGesture = () => {
    void unlockAudio().then((ok) => ok && disarm());
  };
  const disarm = () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  return disarm;
}

export function setMuted(next: boolean) {
  muted = next;
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    // Storage blocked (private mode): the choice lasts for this tab only.
  }
  emit();
}

export function useSoundSettings() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Plays right away, ignoring mute and throttle: for the editor's ▶ buttons. */
export function previewSound(id: SoundId, volume: number) {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  renderSound(ctx, ctx.destination, id, volume);
}

/** A live cue: silent when muted, locked or within the global throttle. Returns whether it played. */
export function playCue(id: SoundId, volume: number, now = Date.now()) {
  if (muted || now - lastCueAt < GLOBAL_THROTTLE_MS) return false;
  const ctx = audioContext();
  if (ctx?.state !== 'running') return false;
  lastCueAt = now;
  renderSound(ctx, ctx.destination, id, volume);
  return true;
}
