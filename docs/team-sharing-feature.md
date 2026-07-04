# Team sharing on multi-name proofs

A plain-English guide for the design team. Shipped in PR #426 (July 2026).

## What it is

When a project has several people's cards on one proof page — say five
business cards for five members of staff — our contact at the company can
now send each person a personal link to the same page. Opening a personal
link scrolls straight to that person's card, highlights it, and greets them
by name, so they review and approve their own card without hunting through
everyone else's. Their name is filled in on the approve step automatically,
which also makes it less likely someone approves the wrong card.

## What the customer sees

On the proof page, between the version thumbnails and the cards, there's a
slim bar reading "Share with your team · 2 of 5 approved". Clicking it opens
a list: every name on the proof, whether they've approved yet, and buttons
to copy or email that person's link (on a phone it uses the normal share
options — WhatsApp, Messages and so on).

The main contact can still review and approve every card themselves — the
panel says so — this is just a shortcut if they'd rather delegate. The bar
doubles as a progress tracker for chasing stragglers, and it disappears once
the proof is fully approved.

## Important: the links are a convenience, not security

Anyone with any of the links can see the whole proof, exactly as before. A
personal link just changes which card the page opens on. The panel says this
to the customer too.

## How you control it

It's a per-version tick box — **"Let the team share this proof"** — on the
new-version and edit-version forms, just below the names. It only appears on
business-card proofs with two or more names, because that's the only place
it does anything.

- **New projects:** the box is ticked by default — untick it if a particular
  customer shouldn't see the panel.
- **Existing projects:** it starts off. Tick it once (edit the current
  version, or tick it when you make the next version) and it stays on for
  future versions of that project.

## One more thing for you

On the project page, under the Public URL, there's now a **"Team share
links"** list — one copy button per name. If a customer asks "can you send
Dave his one directly?", copy Dave's link from there and paste it into your
Help Scout reply.

---

## Technical footnote (for future maintenance, not for designers)

- The toggle is `proof_versions.team_sharing_enabled` (migration 000304,
  default false; exposed to the customer page via
  `public_get_customer_proof`).
- A personal link is `/p/:proofId?for=<recipient name>` — presentation only,
  matched case-insensitively against the current version's names roster.
- Customer-side panel: `src/components/ShareWithTeamPanel.tsx`; focus/greet
  behaviour lives in `src/pages/CustomerProofPage.tsx`.
- Deliberately not covered: Set (collection) proofs (per-layout links would
  be the natural follow-up) and emailing team members directly from the
  system (would need sending infrastructure outside Help Scout).
