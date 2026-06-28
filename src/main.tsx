import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { registerServiceWorker, reconcileSubscription } from './lib/push'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the push-only service worker and, if this device already has
// notifications enabled, re-save its (possibly rotated) subscription. Both are
// best-effort and no-ops when push isn't supported / the user isn't signed in,
// so they never block first paint.
void registerServiceWorker().then(() => reconcileSubscription())
