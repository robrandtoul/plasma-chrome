// Tiny Web Audio chime generator for chat notifications. No asset files — the
// tones are synthesised, so there's nothing to bundle or fetch. Two cues:
//   • 'general' — a soft, low single blip for an ordinary message.
//   • 'mention' — a brighter two-note rising chime when you're @mentioned.
//
// Browsers require a user gesture before audio can play, and iOS/iPadOS is the
// strictest about it, so the unlock here is deliberately belt-and-braces:
//   * Listeners stay armed on every gesture type (touchend is the one iPads
//     reliably honour) and KEEP trying until the context is actually running —
//     the old code removed them after the first attempt, so one failed unlock
//     meant permanent silence.
//   * A silent one-frame buffer is played inside the gesture (the classic iOS
//     unlock) alongside resume().
//   * Returning to the tab re-resumes a context iPadOS suspended in the
//     background.
//   * Where the Audio Session API exists (Safari 17+), the page's audio is
//     declared 'transient' — short notification-type sound that mixes with
//     other media and isn't muted by the Silent switch.
// If none of that lands, playback stays a silent no-op (never throws).
let ctx = null;
function ensureContext() {
    if (typeof window === 'undefined')
        return null;
    if (!ctx) {
        const AC = window.AudioContext ??
            window.webkitAudioContext;
        if (!AC)
            return null;
        try {
            ctx = new AC();
        }
        catch {
            return null;
        }
    }
    return ctx;
}
// Declare the page's audio as short, mixable notification sound (Safari 17+).
// On iPhone/iPad this is what lets the chime through the Silent switch and
// stops it interrupting music the user has playing. Harmless no-op elsewhere.
function configureAudioSession() {
    try {
        const session = navigator.audioSession;
        if (session)
            session.type = 'transient';
    }
    catch {
        /* unsupported — fine */
    }
}
if (typeof window !== 'undefined') {
    configureAudioSession();
    // Unlock on user gesture. Listeners persist until the context is RUNNING —
    // each tap/keypress is another chance, so a rejected first attempt (common
    // on iPadOS, which honours touchend rather than pointerdown for audio
    // activation) doesn't disable sound for the whole session.
    const GESTURES = ['touchend', 'pointerdown', 'mousedown', 'keydown', 'click'];
    const onGesture = () => {
        const c = ensureContext();
        if (!c) {
            GESTURES.forEach((e) => window.removeEventListener(e, onGesture));
            return;
        }
        if (c.state === 'running') {
            GESTURES.forEach((e) => window.removeEventListener(e, onGesture));
            return;
        }
        try {
            // The classic iOS unlock: start a silent one-frame buffer from inside
            // the gesture. Combined with resume(), one of the two always lands on
            // WebKit versions that reject the other.
            const buffer = c.createBuffer(1, 1, 22050);
            const source = c.createBufferSource();
            source.buffer = buffer;
            source.connect(c.destination);
            source.start(0);
        }
        catch {
            /* ignore */
        }
        void c
            .resume()
            .then(() => {
            if (c.state === 'running') {
                GESTURES.forEach((e) => window.removeEventListener(e, onGesture));
            }
        })
            .catch(() => {
            /* keep the listeners armed — the next gesture retries */
        });
    };
    GESTURES.forEach((e) => window.addEventListener(e, onGesture, { passive: true }));
    // iPadOS suspends the context when the tab is backgrounded; a context the
    // user has already activated may be resumed programmatically on return.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible')
            return;
        if (ctx && ctx.state === 'suspended')
            void ctx.resume().catch(() => { });
    });
}
function tone(c, freq, start, dur, gain, type) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Quick attack, exponential decay — reads as a soft "blip" rather than a beep.
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.03);
}
function playNow(c, kind) {
    const now = c.currentTime;
    if (kind === 'mention') {
        // Two rising notes, a touch louder — "this one's for you".
        tone(c, 660, now, 0.16, 0.14, 'triangle');
        tone(c, 988, now + 0.14, 0.22, 0.14, 'triangle');
    }
    else {
        // One gentle low blip.
        tone(c, 600, now, 0.11, 0.05, 'sine');
    }
}
export function playChatSound(kind) {
    const c = ensureContext();
    if (!c)
        return;
    if (c.state === 'running') {
        playNow(c, kind);
        return;
    }
    // Suspended (e.g. just returned to the tab): try to wake it and play a
    // beat late rather than dropping the cue. If the browser refuses (no
    // gesture yet), stay silent — never throw.
    void c
        .resume()
        .then(() => {
        if (c.state === 'running')
            playNow(c, kind);
    })
        .catch(() => { });
}
//# sourceMappingURL=sound.js.map