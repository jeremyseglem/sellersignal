-- Agent profiles — return address + branding for mail campaigns
CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id TEXT PRIMARY KEY,
  agent_name TEXT,
  brokerage TEXT,
  phone TEXT,
  email TEXT,
  return_address TEXT,
  return_city TEXT,
  return_state TEXT,
  return_zip TEXT,
  license_number TEXT,
  logo_url TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY;
