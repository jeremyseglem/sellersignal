CREATE TABLE IF NOT EXISTS beta_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT,
  zip_code TEXT,
  working TEXT,
  confusing TEXT,
  missing TEXT,
  rating INTEGER,
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_agent ON beta_feedback(agent_id);
ALTER TABLE beta_feedback ENABLE ROW LEVEL SECURITY;
