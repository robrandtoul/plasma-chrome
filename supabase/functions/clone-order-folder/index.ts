// clone-order-folder — designer-only. Copies an existing order's Dropbox folder
// (the original order's artwork) into a NEW sibling folder named with the next
// order number, for a free reprint. Returns the new folder's shared link +
// parsed number/project so the caller can link it straight to the reprint order.
//
// A reprint needs its OWN folder: the folder name IS the Stock Control order
// number, and the original's number can't be reused (one number = one job).
// This just saves the designer copying the artwork across by hand.
//
// Best-effort convenience. Any failure returns { ok:false, error } and the
// designer falls back to creating the folder manually (the normal Orders flow),
// so a clone miss never blocks the reprint. `dry_run:true` resolves the source
// path + planned destination WITHOUT copying, for safe verification.
//
// Always responds 200 with an { ok } discriminator (matching dropbox-folder);
// the only non-200s are genuine client errors (bad method / JSON / inputs).
//
// Auth: verify_jwt = true PLUS requireDesigner in the body, like dropbox-folder.
// The in-body check is the load-bearing one: verify_jwt only proves a validly-
// signed project JWT, and the publishable anon key is one — it ships in every
// visitor's browser bundle. That matters more here than on dropbox-folder,
// because this endpoint WRITES: it copies a folder inside Plasma's Dropbox and
// mints a new shared link for the copy. Reads the Dropbox connection with a
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
  // unauthenticated caller never reaches the Dropbox connection, and in
  // particular never reaches the copy. Returns the shared 401/403 Response,
  // which carries { error } rather than this function's { ok:false } shape; a
  // missing `ok` reads as failure on the frontend either way.
  const check = await requireDesigner(req)
  if (check instanceof Response) return check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const sourceUrl = typeof body.source_url === 'string' ? body.source_url.trim() : ''
  const newName = typeof body.new_name === 'string' ? body.new_name.trim() : ''
  const dryRun = body.dry_run === true
  if (!sourceUrl) return json({ ok: false, error: 'Missing source_url' }, 400)
  if (!newName) return json({ ok: false, error: 'Missing new_name' }, 400)

  // The new name drives the Stock Control order number, so it must parse to a
  // leading number (same rule the Orders page enforces on a linked folder).
  const parsed = parseOrderFolderName(newName)
  if (!parsed.order_number) {
    return json({ ok: false, error: 'The new folder name needs a leading order number, e.g. "404015 - Project".' }, 400)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  const token = await getDropboxAccessToken(admin)
  if (!token) return json({ ok: false, error: 'Dropbox is not connected.' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 1) Resolve the source folder's real path in Plasma's Dropbox. path_lower is
  //    only returned for content the connected account owns — which the order
  //    folders are — and we need it to copy the folder server-side.
  const metaRes = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: sourceUrl }),
  })
  if (!metaRes.ok) {
    return json({ ok: false, error: 'Could not read the original Dropbox link.' })
  }
  const meta = await metaRes.json().catch(() => null)
  if (meta?.['.tag'] !== 'folder') {
    return json({ ok: false, error: 'The original order link is not a folder.' })
  }
  const sourcePath = typeof meta?.path_lower === 'string' ? meta.path_lower : null
  if (!sourcePath) {
    return json({ ok: false, error: 'Could not locate the original folder in Dropbox — create the new folder manually.' })
  }

  // The new folder is a SIBLING of the source (same parent), named newName.
  const slash = sourcePath.lastIndexOf('/')
  const parent = slash > 0 ? sourcePath.slice(0, slash) : ''
  const destPath = `${parent}/${newName}`

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      source_path: sourcePath,
      dest_path: destPath,
      order_number: parsed.order_number,
      project_name: parsed.project_name,
    })
  }

  // 2) Copy the whole folder (server-side, recursive) to the new path.
  const copyRes = await fetch('https://api.dropboxapi.com/2/files/copy_v2', {
    method: 'POST',
    headers,
    body: JSON.stringify({ from_path: sourcePath, to_path: destPath, autorename: false }),
  })
  if (!copyRes.ok) {
    const errBody = await copyRes.json().catch(() => null)
    if (JSON.stringify(errBody ?? '').includes('conflict')) {
      return json({ ok: false, error: `A folder named "${newName}" already exists — use a different order number.` })
    }
    return json({ ok: false, error: 'Could not copy the artwork folder — create the new folder manually.' })
  }

  // 3) Create (or, if already shared, fetch) a shared link on the new folder.
  let sharedUrl: string | null = null
  const linkRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: destPath }),
  })
  if (linkRes.ok) {
    sharedUrl = (await linkRes.json().catch(() => null))?.url ?? null
  } else {
    const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: destPath, direct_only: true }),
    })
    if (listRes.ok) {
      const links = (await listRes.json().catch(() => null))?.links
      sharedUrl = Array.isArray(links) && links[0]?.url ? (links[0].url as string) : null
    }
  }
  if (!sharedUrl) {
    return json({
      ok: false,
      copied: true,
      error: 'Copied the folder, but couldn’t create its share link — open Dropbox and link it manually.',
    })
  }

  // Confirm the copy carried the artwork across (file tally for the caller).
  let fileCount: number | null = null
  try {
    const files = await listSharedLinkEntries(token, sharedUrl)
    fileCount = files.filter((f) => !f.is_folder).length
  } catch {
    fileCount = null
  }

  return json({
    ok: true,
    shared_url: sharedUrl,
    order_number: parsed.order_number,
    project_name: parsed.project_name,
    file_count: fileCount,
  })
})
