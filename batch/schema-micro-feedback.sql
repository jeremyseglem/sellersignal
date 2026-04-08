-- Micro-feedback table for in-app behavioral signals during beta
-- Separate from beta_feedback (long-form survey) so we can query each cleanly

CREATE TABLE IF NOT EXISTS beta_micro_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT,                    -- user_id from Supabase auth, or session id if not logged in
  agent_email TEXT,                 -- explicit email if logged in
  zip_code TEXT,                    -- current briefing ZIP when prompt was shown
  prompt_type TEXT NOT NULL,        -- 'deep_signal_quality' | 'six_letters_sendable' | 'act_today_value' | 'would_contact' | 'skip_reason' | 'generic_nps'
  response TEXT NOT NULL,           -- the selected answer text
  response_value INTEGER,           -- numeric weight if applicable (e.g. 1=positive, 0=neutral, -1=negative)
  prospect_id TEXT,                 -- the parcel id this was about (if applicable)
  prospect_score INTEGER,           -- briefing_rank at time of feedback
  context JSONB,                    -- additional context (cohort, tier, etc)
  session_id TEXT,                  -- browser session id for grouping
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_micro_feedback_agent ON beta_micro_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_micro_feedback_email ON beta_micro_feedback(agent_email);
CREATE INDEX IF NOT EXISTS idx_micro_feedback_prompt ON beta_micro_feedback(prompt_type);
CREATE INDEX IF NOT EXISTS idx_micro_feedback_created ON beta_micro_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_micro_feedback_zip ON beta_micro_feedback(zip_code);

ALTER TABLE beta_micro_feedback ENABLE ROW LEVEL SECURITY;

-- Analytics view: response breakdown by prompt type over last 30 days
CREATE OR REPLACE VIEW beta_micro_feedback_summary AS
SELECT 
  prompt_type,
  response,
  COUNT(*) as count,
  COUNT(DISTINCT agent_id) as unique_agents,
  AVG(response_value) as avg_value,
  MAX(created_at) as last_response
FROM beta_micro_feedback
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY prompt_type, response
ORDER BY prompt_type, count DESC;
