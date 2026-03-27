-- Add YouTube OAuth columns to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS youtube_access_token TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS youtube_refresh_token TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS youtube_channel_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS youtube_channel_thumb TEXT;
