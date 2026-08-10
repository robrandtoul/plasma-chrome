-- 000406: stop 41 register rows telling a customer the wrong thing about their
-- own last order.
--
-- THE DEFECT. The register was seeded from Xero, and the phrase in `last_spec`
-- was only taken from invoices with EXACTLY ONE product line — a sound rule, so
-- that "250 stainless steel cards (500 micron)" is never a lie by omission
-- about a mixed order. But the seeding job applied that filter FIRST and then
-- took the latest of the SURVIVORS, while `last_order_on` came from the latest
-- invoice regardless. So for a customer whose most recent invoice happened to
-- carry two or more products, the register paired an OLD purchase with a NEW
-- date.
--
-- src/lib/reengagement.ts recognitionLine() renders exactly that pair as one
-- sentence: "You last ordered {last_spec} in {month of last_order_on}." Which
-- makes it a confident, specific, false claim about their own history — spoken
-- to somebody we approached out of the blue, where being demonstrably their
-- real supplier is the only asset the whole feature rests on.
--
-- Worked example, verified against Xero on 2026-08-10:
--   Gestion AHD inc. — register said "100 matte black metal cards (800 micron)"
--   dated 2026-07-19. Xero: INV-24639 (2025-03-05) was 100 matte black metal
--   800 micron; INV-26635 (2026-07-19) was 500 foiled paper cards AND 50 matte
--   black metal. So the quantity was wrong (100 vs 50), the paper was missing
--   entirely, and the date belonged to a different order.
--
-- SCOPE. All 41 rows where the chosen invoice is older than the latest one,
-- identified by replaying the seeding rule against the original Xero pull. 29
-- had other products on the newer invoice (the misleading case above); 12 had a
-- newer invoice with no countable product line, where the date is still not the
-- date of the thing we are naming. Both are nulled — we either know what they
-- last bought or we do not.
--
-- THE FIX is to say less. Nulling the four derived columns drops the page back
-- to the date-only sentence ("You last ordered from us in July 2026"), which is
-- true, and removes the price-grid badge that would otherwise point at the
-- wrong column on 15 of them. Same stance as 000394, and as the commit that
-- introduced this rule: only tell a returning customer what we can stand
-- behind.
--
-- ⚠ Ids are hardcoded because the defect is invisible from inside the database
-- — detecting it needs the source invoice line counts, which were never stored.
-- The replay that produced this list is described in
-- docs/reorder-register-rescrape-spec.md; a fresh replay of these migrations
-- against an unseeded register simply matches nothing, which is correct.
--
-- Verified read-only before applying (live, 2026-08-10):
--   * all 41 xero_contact_ids match a register row; 39 still carry a phrase
--     (000394 had already nulled 2 on other grounds)
--   * 15 carry a last_variant_id, i.e. would badge a price column
--   * 30 are still servable (state pending/queued) — 7 of them scoring >= 70,
--     so they were due to be approached SOONER than average
--   * 0 have been contacted, and 0 proofs were ever built from one of these
--     rows, so nothing downstream carries a bad reengagement_context snapshot
--
-- DURABILITY. proofs.reconcile_reorder_register() only overwrites these columns
-- `when f.quantity >= 25 and f.material is not null` — i.e. when a NEW payment
-- lands through the app — and otherwise carries the existing value forward. So
-- the null persists, and the first genuine in-app order re-fills it from our own
-- order row rather than from a guess. The null heals itself with good data.

update proofs.reorder_prospects
   set last_spec         = null,
       last_qty          = null,
       last_variant_id   = null,
       last_variant_label = null,
       last_material_id  = null
 where xero_contact_id in (
   '74cd348a-5c04-43f0-bf38-5099b6c3336d','24eac3b6-b2ec-497d-a8cc-b3aeb476c8ad',
   '31bb067b-e8fd-40a4-8c4e-a917b184e216','71be9dbc-ff54-45e1-9eae-eebc148e5d68',
   '98dfbc65-eeec-4b8e-b417-c662cd8b000f','fdc59ee0-e1cf-44e9-bf8f-6871c4edec95',
   '4faa2e9c-ffef-4467-a492-47a29783c93a','25c9901c-8641-4023-af4a-6603dd2e2721',
   '09b184e7-e531-4869-b039-df5f5619fde8','e44b5bda-fdaf-4e83-a3b9-0a7a31cdcdff',
   '16728d67-0051-410e-95ce-1527f4f49f19','013ffce5-5946-4bd2-8e22-b983d6ef36b3',
   '641b31b3-7652-44c3-a1d1-4f65b0d214dc','f2e2b834-a811-49a9-8c8d-eb457526157b',
   'c22797c3-9125-4425-9f19-7c2c6a551579','b4f9a24e-098e-4f5b-b8ce-845a34652836',
   '7a4d042f-8dea-4d16-ab11-67cd62c517a6','f35efb4d-fc9b-4176-8287-8d089302943d',
   '2765cd18-563f-4c0f-a9ad-47cdfdbf62e2','7678d273-ee0b-4531-be78-2f33210db0ae',
   '669edafc-b739-470f-856b-479708db7cd1','1ebe60a9-fc08-4b7e-be2b-cc2f67252a30',
   '067caa3d-92c4-43a9-85ef-c1adb83b12b8','aeaf14fa-1453-47da-a64c-b4e92df81283',
   '0d856286-e88e-4413-be2e-a3bc6e1401e7','3b35c08b-b9f2-4fba-8378-74a263ac185f',
   '36784e97-38b5-45ac-abdc-5223e26fcca4','056a47c5-8bb8-4d7a-adcc-65cb75e898e6',
   '97f3f76e-f3c1-4300-8afd-2187e4bdbd60','7b8b7e80-ff76-4b15-9d78-1f39429c336a',
   '66ced85b-a6d5-410f-80eb-8d419357d2eb','0c3ad813-fe35-4d4c-afba-5b0691997e91',
   '70172cdf-a745-40ba-9ff8-5b727ba7f230','e4453234-eb76-4795-a3de-6d03e5923271',
   '66d87f16-c8aa-4b3b-9d0a-851d559f1b85','875b4ad5-672e-4403-a934-3439f68ebf17',
   '2b79b014-db3b-46af-8bb1-8f2c6bc67da4','51e7a727-a4c5-4dab-9501-4d0cfd059046',
   '8cba43ce-2dbb-4a9f-8f3a-f59132c6dbe5','5e00393a-0d05-4230-a3d4-9ab32f1d24f0',
   '79152fe3-bda8-47c1-9799-1381344e1ef3'
 );
