// ⚠ THIS IS AN AS-RUN ARCHIVE, NOT A MAINTAINED TOOL.
//
// This file is a verbatim copy of the script that actually produced the live
// reorder register on 2026-08-09, rescued from a session-scoped temp directory
// before it was cleaned up. Its logic is UNCHANGED — including the defects
// noted below — because its whole value is that it describes what really
// happened to 2,739 customer records. "Fixing" it in place would make it stop
// being a record of anything.
//
// The only edit is that the hardcoded scratchpad path became a parameter.
//
// See scripts/reorder-register/README.md before running or changing anything.

// Merge resolved emails into the register chunks and emit final seed chunks.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs'

const DIR = process.env.REGISTER_DATA_DIR ?? process.argv[2]
if (!DIR) {
  console.error('Usage: REGISTER_DATA_DIR=<dir> node <script>   (or pass the dir as argv[2])')
  console.error('The dir holds the raw Xero pulls — see README.md.')
  process.exit(1)
}

const emails = existsSync(`${DIR}/emails.json`) ? JSON.parse(readFileSync(`${DIR}/emails.json`, 'utf8')) : {}
const register = JSON.parse(readFileSync(`${DIR}/register.json`, 'utf8'))
let withEmail = 0
for (const r of register) {
  const e = emails[r.xero_contact_id]
  if (e && e.email) { r.email = String(e.email).toLowerCase(); withEmail++ } else { r.email = null }
}
mkdirSync(`${DIR}/final-seed`, { recursive: true })
const CHUNK = 150
let files = 0
for (let i = 0; i < register.length; i += CHUNK) {
  writeFileSync(`${DIR}/final-seed/chunk-${String(i / CHUNK).padStart(2, '0')}.json`, JSON.stringify(register.slice(i, i + CHUNK)))
  files++
}
console.log(`rows: ${register.length}, with email: ${withEmail}, chunks: ${files}`)
