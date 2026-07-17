// Tiny Web Audio chime generator for chat notifications. No asset files — the
// tones are synthesised, so there's nothing to bundle or fetch. Two cues:
//   • 'general' — a soft, low single blip for an ordinary message.
//   • 'mention' — a brighter two-note rising chime when you're @mentioned.
//
// Browsers require a user gesture before audio can play. Designers are
// constantly interacting with the app, so we lazily create the AudioContext and
// resume it on the first pointer/key event; if it still can't start, playback is
// a silent no-op (never throws).

let ctx: AudioContext | null = null

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    try {
      ctx = new AC()
    } catch {
      return null
    }
  }
  return ctx
}

// Resume the context on the first user gesture (module-load, runs once).
if (typeof window !== 'undefined') {
  const onGesture = () => {
    const c = ensureContext()
    if (c && c.state === 'suspended') void c.resume()
    window.removeEventListener('pointerdown', onGesture)
    window.removeEventListener('keydown', onGesture)
  }
  window.addEventListener('pointerdown', onGesture)
  window.addEventListener('keydown', onGesture)
}

function tone(
  c: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain: number,
  type: OscillatorType,
): void {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  // Quick attack, exponential decay — reads as a soft "blip" rather than a beep.
  g.gain.setValueAtTime(0.0001, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g).connect(c.destination)
  osc.start(start)
  osc.stop(start + dur + 0.03)
}

export type ChatSoundKind = 'general' | 'mention'

export function playChatSound(kind: ChatSoundKind): void {
  const c = ensureContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume()
  if (c.state !== 'running') return // no gesture yet → skip silently
  const now = c.currentTime
  if (kind === 'mention') {
    // Two rising notes, a touch louder — "this one's for you".
    tone(c, 660, now, 0.16, 0.14, 'triangle')
    tone(c, 988, now + 0.14, 0.22, 0.14, 'triangle')
  } else {
    // One gentle low blip.
    tone(c, 600, now, 0.11, 0.05, 'sine')
  }
}
