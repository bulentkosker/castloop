-- Add restart_at column to streams table
ALTER TABLE streams ADD COLUMN IF NOT EXISTS restart_at TIMESTAMPTZ;
