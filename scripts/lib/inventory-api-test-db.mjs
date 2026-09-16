// Minimal PostgREST adapter backed by real local PostgreSQL. Production API
// helpers run unchanged; this adapter supplies only their ordinary DB methods.
import { supabaseFor } from './inventory-test-db.mjs';
export function apiDb(pg) {
 const numeric=new Set(['price','subtotal','quantity','unit_price','line_total','order_total']);
 const jsonRow=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,numeric.has(k)&&v!=null?Number(v):v]));
 const ident=s=>{if(!/^[a-z_][a-z0-9_]*$/i.test(s))throw Error('Unsafe test identifier');return '"'+s+'"';};
 return {...supabaseFor(pg),from(table) {
  let filters=[],args=[],ordering=[],range=null,cols='*',single=false,mode='select',values;
  const query={
   select(c='*'){cols=c;return query;},eq(k,v){args.push(v);filters.push(`${ident(k)}=$${args.length}`);return query;},
   in(k,v){args.push(v);filters.push(`${ident(k)}=any($${args.length})`);return query;},
   order(k,opt={}){ordering.push(`${ident(k)} ${opt.ascending===false?'desc':'asc'}`);return query;},
   range(a,b){range=[a,b-a+1];return query;},limit(n){range=[0,n];return query;},
   maybeSingle(){single=true;return query;},single(){single=true;return query;},
   insert(v){mode='insert';values=v;return query;},update(v){mode='update';values=v;return query;},
   async then(resolve,reject){try {
    let sql,embed=cols.includes('technician:technicians'),embedLines=cols.includes('line_items:booking_line_items');
    const fields=embed||embedLines?'*':cols.split(',').map(s=>s.trim()==='*'?'*':ident(s.trim())).join(',');
    const where=filters.length?' where '+filters.join(' and '):'';
    if(mode==='select')sql=`select ${fields} from app.${ident(table)}${where}${ordering.length?' order by '+ordering.join(','):''}${range?' limit '+range[1]+' offset '+range[0]:''}`;
    if(mode==='update'){const setters=Object.entries(values).map(([k,v])=>{args.push(v);return `${ident(k)}=$${args.length}`;});sql=`update app.${ident(table)} set ${setters.join(',')}${where} returning ${fields}`;}
    if(mode==='insert'){const entries=Object.entries(values);sql=`insert into app.${ident(table)}(${entries.map(([k])=>ident(k))}) values(${entries.map(([,v])=>{args.push(v);return '$'+args.length;})}) returning ${fields}`;}
    const r=await pg.query(sql,args);r.rows=r.rows.map(jsonRow);
    if(embed)for(const row of r.rows)row.technician=row.technician_id?(await pg.query('select id,name from app.technicians where id=$1',[row.technician_id])).rows[0]:null;
    if(embedLines)for(const row of r.rows)row.line_items=(await pg.query('select * from app.booking_line_items where booking_id=$1 order by sort_order',[row.id])).rows.map(jsonRow);
    return resolve({data:single?(r.rows[0] || null):r.rows,error:null});
   }catch(error){return resolve({data:null,error});}}
  };return query;
 }};
}
