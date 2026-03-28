-- Create youtube_accounts table for multi-channel support
CREATE TABLE IF NOT EXISTS youtube_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id TEXT,
  channel_name TEXT,
  channel_thumb TEXT,
  access_token TEXT,
  refresh_token TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, channel_id)
);

-- Enable RLS
ALTER TABLE youtube_accounts ENABLE ROW LEVEL SECURITY;

-- Users can read/delete their own accounts
CREATE POLICY "Users can view own youtube accounts" ON youtube_accounts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own youtube accounts" ON youtube_accounts
  FOR DELETE USING (auth.uid() = user_id);

-- Service role can do everything (for OAuth callback)
CREATE POLICY "Service role full access" ON youtube_accounts
  FOR ALL USING (true) WITH CHECK (true);
