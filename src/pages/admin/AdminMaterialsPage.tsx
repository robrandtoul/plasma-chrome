import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import AdminMaterialContentModal, { type MaterialContent } from './AdminMaterialContentModal'

// Materials admin tab. Previously embedded as a section in the
// Settings page; lifted to its own top-level tab so customer-facing
// material metadata (name, description, icon, key features,
// personalisation eligibility, etc.) reads as a peer to Pricing
// rather than buried in a long settings scroll.
//
// Per-material pricing lives at /admin/pricing/materials/:code —
// the "Pricing & variants" link on each row navigates there.
// Per-material content edits open AdminMaterialContentModal, same
// modal that shipped originally inside Settings.

export default function AdminMaterialsPage() {
  const [materials, setMaterials] = useState<MaterialContent[]>([])
  const [editingMaterial, setEditingMaterial] = useState<MaterialContent | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => { void loadMaterials() }, [])

  async function loadMaterials() {
    // Admin list — loads all active materials including archived ones
    // so the "Show archived" toggle can reveal them without a second
    // round-trip. RLS lets admins see archived rows; designers
    // wouldn't.
    const { data } = await supabase
      .from('materials')
      .select('id, code, display_name, category, description, icon_url, is_published, archived_at, display_quantities, quote_min_quantity, quote_max_quantity, key_features, supports_personalisation')
      .eq('is_active', true)
      .order('sort_order')
    setMaterials((data ?? []) as MaterialContent[])
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Materials</h2>
        <p className="mt-1 text-sm text-gray-500">
          Per-material description and icon for the customer-facing "About [Material]" block. Unpublished materials stay hidden from designers until an admin publishes them. Archived materials are hidden entirely.
        </p>
      </div>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Catalogue</h3>
            <p className="mt-1 text-xs text-gray-500">
              Click Edit to open the content editor for a material. Click Pricing & variants to manage its price grid.
            </p>
          </div>
          <Link
            to="/admin/materials/new"
            className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Add material
          </Link>
        </div>

        {(() => {
          const active = materials.filter((m) => m.archived_at == null)
          const archived = materials.filter((m) => m.archived_at != null)
          return (
            <>
              {archived.length > 0 && (
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setShowArchived(!showArchived)}
                    role="switch"
                    aria-checked={showArchived}
                    className={[
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                      showArchived ? 'bg-gray-900' : 'bg-gray-200',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                        showArchived ? 'translate-x-[1.125rem] translate-y-0.5' : 'translate-x-0.5 translate-y-0.5',
                      ].join(' ')}
                    />
                  </button>
                  <label className="text-gray-500">
                    Show archived ({archived.length})
                  </label>
                </div>
              )}

              <div className="mt-4 overflow-hidden rounded-lg ring-1 ring-gray-200">
                {active.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-gray-400">No active materials.</p>
                ) : (
                  active.map((m, i) => renderMaterialRow(
                    m, i, setEditingMaterial, /* muted */ false,
                  ))
                )}
              </div>

              {showArchived && archived.length > 0 && (
                <div className="mt-6">
                  <div className="mb-2 flex items-center gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                      Archived
                    </h4>
                    <span className="text-xs text-gray-400">
                      ({archived.length})
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-lg ring-1 ring-gray-200">
                    {archived.map((m, i) => renderMaterialRow(
                      m, i, setEditingMaterial, /* muted */ true,
                    ))}
                  </div>
                </div>
              )}
            </>
          )
        })()}
      </section>

      {editingMaterial && (
        <AdminMaterialContentModal
          material={editingMaterial}
          onClose={() => { setEditingMaterial(null); void loadMaterials() }}
          onSaved={(updated) => {
            setMaterials((prev) => prev.map((m) => m.id === updated.id ? updated : m))
          }}
        />
      )}
    </div>
  )
}

// One row in the materials list. Pulled out so the active and
// archived sections can share layout; `muted` greys the whole row +
// replaces the Published/Unpublished pill with an Archived badge.
function renderMaterialRow(
  m: MaterialContent,
  i: number,
  openEditor: (m: MaterialContent) => void,
  muted: boolean,
): React.ReactNode {
  return (
    <div
      key={m.id}
      className={[
        'flex items-center gap-4 px-4 py-3',
        i > 0 ? 'border-t border-gray-100' : '',
        muted ? 'opacity-70' : '',
      ].join(' ')}
    >
      <div className={[
        'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-50 ring-1 ring-gray-200',
        muted ? 'grayscale' : '',
      ].join(' ')}>
        {m.icon_url
          ? <img src={m.icon_url} alt="" className="max-h-full max-w-full object-contain" />
          : <svg viewBox="0 0 16 16" className="h-4 w-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12l3-4 3 3 3-5 3 4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </div>
      <div className="min-w-0 flex-1">
        <div className={[
          'truncate text-sm font-semibold',
          muted ? 'italic text-gray-500' : 'text-gray-900',
        ].join(' ')}>
          {m.display_name}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {muted ? (
            <span className="inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-700">
              Archived
            </span>
          ) : m.is_published ? (
            <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Published</span>
          ) : (
            <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Unpublished</span>
          )}
          {!m.description && !muted && (
            <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">
              Needs content
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <button
          onClick={() => openEditor(m)}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
        >
          Edit
        </button>
        <Link
          to={`/admin/pricing/materials/${m.code}`}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-50"
        >
          Pricing &amp; variants
        </Link>
      </div>
    </div>
  )
}
