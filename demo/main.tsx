/* The demo entry point. Two stylesheet imports, in the order a host
   would use: the package's own sheet first, this page's furniture
   second, so a furniture rule that accidentally beats a chrome rule is
   visible here rather than in an app.

   No <StrictMode>: the popover sections open themselves on mount, and
   StrictMode's deliberate double-invoke would toggle them straight
   shut again. The components are strict-mode safe in a host; this is a
   property of the demo's auto-open, not of the chrome. */

import { createRoot } from 'react-dom/client';

import '../src/chrome.css';
import './demo.css';

import { App } from './App';

const host = document.getElementById('root');
if (!host) throw new Error('demo: #root missing from index.html');

createRoot(host).render(<App />);
