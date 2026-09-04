// Guard: a scoped utility must reach the element carrying the scope class.
//
// WHY THIS EXISTS. chat.css scopes every utility under `.pd-chat` so it can
// never touch anything a host app renders. The obvious way to write that is a
// descendant selector:
//
//   .pd-chat .pdc-h-full { height: 100% }
//
// which is correct for every element INSIDE the panel and silently wrong for
// the panel's own root, because that root carries `pd-chat` and its layout
// classes on the SAME element, and a descendant combinator never matches the
// element itself. The result is not a visibly broken stylesheet. It is a root
// that quietly loses `display:flex` and `height:100%`, so the message list
// grows to its content instead of scrolling and the composer is pushed below
// the container's overflow and disappears. That shipped, and no test saw it:
// every class was defined, the file parsed, the build passed.
//
// So each utility gets both forms, `.pd-chat.pdc-x, .pd-chat .pdc-x`, and this
// script fails the build if one is ever written with only the descendant form.
// It runs in `npm run build`, which is a required release step, because a check
// nobody runs is not a check.

import { readFileSync } from 'node:fs'

const FILES = ['src/chat/chat.css']
const problems = []

for (const file of FILES) {
  const css = readFileSync(file, 'utf8')
  css.split('\n').forEach((line, i) => {
    // Only selector lines that scope a utility. Anything without `.pdc-` is a
    // component class or a plain declaration and is not this rule's business.
    const head = line.split('{')[0]
    if (!head.includes('.pdc-')) return
    if (!head.includes('.pd-chat')) return

    // Split on commas so a rule that already carries both forms passes.
    const selectors = head.split(',').map((s) => s.trim()).filter(Boolean)
    const utilities = new Set()
    for (const sel of selectors) {
      const m = sel.match(/\.pd-chat[ .]\.?(pdc-[A-Za-z0-9-]+)/)
      if (m) utilities.add(m[1])
    }
    for (const util of utilities) {
      const hasSameElement = selectors.some((s) => s.includes(`.pd-chat.${util}`))
      if (!hasSameElement) {
        problems.push(
          `${file}:${i + 1}  .${util} is descendant-only, so it cannot reach the ` +
            `panel root.\n    write:  .pd-chat.${util}, .pd-chat .${util} { … }`,
        )
      }
    }
  })
}

if (problems.length) {
  console.error(
    `\nscoped utilities that cannot reach the scope root (${problems.length}):\n`,
  )
  for (const p of problems) console.error('  ' + p)
  console.error('')
  process.exit(1)
}

console.log(`css scope check: every scoped utility reaches the root`)
