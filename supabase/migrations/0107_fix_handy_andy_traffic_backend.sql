-- Corrects a data error from migration 0106: Handy Andy's website-traffic
-- events do NOT live same-origin with this CRM ("self") -- like Dom's, they
-- live on a separate dedicated Vercel deployment (both are LandingSite-era
-- brands that predate the shared sites-backend stack; see the removed
-- WEB_ANA_ORIGIN map's own comment in public/admin.html for the same fact).
-- Caught by re-reading loadWebAnalytics() before wiring the frontend to this
-- column, rather than after shipping a broken Website tab for Handy Andy.
update app.businesses
set analytics_config = jsonb_set(
  analytics_config, '{traffic_backend}',
  jsonb_build_object('kind', 'remote', 'origin', 'https://backend-beryl-seven-95.vercel.app')
)
where slug = 'handy-andy';
