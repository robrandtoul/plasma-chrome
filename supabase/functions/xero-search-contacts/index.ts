// xero-search-contacts — designer-only Xero contact typeahead for the Create
// order modal's "Xero customer" picker. Takes a short search string and returns
// a light id+name+email list from Xero's Contacts searchTerm (case-insensitive
// across name / first / last / contact number / company number / email).
//
// Read-only: no writes, no money, no customer/proof data — just the org's Xero
// contacts the designer is choosing which invoice to file under. Auth:
// requireDesigner validates the caller's JWT in-body, so this deploys with
// platform verify_jwt OFF, mirroring create-order / retry-order-invoice.

import { json, requireDesigner, CORS_HEADERS } from '../_shared/admin.ts'
import { getAccessContext, searchContacts } from '../_shared/xero.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check

  let body: { q?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const q = typeof body.q === 'string' ? body.q.trim() : ''
  // Two characters is the floor for a useful Xero search; below that, return
  // empty rather than pulling the whole contact book.
  if (q.length < 2) return json({ contacts: [] })

  // getAccessContext refreshes/rotates the Xero token as needed (proofs-schema
  // admin client). Null when Xero isn't connected — surface a clear, non-fatal
  // message so the picker can fall back to "leave blank / new customer".
  const ctx = await getAccessContext(check.admin)
  if (!ctx) {
    return json({ error: 'Xero is not connected — connect it in Settings to search customers.', contacts: [] }, 200)
  }

  const contacts = await searchContacts(ctx.accessToken, ctx.tenantId, q)
  return json({ contacts })
})
