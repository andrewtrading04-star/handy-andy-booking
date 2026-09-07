-- One source of truth for per-business analytics wiring, replacing 5 hand-
-- maintained JS registries scattered across analytics.js, log-event.js and
-- admin.html (NATIVE_BUSINESS's analytics use, ANA_ORIGIN, WEB_ANA_ORIGIN,
-- GSC_DOMAIN_BY_SLUG, LAUNCH_CITY_OF). Investigated 2026-09-07 after "TV
-- Mounting Los Angeles" 400'd on its own analytics tab: LA's 3 businesses
-- were never added to any of the 5 lists, so their traffic was both
-- unqueryable AND (via log-event.js's fallback) silently miscounted into
-- Handy Andy's own numbers. A missing row here now means "not wired up yet,
-- shown honestly" instead of a 400 or silent data corruption.
--
--   funnel_backend   the `widget` tag this business's booking-funnel events
--                     are stored under in public.events. Usually the slug
--                     itself, but Dom's live widget tags 'doms-tv', not
--                     'doms' -- this column is exactly where that kind of
--                     mismatch belongs, instead of being undiscoverable.
--   traffic_backend   where page-view/session traffic for this business's
--                     OWN site lives: {"kind":"self"} for the two original
--                     LandingSite-era brands (same origin as this CRM),
--                     {"kind":"remote","origin":"https://..."} for a
--                     dedicated backend, {"kind":"shared","path":"<slug>"}
--                     for the shared sites-backend multi-tenant deployment,
--                     or null if nothing is wired yet.
--   gsc_domain        the verified Search Console property domain, or null.
--   city_pages        landing-page paths on this business's OWN site worth
--                      breaking out individually (Handy Andy's city pages
--                      today), or null for a business that's a single page.
alter table app.businesses add column if not exists analytics_config jsonb;

update app.businesses set analytics_config = case slug
  when 'handy-andy' then jsonb_build_object(
    'funnel_backend', 'handy-andy',
    'traffic_backend', jsonb_build_object('kind','self'),
    'gsc_domain', 'ihandyandy.com',
    'city_pages', jsonb_build_array(
      '/denvertvmounting', '/austin-tv-mounting', '/commercial-tv-mounting-austin',
      '/tvmounting-dallas', '/tvmounting-arlington', '/tvmounting-fortworth',
      '/frametvmounting-dallas', '/frametvmounting-arlington', '/frametvmounting-fortworth'
    )
  )
  when 'doms' then jsonb_build_object(
    'funnel_backend', 'doms-tv',
    'traffic_backend', jsonb_build_object('kind','remote','origin','https://doms-backend.vercel.app'),
    'gsc_domain', 'domstvmounting.com'
  )
  when 'mile-high' then jsonb_build_object('funnel_backend', 'mile-high')
  when 'precision' then jsonb_build_object('funnel_backend', 'precision')
  when 'tvmountingdenver' then jsonb_build_object(
    'funnel_backend', 'tvmountingdenver',
    'traffic_backend', jsonb_build_object('kind','shared','path','tvmountingdenver')
  )
  when 'austin' then jsonb_build_object(
    'funnel_backend', 'austin',
    'traffic_backend', jsonb_build_object('kind','shared','path','austin')
  )
  when 'houstonmounting' then jsonb_build_object(
    'funnel_backend', 'houstonmounting',
    'traffic_backend', jsonb_build_object('kind','shared','path','houstonmounting')
  )
  when 'houstontvinstallation' then jsonb_build_object(
    'funnel_backend', 'houstontvinstallation',
    'traffic_backend', jsonb_build_object('kind','shared','path','houstontvinstallation')
  )
  when 'tvhanginghouston' then jsonb_build_object(
    'funnel_backend', 'tvhanginghouston',
    'traffic_backend', jsonb_build_object('kind','shared','path','tvhanginghouston')
  )
  when 'htvmounting' then jsonb_build_object(
    'funnel_backend', 'htvmounting',
    'traffic_backend', jsonb_build_object('kind','shared','path','htvmounting')
  )
  when 'houstontvmountingpros' then jsonb_build_object(
    'funnel_backend', 'houstontvmountingpros',
    'traffic_backend', jsonb_build_object('kind','shared','path','houstontvmountingpros')
  )
  when 'atxmountpros' then jsonb_build_object(
    'funnel_backend', 'atxmountpros',
    'traffic_backend', jsonb_build_object('kind','shared','path','atxmountpros')
  )
  when 'atxtvmount' then jsonb_build_object(
    'funnel_backend', 'atxtvmount',
    'traffic_backend', jsonb_build_object('kind','shared','path','atxtvmount')
  )
  when 'austinmountingpros' then jsonb_build_object(
    'funnel_backend', 'austinmountingpros',
    'traffic_backend', jsonb_build_object('kind','shared','path','austinmountingpros')
  )
  when 'austintvinstall' then jsonb_build_object(
    'funnel_backend', 'austintvinstall',
    'traffic_backend', jsonb_build_object('kind','shared','path','austintvinstall')
  )
  -- The Los Angeles trio: real rows, real config, for the first time. No
  -- traffic backend exists for them yet -- that shows up honestly in the
  -- Overview as "no data", not a 400 and not someone else's numbers.
  when 'tvmountinglosangeles' then jsonb_build_object('funnel_backend', 'tvmountinglosangeles')
  when 'latvpro' then jsonb_build_object('funnel_backend', 'latvpro')
  when 'lainstall' then jsonb_build_object('funnel_backend', 'lainstall')
  else analytics_config
end
where slug in (
  'handy-andy','doms','mile-high','precision','tvmountingdenver','austin',
  'houstonmounting','houstontvinstallation','tvhanginghouston','htvmounting',
  'houstontvmountingpros','atxmountpros','atxtvmount','austinmountingpros',
  'austintvinstall','tvmountinglosangeles','latvpro','lainstall'
);
