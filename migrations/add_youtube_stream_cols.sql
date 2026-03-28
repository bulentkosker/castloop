-- Add YouTube broadcast tracking and account link to streams table
ALTER TABLE streams ADD COLUMN IF NOT EXISTS youtube_account_id UUID;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS youtube_broadcast_id TEXT;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS youtube_stream_id TEXT;
