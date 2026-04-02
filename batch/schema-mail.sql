-- SellerSignal Direct Mail System — Run in Supabase SQL Editor

-- Mail credits per agent
CREATE TABLE IF NOT EXISTS mail_credits (
  user_id TEXT PRIMARY KEY,           -- agent email or user ID
  credits_remaining INTEGER DEFAULT 0,
  credits_purchased INTEGER DEFAULT 0,
  credits_used INTEGER DEFAULT 0,
  last_purchase_at TIMESTAMP WITH TIME ZONE,
  stripe_customer_id TEXT
);

-- Enrolled sellers — tracks each seller's position in their mail sequence
CREATE TABLE IF NOT EXISTS mail_enrollments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  agent_id TEXT NOT NULL,             -- agent email or user ID
  
  -- Seller info (denormalized for quick access)
  owner_name TEXT,
  property_address TEXT,
  mailing_address TEXT,
  mailing_city TEXT,
  mailing_state TEXT,
  mailing_zip TEXT,
  cohort TEXT,                        -- trust, estate, investor, absentee, residential
  
  -- Sequence tracking
  current_position INTEGER DEFAULT 0, -- 0 = generated but not yet sent, 1 = letter 1 sent, etc.
  total_letters INTEGER DEFAULT 6,
  status TEXT DEFAULT 'active',       -- active, paused, completed, cancelled
  
  enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_sent_at TIMESTAMP WITH TIME ZONE,
  next_send_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(parcel_id, agent_id)
);

-- Pre-generated letters — all 6 stored at enrollment time
CREATE TABLE IF NOT EXISTS mail_letters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID REFERENCES mail_enrollments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,          -- 1-6
  
  -- Letter content
  subject TEXT,                       -- for tracking, not printed
  body_html TEXT NOT NULL,            -- full HTML for Lob
  body_text TEXT,                     -- plain text version
  
  -- Dynamic slots filled at send time
  dynamic_comp_address TEXT,          -- nearby comparable sale address
  dynamic_comp_price TEXT,            -- nearby comparable sale price
  
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(enrollment_id, position)
);

-- Send log — tracks each physical mailing
CREATE TABLE IF NOT EXISTS mail_sends (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID REFERENCES mail_enrollments(id) ON DELETE CASCADE,
  letter_id UUID REFERENCES mail_letters(id),
  position INTEGER NOT NULL,
  
  -- Lob tracking
  lob_letter_id TEXT,
  lob_url TEXT,                       -- tracking URL
  
  -- Status
  status TEXT DEFAULT 'created',      -- created, mailed, in_transit, delivered, returned, failed
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  delivered_at TIMESTAMP WITH TIME ZONE,
  
  -- Cost tracking
  cost_cents INTEGER                  -- actual Lob cost
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_enrollments_agent ON mail_enrollments(agent_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_zip ON mail_enrollments(zip_code);
CREATE INDEX IF NOT EXISTS idx_enrollments_status ON mail_enrollments(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_letters_enrollment ON mail_letters(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_sends_enrollment ON mail_sends(enrollment_id);

-- RLS
ALTER TABLE mail_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_sends ENABLE ROW LEVEL SECURITY;
