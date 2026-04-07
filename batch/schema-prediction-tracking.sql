-- =============================================
-- PREDICTION SNAPSHOTS — time-series record of every score from every batch run
-- This is training data for the ML model AND validation data for accuracy claims
-- =============================================
CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id BIGSERIAL PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  market_key TEXT,
  
  -- The score at this point in time
  briefing_rank INTEGER NOT NULL,
  calibrated_rank INTEGER,
  cohort TEXT,  -- 'act_today' | 'outreach' | 'watch' | null
  lite_score NUMERIC,
  
  -- Metadata
  snapshot_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  batch_run_id TEXT,
  
  -- Owner data captured at snapshot time (for training)
  owner_name TEXT,
  owner_type TEXT,
  is_absentee BOOLEAN,
  is_out_of_state BOOLEAN,
  years_owned INTEGER
);

CREATE INDEX IF NOT EXISTS idx_snapshots_parcel ON prediction_snapshots(parcel_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_zip ON prediction_snapshots(zip_code, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_cohort ON prediction_snapshots(cohort, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON prediction_snapshots(snapshot_date DESC);

-- =============================================
-- PREDICTION VALIDATIONS — when a flagged parcel actually sells
-- One row per validated prediction. Joins snapshots to actual outcomes.
-- =============================================
CREATE TABLE IF NOT EXISTS prediction_validations (
  id BIGSERIAL PRIMARY KEY,
  parcel_id TEXT NOT NULL UNIQUE,
  zip_code TEXT NOT NULL,
  market_key TEXT,
  
  -- The actual sale
  sale_date DATE NOT NULL,
  sale_price NUMERIC,
  
  -- First time we flagged this parcel (earliest snapshot with cohort != null)
  first_flagged_date TIMESTAMPTZ,
  first_flagged_score INTEGER,
  first_flagged_cohort TEXT,
  days_from_first_flag INTEGER,
  
  -- Most recent score before the sale
  last_score_before_sale INTEGER,
  last_cohort_before_sale TEXT,
  last_score_date TIMESTAMPTZ,
  
  -- Was it ever in Act Today before the sale?
  ever_act_today BOOLEAN DEFAULT FALSE,
  ever_outreach BOOLEAN DEFAULT FALSE,
  
  -- How many snapshots did we capture for this parcel before sale
  snapshot_count INTEGER DEFAULT 0,
  
  validated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validations_zip ON prediction_validations(zip_code);
CREATE INDEX IF NOT EXISTS idx_validations_sale_date ON prediction_validations(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_validations_cohort ON prediction_validations(first_flagged_cohort);
CREATE INDEX IF NOT EXISTS idx_validations_act_today ON prediction_validations(ever_act_today) WHERE ever_act_today = TRUE;

-- =============================================
-- VIEW: Accuracy summary by cohort and time window
-- This is the marketing claim engine
-- =============================================
CREATE OR REPLACE VIEW prediction_accuracy_summary AS
SELECT
  market_key,
  zip_code,
  COUNT(*) AS total_validations,
  COUNT(*) FILTER (WHERE ever_act_today) AS act_today_hits,
  COUNT(*) FILTER (WHERE days_from_first_flag <= 30) AS hit_within_30d,
  COUNT(*) FILTER (WHERE days_from_first_flag <= 60) AS hit_within_60d,
  COUNT(*) FILTER (WHERE days_from_first_flag <= 90) AS hit_within_90d,
  COUNT(*) FILTER (WHERE days_from_first_flag <= 180) AS hit_within_180d,
  ROUND(AVG(days_from_first_flag)::numeric, 1) AS avg_days_to_sale,
  ROUND(AVG(first_flagged_score)::numeric, 1) AS avg_first_score,
  ROUND(AVG(sale_price)::numeric, 0) AS avg_sale_price
FROM prediction_validations
WHERE first_flagged_date IS NOT NULL
GROUP BY market_key, zip_code;
