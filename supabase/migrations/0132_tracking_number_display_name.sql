-- ============================================================================
-- Migration 0132: A short display name for each tracking line, separate from
-- its legal call-recording disclosure text
-- ----------------------------------------------------------------------------
-- tracking_numbers.label is the sentence read/logged as the recording
-- consent disclosure ("Please be aware. This call is from Handy Andy TV
-- Mounting Denver."), never meant to be a UI label. Every place that showed
-- it (or the plain business name) as a line's name broke down the moment one
-- business had multiple lines -- every Handy Andy lead-gen city number
-- collapsed to the single business name "Handy Andy", with no way to tell
-- Denver from Golden from Greenway from Houston (owner, 2026-09-22, after
-- Jiyah's call audit dashboard showed 8 lines all labeled "Handy Andy").
--
-- display_name is what every screen should show instead: short, human,
-- already disambiguated. Backfilled below for the 28 lines that exist today;
-- a new line ported in later needs one set explicitly (falls back to the
-- business name in code until then, not to the disclosure sentence).
-- ============================================================================
set search_path = app, public, extensions;

alter table tracking_numbers add column if not exists display_name text;

-- Handy Andy's lead-gen lines: one business, many cities -- these are the ones
-- that were actually ambiguous.
update tracking_numbers set display_name = 'HA Austin'       where phone = '5126686643';
update tracking_numbers set display_name = 'HA Denver'       where phone = '7205418180';
update tracking_numbers set display_name = 'HA Denver 2'     where phone = '7207401120';
update tracking_numbers set display_name = 'HA Golden'       where phone = '7206373707';
update tracking_numbers set display_name = 'HA Greenway'     where phone = '2816388419';
update tracking_numbers set display_name = 'HA Houston'      where phone = '7138769032';
update tracking_numbers set display_name = 'HA Houston 2'    where phone = '2816265853';
update tracking_numbers set display_name = 'HA Los Angeles'  where phone = '2135793329';
update tracking_numbers set display_name = 'HA Los Angeles 2' where phone = '3235701778';
update tracking_numbers set display_name = 'HA Phoenix'      where phone = '4804854695';
update tracking_numbers set display_name = 'HA San Antonio'  where phone = '2106101714';
update tracking_numbers set display_name = 'HA Georgia'      where phone = '4704659899';

-- Every other business already has exactly one (or a same-named) line per
-- brand, so its own business name IS an unambiguous display name.
update tracking_numbers t set display_name = b.name
  from businesses b
  where b.slug = t.business_slug and t.display_name is null;
