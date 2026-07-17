import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getVpLogEntries,
  glueMode,
  setGlueMode,
  subscribeVpLog,
  type GlueMode,
  type VpLogEntry,
} from '../lib/viewportDebug'

// TEMPORARY on-device debug overlay for the iOS PWA keyboard/viewport saga.
// Renders a small always-on-top panel showing every viewport signal live plus
// a rolling event log, so on-device screenshots can tell us what iOS actually
// did during the tap → keyboard → dismiss cycle. See src/lib/viewportDebug.ts
// for how it's enabled (Netlify previews: on by default; ?debug=1 elsewhere).
//
// Design constraints so the instrument doesn't disturb the experiment:
// - Portalled to document.body, OUTSIDE the app frame, so the frame's inline
//   height/transform never move it and it never affects frame layout.
// - pointer-events: none everywhere except the small buttons, and those
//   preventDefault() on pointerdown so tapping them never steals focus from
//   (or blurs) the field under test.
// - No inputs of its own; state updates are confined to this subtree.
// - It repositions ITSELF from visualViewport (transform on its own root, via
//   direct style writes) so it stays visible while iOS pans the viewport —
//   without that, the panel sits in layout-viewport coordinates and slides
//   out of view at exactly the interesting moments.

interface Sample {
  innerHeight: number
  vvHeight: number | null
  vvOffsetTop: number | null
  vvPageTop: number | null
  vvScale: number | null
  scrollY: number
  appScrollTop: number | null
  dvhProbe: number | null
  frameHeight: string
  frameTransform: string
  activeEl: string
}

function takeSample(dvhProbeEl: HTMLElement | null): Sample {
  const vv = window.visualViewport
  const frame = document.querySelector<HTMLElement>('[data-app-frame]')
  const appScroll = document.getElementById('app-scroll')
  const active = document.activeElement
  return {
    innerHeight: window.innerHeight,
    vvHeight: vv ? Math.round(vv.height * 10) / 10 : null,
    vvOffsetTop: vv ? Math.round(vv.offsetTop * 10) / 10 : null,
    vvPageTop: vv ? Math.round(vv.pageTop * 10) / 10 : null,
    vvScale: vv ? Math.round(vv.scale * 100) / 100 : null,
    scrollY: Math.round(window.scrollY),
    appScrollTop: appScroll ? Math.round(appScroll.scrollTop) : null,
    dvhProbe: dvhProbeEl ? dvhProbeEl.offsetHeight : null,
    frameHeight: frame?.style.height || '(css)',
    frameTransform: frame?.style.transform || '(none)',
    activeEl: active && active !== document.body ? active.tagName : '(none)',
  }
}

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  lineHeight: 1.45,
}

const btnStyle: React.CSSProperties = {
  pointerEvents: 'auto',
  border: '1px solid rgba(255,255,255,0.35)',
  borderRadius: 5,
  padding: '2px 7px',
  background: 'transparent',
  color: '#fff',
  fontSize: 10,
  fontFamily: 'inherit',
}

