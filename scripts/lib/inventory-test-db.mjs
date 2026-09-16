import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
export const ids = { business:'00000000-0000-4000-8000-000000000001', otherBusiness:'00000000-0000-4000-8000-000000000002',
  a:'00000000-0000-4000-8000-000000000011',b:'00000000-0000-4000-8000-000000000012',c:'00000000-0000-4000-8000-000000000013',job:'00000000-0000-4000-8000-000000000021' };
export async function createInventoryTestDb({ migrations = true } = {}) {
 const db=new PGlite();await db.waitReady;
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema app;grant usage on schema app to anon,authenticated,service_role;
 set search_path=app,public;alter default privileges in schema app grant all on tables to service_role;
 create type booking_status as enum('pending','confirmed','assigned','on_the_way','arrived','in_progress','completed','cancelled','no_show');
 create type line_item_kind as enum('service','option','addon','coupon','tip','fee','custom');
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=clock_timestamp();return new;end$$;
 create table businesses(id uuid primary key,slug text,name text);
 create table technicians(id uuid primary key,business_id uuid references businesses(id),name text);
 create table bookings(id uuid primary key,business_id uuid references businesses(id),technician_id uuid references technicians(id),secondary_technician_id uuid references technicians(id),
 bracket_supplied_by uuid references technicians(id),bracket_supplied_at timestamptz,status booking_status default 'assigned',metadata jsonb default '{}',
 scheduled_at timestamptz,scheduled_end timestamptz,confirmed_at timestamptz,assigned_at timestamptz,on_the_way_at timestamptz,arrived_at timestamptz,completed_at timestamptz,cancelled_at timestamptz,
 cancellation_reason text,extra_slots text[] not null default '{}',sms_consent boolean,price numeric default 0,subtotal numeric default 0,
 address_line1 text,address_line2 text,city text,state text,postal_code text,notes text,customer_notes text,updated_at timestamptz default clock_timestamp());
 create trigger booking_updated before update on bookings for each row execute function set_updated_at();
 create table booking_line_items(id uuid primary key default gen_random_uuid(),booking_id uuid references bookings(id),business_id uuid references businesses(id),
 kind line_item_kind default 'service',name text not null,quantity numeric not null default 1,unit_price numeric default 0,line_total numeric default 0,taxable boolean default true,sort_order int default 0);
 create table booking_status_events(id uuid default gen_random_uuid(),booking_id uuid,business_id uuid,technician_id uuid,status booking_status,note text);
 insert into businesses values('${ids.business}','handy-andy','Handy Andy'),('${ids.otherBusiness}','doms','Doms');
 insert into technicians values('${ids.a}','${ids.business}','A'),('${ids.b}','${ids.otherBusiness}','B'),('${ids.c}','${ids.business}','C');`);
 for(const name of ['0029_bracket_inventory.sql','0030_bracket_pending_deliveries.sql','0056_bracket_order_total.sql','0057_bracket_estimated_delivery.sql','0088_bracket_moves_ledger.sql']) {
   let sql=await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
   // The old migration ships an unrelated hard-coded seed. Test fixture contains
   // only schema and deliberately created test data; no production order IDs.
   if(name==='0030_bracket_pending_deliveries.sql') sql=sql.slice(0,sql.indexOf('-- ── One-time test seed'));
   await db.exec(sql);
 }
 await db.exec(`alter table app.bracket_inventory add column wire_plate_qty int default 0;alter table app.bracket_inventory add column appletv_bracket_qty int default 0;grant all on all tables in schema app to service_role;`);
 if(migrations) await applyInventoryMigration(db);
 return db;
}
export async function applyInventoryMigration(db) {await db.exec(await readFile(new URL('../../supabase/migrations/0112_inventory_reliability.sql',import.meta.url),'utf8'));}
export function supabaseFor(db) {return {async rpc(name,args){try {const keys=Object.keys(args);const q=await db.query(`select app.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as result`,Object.values(args));return {data:q.rows[0].result,error:null};}catch(error){return {data:null,error};}}};}
