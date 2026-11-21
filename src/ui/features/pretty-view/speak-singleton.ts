/**
 * Shared speak singleton — module-scope pair for the app-wide "one bubble
 * speaks at a time" invariant.
 *
 * Extracted from ChatMessage.tsx (Phase 97 UAT batch #6, 2026-09-10) so
 * BOTH ChatMessage and RelayInboundBubble can consume the same singleton.
 * Tapping speak on a ChatMessage stops speak on a RelayInboundBubble and
 * vice versa — one owner at a time, cross-bubble preempt intact.
 *
 * Cross-bubble Stop / new-bubble-preempt semantics preserved:
 *   - Starting on bubble A while bubble B plays stops B first.
 *   - Clicking Stop on the playing bubble stops it.
 *   - Unmount cleanup stops if this bubble owns the singleton.
 *
 * Deliberately a mutable module-scope pair (not React context / not a hook
 * wrapper / not an event bus) — that is the pattern the existing
 * cross-bubble preempt relies on and every test in
 * ChatMessage.speak.test.tsx pins.
 *
 * Speak buttons (useSpeakPlayback) also publish their state here, and
 * listeners hear every change of owner or button state. Voice mode watches
 * it so a speak button talking counts as "speaking" (no listening), and a
 * preempted button watches it to fall back to idle.
 */
import type { WebAudioStreamPlayer } from "./webAudioStreamPlayer";

let currentPlayer: WebAudioStreamPlayer | null = null;
let currentOwner: symbol | null = null;

export type ButtonSpeechState = "loading" | "playing" | "paused";
let buttonSpeech: { owner: symbol; state: ButtonSpeechState } | null = null;

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of [...listeners]) l();
}

/** Hear every change of owner or speak-button state. Returns the unsubscribe. */
export function subscribeSpeech(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A speak button reports its state while it holds (or is taking) ownership. */
export function setButtonSpeechState(owner: symbol, state: ButtonSpeechState): void {
  if (buttonSpeech?.owner === owner && buttonSpeech.state === state) return;
  buttonSpeech = { owner, state };
  emit();
}

/**
 * A speak button takes playback over in ONE step: the previous player (already
 * stopped by the caller) is dropped and this button owns it, "loading", with a
 * single notification. Separate clear + set calls would show listeners a
 * moment of "nothing speaking" between two bubbles.
 */
export function takeOverForButton(owner: symbol): void {
  currentPlayer = null;
  currentOwner = owner;
  buttonSpeech = { owner, state: "loading" };
  emit();
}

/**
 * Pause / resume for the speak button that owns playback, so voice mode's
 * pause can hold a button's reading through the button's own pause (its icon
 * and state follow). A button registers when it takes playback over.
 */
let buttonControls: { owner: symbol; pause: () => void; resume: () => void } | null = null;

export function setButtonControls(owner: symbol, controls: { pause: () => void; resume: () => void }): void {
  buttonControls = { owner, ...controls };
}

/** Pause the owning speak button if it is loading or playing. Returns its owner, or null. */
export function pauseButtonSpeech(): symbol | null {
  const state = getButtonSpeechState();
  if (buttonControls === null || buttonControls.owner !== currentOwner) return null;
  if (state !== "loading" && state !== "playing") return null;
  buttonControls.pause();
  return buttonControls.owner;
}

/** Resume `owner`'s speak button if it still owns playback and is paused. */
export function resumeButtonSpeech(owner: symbol): boolean {
  if (buttonControls === null || buttonControls.owner !== owner || currentOwner !== owner) return false;
  if (getButtonSpeechState() !== "paused") return false;
  buttonControls.resume();
  return true;
}

/** State of the speak button that currently owns playback; null when none does. */
export function getButtonSpeechState(): ButtonSpeechState | null {
  return buttonSpeech !== null && buttonSpeech.owner === currentOwner ? buttonSpeech.state : null;
}

export function getCurrentPlayer(): WebAudioStreamPlayer | null {
  return currentPlayer;
}

export function setCurrentPlayer(p: WebAudioStreamPlayer | null): void {
  currentPlayer = p;
}

export function getCurrentOwner(): symbol | null {
  return currentOwner;
}

export function setCurrentOwner(o: symbol | null): void {
  if (currentOwner === o) return;
  currentOwner = o;
  if (buttonSpeech !== null && buttonSpeech.owner !== o) buttonSpeech = null;
  emit();
}

/** Convenience: set both to null in one call (matches the paired-clear
 * pattern used at every ownership-release site in ChatMessage/RelayInboundBubble). */
export function clearCurrentPlayer(): void {
  const changed = currentOwner !== null || buttonSpeech !== null;
  currentPlayer = null;
  currentOwner = null;
  buttonSpeech = null;
  if (changed) emit();
}

/**
 * Heard reports (shape-voice-heard-ordering): a speak button playing an agent
 * reply says when its audio began and when it played to the end, so voice
 * mode's heard note can count replies the user played themselves.
 */
export interface HeardReport {
  eventId?: string;
  text: string;
  /** began = audio started; finished = played to the end. */
  outcome: "began" | "finished";
}
const heardListeners = new Set<(r: HeardReport) => void>();

export function reportHeard(report: HeardReport): void {
  for (const l of [...heardListeners]) l(report);
}

/** Hear every heard report. Returns the unsubscribe. */
export function subscribeHeard(listener: (r: HeardReport) => void): () => void {
  heardListeners.add(listener);
  return () => {
    heardListeners.delete(listener);
  };
}
