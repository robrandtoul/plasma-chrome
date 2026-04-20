-- Migration 000058: housekeeping — drop the debug RPCs from 000049,
-- 000052, 000053, 000055. They were only introduced to diagnose why
-- material-icons uploads were being rejected by storage RLS (fixed in
-- 000054 + 000057).

begin;

drop function if exists debug_storage_objects_policies();
drop function if exists debug_storage_buckets_policies();
drop function if exists debug_storage_rls_status();
drop function if exists debug_buckets_config();

commit;
