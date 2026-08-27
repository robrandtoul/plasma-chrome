/* ─────────────────────────────────────────────────────────────
   The parity harness.

   Every section of docs/handoff/reference/chrome-reference.html,
   rebuilt out of the React components in ../src, in the same order
   and with the same fixtures. Open the two pages side by side: a
   visual difference between them is a real difference, because the
   grey furniture around each frame is the only thing this page
   styles itself (see demo.css).

   The only markup written here rather than rendered by a component is
   the furniture: .frame, .states, .phone and their children. Every
   `pd-chrome*` class on this page comes out of ../src.
   ─────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps, JSX, ReactNode } from 'react';

import { Chrome } from '../src/Chrome';
import { SwitcherStrip } from '../src/SwitcherStrip';
import { MobileChrome } from '../src/MobileChrome';
import { NavLinkish } from '../src/HeaderBar';
import { BellIcon, ChatIcon } from '../src/icons';
import { cx } from '../src/types';

import {
  ACCOUNT_LINKS,
  APPS,
  APPS_ONE,
  APPS_WITHOUT_PROGRAMME,
  PROGRAMME_NAV,
  PROOFS_MOBILE_TABS,
  PROOFS_NAV,
  QR_NAV,
  STOCK_MOBILE_TABS,
  STOCK_NAV,
  USER,
  USER_PRODUCTION,
  noop,
} from './fixtures';

/* ── Furniture ──────────────────────────────────────────── */

function Rule({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rule">
      <span className="eyebrow" style={{ margin: 0 }}>
        {children}
      </span>
      <span />
    </div>
  );
}

