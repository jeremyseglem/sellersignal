-- SellerSignal Supabase Setup
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Create profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  plan TEXT DEFAULT 'free',
  signals_used INTEGER DEFAULT 0,
  signals_limit INTEGER DEFAULT 3,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create signals cache table (stores research results)
CREATE TABLE IF NOT EXISTS signals_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name TEXT NOT NULL,
  property_address TEXT NOT NULL,
  cache_key TEXT UNIQUE NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days')
);

-- 3. Create signals history table (tracks who searched what)
CREATE TABLE IF NOT EXISTS signals_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  owner_name TEXT NOT NULL,
  property_address TEXT NOT NULL,
  score INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals_history ENABLE ROW LEVEL SECURITY;

-- 5. Profiles policies - users can only see/edit their own
CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- 6. Signals cache policies - anyone can read (it's just cached data)
CREATE POLICY "Anyone can read cache" ON signals_cache
  FOR SELECT USING (true);

-- 7. Signals history policies - users see only their own
CREATE POLICY "Users can read own history" ON signals_history
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own history" ON signals_history
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 8. Create function to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, plan, signals_used, signals_limit)
  VALUES (NEW.id, NEW.email, 'free', 0, 3);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Create trigger for auto-profile creation
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 10. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_stripe ON profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_cache_key ON signals_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON signals_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_history_user ON signals_history(user_id);

-- 11. Function to clean expired cache (run periodically)
CREATE OR REPLACE FUNCTION clean_expired_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM signals_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Done! Your database is ready.
