-- ============================================================================
-- Migration 0013: Add review_token to bookings table
-- ============================================================================
-- Adds review_token column to store signed token for accessing /review.html
-- Token is generated at booking time and valid for 30 days.
-- Run after 0012. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_token text;
CREATE INDEX IF NOT EXISTS idx_bookings_review_token ON bookings(review_token) WHERE review_token IS NOT NULL;
