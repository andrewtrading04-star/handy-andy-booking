-- 0129: USA-only traffic (owner rule 2026-09-22). The owner works from Bangkok and
-- scrapers run from everywhere; a session counts only when the browser reports a
-- US timezone. That also drops UTC, which is headless/datacenter traffic, never a
-- real US visitor.
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
     and coalesce(s.metadata->>'timezone', '') ~ '^(America/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Yakutat|Metlakatla|Menominee|Adak|Indianapolis|Louisville|Indiana/.*|Kentucky/.*|North_Dakota/.*)|Pacific/Honolulu)$'
     and coalesce(s.page_url, '') !~* '^https?://(localhost|127\.0\.0\.1)'
   group by 2, 3
  union all
  -- Dom's reports to its own table (web_events_doms); one key for the whole site.
  select 'site'::text, 'doms'::text, (d.created_at at time zone 'America/Chicago')::date,
         count(distinct d.session_id), count(*)
    from public.web_events_doms d, bounds, bot
   where d.event_type = 'page_view' and d.created_at >= bounds.since
     and coalesce(d.user_agent, '') !~* bot.re
     and coalesce(d.metadata->>'timezone', '') ~ '^(America/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Yakutat|Metlakatla|Menominee|Adak|Indianapolis|Louisville|Indiana/.*|Kentucky/.*|North_Dakota/.*)|Pacific/Honolulu)$'
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
     and coalesce(e.metadata->>'timezone', '') ~ '^(America/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Yakutat|Metlakatla|Menominee|Adak|Indianapolis|Louisville|Indiana/.*|Kentucky/.*|North_Dakota/.*)|Pacific/Honolulu)$'
   group by 2, 3;
$$;

revoke all on function public.launch_daily_traffic(int) from public, anon, authenticated;
grant execute on function public.launch_daily_traffic(int) to service_role;
