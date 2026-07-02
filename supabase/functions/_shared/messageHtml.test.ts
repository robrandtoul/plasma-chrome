// Run: pnpm test:message-html
import { messageBodyToHtml } from './messageHtml.ts'

let failures = 0
function eq(name: string, got: string, want: string) {
  if (got === want) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}\n   got:  ${got}\n   want: ${want}`)
  }
}
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

// The reported bug: a URL followed by a blank line and more copy. The link
// must end at the UUID and NOT absorb the following markup/text.
{
  const body =
    "Please look:\n\nhttps://proofs.plasmadesign.co.uk/p/28d81d37-ca6c-464c-9194-f4b19cd3186d\n\nYou're able to approve online."
  const html = messageBodyToHtml(body)
  eq(
    'link ends at the UUID, copy after it stays plain text',
    html,
    'Please look:<br><br><a href="https://proofs.plasmadesign.co.uk/p/28d81d37-ca6c-464c-9194-f4b19cd3186d">https://proofs.plasmadesign.co.uk/p/28d81d37-ca6c-464c-9194-f4b19cd3186d</a><br><br>You\'re able to approve online.',
  )
  // The href must be exactly the proof URL — never the mangled form.
  check('href is the clean proof URL', html.includes('href="https://proofs.plasmadesign.co.uk/p/28d81d37-ca6c-464c-9194-f4b19cd3186d"'))
  check('no <br> leaked into the href', !html.includes('href="https://proofs.plasmadesign.co.uk/p/28d81d37-ca6c-464c-9194-f4b19cd3186d<br>'))
}

// Newlines become <br> so paragraph spacing survives once we emit tags
// (Help Scout no longer nl2brs a body that already contains HTML).
eq('newlines become <br>', messageBodyToHtml('a\n\nb'), 'a<br><br>b')

// A URL at the very end (the nudge templates) still linkifies cleanly.
eq(
  'trailing url linkified',
  messageBodyToHtml('here:\n\nhttps://x.test/p/abc'),
  'here:<br><br><a href="https://x.test/p/abc">https://x.test/p/abc</a>',
)

// Trailing sentence punctuation is pulled back out of the href.
eq(
  'trailing full stop stays outside the link',
  messageBodyToHtml('see https://x.test/p/abc.'),
  'see <a href="https://x.test/p/abc">https://x.test/p/abc</a>.',
)

// Angle brackets a designer types are escaped, never treated as tags.
eq('angle brackets escaped', messageBodyToHtml('1 < 2 > 0'), '1 &lt; 2 &gt; 0')

// Ampersands escaped; a query string stays intact inside the href.
eq(
  'ampersand escaped in url and text',
  messageBodyToHtml('a & b https://x.test/p?x=1&y=2'),
  'a &amp; b <a href="https://x.test/p?x=1&amp;y=2">https://x.test/p?x=1&amp;y=2</a>',
)

if (failures) {
  console.error(`\n${failures} test(s) failed`)
  // deno-lint-ignore no-process-global
  ;(globalThis as { process?: { exit(code: number): void } }).process?.exit(1)
} else {
  console.log('\nall message-html tests passed')
}
