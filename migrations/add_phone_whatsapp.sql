-- Add phone number and WhatsApp notification preference to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS whatsapp_notifications BOOLEAN DEFAULT true;
