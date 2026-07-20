import { useEffect, useId, useRef, useState } from 'react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import {
  DESIGNER_COLOURS,
  designerColourCss,
  designerColourLabel,
  designerTint,
  type DesignerColour,
} from '../lib/designerColours'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive up-to-2 uppercase initials from a full name. "Rob Randtoul" → "RR" */
function initialsFromName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

// ── Colour catalogue ─────────────────────────────────────────────────────────

/**
 * Swatch styling, derived from the shared palette rather than a parallel set of
 * Tailwind classes. The old sky/teal/orange/violet classes were only ever an
 * approximation of the real avatar colours, so the picker showed you something
 * slightly different from what everyone else would see. Soft tint + solid text
 * matches how DesignerAvatar renders on the dashboard.
 */
function swatchStyle(c: DesignerColour) {
  return { backgroundColor: designerTint(c, 14), color: designerColourCss(c) }
}

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 2 * 1024 * 1024 // 2 MB

// ── Shared input style (matches AddUserDialog) ────────────────────────────────

const inputClass =
  'w-full rounded-lg border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'

// ── Types ────────────────────────────────────────────────────────────────────

export interface EditProfileSavedPayload {
  initials: string
  colour: DesignerColour
  fullName: string
  avatarUrl: string | null
}

interface EditProfileModalProps {
  userId: string
  onClose: () => void
  onSaved: (payload: EditProfileSavedPayload) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export default function EditProfileModal({
  userId,
  onClose,
  onSaved,
}: EditProfileModalProps) {
  const titleId   = useId()
  const fileRef   = useRef<HTMLInputElement>(null)

  const [fullName, setFullName]                     = useState('')
  const [initials, setInitials]                     = useState('')
  const [colour, setColour]                         = useState<DesignerColour>('blue')
  const [initialsUserEdited, setInitialsUserEdited] = useState(false)
  const [avatarUrl, setAvatarUrl]                   = useState<string | null>(null)
  // Snapshot of the row as loaded. Used by handleSubmit to compute a
  // before/after diff that only includes changed fields when logging
  // the profile.updated audit event (PV-2026W21-075).
  const [originalSnapshot, setOriginalSnapshot]     = useState<{
    fullName: string
    initials: string
    colour: DesignerColour
  } | null>(null)

  const [loading,         setLoading]         = useState(true)
  const [saving,          setSaving]          = useState(false)
  const [uploading,       setUploading]       = useState(false)
  const [uploadError,     setUploadError]     = useState<string | null>(null)
  const [formError,       setFormError]       = useState<string | null>(null)
  // Colour → the teammate already using it, so the picker can steer you off a
  // clash. Keyed off the roster RPC rather than a profiles read: the profiles
  // SELECT policies only expose your own row to a non-admin (see 000329).
  const [takenBy,         setTakenBy]         = useState<Partial<Record<DesignerColour, string>>>({})

  // ── Load current profile ─────────────────────────────────────────────────

  useEffect(() => {
    supabase
      .from('profiles')
      .select('full_name, designer_initials, designer_colour, avatar_url')
      .eq('id', userId)
      .single()
      .then(({ data }) => {
        if (data) {
          const loadedName     = data.full_name ?? ''
          const loadedInitials = (data.designer_initials ?? '').slice(0, 2)
          const loadedColour   = (data.designer_colour ?? 'blue') as DesignerColour
          setFullName(loadedName)
          setInitials(loadedInitials)
          setColour(loadedColour)
          setAvatarUrl(data.avatar_url ?? null)
          setOriginalSnapshot({
            fullName: loadedName,
            initials: loadedInitials,
            colour:   loadedColour,
          })
          // If the stored initials match what we'd auto-derive, treat them
          // as not manually edited so auto-derive keeps working as they type.
          const stored  = loadedInitials.toUpperCase()
          const derived = initialsFromName(loadedName)
          setInitialsUserEdited(stored !== '' && stored !== derived)
        }
        setLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // ── Which colours are already spoken for ─────────────────────────────────
  //
  // Best-effort: if the roster call fails the picker simply offers everything,
  // which is the behaviour it had before. Never blocks opening the modal.

  useEffect(() => {
    supabase
      .rpc('team_roster')
      .then(({ data, error }) => {
        if (error || !data) return
        const map: Partial<Record<DesignerColour, string>> = {}
        for (const m of data as Array<{
          id: string
          full_name: string | null
          designer_colour: string | null
        }>) {
          if (m.id === userId) continue
          const c = m.designer_colour as DesignerColour | null
          if (c && !map[c]) map[c] = (m.full_name ?? 'a teammate').split(' ')[0]
        }
        setTakenBy(map)
      })
  }, [userId])

  // ── Avatar upload ────────────────────────────────────────────────────────
  //
  // Upload is applied immediately on file select — same UX as Slack,
  // GitHub, etc. The user doesn't need to hit Save; if they cancel the
  // rest of the form the picture is still saved (which is fine and
  // expected). The stored path is always `{userId}/avatar` so previous
  // uploads are silently overwritten rather than accumulating.

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset input so re-selecting the same file fires onChange again.
    e.target.value = ''

    setUploadError(null)

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setUploadError('Please choose a JPEG, PNG, or WebP image.')
      return
    }
    if (file.size > MAX_BYTES) {
      setUploadError('Image must be 2 MB or smaller.')
      return
    }

    setUploading(true)
    const storagePath = `${userId}/avatar`

    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(storagePath, file, { upsert: true, contentType: file.type })

    if (upErr) {
      setUploading(false)
      setUploadError(upErr.message || 'Upload failed. Please try again.')
      return
    }

    // Get the public URL and append a cache-buster so browsers always
    // fetch the latest version rather than serving a stale cached copy.
    const { data: { publicUrl } } = supabase.storage
      .from('avatars')
      .getPublicUrl(storagePath)

    const urlWithBuster = `${publicUrl}?t=${Date.now()}`

    // Persist immediately to profiles.avatar_url.
    const { error: dbErr } = await supabase
      .from('profiles')
      .update({ avatar_url: urlWithBuster })
      .eq('id', userId)

    setUploading(false)

    if (dbErr) {
      // Roll back the storage write so the bucket doesn't carry an
      // orphan file whose URL is no longer referenced anywhere
      // (PV-2026W21-079). A 404 means the object never landed; any
      // other error is logged but not surfaced — the original dbErr
      // is what the designer needs to see.
      const { error: rollbackErr } = await supabase
        .storage
        .from('avatars')
        .remove([storagePath])
      if (rollbackErr && !/not\s*found/i.test(rollbackErr.message)) {
        console.warn('[avatar] storage rollback failed:', rollbackErr.message)
      }
      setUploadError(dbErr.message || 'Could not save avatar. Please try again.')
      return
    }

    setAvatarUrl(urlWithBuster)
    // Mirror the immediate DB write to the parent so the dashboard
    // header re-renders with the new photo right away. Without this,
    // closing via Cancel after upload leaves the header showing
    // initials until the next dashboard refetch (PV-2026W21-078;
    // matches the same pattern on Remove photo).
    onSaved({
      initials,
      colour,
      fullName,
      avatarUrl: urlWithBuster,
    })
    // Audit log (PV-2026W21-075). Designer self-edited their own avatar;
    // record size + content-type as metadata, no diff payload because
    // avatar bytes aren't meaningfully diffable.
    void logAudit({
      action:      'profile.avatar_uploaded',
      targetType:  'user',
      targetId:    userId,
      targetLabel: fullName || undefined,
      metadata:    { size_bytes: file.size, content_type: file.type },
    })
  }

  // ── Name / initials handlers ─────────────────────────────────────────────

  function handleNameChange(name: string) {
    setFullName(name)
    if (!initialsUserEdited) {
      setInitials(initialsFromName(name))
    }
  }

  function handleInitialsChange(raw: string) {
    setInitialsUserEdited(true)
    setInitials(raw.slice(0, 2).toUpperCase())
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)

    const cleanName = fullName.trim()
    if (!cleanName) {
      setFormError('Full name is required.')
      return
    }

    const finalInitials = (initials.trim() || initialsFromName(cleanName) || '?').slice(0, 2)

    setSaving(true)
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({
        full_name:         cleanName,
        designer_initials: finalInitials,
        designer_colour:   colour,
        // avatar_url is already written in handleFileChange; re-writing
        // it here keeps the row consistent if the user uploaded and then
        // also changed their name in the same session.
        avatar_url:        avatarUrl,
      })
      .eq('id', userId)
    setSaving(false)

    if (updateErr) {
      setFormError(updateErr.message || 'Failed to save profile.')
      return
    }

    // Audit log (PV-2026W21-075). Build before/after payloads that
    // only include fields that actually changed against the snapshot
    // captured on load — saving without edits produces no audit row.
    if (originalSnapshot) {
      const before: Record<string, unknown> = {}
      const after:  Record<string, unknown> = {}
      if (originalSnapshot.fullName !== cleanName) {
        before.full_name = originalSnapshot.fullName
        after.full_name  = cleanName
      }
      if (originalSnapshot.initials !== finalInitials) {
        before.designer_initials = originalSnapshot.initials
        after.designer_initials  = finalInitials
      }
      if (originalSnapshot.colour !== colour) {
        before.designer_colour = originalSnapshot.colour
        after.designer_colour  = colour
      }
      if (Object.keys(after).length > 0) {
        void logAudit({
          action:      'profile.updated',
          targetType:  'user',
          targetId:    userId,
          targetLabel: cleanName,
          beforeValue: before,
          afterValue:  after,
        })
      }
    }

    onSaved({ initials: finalInitials, colour, fullName: cleanName, avatarUrl })
    onClose()
  }

  // ── Render ───────────────────────────────────────────────────────────────

  // Only bar a clash while there is somewhere else to go — with more staff than
  // colours, a disabled-everything picker would be a dead end.
  const freeColourExists = DESIGNER_COLOURS.some((c) => !takenBy[c])

  return (
    <Modal open onClose={onClose} preventClose={saving || uploading} ariaLabelledBy={titleId}>
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">

          <h3 id={titleId} className="text-lg font-semibold text-ink">
            Edit profile
          </h3>

          {/* Avatar upload ──────────────────────────────────────────────── */}
          <div>
            <p className="mb-2 text-sm font-medium text-ink-soft">Profile picture</p>
            <div className="flex items-center gap-4">
              {/* Clickable avatar — shows photo if uploaded, initials otherwise */}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                aria-label="Upload profile picture"
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt="Profile"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span
                    className="flex h-full w-full items-center justify-center text-lg font-semibold"
                    style={swatchStyle(colour)}
                    aria-hidden
                  >
                    {initials || '?'}
                  </span>
                )}

                {/* Hover/focus overlay */}
                {uploading ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  </span>
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30 group-focus-visible:bg-black/30">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-5 w-5 text-on-ink opacity-0 drop-shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden
                    >
                      <path
                        fillRule="evenodd"
                        d="M1 8a2 2 0 0 1 2-2h.93a2 2 0 0 0 1.664-.89l.812-1.22A2 2 0 0 1 8.07 3h3.86a2 2 0 0 1 1.664.89l.812 1.22A2 2 0 0 0 16.07 6H17a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8Zm13.5 3a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM10 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </span>
                )}
              </button>

