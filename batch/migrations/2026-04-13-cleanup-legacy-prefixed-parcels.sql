-- 2026-04-13-cleanup-legacy-prefixed-parcels.sql
-- =====================================================================
-- Delete orphan rows in parcels table that were written by the pre-24818aa
-- inline batch runner (removed April 2, 2026). That runner used parseFloat()
-- directly on raw Maricopa FCV_CUR strings which have leading whitespace and
-- commas — parseFloat('   2,994,100') returns 2 because parseFloat stops at
-- the first non-digit character after whitespace. This wrote 7,907+ Paradise
-- Valley parcels with assessed_value of $2, $3, $5 etc. instead of real
-- million-dollar estate values.
--
-- Current code (batch/pipeline.js:parseNumericValue) correctly strips commas
-- before parseInt. But the old legacy rows have IDs like 'AZ_MARICOPA-17212053'
-- (prefixed with market_key + '-') while current code writes naked APN IDs
-- like '17212053'. The primary key mismatch means the orphans never get
-- overwritten — they just sit there polluting briefings with $2 cards.
--
-- This migration deletes only AZ_MARICOPA-prefixed parcels. Other markets
-- (MT, WA_KING) also have dual-format data but those still have valuable
-- investigation_cache entries keyed to prefixed IDs — those need a separate
-- re-key migration before their cleanup. AZ_MARICOPA has ZERO investigation_cache
-- entries so it's safe to delete outright.
--
-- Cascades: parcel_scores and deep_signals both have ON DELETE CASCADE on
-- their parcel_id FK, so stale scores and deep signals for these orphans
-- will be cleaned up automatically.
--
-- Verification query before and after:
--   SELECT COUNT(*), MIN(assessed_value), MAX(assessed_value)
--   FROM parcels WHERE zip_code = '85253';
--
-- Expected: total drops from ~19,511 to ~9,740; min bumps up from $1 to ~$9
-- (one legitimate country-club common-area parcel); max stays ~$100M.

BEGIN;

-- Safety check: make sure this is actually the broken data
-- and not current production data we'd nuke by accident
DO $$
DECLARE
  broken_count INT;
  total_prefixed INT;
BEGIN
  SELECT COUNT(*) INTO total_prefixed FROM parcels WHERE id LIKE 'AZ_MARICOPA-%';
  SELECT COUNT(*) INTO broken_count FROM parcels WHERE id LIKE 'AZ_MARICOPA-%' AND assessed_value < 100 AND assessed_value > 0;
  
  IF total_prefixed = 0 THEN
    RAISE EXCEPTION 'No AZ_MARICOPA- prefixed rows found — migration already ran or data layout changed. Aborting.';
  END IF;
  
  IF broken_count < total_prefixed * 0.3 THEN
    RAISE EXCEPTION 'Only % of % prefixed rows have broken values. Expected >30%% broken. Data may have been fixed or this migration is targeting the wrong rows. Aborting.', broken_count, total_prefixed;
  END IF;
  
  RAISE NOTICE 'Safety check passed: % prefixed rows, % broken (%.1f%%)', 
    total_prefixed, broken_count, 100.0 * broken_count / total_prefixed;
END $$;

-- Check for any investigation_cache entries we'd cascade-delete
DO $$
DECLARE
  inv_count INT;
BEGIN
  SELECT COUNT(*) INTO inv_count 
  FROM investigation_cache 
  WHERE parcel_id LIKE 'AZ_MARICOPA-%';
  
  IF inv_count > 0 THEN
    RAISE EXCEPTION 'Found % investigation_cache entries keyed to AZ_MARICOPA- prefixed IDs. These need to be migrated first. Aborting.', inv_count;
  END IF;
  
  RAISE NOTICE 'investigation_cache is clean for AZ_MARICOPA — safe to proceed';
END $$;

-- Do the delete. Cascade handles parcel_scores and deep_signals.
DELETE FROM parcels WHERE id LIKE 'AZ_MARICOPA-%';

-- Report final state
DO $$
DECLARE
  remaining INT;
  min_val NUMERIC;
  max_val NUMERIC;
  broken_remaining INT;
BEGIN
  SELECT COUNT(*), MIN(assessed_value), MAX(assessed_value)
    INTO remaining, min_val, max_val
    FROM parcels WHERE zip_code = '85253';
  
  SELECT COUNT(*) INTO broken_remaining
    FROM parcels WHERE zip_code = '85253' AND assessed_value < 100 AND assessed_value > 0;
  
  RAISE NOTICE '85253 after cleanup: % total parcels, min=$%, max=$%, broken=% (expected ~1, Paradise Valley Country Club common-area only)',
    remaining, min_val, max_val, broken_remaining;
END $$;

COMMIT;
