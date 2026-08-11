// dropbox-order-proofs — designer-only. Given whatever a designer pasted for an
// old order folder (a shared link, a Dropbox web address, a path, or just the
// folder name), returns a shortlist of the proof images in it with a temporary
// download link for each.
//
// This backs reusing archived artwork: rather than hunting the folder, exporting
// each proof and cropping the price panel off by hand, the designer pastes one
// URL and confirms what comes back.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   · It does not decide what the artwork MEANS. Recipient names, proof type and
//     which round was approved are not derivable from a folder — filenames name
//     card sides and materials as often as people, and getting the roster wrong
//     changes what the customer is charged. Those stay with the designer.
//   · It does not send the bytes. Dropbox serves its temporary links with
//     `access-control-allow-origin: *`, so the browser fetches each image
//     directly and crops it there, where the crop engine already lives. Proxying
//     40 JPEGs through here would be slower and risks the platform kill that
//     large artwork-check runs have already hit once.
//   · It creates nothing and writes nothing, in Dropbox or in the database.
//
// Auth: verify_jwt = true PLUS requireDesigner in the body. The second is the
// load-bearing one — verify_jwt only proves a validly-signed project JWT, and
// the publishable anon key is one, shipped in every visitor's browser bundle.
// Reads the Dropbox connection with a service-role client.
//
// Always responds 200 with an { ok } discriminator, matching dropbox-folder.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireDesigner } from '../_shared/admin.ts'
import {
  getDropboxAccessToken,
  listFolderByPath,
  findFolderByName,
  getTemporaryLink,
  parseOrderFolderName,
} from '../_shared/dropbox.ts'
import { parseFolderInput, selectProofImages } from '../_shared/dropboxProofFiles.ts'

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

  const check = await requireDesigner(req)
  if (check instanceof Response) return check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const raw = typeof body.input === 'string' ? body.input : ''
  const target = parseFolderInput(raw)
  if (!target) {
    return json({
      ok: false,
      error: 'Paste a Dropbox folder link, the folder’s address, or its name (e.g. “Order 38294 - Norwood”).',
    })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )
  const token = await getDropboxAccessToken(admin)
  if (!token) return json({ ok: false, error: 'Dropbox is not connected.' })

  // 1) Resolve whatever was pasted to a PATH, then read the folder one way.
  //
  // Every route funnels through a path deliberately. A shared link could be
  // listed directly, but only a path can produce a per-file download link, so
  // listing a link that way would return a set of images the browser then had
  // no way to fetch. Resolving the link to its path first — which works because
  // these folders belong to the connected account, the same fact
  // clone-order-folder relies on — leaves exactly one route to get right.
  let path: string | null = null

  if (target.kind === 'shared') {
    const metaRes = await fetch('https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target.url }),
    })
    const meta = metaRes.ok ? await metaRes.json().catch(() => null) : null
    if (!meta) {
      return json({ ok: false, error: 'Could not read that Dropbox link — check it is a shared folder link.' })
    }
    if (meta['.tag'] !== 'folder') {
      return json({ ok: false, error: 'That link points to a file, not the order folder.' })
    }
    path = typeof meta.path_lower === 'string' ? meta.path_lower : null
    if (!path) {
      return json({
        ok: false,
        error: 'That folder is shared with us rather than ours, so its files cannot be read this way.',
      })
    }
  } else if (target.kind === 'name') {
    // Only an unambiguous match is accepted — see findFolderByName for why
    // picking the first would hand back a different job's artwork.
    path = await findFolderByName(token, target.name)
    if (!path) {
      return json({
        ok: false,
        error: `Could not find exactly one folder called “${target.name}”. Open it in Dropbox and paste the address instead.`,
      })
    }
  } else {
    path = target.path
  }

  const listing = await listFolderByPath(token, path)
  if (!listing) {
    return json({
      ok: false,
      error: 'Could not open that folder. Check the address, or open it in Dropbox and copy the address from the bar.',
    })
  }
  const { folderName, folderPath, entries } = listing

  // 2) Shortlist the proofs. Everything left out comes back with a reason —
  //    "we found 3 proofs" reads as complete whether it is or not.
  const selection = selectProofImages(entries)
  const parsed = parseOrderFolderName(folderName)

  // 3) A temporary link per image. A file that fails to produce one is
  //    RETURNED with the failure rather than dropped: a missing image the
  //    designer can see is a nuisance, one they cannot is a silently
  //    incomplete proof.
  const files = await Promise.all(
    selection.chosen.map(async (f) => {
      const link = await getTemporaryLink(token, `${folderPath}${f.path}`)
      return {
        name: f.name,
        path: f.path,
        size: f.size ?? 0,
        why: f.why,
        link,
        error: link ? null : 'Could not fetch this file from Dropbox.',
      }
    }),
  )

  return json({
    ok: true,
    folder_name: folderName,
    order_number: parsed.order_number,
    project_name: parsed.project_name,
    basis: selection.basis,
    files,
    skipped: selection.skipped,
  })
})
