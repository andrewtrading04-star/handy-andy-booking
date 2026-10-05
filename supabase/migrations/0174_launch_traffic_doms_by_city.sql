-- 0174: Dom's is 3 independent locations (owner 2026-10-05). Its site traffic
-- used to come back as ONE key ('doms'), so the Denver card counted OKC and Tulsa
-- visits and the OKC/Tulsa cards showed nothing. Split web_events_doms by page:
--   any path containing 'oklahoma-city' -> 'doms-okc'
--   any path containing 'tulsa'         -> 'doms-tulsa'
--   everything else (home page, Denver pages) -> 'doms'
-- Same filters as 0130 otherwise (bots, US time zones, no localhost, no blog).
create or replace function public.launch_daily_traffic(p_days int default 30)
returns table (src text, key text, day date, sessions bigint, views bigint)
language sql stable security definer set search_path = public
as $$
  with bounds as (select now() - make_interval(days => p_days + 1) as since),
  bot as (select '(bot\M|bot/|robot|crawl|spider|slurp|ahrefs|semrush|majestic|dotbot|dataprovider|screaming ?frog|sitecheck|siteaudit|uptime|pingdom|gtmetrix|lighthouse|pagespeed|ptst/|headless|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|curl/|wget/|libwww|okhttp|java/|go-http|node-fetch|axios/|got/|scrapy|facebookexternalhit|externalhit|externalagent|webindexer|whatsapp|embedly|feedfetcher|apis-google|mediapartners|google-agent|google-inspectiontool|googleother|google-read-aloud|yandex|sogou|Claude/|ClaudeSEO|Electron/|vercel-screenshot|vercel-favicon)'::text as re),
  us as (select '^(America/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Yakutat|Metlakatla|Menominee|Adak|Indianapolis|Louisville|Indiana/.*|Kentucky/.*|North_Dakota/.*)|Pacific/Honolulu)$'::text as re),
  doms as (
    select d.session_id, d.created_at,
           regexp_replace(regexp_replace(d.page_url, '^https?://[^/]+', ''), '[?#].*$|/+$', '', 'g') as path
      from public.web_events_doms d, bounds, bot, us
     where d.event_type = 'page_view' and d.created_at >= bounds.since
       and coalesce(d.user_agent, '') !~* bot.re
       and coalesce(d.metadata->>'timezone', '') ~ us.re
       and coalesce(d.page_url, '') !~* '^https?://(localhost|127\.0\.0\.1)'
  )
  select 'site'::text, s.site, (s.created_at at time zone 'America/Chicago')::date,
         count(distinct s.session_id), count(*)
    from public.web_events_sites s, bounds, bot, us
   where s.event_type = 'page_view' and s.created_at >= bounds.since
     and coalesce(s.user_agent, '') !~* bot.re
     and coalesce(s.metadata->>'timezone', '') ~ us.re
     and coalesce(s.page_url, '') !~* '^https?://(localhost|127\.0\.0\.1)'
   group by 2, 3
  union all
  select 'site'::text,
         case when doms.path ~* 'oklahoma-city' then 'doms-okc'
              when doms.path ~* 'tulsa' then 'doms-tulsa'
              else 'doms' end,
         (doms.created_at at time zone 'America/Chicago')::date,
         count(distinct doms.session_id), count(*)
    from doms
   where not public.launch_is_blog_path(doms.path)
   group by 2, 3
  union all
  select 'path'::text,
         coalesce(nullif(regexp_replace(regexp_replace(e.page_url, '^https?://[^/]+', ''), '[?#].*$|/+$', '', 'g'), ''), '/'),
         (e.created_at at time zone 'America/Chicago')::date,
         count(distinct e.session_id), count(*)
    from public.web_events e, bounds, bot, us
   where e.event_type = 'page_view' and e.created_at >= bounds.since
     and e.page_url ~* '^https?://(www\.)?ihandyandy\.com'
     and coalesce(e.user_agent, '') !~* bot.re
     and coalesce(e.metadata->>'timezone', '') ~ us.re
     and not public.launch_is_blog_path(regexp_replace(regexp_replace(e.page_url, '^https?://[^/]+', ''), '[?#].*$|/+$', '', 'g'))
   group by 2, 3;
$$;
revoke all on function public.launch_daily_traffic(int) from public, anon, authenticated;
grant execute on function public.launch_daily_traffic(int) to service_role;
