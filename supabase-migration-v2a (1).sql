-- ============================================================
-- SELLERSIGNAL V2A PERSISTENCE LAYER
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. PARCEL SNAPSHOTS — frozen-in-time state for future outcome labeling
CREATE TABLE IF NOT EXISTS parcel_snapshot (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    parcel_id TEXT NOT NULL,
    zip_code TEXT,
    source_key TEXT,  -- MT, WA_KING, AZ_MARICOPA, etc.
    snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    -- Owner
    owner_name_raw TEXT,
    owner_name_norm TEXT,
    owner_type TEXT,  -- individual, trust, estate, llc, corp, unknown
    
    -- Addresses
    situs_address TEXT,
    situs_city TEXT,
    situs_state TEXT,
    mailing_address TEXT,
    mailing_city TEXT,
    mailing_state TEXT,
    mailing_zip TEXT,
    
    -- Flags
    is_absentee BOOLEAN DEFAULT FALSE,
    is_out_of_state BOOLEAN DEFAULT FALSE,
    is_vacant_land BOOLEAN DEFAULT FALSE,
    has_building_value BOOLEAN DEFAULT FALSE,
    
    -- Values
    total_value NUMERIC,
    land_value NUMERIC,
    building_value NUMERIC,
    
    -- Property
    property_type TEXT,
    acres NUMERIC,
    year_built INTEGER,
    sqft INTEGER,
    subdivision TEXT,
    
    -- Tenure
    last_transfer_date DATE,
    last_transfer_year INTEGER,
    tenure_years INTEGER,
    sale_price NUMERIC,
    
    -- Scores (at time of snapshot)
    seller_likelihood INTEGER,
    off_market_receptivity INTEGER,
    actionability INTEGER,
    confidence INTEGER,
    briefing_rank INTEGER,
    tier TEXT,  -- act_today, deep_signal_first, outreach_queue, watch, skip
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate snapshots per parcel per day
    UNIQUE(parcel_id, snapshot_date)
);

CREATE INDEX idx_snapshot_parcel ON parcel_snapshot(parcel_id);
CREATE INDEX idx_snapshot_zip ON parcel_snapshot(zip_code);
CREATE INDEX idx_snapshot_date ON parcel_snapshot(snapshot_date);
CREATE INDEX idx_snapshot_tier ON parcel_snapshot(tier);
CREATE INDEX idx_snapshot_owner_type ON parcel_snapshot(owner_type);