function Frame({
  children,
  body,
  tall,
  innerRef,
}: {
  children: ReactNode;
  body?: ReactNode;
  tall?: boolean;
  innerRef?: { current: HTMLDivElement | null };
}): JSX.Element {
  return (
    <div className="frame">
      <div className="frame__scroll">
        <div className="frame__inner" ref={innerRef}>
          {children}
          <div className={cx('frame__body', tall && 'frame__body--tall')}>
            {body ?? <span className="ph">Page content</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* The two popover sections need their panel open on load, and the
   panels are controlled by state inside HeaderBar that the host does
   not reach. Rather than rebuild the bar here with an `open` prop
   (a copy of HeaderBar's markup is exactly the drift this package
   exists to end), the demo clicks the real trigger through a ref.
   `.click()` dispatches a click and no mousedown, so useDismissable's
   outside-press listener does not immediately undo it. */
function useAutoOpen(selector: string): {
  ref: { current: HTMLDivElement | null };
  open: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const open = useCallback(() => {
    const trigger = ref.current?.querySelector(selector);
    if (trigger instanceof HTMLElement) trigger.click();
  }, [selector]);
  useEffect(() => {
    open();
  }, [open]);
  return { ref, open };
}

function Reopen({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <p className="reopen">
      Clicking anywhere outside dismisses it and returns focus to the trigger, which is
      the real behaviour.{' '}
      <button type="button" onClick={onClick}>
        Reopen the {label}
      </button>
    </p>
  );
}

/* ── Shared chrome props ────────────────────────────────── */

type ChromeArgs = ComponentProps<typeof Chrome>;

const BASE: Pick<ChromeArgs, 'user' | 'accountLinks' | 'onSignOut' | 'onEditProfile'> = {
  user: USER,
  accountLinks: ACCOUNT_LINKS,
  onSignOut: noop,
  onEditProfile: noop,
};

/** A controlled preference per frame, so the toggles actually move. */
function useMode(initial: boolean): Pick<ChromeArgs, 'appsVisible' | 'onAppsVisibleChange'> {
  const [appsVisible, setAppsVisible] = useState(initial);
  return { appsVisible, onAppsVisibleChange: setAppsVisible };
}

function useSearch(placeholder: string): ChromeArgs['search'] {
  const [value, onChange] = useState('');
  return { value, onChange, placeholder, onPalette: noop };
}

/* ── 01 · The two modes ─────────────────────────────────── */

function TwoModes(): JSX.Element {
  const withStrip = useMode(true);
  const menuMode = useMode(false);
  const searchA = useSearch('Search orders, customers, jobs');
  const searchB = useSearch('Search orders, customers, jobs');

  return (
    <section>
      <Rule>01 · The two modes</Rule>

      <h2>appsVisible = true · 94px · strip + label mode</h2>
      <p className="note">
        The apps are listed above, so the header&rsquo;s app name is a plain label with no
        chevron. This is the default for anyone whose <code>my_apps()</code> returns three
        or more apps.
      </p>
      <Frame>
        <Chrome
          {...BASE}
          {...withStrip}
          apps={APPS}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="dashboard"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
          search={searchA}
          chatUnread={0}
          notificationsUnread={0}
        />
      </Frame>

      <h2 style={{ marginTop: 34 }}>appsVisible = false · 56px · menu mode</h2>
      <p className="note">
        The same chrome, 38px shorter. The app name grows a chevron and becomes the
        button that opens the app menu, the only structural difference between the two
        modes.
      </p>
      <Frame>
        <Chrome
          {...BASE}
          {...menuMode}
          apps={APPS}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="dashboard"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
          search={searchB}
          chatUnread={0}
          notificationsUnread={0}
        />
      </Frame>
    </section>
  );
}

/* ── 02 · App menu ──────────────────────────────────────── */

function AppMenuSection(): JSX.Element {
  const menuMode = useMode(false);
  const { ref, open } = useAutoOpen('.pd-chrome__app');

  return (
    <section>
      <Rule>02 · App menu, open</Rule>
      <p className="note">
        Menu mode only. The preference row at the bottom reads as &ldquo;keep this
        open&rdquo;, and this is where someone discovers the strip. Turning it on switches
        the header to label mode and removes this chevron.
      </p>
      <Frame innerRef={ref} tall>
        <Chrome
          {...BASE}
          {...menuMode}
          apps={APPS}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="dashboard"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
        />
      </Frame>
      <Reopen label="app menu" onClick={open} />
    </section>
  );
}

/* ── 03 · Account menu ──────────────────────────────────── */

function AccountMenuSection(): JSX.Element {
  const on = useMode(true);
  const off = useMode(false);
  const openOn = useAutoOpen('.pd-chrome__account');
  const openOff = useAutoOpen('.pd-chrome__account');

  return (
    <section>
      <Rule>03 · Account menu, both switch states</Rule>
      <p className="note">
        The one place sign out exists. Here the preference row reads as a setting, so it
        is tinted; the copy under it changes with the state. Both rows, this one and the
        app menu&rsquo;s, write the same cookie.
      </p>

      <h2>Preference on</h2>
      <Frame innerRef={openOn.ref} tall>
        <Chrome
          {...BASE}
          {...on}
          apps={APPS}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="dashboard"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
        />
      </Frame>
      <Reopen label="account menu" onClick={openOn.open} />

      <h2 style={{ marginTop: 34 }}>Preference off, with its alternate hint copy</h2>
      <Frame innerRef={openOff.ref} tall>
        <Chrome
          {...BASE}
          {...off}
          apps={APPS}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="dashboard"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
        />
      </Frame>
      <Reopen label="account menu" onClick={openOff.open} />

      <div className="row">
        <div className="spec">
          <strong>Both controls write one value.</strong> Stored as a cookie on{' '}
          <code>.plasmadesign.co.uk</code>, never <code>localStorage</code>, which is
          per-origin and would give each of the four subdomains its own setting. On this
          page the preference is controlled per frame instead, so each frame keeps the
          state it is labelled with.
        </div>
      </div>
    </section>
  );
}

/* ── 04 · The other three apps ──────────────────────────── */

function OtherApps(): JSX.Element {
  const qr = useMode(true);
  const programme = useMode(true);
  const stock = useMode(true);
  const switcherOnly = useMode(true);
  const single = useMode(true);
  const stockSearch = useSearch('Search materials');

  return (
    <section>
      <Rule>04 · The same chrome in the other three apps</Rule>
      <p className="note">
        One nav-item shape everywhere. Today these are 36px coral pills, 26px uppercase
        mono pills, bare text links, and, in Stock Control, no nav at all.
      </p>

      <Frame
        body={
          <span className="ph">
            Account leaves the nav. It lives in the account menu, and the full email address
            leaves the bar with it.
          </span>
        }
      >
        <Chrome
          {...BASE}
          {...qr}
          apps={APPS}
          currentApp="qr"
          nav={QR_NAV}
          activeNavId="cards"
          mobileTabIds={['cards', 'qr-codes', 'users']}
          chatUnread={0}
        />
      </Frame>

      <Frame
        body={
          <span className="ph">
            Admin is absent, because this is the Production role. The nav array arrives already
            filtered; the chrome holds no role logic.
          </span>
        }
      >
        <Chrome
          {...BASE}
          {...programme}
          user={USER_PRODUCTION}
          apps={APPS}
          currentApp="programme"
          nav={PROGRAMME_NAV}
          activeNavId="this-run"
          mobileTabIds={['overview', 'this-run', 'customers']}
        />
      </Frame>

      <Frame
        body={
          <span className="ph">
            The key and door glyphs are gone. Change password and sign out both live in
            the account menu.
          </span>
        }
      >
        <Chrome
          {...BASE}
          {...stock}
          apps={APPS}
          currentApp="stock"
          nav={STOCK_NAV}
          activeNavId="dashboard"
          mobileTabIds={[]}
          mobileTabs={STOCK_MOBILE_TABS}
          search={stockSearch}
          chatUnread={0}
          notificationsUnread={5}
        />
      </Frame>

      <h2 style={{ marginTop: 34 }}>variant = &ldquo;switcher-only&rdquo;</h2>
      <p className="note">
        Card Programme renders the switcher above its signed-in-but-no-role screen on
        purpose: whoever lands there is usually staff of another app who followed a link,
        and a dead end with no way back is the confusion the strip exists to end.
      </p>
      <Frame
        body={
          <span className="ph">
            You do not hold a role on the card programme. Use the strip above to go back.
          </span>
        }
      >
        <Chrome
          {...BASE}
          {...switcherOnly}
          variant="switcher-only"
          apps={APPS_WITHOUT_PROGRAMME}
          currentApp="programme"
          nav={[]}
          activeNavId={null}
          mobileTabIds={[]}
        />
      </Frame>

      <h2 style={{ marginTop: 34 }}>One app · the strip suppresses itself</h2>
      <p className="note">
        Below two apps there is nothing to switch to, so the strip does not render however
        the preference is set, which is the same no-op <code>mountAppSwitcher</code> returns
        today. The header bar still does, and the chrome reports 56px rather than 94px.
      </p>
      <Frame>
        <Chrome
          {...BASE}
          {...single}
          apps={APPS_ONE}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="orders"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
        />
      </Frame>
    </section>
  );
}

/* ── 05 · Item states ───────────────────────────────────── */

const NAV_STATES = [
  { item: { id: 'logbook', label: 'Logbook', href: '#logbook' }, active: false },
  { item: { id: 'orders', label: 'Orders', href: '#orders', badge: 1 }, active: false },
  { item: { id: 'dashboard', label: 'Dashboard', href: '#dashboard' }, active: true },
  { item: { id: 'orders-many', label: 'Orders', href: '#orders', badge: 24 }, active: true },
];

function ItemStates(): JSX.Element {
  const cluster = useMode(false);
  const search = useSearch('Search');

  return (
    <section>
      <Rule>05 · Item states</Rule>
      <p className="note">
        Hover and focus are live here: mouse over, or tab in. Focus rings are their own
        token rather than the brand coral, which measures 2.89:1 on cream and is under the
        3:1 minimum for a non-text indicator.
      </p>

      <div className="pd-chrome" style={{ position: 'static' }}>
        <div className="states">
          <span className="states__label">
            Nav item · rest · with count · active · active with count (9+)
          </span>
          {NAV_STATES.map(({ item, active }) => (
            <NavLinkish
              key={item.id}
              linkComponent={undefined}
              item={item}
              active={active}
              className={cx(
                'pd-chrome__nav-item',
                active && 'pd-chrome__nav-item--active',
              )}
            >
              {item.label}
              {item.badge ? (
                <span className="pd-chrome__count">{item.badge > 9 ? '9+' : item.badge}</span>
              ) : null}
            </NavLinkish>
          ))}
        </div>
      </div>

      <p className="note" style={{ marginTop: 22 }}>
        The strip below is the real <code>SwitcherStrip</code>, so it shows both link
        states at once: <em>Proofs</em> is current and carries the 2px coral marker on the
        row&rsquo;s bottom edge, the other three are at rest. Hover them.
      </p>
      <div className="frame">
        <SwitcherStrip apps={APPS} currentApp="proofs" />
      </div>

      <p className="note" style={{ marginTop: 22 }}>
        The right cluster in its fixed order (page actions, search, chat, notifications,
        account), rendered by a chrome with an empty nav array so nothing else competes
        for the row. The order is not negotiable and sign out is not on it.
      </p>
      <Frame>
        <Chrome
          {...BASE}
          {...cluster}
          apps={APPS}
          currentApp="proofs"
          nav={[]}
          activeNavId={null}
          mobileTabIds={[]}
          search={search}
          chatUnread={3}
          notificationsUnread={5}
        />
      </Frame>
    </section>
  );
}

/* ── 06 · Mobile ────────────────────────────────────────── */

function Phone({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <span className="eyebrow">{caption}</span>
      <div className="phone demo-phone">
        {children}
        <div className="phone__body">
          <span className="ph">Page content</span>
        </div>
      </div>
    </div>
  );
}

function Mobile(): JSX.Element {
  const [proofsVisible, setProofsVisible] = useState(false);
  const [stockVisible, setStockVisible] = useState(true);
  const search = useSearch('Search');

  // The two right-cluster slots, as a host passes them. Both render in
  // the mobile bar as well as the desktop one — Stock Control loses its
  // chat and its push toggle entirely on a phone otherwise.
  const chatSlot = (
    <button className="pd-chrome__icon-btn" type="button" title="Team chat" aria-label="Team chat, 2 unread">
      <ChatIcon />
      <span className="pd-chrome__dot" aria-hidden="true">
        2
      </span>
    </button>
  );
  const bellSlot = (
    <button className="pd-chrome__icon-btn" type="button" title="Notifications" aria-label="Notifications">
      <BellIcon />
    </button>
  );

  return (
    <section>
      <Rule>06 · Mobile</Rule>
      <p className="note">
        One treatment for both modes, and the only difference is the chevron. Four
        destinations plus More, 48px minimum targets, and the tab bar is{' '}
        <code>absolute</code> inside the app frame, never <code>fixed</code>: iOS pans a
        fixed bar away from the screen edge when the keyboard opens. That needs a
        viewport-locked frame to resolve against, so an app that scrolls the document
        passes <code>tabBarPosition=&quot;fixed&quot;</code> instead. Tap the avatar for
        the account sheet, which is where app switching lives on a phone, or More for the
        rest of the nav.
      </p>
      <div className="row">
        <Phone caption="Menu mode · app name opens the sheet">
          <MobileChrome
            apps={APPS}
            currentApp="proofs"
            appName="Proofs"
            nav={PROOFS_NAV}
            activeNavId="dashboard"
            mobileTabIds={[]}
            mobileTabs={PROOFS_MOBILE_TABS}
            accountLinks={ACCOUNT_LINKS}
            user={USER}
            search={search}
            chat={chatSlot}
            notifications={bellSlot}
            appsVisible={proofsVisible}
            onAppsVisibleChange={setProofsVisible}
            onSignOut={noop}
            onEditProfile={noop}
          />
        </Phone>

        <Phone caption="Label mode · no chevron">
          <MobileChrome
            apps={APPS}
            currentApp="stock"
            appName="Stock Control"
            nav={STOCK_NAV}
            activeNavId="dashboard"
            mobileTabIds={[]}
            mobileTabs={STOCK_MOBILE_TABS}
            accountLinks={ACCOUNT_LINKS}
            user={USER}
            search={search}
            chat={chatSlot}
            notifications={bellSlot}
            appsVisible={stockVisible}
            onAppsVisibleChange={setStockVisible}
            onSignOut={noop}
            onEditProfile={noop}
          />
        </Phone>

        <div className="spec">
          <strong>Three destinations plus More is correct for Stock Control.</strong>{' '}
          Never pad the bar to five. The rule is &ldquo;the fifth slot is always
          overflow&rdquo;, not &ldquo;there are always five tabs&rdquo;.
          <br />
          <br />
          App switching lives in the account sheet behind the avatar. Today&rsquo;s strip
          is <code>overflow-x: auto</code> with <code>scrollbar-width: none</code>, so on
          a narrow phone the fourth app can sit off-screen with nothing indicating it
          exists.
          <br />
          <br />
          These two are mounted directly rather than through <code>Chrome</code>, which
          swaps the desktop and mobile trees by media query. Narrow the window below 768px
          and every frame above turns into this.
        </div>
      </div>
    </section>
  );
}

/* ── 07 · Slots and seams ───────────────────────────────── */

/** Stands in for a router Link: it wants `to`, and the chrome writes
    `href`. proof-viewer's ChromeLink is the real one, and the adapter
    is always about this small. */
function RouterLinkish({ to, ...rest }: { to: string; className?: string; children?: ReactNode }): JSX.Element {
  return <a href={to} {...rest} />;
}

function ToLink({
  href,
  end,
  ...rest
}: {
  href?: string;
  end?: boolean;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  void end; // the chrome forwards it; this stand-in has no use for it
  return <RouterLinkish to={href ?? ''} {...rest} />;
}

function Slots(): JSX.Element {
  const mode = useMode(true);
  const search = useSearch('Search orders');

  return (
    <section>
      <Rule>07 · Slots and seams, not in the reference page</Rule>
      <p className="note">
        Three props the static reference has no way to show. <code>actions</code> takes
        page CTAs and drops them left of the right cluster; <code>chat</code> takes a
        whole control rather than a count, which is how proof-viewer passes its ChatMenu
        through without the package owning a realtime subscription; and{' '}
        <code>linkComponent</code> is the router seam, here a component that wants{' '}
        <code>to</code> instead of <code>href</code>, adapted in four lines.
      </p>
      <Frame>
        <Chrome
          {...BASE}
          {...mode}
          apps={APPS}
          currentApp="proofs"
          nav={PROOFS_NAV}
          activeNavId="orders"
          mobileTabIds={[]}
          mobileTabs={PROOFS_MOBILE_TABS}
          linkComponent={ToLink}
          search={search}
          notificationsUnread={2}
          actions={
            <button
              type="button"
              className="pd-chrome__nav-item pd-chrome__nav-item--active"
            >
              New order
            </button>
          }
          chat={
            <button
              className="pd-chrome__icon-btn"
              type="button"
              title="Team chat"
              aria-label="Team chat, 2 mentioning you"
            >
              <ChatIcon />
              <span className="pd-chrome__dot" aria-hidden="true">
                2
              </span>
            </button>
          }
        />
      </Frame>
    </section>
  );
}

/* ── Page ───────────────────────────────────────────────── */

export function App(): JSX.Element {
  return (
    <div className="wrap">
      <span className="eyebrow">@plasma/chrome</span>
      <h1>Component parity demo</h1>
      <p className="lede">
        Every section of <code>docs/handoff/reference/chrome-reference.html</code>, built
        out of the React components in <code>src/</code> instead of hand-written markup.
        Open the two side by side; anything that differs is a real difference.
      </p>
      <p className="lede lede--soft">
        Hover, focus and both popovers are live. Colour is not restated anywhere on this
        page: <code>src/chrome.css</code> is the source of truth, and a value quoted here
        would be a second one to keep in step. Several chromes are mounted on one page, so
        the <code>--pd-chrome-height</code> each writes to <code>:root</code> is the last
        mounted rather than a meaningful value; a host mounts exactly one.
      </p>

      <TwoModes />
      <AppMenuSection />
      <AccountMenuSection />
      <OtherApps />
      <ItemStates />
      <Mobile />
      <Slots />
    </div>
  );
}