export default function ViewportDebugOverlay() {
  const [expanded, setExpanded] = useState(true)
  const [sample, setSample] = useState<Sample | null>(null)
  const [entries, setEntries] = useState<readonly VpLogEntry[]>([])
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const probeRef = useRef<HTMLDivElement | null>(null)
  const mode = glueMode()

  useEffect(() => {
    let raf = 0
    const refresh = () => {
      // Coalesce bursts (vv scroll fires continuously during a pan) into one
      // update per frame so the overlay's own re-renders stay negligible.
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setSample(takeSample(probeRef.current))
        setEntries([...getVpLogEntries()])
        // Keep the panel inside the VISIBLE area: fixed elements live in
        // layout-viewport coordinates and slide off-screen when iOS pans the
        // visual viewport. Direct style write on our own root — never touches
        // the app frame.
        const vv = window.visualViewport
        const el = rootRef.current
        if (el) {
          const x = vv ? vv.offsetLeft : 0
          const y = vv ? vv.offsetTop : 0
          el.style.transform = x || y ? `translate(${x}px, ${y}px)` : ''
        }
      })
    }
    const unsub = subscribeVpLog(refresh)
    const vv = window.visualViewport
    vv?.addEventListener('resize', refresh)
    vv?.addEventListener('scroll', refresh)
    const interval = window.setInterval(refresh, 250)
    refresh()
    return () => {
      unsub()
      vv?.removeEventListener('resize', refresh)
      vv?.removeEventListener('scroll', refresh)
      window.clearInterval(interval)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  function copyDump() {
    // Clipboard API only exists in secure contexts — on a plain-http LAN URL
    // the property itself is undefined and would throw synchronously.
    if (!navigator.clipboard?.writeText) return
    const dump = {
      ua: navigator.userAgent,
      standalone:
        window.matchMedia('(display-mode: standalone)').matches ||
        ((navigator as { standalone?: boolean }).standalone ?? false),
      mode,
      sample: takeSample(probeRef.current),
      log: getVpLogEntries(),
    }
    navigator.clipboard
      .writeText(JSON.stringify(dump, null, 2))
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* clipboard unavailable — screenshots still work */
      })
  }

  // Buttons preventDefault on pointerdown so tapping them never blurs the
  // field under test. That also suppresses the synthetic click in some
  // browsers, so the actual action fires on pointerup instead — but touch
  // pointers get implicit pointer capture, so pointerup fires even if the
  // finger slid off the button. Hit-test on release so dragging away still
  // cancels (a mis-tap on a mode button reloads the page and destroys the
  // in-memory log, so it must be cancellable).
  const noSteal = (e: React.PointerEvent) => e.preventDefault()
  const onRelease = (fn: () => void) => (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    fn()
  }

  const s = sample
  const shown = [...entries].slice(-20).reverse()

  return createPortal(
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        // Below the mobile header's top bar so the wordmark home link, search
        // icon and avatar stay tappable while the panel is expanded.
        top: 'calc(env(safe-area-inset-top) + 60px)',
        left: 4,
        zIndex: 2147483000,
        pointerEvents: 'none',
        ...mono,
      }}
    >
      {/* 100dvh probe: zero-width, hidden; only its offsetHeight is read. */}
      <div ref={probeRef} aria-hidden="true" style={{ position: 'absolute', width: 0, height: '100dvh', visibility: 'hidden' }} />
      {expanded ? (
        <div
          style={{
            background: 'rgba(10,10,14,0.86)',
            color: '#fff',
            borderRadius: 8,
            padding: '6px 8px',
            maxWidth: 250,
            boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
            {(['main', 'off', 'blur'] as GlueMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onPointerDown={noSteal}
                onPointerUp={onRelease(() => m !== mode && setGlueMode(m))}
                style={{
                  ...btnStyle,
                  background: m === mode ? '#e0562d' : 'transparent',
                  borderColor: m === mode ? '#e0562d' : 'rgba(255,255,255,0.35)',
                  fontWeight: m === mode ? 700 : 400,
                }}
              >
                {m}
              </button>
            ))}
            <button type="button" onPointerDown={noSteal} onPointerUp={onRelease(copyDump)} style={btnStyle}>
              {copied ? '✓' : 'copy'}
            </button>
            <button type="button" onPointerDown={noSteal} onPointerUp={onRelease(() => setExpanded(false))} style={btnStyle}>
              hide
            </button>
          </div>
          {s && (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 10 }}>
              <span>innerH {s.innerHeight}</span>
              <span>vv.h {s.vvHeight ?? '–'}</span>
              <span>vv.top {s.vvOffsetTop ?? '–'}</span>
              <span>vv.pageTop {s.vvPageTop ?? '–'}</span>
              <span>scrollY {s.scrollY}</span>
              <span>appScroll {s.appScrollTop ?? '–'}</span>
              <span>dvh {s.dvhProbe ?? '–'}</span>
              <span>active {s.activeEl}</span>
              <span style={{ gridColumn: '1 / -1' }}>
                frame h={s.frameHeight} t={s.frameTransform}
              </span>
            </div>
          )}
          <div
            style={{
              marginTop: 4,
              borderTop: '1px solid rgba(255,255,255,0.25)',
              paddingTop: 3,
              maxHeight: 150,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            {shown.map((e, i) => (
              <div key={entries.length - i} style={{ opacity: i === 0 ? 1 : 0.75 }}>
                +{(e.t / 1000).toFixed(2)}s {e.event}
                {e.n > 1 ? ` ×${e.n}` : ''} {e.detail}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onPointerDown={noSteal}
          onPointerUp={onRelease(() => setExpanded(true))}
          style={{
            ...btnStyle,
            background: 'rgba(10,10,14,0.86)',
            borderColor: 'rgba(255,255,255,0.35)',
            borderRadius: 999,
            padding: '3px 9px',
          }}
        >
          VP {mode} {s?.vvHeight ?? ''}
        </button>
      )}
    </div>,
    document.body,
  )
}
