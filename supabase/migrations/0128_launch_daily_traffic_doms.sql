-- 0128: adds Dom's (web_events_doms) to 0127's function.
-- Launch tab traffic charts: one grouped query instead of pulling every
-- page_view row into Node per business (that was the slow part of the tab).
--
-- Two sources, because the brands report to two trackers:
--   web_events_sites  the microsite tracker (sites-backend), keyed by `site`
--   web_events        ihandyandy.com's own tracker, keyed here by URL path so
--                     each Handy Andy location page gets its own line
-- Returns one row per key per Central-time day: unique sessions + page views.
-- The bot pattern mirrors api/_lib/bot-filter.js (BOT_UA + INTERNAL_UA).
create or replace function public.launch_daily_traffic(p_days int default 30)
returns table (src text, key text, day date, sessions bigint, views bigint)
language sql stable security definer set search_path = public
as $$
  with bounds as (select now() - make_interval(days => p_days + 1) as since),
  bot as (select '(bot\M|bot/|robot|crawl|spider|slurp|ahrefs|semrush|majestic|dotbot|dataprovider|screaming ?frog|sitecheck|siteaudit|uptime|pingdom|gtmetrix|lighthouse|pagespeed|ptst/|headless|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|curl/|wget/|libwww|okhttp|java/|go-http|node-fetch|axios/|got/|scrapy|facebookexternalhit|externalhit|externalagent|webindexer|whatsapp|embedly|feedfetcher|apis-google|mediapartners|google-agent|google-inspectiontool|googleother|google-read-aloud|yandex|sogou|Claude/|ClaudeSEO|Electron/|vercel-screenshot|vercel-favicon)'::text as re)
  select 'site'::text, s.site, (s.created_at at time zone 'America/Chicago')::date,
         count(distinct s.session_id), count(*)
    from public.web_events_sites s, bounds, bot
   where s.event_type = 'page_view' and s.created_at >= bounds.since
     and coalesce(s.user_agent, '') !~* bot.re
     and coalesce(s.page_url, '') !~* '^https?://(localhost|127\.0\.0\.1)'
   group by 2, 3
  union all
  -- Dom's reports to its own table (web_events_doms); one key for the whole site.
  select 'site'::text, 'doms'::text, (d.created_at at time zone 'America/Chicago')::date,
         count(distinct d.session_id), count(*)
    from public.web_events_doms d, bounds, bot
   where d.event_type = 'page_view' and d.created_at >= bounds.since
     and coalesce(d.user_agent, '') !~* bot.re
     and coalesce(d.page_url, '') !~* '^https?://(localhost|127\.0\.0\.1)'
   group by 3
  union all
  select 'path'::text,
         coalesce(nullif(regexp_replace(regexp_replace(e.page_url, '^https?://[^/]+', ''), '[?#].*$|/+$', '', 'g'), ''), '/'),
         (e.created_at at time zone 'America/Chicago')::date,
         count(distinct e.session_id), count(*)
    from public.web_events e, bounds, bot
   where e.event_type = 'page_view' and e.created_at >= bounds.since
     and e.page_url ~* '^https?://(www\.)?ihandyandy\.com'
     and coalesce(e.user_agent, '') !~* bot.re
   group by 2, 3;
$$;

revoke all on function public.launch_daily_traffic(int) from public, anon, authenticated;
grant execute on function public.launch_daily_traffic(int) to service_role;
