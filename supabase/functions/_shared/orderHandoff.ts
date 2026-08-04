// orderHandoff.ts — builds the direct hand-off contract payload
// (docs/order-handoff-spec.md §3.2, payload_version 1).
//
// PURE module: no imports, no Deno APIs — it is imported both by the
// place-order edge function and by the tsx contract test
// (./orderHandoff.test.ts, `pnpm test:handoff-contract`), which pins the
// composed payload against golden fixtures for every product combo.
// The payload is the contract between proof-viewer and Stock Control's
// create_order_handoff importer: new fields are new keys (the importer ignores
// keys it doesn't know); payload_version bumps only on a breaking reshape.

export interface HandoffSplitEntry {
  name: string
  qty: number
}

export interface HandoffPayloadInput {
  pvOrderId: string
  placedBy: string
  stockOrderNumber: string
  route: 'in_house' | 'supplier'
  customerName: string
  projectName: string | null
  /** The proof thread's Help Scout conversation id (in-house target); numeric string or null. */
  helpscoutConversationId: string | null
  qty: number
  supplierQty: number
  supplierOvers: number
  isPrototype: boolean
  material: {
    pvMaterialId: string | null
    code: string
    display: string | null
    /** buildCardLine output — the human echo AND the name-match input for
     *  stock-colour / wood-species / translucent resolution. */
    cardLine: string | null
    letterpress: { front: string; core: string; back: string; gilding: boolean } | null
  }
  supplier: {
    supplierId: string | null
    supplierName: string | null
    productTypeName: string | null
    specificType: string | null
    thickness: string | null
    finish: string | null
    /** ISO date (YYYY-MM-DD) or null. */
    mustShipBy: string | null
  } | null
  /** ISO date (YYYY-MM-DD) or null. */
  dateRequired: string | null
  inks: { front: string | null; back: string | null }
  packaging: 'Domestic' | 'International' | null
  split: HandoffSplitEntry[]
  dropboxFolderUrl: string | null
  note: string | null
  /** "Base cards supplied under another order's batch" (migration 000383):
   *  set on an in-house hand-off whose blanks ride a sibling order's supplier
   *  batch. Presence tells create_order_handoff to tolerate an unmapped
   *  material (the job is created without a material line — supplier blanks
   *  aren't sheet stock to allocate); the fields are the durable record on
   *  handoff_payload. Emitted only when set, so pre-existing payloads are
   *  byte-identical. */
  blanksSource?: {
    orderId: string
    stockOrderNumber: string | null
    reference: string | null
    batchQuantity: number
  } | null
}

export function buildHandoffPayload(i: HandoffPayloadInput): Record<string, unknown> {
  return {
    payload_version: 1,
    pv_order_id: i.pvOrderId,
    placed_by: i.placedBy,
    stock_order_number: i.stockOrderNumber.trim(),
    route: i.route,
    customer_name: i.customerName,
    project_name: i.projectName,
    helpscout_conversation_id: i.helpscoutConversationId,
    qty: i.qty,
    supplier_qty: i.route === 'supplier' ? i.supplierQty : i.qty,
    supplier_overs: i.route === 'supplier' ? i.supplierOvers : 0,
    prototype: i.isPrototype ? { is_prototype: true, max_copies: i.qty } : null,
    material: {
      pv_material_id: i.material.pvMaterialId,
      code: i.material.code,
      display: i.material.display,
      card_line: i.material.cardLine,
      letterpress: i.material.letterpress
        ? {
            front: i.material.letterpress.front,
            core: i.material.letterpress.core,
            back: i.material.letterpress.back,
            gilding: i.material.letterpress.gilding,
          }
        : null,
    },
    supplier:
      i.route === 'supplier' && i.supplier
        ? {
            supplier_id: i.supplier.supplierId,
            supplier_name: i.supplier.supplierName,
            product_type_name: i.supplier.productTypeName,
            specific_type: i.supplier.specificType,
            thickness: i.supplier.thickness,
            finish: i.supplier.finish,
            must_ship_by: i.supplier.mustShipBy,
          }
        : null,
    date_required: i.dateRequired,
    inks: { front: i.inks.front, back: i.inks.back },
    packaging: i.packaging,
    split: i.split.map((s) => ({ name: s.name, qty: s.qty })),
    artwork: { dropbox_url: i.dropboxFolderUrl },
    note: i.note,
    ...(i.blanksSource
      ? {
          blanks_source: {
            pv_order_id: i.blanksSource.orderId,
            stock_order_number: i.blanksSource.stockOrderNumber,
            reference: i.blanksSource.reference,
            batch_quantity: i.blanksSource.batchQuantity,
          },
        }
      : {}),
  }
}
