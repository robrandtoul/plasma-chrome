// dropbox-folder — designer-only. Given a Dropbox shared link to an order
// folder, returns the folder name parsed into "<number> - <project>" plus the
// files in it (the prepped source artwork). Backs the Orders page: linking the
// order folder fills the order number + project that drive the Stock Control
// hand-off, and confirms artwork is present.
//
// Always responds 200 with an { ok } discriminator (matching the house
// retry-order-invoice shape) so the frontend reads outcomes uniformly; the only
// non-200s are genuine client errors (bad method / unparseable JSON / no link).
//
// Auth: verify_jwt = true PLUS requireDesigner in the body. Both are needed and
// the second is the load-bearing one — verify_jwt only proves the caller holds a
// validly-signed project JWT, and the publishable anon key is exactly that. It
// ships in every visitor's browser bundle, so verify_jwt alone left this open to
// anyone: hand it a Dropbox shared link and it resolves and lists that link
// through Plasma's own Dropbox account, including links restricted to our team
// that the caller could not open themselves. Reads the Dropbox connection with a
// service-role client.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireDesigner } from '../_shared/admin.ts'
import { getDropboxAccessToken, parseOrderFolderName, listSharedLinkEntries } from '../_shared/dropbox.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  // Designer or admin only — checked BEFORE the body is read, so an
  // unauthenticated caller never reaches the Dropbox connection at all. Returns
  // the shared 401/403 Response, which carries { error } rather than this
  // function's { ok:false } shape; the frontend reads a missing `ok` as failure
  // either way, and an auth rejection is precisely the "genuine client error"
  // case the header comment reserves non-200s for.
  const check = await requireDesigner(req)
  if (check instanceof Response) return check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  const link = typeof body.link === 'string' ? body.link.trim() : ''
  if (!link) return json({ ok: false, error: 'Missing link' }, 400)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  const token = await getDropboxAccessToken(admin)
  if (!token) return json({ ok: false, error: 'Dropbox is not connected.' })

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 1) Resolve the shared link → folder name (and confirm it IS a folder).
  const metaRes = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: link }),
  })
  if (!metaRes.ok) {
    return json({ ok: false, error: 'Could not read that Dropbox link — check it is a shared folder link.' })
  }
  const meta = await metaRes.json().catch(() => null)
  const name = (meta?.name as string | undefined) ?? ''
  if (meta?.['.tag'] !== 'folder') {
    return json({ ok: false, error: 'That link points to a file, not the order folder.' })
  }

  const { order_number, project_name } = parseOrderFolderName(name)

  // 2) List the folder's contents (the prepped artwork files). Dropbox only
  // supports NON-recursive listing through a shared link, so the helper walks
  // subfolders itself rather than passing recursive:true (which fails and used
  // to silently report zero files). Folder entries are excluded from the tally.
  const files = await listSharedLinkEntries(token, link)
  const fileCount = files.filter((f) => !f.is_folder).length

  return json({ ok: true, name, order_number, project_name, files, file_count: fileCount })
})
