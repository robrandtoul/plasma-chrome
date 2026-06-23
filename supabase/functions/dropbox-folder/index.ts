// dropbox-folder — designer-only. Given a Dropbox shared link to an order
// folder, returns the folder name parsed into "<number> - <project>" plus the
// files in it (the prepped source artwork). Backs the Orders page: linking the
// order folder fills the order number + project that drive the Stock Control
// hand-off, and confirms artwork is present.
//
// Auth: verify_jwt = true (the designer's session JWT). Reads the Dropbox
// connection with a service-role client.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getDropboxAccessToken, parseOrderFolderName } from '../_shared/dropbox.ts'

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
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const link = typeof body.link === 'string' ? body.link.trim() : ''
  if (!link) return json({ error: 'Missing link' }, 400)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  const token = await getDropboxAccessToken(admin)
  if (!token) return json({ error: 'Dropbox is not connected' }, 503)

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 1) Resolve the shared link → folder name (and confirm it IS a folder).
  const metaRes = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: link }),
  })
  if (!metaRes.ok) {
    const detail = await metaRes.text().catch(() => '')
    return json({ error: 'Could not read that Dropbox link — check it is a shared folder link.', detail: detail.slice(0, 300) }, 400)
  }
  const meta = await metaRes.json().catch(() => null)
  const name = (meta?.name as string | undefined) ?? ''
  if (meta?.['.tag'] !== 'folder') {
    return json({ error: 'That link points to a file, not the order folder.' }, 400)
  }

  const { order_number, project_name } = parseOrderFolderName(name)

  // 2) List the folder's contents (the prepped artwork files).
  const listRes = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: '', shared_link: { url: link } }),
  })
  let files: { name: string; is_folder: boolean }[] = []
  if (listRes.ok) {
    const listing = await listRes.json().catch(() => null)
    const entries = Array.isArray(listing?.entries) ? listing.entries : []
    files = entries.map((e: Record<string, unknown>) => ({
      name: (e.name as string) ?? '',
      is_folder: e['.tag'] === 'folder',
    }))
  }
  const fileCount = files.filter((f) => !f.is_folder).length

  return json({ name, order_number, project_name, files, file_count: fileCount })
})
