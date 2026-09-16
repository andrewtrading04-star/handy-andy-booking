import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInventoryTestDb,ids} from './lib/inventory-test-db.mjs';

const files=['0112_inventory_reliability.sql','0113_bracket_shipping_addresses.sql','0114_inventory_controls.sql','0115_inventory_address_controls.sql'];
const parts=await Promise.all(files.map(async name=>({name,sql:await fs.readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')})));
const sql='-- Tested inventory repair migration bundle. Apply only to the CRM database.\n-- Preserves all current stock counts; review historical facts before reconciliation.\nBEGIN;\n'+parts.map(p=>'\n-- '+p.name+'\n'+p.sql.replace(/^\s*(?:begin|commit);\s*$/gmi,'')).join('\n')+'\nCOMMIT;\n';
const pg=await createInventoryTestDb({migrations:false});
try {
 await pg.query(`select app.bracket_move($1,$2,'adjust',4,3,2,'release-fixture',null,null,null,'Release preservation fixture','test')`,[ids.business,ids.a]);
 await pg.query(`insert into app.bookings(id,business_id,technician_id,status,completed_at) values($1,$2,$3,'completed',clock_timestamp()-interval '1 day')`,[ids.job,ids.business,ids.a]);
 const before=(await pg.query('select technician_id,flat_qty,tilting_qty,full_motion_qty from app.bracket_inventory order by technician_id')).rows;
 await pg.exec(sql);
 assert.deepEqual((await pg.query('select technician_id,flat_qty,tilting_qty,full_motion_qty from app.bracket_inventory order by technician_id')).rows,before,'migration preserves stock');
 const first=(await pg.query("select value::text from app.inventory_settings where key='cutover'")).rows[0].value;
 await pg.exec(sql);
 assert.deepEqual((await pg.query('select technician_id,flat_qty,tilting_qty,full_motion_qty from app.bracket_inventory order by technician_id')).rows,before,'reapplying preserves stock');
 assert.equal((await pg.query("select value::text from app.inventory_settings where key='cutover'")).rows[0].value,first,'reapplying preserves cutover');
 assert.equal((await pg.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname='inventory_job_write'")).rows[0].n,1,'no ambiguous job RPC overload');
}finally{await pg.close();}
const output=new URL('../../../outputs/',import.meta.url);await fs.mkdir(output,{recursive:true});
await fs.writeFile(new URL('inventory-repair-migrations.sql',output),sql);
const manifest=parts.map(p=>({file:p.name,sha256:createHash('sha256').update(p.sql).digest('hex')}));
await fs.writeFile(new URL('inventory-repair-migration-check.json',output),JSON.stringify({checked_at:new Date().toISOString(),bundle_sha256:createHash('sha256').update(sql).digest('hex'),checks:['all four migrations apply together','existing quantities preserved','safe reapplication','cutover preserved','single job RPC signature'],files:manifest},null,2)+'\n');
console.log('Release SQL validated: first application and repeat preserve existing quantities and cutover. Bundle written to outputs.');
