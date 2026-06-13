// Single source of truth for seeding proofs.ai_draft_house_rules /
// proofs.ai_draft_exemplars (migration 000225) from the in-code briefing
// constants — and for the drift check that the migration's seed still matches
// those constants byte-for-byte.
//
//   pnpm tsx scripts/briefing-seed.ts            → print the seed SQL (to paste)
//   pnpm tsx scripts/briefing-seed.ts --check    → fail if the migration drifted
//
// Why this exists: the migration's seed is hand-frozen SQL (PostgreSQL can't
// import TypeScript), but the drafter falls back to the TS constants when the
// DB is unreadable. If someone edits houseRules.ts / exemplars.ts without
// re-seeding, the DB (prod) and the fallback (code) would feed the model
// different briefings. The --check gate makes that drift loud.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HOUSE_RULES } from '../supabase/functions/_shared/aiDrafts/briefing/houseRules.ts'
import { EXEMPLARS } from '../supabase/functions/_shared/aiDrafts/briefing/exemplars.ts'

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

export function seedSql(): string {
  const rules = HOUSE_RULES.map((r, i) => `  (${i + 1}, ${q(r)}, 'seed')`).join(',\n')
  const ex = EXEMPLARS
    .map((e, i) => `  (${i + 1}, ${q(e.category)}, ${q(e.customer)}, ${q(e.reply)}, 'seed')`)
    .join(',\n')
  return (
    `insert into proofs.ai_draft_house_rules (sort_order, rule_text, source) values\n${rules};\n\n` +
    `insert into proofs.ai_draft_exemplars (sort_order, category, customer_text, reply_text, source) values\n${ex};`
  )
}

const MIGRATION = '000225_ai_draft_briefing_tables.sql'

function main(): void {
  const sql = seedSql()
  if (!process.argv.includes('--check')) {
    console.log(sql)
    return
  }
  const dir = dirname(fileURLToPath(import.meta.url))
  const path = join(dir, '..', 'supabase', 'migrations', MIGRATION)
  const migration = readFileSync(path, 'utf8')
  if (!migration.includes(sql)) {
    console.error(
      `✗ Briefing seed DRIFT: ${MIGRATION} no longer contains the seed generated from the current ` +
        `HOUSE_RULES (${HOUSE_RULES.length}) / EXEMPLARS (${EXEMPLARS.length}). ` +
        `Regenerate with \`pnpm tsx scripts/briefing-seed.ts\` and update the migration's seed block.`,
    )
    process.exit(1)
  }
  console.log(`✓ Briefing seed matches: ${HOUSE_RULES.length} house rules, ${EXEMPLARS.length} exemplars.`)
}

main()
