-- 0171: per-tech inventory exemption. technicians.skip_inventory = true means the
-- bracket/wire-plate inventory system ignores this tech entirely: no ledger moves,
-- no low-stock/bracket alerts, no Stock tab or bracket nags in the tech app, and
-- excluded from admin inventory screens. Default false = unchanged for everyone else.
-- tech_invites.skip_inventory is copied onto the technician row on join (api/tech.js joinComplete).
alter table app.technicians  add column if not exists skip_inventory boolean not null default false;
alter table app.tech_invites add column if not exists skip_inventory boolean not null default false;

-- Owner 2026-10-03: "ignore Megale and Dom inventory until I tell you different."
update app.technicians  set skip_inventory = true where id = '27760e4c-5038-413f-be32-d1d7c673cd75'; -- Dominic Urban (OKC)
update app.tech_invites set skip_inventory = true where id = '39d08d6f-20f8-4657-8a55-a775f7cbfc2c'; -- Megale F. invite (OKC)
