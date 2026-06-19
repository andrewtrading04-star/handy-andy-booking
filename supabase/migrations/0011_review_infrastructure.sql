-- ============================================================================
-- Migration 0011: Review infrastructure (feedback email + location URLs)
-- ----------------------------------------------------------------------------
-- Adds feedback_email to businesses table (where to send ≤4★ feedback)
-- Adds review_url to service_areas table (where to redirect 5★ reviews)
-- Run after 0010. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

-- Add feedback email for each business (where to send customer feedback)
alter table businesses add column if not exists feedback_email text;

-- Add review_url to service_areas (location-specific Google review page)
alter table service_areas add column if not exists review_url text;

-- Initialize feedback emails for existing businesses
-- Handy Andy -> contact@ihandyandy.com
-- Doms TV Mounting -> domstvmounting@gmail.com
update businesses set feedback_email = 'contact@ihandyandy.com'
  where slug = 'handy-andy' and feedback_email is null;

update businesses set feedback_email = 'domstvmounting@gmail.com'
  where slug = 'doms' and feedback_email is null;