-- 2. CLAIMS — typed evidence with provenance
CREATE TABLE IF NOT EXISTS claim (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    parcel_id TEXT NOT NULL,
    subject_id TEXT,  -- owner name or entity
    briefing_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    claim_type TEXT NOT NULL,
    claim_value JSONB,
    source TEXT NOT NULL,  -- parcel_feed, serpapi_life_event, listing_scan, snapshot_history, person_intelligence
    
    source_confidence NUMERIC,
    match_confidence NUMERIC,
    freshness_days INTEGER DEFAULT 0,
    
    accepted BOOLEAN DEFAULT FALSE,
    accepted_reason TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_claim_parcel ON claim(parcel_id);
CREATE INDEX idx_claim_type ON claim(claim_type);
CREATE INDEX idx_claim_date ON claim(briefing_date);
CREATE INDEX idx_claim_accepted ON claim(accepted);

-- 3. EVIDENCE BUNDLES — aggregated claim counts per prospect per briefing
CREATE TABLE IF NOT EXISTS evidence_bundle (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    parcel_id TEXT NOT NULL,
    subject_id TEXT,
    briefing_date DATE NOT NULL DEFAULT CURRENT_DATE,
    zip_code TEXT,
    
    -- Category counts
    time_count INTEGER DEFAULT 0,
    transition_count INTEGER DEFAULT 0,
    burden_count INTEGER DEFAULT 0,
    contact_count INTEGER DEFAULT 0,
    blocker_count INTEGER DEFAULT 0,
    market_count INTEGER DEFAULT 0,
    identity_count INTEGER DEFAULT 0,
    weak_count INTEGER DEFAULT 0,
    
    corroborating_count INTEGER DEFAULT 0,
    contradiction_count INTEGER DEFAULT 0,
    contradiction_penalty INTEGER DEFAULT 0,
    
    -- Gate result
    tier TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bundle_parcel ON evidence_bundle(parcel_id);
CREATE INDEX idx_bundle_date ON evidence_bundle(briefing_date);

-- 4. INTELLIGENCE RESULTS — final scored output per prospect per briefing
CREATE TABLE IF NOT EXISTS intelligence_result (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    parcel_id TEXT NOT NULL,
    subject_id TEXT,
    briefing_date DATE NOT NULL DEFAULT CURRENT_DATE,
    zip_code TEXT,
    agent_id UUID,  -- which agent's briefing produced this
    
    -- Scores
    seller_likelihood INTEGER,
    off_market_receptivity INTEGER,
    actionability INTEGER,
    confidence INTEGER,
    briefing_rank INTEGER,
    tier TEXT,
    score_class TEXT,
    
    -- Explanation
    top_reason TEXT,
    signals JSONB,  -- array of signal objects
    
    -- Search activity
    searches_executed INTEGER DEFAULT 0,
    claims_total INTEGER DEFAULT 0,
    claims_accepted INTEGER DEFAULT 0,
    claims_weak INTEGER DEFAULT 0,
    gaps JSONB,  -- array of gap strings
    search_plan JSONB,  -- planned searches
    
    -- Person intelligence
    person_profile JSONB,  -- age, retirement, employment, etc.
    life_events JSONB,  -- detected life events
    
    -- Deep Signal
    deep_signal_run BOOLEAN DEFAULT FALSE,
    deep_signal_data JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_intel_parcel ON intelligence_result(parcel_id);
CREATE INDEX idx_intel_date ON intelligence_result(briefing_date);
CREATE INDEX idx_intel_agent ON intelligence_result(agent_id);
CREATE INDEX idx_intel_tier ON intelligence_result(tier);
CREATE INDEX idx_intel_zip ON intelligence_result(zip_code);

-- 5. CONTACT OUTCOMES — what happened when agent reached out
CREATE TABLE IF NOT EXISTS contact_outcome (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    parcel_id TEXT NOT NULL,
    agent_id UUID NOT NULL,
    
    contact_date TIMESTAMPTZ DEFAULT NOW(),
    channel TEXT,  -- mail, call, door, email, text
    
    result TEXT,  -- no_response, response, appointment, listing, declined, wrong_person, bad_data
    notes TEXT,
    
    -- Follow-up tracking
    follow_up_date DATE,
    follow_up_done BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contact_parcel ON contact_outcome(parcel_id);
CREATE INDEX idx_contact_agent ON contact_outcome(agent_id);
CREATE INDEX idx_contact_result ON contact_outcome(result);

-- 6. TRANSFER OUTCOME LABELS — did this property actually sell? (filled in over time)
CREATE TABLE IF NOT EXISTS transfer_outcome_label (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    parcel_id TEXT NOT NULL,
    snapshot_date DATE NOT NULL,  -- when we first scored this property
    zip_code TEXT,
    
    -- Labels (filled in by periodic background checks)
    listed_within_6m BOOLEAN,
    listed_within_12m BOOLEAN,
    sold_within_6m BOOLEAN,
    sold_within_12m BOOLEAN,
    sold_within_24m BOOLEAN,
    
    -- When we checked
    last_checked TIMESTAMPTZ,
    check_source TEXT,  -- listing_scan, recorder_check, manual
    
    -- The scores at time of snapshot (for training)
    original_seller_likelihood INTEGER,
    original_tier TEXT,
    original_owner_type TEXT,
    original_tenure_years INTEGER,
    original_is_absentee BOOLEAN,
    original_is_out_of_state BOOLEAN,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(parcel_id, snapshot_date)
);

CREATE INDEX idx_transfer_parcel ON transfer_outcome_label(parcel_id);
CREATE INDEX idx_transfer_zip ON transfer_outcome_label(zip_code);
CREATE INDEX idx_transfer_date ON transfer_outcome_label(snapshot_date);

-- 7. AGENT BEHAVIOR — what agents do in the product
CREATE TABLE IF NOT EXISTS agent_behavior (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id UUID,
    session_id TEXT,
    
    event_type TEXT NOT NULL,  -- briefing_opened, lead_viewed, lead_expanded, deep_signal_clicked, 
                               -- marked_contacted, marked_not_fit, tracked, skipped, 
                               -- script_copied, letter_generated, map_opened, zip_searched
    
    parcel_id TEXT,
    zip_code TEXT,
    tier TEXT,  -- which tier the lead was in when interacted with
    briefing_rank INTEGER,  -- score at time of interaction
    
    metadata JSONB,  -- any additional context
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_behavior_agent ON agent_behavior(agent_id);
CREATE INDEX idx_behavior_event ON agent_behavior(event_type);
CREATE INDEX idx_behavior_parcel ON agent_behavior(parcel_id);
CREATE INDEX idx_behavior_date ON agent_behavior(created_at);

-- 8. ZIP CLAIMS — which zips are taken, available, waitlisted
CREATE TABLE IF NOT EXISTS zip_claim (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    zip_code TEXT NOT NULL,
    agent_id UUID NOT NULL,
    
    status TEXT DEFAULT 'active',  -- active, waitlisted, expired, cancelled
    claimed_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    
    -- Subscription
    stripe_subscription_id TEXT,
    plan_type TEXT,  -- monthly, semi_annual, annual
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(zip_code, agent_id)
);

CREATE INDEX idx_zip_claim_zip ON zip_claim(zip_code);
CREATE INDEX idx_zip_claim_agent ON zip_claim(agent_id);
CREATE INDEX idx_zip_claim_status ON zip_claim(status);

-- 9. BRIEFING RUNS — track every briefing execution for analytics
CREATE TABLE IF NOT EXISTS briefing_run (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id UUID,
    zip_code TEXT NOT NULL,
    
    run_date TIMESTAMPTZ DEFAULT NOW(),
    
    -- Counts
    parcels_loaded INTEGER,
    parcels_scored INTEGER,
    act_today_count INTEGER,
    outreach_count INTEGER,
    watch_count INTEGER,
    
    -- Search usage
    serpapi_searches INTEGER DEFAULT 0,
    anthropic_calls INTEGER DEFAULT 0,
    
    -- Timing
    duration_seconds NUMERIC,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_briefing_agent ON briefing_run(agent_id);
CREATE INDEX idx_briefing_zip ON briefing_run(zip_code);
CREATE INDEX idx_briefing_date ON briefing_run(run_date);

-- ============================================================
-- VIEWS for training data extraction
-- ============================================================

-- Feature rows for model training: snapshot + outcome
CREATE OR REPLACE VIEW training_features AS
SELECT 
    s.parcel_id,
    s.zip_code,
    s.snapshot_date,
    s.owner_type,
    s.is_absentee,
    s.is_out_of_state,
    s.is_vacant_land,
    s.has_building_value,
    s.total_value,
    s.tenure_years,
    s.property_type,
    s.seller_likelihood,
    s.tier,
    t.listed_within_6m,
    t.listed_within_12m,
    t.sold_within_6m,
    t.sold_within_12m,
    t.sold_within_24m
FROM parcel_snapshot s
LEFT JOIN transfer_outcome_label t 
    ON s.parcel_id = t.parcel_id 
    AND s.snapshot_date = t.snapshot_date
WHERE t.last_checked IS NOT NULL;

-- Agent conversion funnel
CREATE OR REPLACE VIEW agent_funnel AS
SELECT 
    b.agent_id,
    b.zip_code,
    COUNT(DISTINCT b.id) AS briefings_run,
    COUNT(DISTINCT CASE WHEN ab.event_type = 'lead_viewed' THEN ab.parcel_id END) AS leads_viewed,
    COUNT(DISTINCT CASE WHEN ab.event_type = 'deep_signal_clicked' THEN ab.parcel_id END) AS ds_unlocked,
    COUNT(DISTINCT CASE WHEN co.result IS NOT NULL THEN co.parcel_id END) AS leads_contacted,
    COUNT(DISTINCT CASE WHEN co.result = 'response' THEN co.parcel_id END) AS leads_responded,
    COUNT(DISTINCT CASE WHEN co.result = 'appointment' THEN co.parcel_id END) AS appointments,
    COUNT(DISTINCT CASE WHEN co.result = 'listing' THEN co.parcel_id END) AS listings_won
FROM briefing_run b
LEFT JOIN agent_behavior ab ON b.agent_id = ab.agent_id AND ab.zip_code = b.zip_code
LEFT JOIN contact_outcome co ON b.agent_id = co.agent_id
GROUP BY b.agent_id, b.zip_code;
