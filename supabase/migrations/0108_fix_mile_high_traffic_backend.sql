-- Mile High's website IS live and actively reporting to the shared
-- sites-backend (public.web_events_sites has 900+ real events, most recent
-- minutes old at the time of writing) -- it was simply never given a
-- traffic_backend in migration 0106, so the Website tab showed "not
-- configured" for a business that actually had real data waiting.
--
-- Confirmed directly against the live endpoint before writing this: the
-- site's real key is 'milehightvmounting' (site column in web_events_sites),
-- NOT the CRM's business slug 'mile-high' -- same class of mismatch as
-- Dom's funnel_backend ('doms-tv' vs slug 'doms'). Guessing the slug as the
-- path would have silently kept this broken.
--   /s/milehightvmounting -> {"total":40,...}      (real data)
--   /s/mile-high           -> {"error":"Unknown site"}
--
-- Checked precision and houstontvmountingpros for the same mismatch while
-- here -- neither has ANY key in web_events_sites under any guessed name, so
-- those two genuinely have no tracking installed yet. That's a change to
-- those sites' own code, not a config fix, and is out of scope here.
update app.businesses
set analytics_config = jsonb_set(
  analytics_config, '{traffic_backend}',
  jsonb_build_object('kind', 'shared', 'path', 'milehightvmounting')
)
where slug = 'mile-high';