              <div className="text-xs text-ink-mute leading-relaxed">
                <p>Click to upload a photo.</p>
                <p>JPEG, PNG, or WebP. Max 2 MB.</p>
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={async () => {
                      // Delete the object first so the public bucket
                      // doesn't keep an orphan file after avatar_url is
                      // nulled (PV-2026W21-076). A 404 is fine — it
                      // just means the row was nulled outside of this
                      // session. Any other error is logged as a warning
                      // but doesn't block the profile UPDATE: the row
                      // reference should still clear so the UI stops
                      // referring to a file we can't manage.
                      const { error: storageErr } = await supabase
                        .storage
                        .from('avatars')
                        .remove([`${userId}/avatar`])
                      if (storageErr && !/not\s*found/i.test(storageErr.message)) {
                        console.warn('[avatar] storage remove failed:', storageErr.message)
                      }
                      const { error } = await supabase
                        .from('profiles')
                        .update({ avatar_url: null })
                        .eq('id', userId)
                      if (!error) {
                        setAvatarUrl(null)
                        // Audit log (PV-2026W21-075). Designer removed their
                        // own avatar; no diff payload needed.
                        void logAudit({
                          action:      'profile.avatar_removed',
                          targetType:  'user',
                          targetId:    userId,
                          targetLabel: fullName || undefined,
                        })
                        // Refetch the canonical row state before calling
                        // onSaved so any unsaved edits to the form fields
                        // (name/initials/colour) don't leak into the
                        // payload (PV-2026W21-080). Falls back to current
                        // in-memory values if the refetch fails.
                        const { data: latest } = await supabase
                          .from('profiles')
                          .select('full_name, designer_initials, designer_colour, avatar_url')
                          .eq('id', userId)
                          .single()
                        onSaved({
                          initials:  (latest?.designer_initials ?? initials).slice(0, 2),
                          colour:    (latest?.designer_colour ?? colour) as DesignerColour,
                          fullName:  latest?.full_name ?? fullName,
                          avatarUrl: latest?.avatar_url ?? null,
                        })
                      }
                    }}
                    className="mt-1 text-out hover:underline"
                  >
                    Remove photo
                  </button>
                )}
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={handleFileChange}
              tabIndex={-1}
              aria-hidden
            />

            {uploadError && (
              <p className="mt-2 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">
                {uploadError}
              </p>
            )}
          </div>

          {/* Full name ─────────────────────────────────────────────────── */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-soft">
              Full name <span className="text-out" aria-hidden>*</span>
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => handleNameChange(e.target.value)}
              className={inputClass}
              placeholder="e.g. Rob Randtoul"
              autoComplete="name"
            />
          </div>

          {/* Initials + live preview ────────────────────────────────────── */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-soft">
              Initials
            </label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={initials}
                onChange={(e) => handleInitialsChange(e.target.value)}
                maxLength={2}
                className={[inputClass, 'w-20 text-center font-semibold uppercase tracking-widest'].join(' ')}
                placeholder="RR"
                aria-label="Initials, up to two characters"
              />
              {/* Live avatar preview — shows photo if uploaded, initials otherwise */}
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 select-none items-center justify-center overflow-hidden rounded-full text-sm font-semibold ring-1 ring-line"
                style={avatarUrl ? undefined : swatchStyle(colour)}
              >
                {avatarUrl
                  ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                  : (initials || '?')
                }
              </span>
            </div>
            <p className="mt-1.5 text-xs text-ink-dim">
              Shown when no photo is uploaded. Auto-derived from your name — edit to override.
            </p>
          </div>

          {/* Colour picker ──────────────────────────────────────────────── */}
          <div>
            <p className="mb-2 text-sm font-medium text-ink-soft">Avatar colour</p>
            <p className="mb-2 text-xs text-ink-dim">
              Used as the background for your initials when no photo is set, and as the tint on your
              chat messages. Colours already taken by a teammate are greyed out, so everyone stays
              telling-apart-able at a glance.
            </p>
            <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Avatar colour">
              {DESIGNER_COLOURS.map((c) => {
                const owner = takenBy[c]
                // Your own current colour is never "taken" — it's yours.
                const blocked = !!owner && c !== colour && freeColourExists
                const label = designerColourLabel(c)
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={colour === c}
                    aria-label={owner ? `${label} — already used by ${owner}` : label}
                    title={owner ? `${label} — already used by ${owner}` : label}
                    disabled={blocked}
                    onClick={() => setColour(c)}
                    className={[
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                      blocked
                        ? 'cursor-not-allowed opacity-30 ring-1 ring-line'
                        : colour === c
                          ? 'scale-110 ring-2 ring-offset-2'
                          : 'ring-1 ring-line hover:scale-105',
                    ].join(' ')}
                    style={{
                      ...swatchStyle(c),
                      ...(colour === c && !blocked
                        ? { ['--tw-ring-color' as string]: designerColourCss(c) }
                        : {}),
                    }}
                  >
                    {initials || '?'}
                  </button>
                )
              })}
            </div>
          </div>

          {formError && (
            <p className="rounded-lg bg-out-soft px-3 py-2 text-xs text-out">
              {formError}
            </p>
          )}

          {/* Actions ────────────────────────────────────────────────────── */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving || uploading}
              className="rounded px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || uploading}
              className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>

        </form>
      )}
    </Modal>
  )
}
