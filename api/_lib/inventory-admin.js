import { recount, syncBracketOrder } from './bracket-moves.js';
import { requireBracketQuantities } from './bracket-materials.js';
import { inventoryError, inventoryRequestId } from './inventory-job.js';
import { saveBracketShippingAddress } from './bracket-shipping.js';

const types = ['flat','tilting','full_motion'];
const terminal = p => ['delivered','canceled','cancelled'].includes(p.status) && !['review','unverified'].includes(p.inventory_status);
async function read(query) { const r = await query; if (r.error) throw r.error; return r.data; }
async function allRows(build) {
  const rows=[];
  for(let offset=0;;offset+=1000) { const batch=await read(build().range(offset,offset+999));rows.push(...(batch || []));if(!batch || batch.length<1000)return rows; }
}
function strictQty(body, fields) {
  for(const f of fields) if(body[f] !== undefined && (body[f] === null || body[f] === '' || typeof body[f] === 'boolean' || !Number.isInteger(Number(body[f])) || Number(body[f])<0)) throw new Error('A whole nonnegative quantity is required for '+f+'.');
}
function requiredMutation(body) {
  if (!body.operation_id) throw new Error('A stable operation ID is required. Refresh the inventory screen.');
  if (typeof body.notes !== 'string' || !body.notes.trim()) throw new Error('A reason is required.');
}
async function technician(db,id) {
  const t=await read(db.from('technicians').select('id,business_id,name,active').eq('id',id).maybeSingle());
  if(!t || t.active===false)throw new Error('An active technician is required.');return t;
}
export async function inventoryAdmin(req,res,db,auth,body,action,biz) {
 try {
  const writes=new Set(['bracket_update','bracket_record_order','bracket_receive','bracket_transfer','bracket_reassign','bracket_assign','bracket_set_status','bracket_shipping_address_save']);
  if(writes.has(action)) {
    if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
    if(auth.role!=='owner')return res.status(403).json({error:'Only the owner can change inventory.'});
  } else if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  if(action==='bracket_parse_email')return res.status(410).json({error:'Use the verified inbox scan or record an incoming order.'});
  const actor=auth.name || auth.role || 'owner';
  if(action==='bracket_inventory') {
    const businesses=await read(db.from('businesses').select('id,slug').eq('active',true));
    const ids=(businesses || []).map(b=>b.id),slug=new Map((businesses || []).map(b=>[b.id,b.slug]));
    const techs=await read(db.from('technicians').select('id,name,business_id').in('business_id',ids).eq('active',true).order('name'));
    const inventory=await read(db.from('bracket_inventory').select('*').in('business_id',ids));
    const plates=await read(db.from('wire_plate_purchases').select('business_id').in('business_id',ids));
    const tracked=new Set((plates || []).map(p=>p.business_id));
    return res.status(200).json({snapshot_at:new Date().toISOString(),inventory:(techs || []).map(t=>{
      const i=(inventory || []).find(i=>i.technician_id===t.id && i.business_id===t.business_id);
      const verified=types.map(k=>i?.[k+'_verified_at']);
      return {technician_id:t.id,technician_name:t.name,business:slug.get(t.business_id),
        flat:i?.flat_qty ?? 0,tilting:i?.tilting_qty ?? 0,full_motion:i?.full_motion_qty ?? 0,
        total:types.reduce((n,k)=>n+(i?.[k+'_qty'] || 0),0),initialized:!!i,updated_at:i?.updated_at || 'uninitialized',
        last_verified_at:verified.every(Boolean)?verified.sort()[0]:null,
        verified_at:Object.fromEntries(types.map(k=>[k,i?.[k+'_verified_at'] || null])),
        wire_plate:i?.wire_plate_qty || 0,wire_plate_tracked:tracked.has(t.business_id)||(i?.wire_plate_qty || 0)>0,
        appletv_bracket:i?.appletv_bracket_qty || 0};
    })});
  }
  if(action==='bracket_purchases' || action==='bracket_pending') {
    const rows=await allRows(()=>db.from('bracket_purchases').select('*,technician:technicians(id,name)').order('created_at',{ascending:false}).order('id'));
    // Old imports mirrored one Walmart order into several businesses. Prefer
    // the assigned record, then the one already processed by the new ledger.
    const canonical=new Map(),score=p=>(p.technician_id?4:0)+(p.last_event_at?2:0);
    for(const p of rows) {const key=p.walmart_order_num || p.id;if(!canonical.has(key)||score(p)>score(canonical.get(key)))canonical.set(key,p);}
    const shape=p=>({...p,technician_id:p.technician_id || p.technician?.id || null,
      technician_name:p.technician?.name || 'Unassigned',total_qty:types.reduce((n,k)=>n+(p[k+'_qty']||0),0),
      order_total:auth.role==='owner'?p.order_total:null});
    const all=[...canonical.values()];
    if(action==='bracket_pending')return res.status(200).json({pending:all.filter(p=>!p.technician_id&&!['canceled','cancelled'].includes(p.status)).map(shape)});
    const history=all.filter(terminal),limit=Math.max(1,Math.min(Number.parseInt(req.query.limit)||20,100)),page=Math.max(0,Number.parseInt(req.query.history_page)||0);
    return res.status(200).json({purchases:history.slice(page*limit,(page+1)*limit).map(shape),open_orders:all.filter(p=>!terminal(p)).map(shape),history_page:page,has_more:history.length>(page+1)*limit});
  }
  if(action==='bracket_movements') {
    const page=Math.max(0,Number.parseInt(req.query.page)||0),size=50;
    let q=db.from('bracket_moves').select('*').order('created_at',{ascending:false}).order('id');
    if(req.query.technician_id)q=q.eq('technician_id',req.query.technician_id);
    const rows=await read(q.range(page*size,(page+1)*size));
    return res.status(200).json({movements:(rows || []).slice(0,size),has_more:(rows || []).length>size});
  }
  if(action==='bracket_exceptions') {
    const exceptions=await allRows(()=>db.from('inventory_exceptions').select('*').eq('status','open').order('created_at',{ascending:false}).order('id'));
    const orderIds=exceptions.filter(e=>e.entity_type==='order'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(e.entity_id)).map(e=>e.entity_id);
    const orderNumbers=new Map();
    for(let i=0;i<orderIds.length;i+=100)for(const p of await read(db.from('bracket_purchases').select('id,walmart_order_num').in('id',orderIds.slice(i,i+100))) || [])orderNumbers.set(p.id,p.walmart_order_num);
    return res.status(200).json({exceptions:exceptions.map(e=>({...e,type:e.code,booking_id:e.entity_type==='job'?e.entity_id:null,order_num:e.entity_type==='order'?(orderNumbers.get(e.entity_id)||(/^\d{7}-\d{8}$/.test(e.entity_id)?e.entity_id:null)):null}))});
  }
  if(action==='bracket_shipping_addresses' || action==='bracket_shipping_address_save') {
    if(auth.role!=='owner')return res.status(403).json({error:'Only the owner can manage shipping addresses.'});
    if(action==='bracket_shipping_addresses')return res.status(200).json({addresses:await read(db.from('bracket_shipping_addresses').select('id,technician_id,address,active,updated_at').order('created_at'))});
    if(!body.operation_id)throw new Error('Operation ID required.');
    await technician(db,body.technician_id);
    return res.status(200).json(await saveBracketShippingAddress(db,{id:body.id || null,technicianId:body.technician_id,address:body.address,
      active:body.active!==false,requestId:inventoryRequestId(body,action),expectedUpdatedAt:body.expected_updated_at || null,actor}));
  }
  if(action==='bracket_update') {
    // Adjacent supplies retain a separate, version-checked correction path.
    if(body.wire_plate_delta!=null || body.appletv_bracket_delta!=null) {
      const t=await technician(db,body.technician_id);
      const inv=await read(db.from('bracket_inventory').select('*').eq('technician_id',t.id).eq('business_id',t.business_id).maybeSingle());
      if(!inv)throw new Error('Record a physical bracket count to initialize this technician first.');
      const patch={};for(const [field,key] of [['wire_plate_delta','wire_plate_qty'],['appletv_bracket_delta','appletv_bracket_qty']])if(body[field]!=null){const d=Number(body[field]);if(!Number.isInteger(d)||inv[key]+d<0)throw new Error('Invalid quantity or insufficient stock.');patch[key]=inv[key]+d;}
      const saved=await read(db.from('bracket_inventory').update(patch).eq('id',inv.id).eq('updated_at',inv.updated_at).select('id'));
      if(!saved?.length)throw new Error('Inventory changed; refresh before retrying.');
      const notes=Object.entries(patch).map(([k,v])=>`${k}: ${inv[k]} → ${v}`).join(', ');
      const log=await db.from('bracket_usage_logs').insert({business_id:t.business_id,technician_id:t.id,booking_id:body.booking_id || null,
        flat_used:0,tilting_used:0,full_motion_used:0,logged_by_kind:'admin',notes:`Manual supply correction by ${actor}: ${notes}. ${body.notes || ''}`});
      if(log.error)console.error('[inventory] adjacent supply change log failed',log.error.message);
      return res.status(200).json({ok:true,...(log.error?{warning:'Count saved; the supply change note could not be saved.'}:{})});
    }
    requiredMutation(body);
    if(body.action!=='set')throw new Error('Use a physical count, receipt, transfer, or job usage to change bracket stock.');
    strictQty(body,types);const result=await recount(db,{technicianId:body.technician_id,flat:body.flat,tilting:body.tilting,fullMotion:body.full_motion,
      expectedUpdatedAt:body.expected_updated_at,requestId:inventoryRequestId(body,'recount'),reason:body.notes,actor});
    return res.status(200).json(result);
  }
  requiredMutation(body);
  const event_id=inventoryRequestId(body,action);
  if(action==='bracket_transfer' || action==='bracket_reassign' || action==='bracket_assign') {
    let payload;
    if(action==='bracket_transfer') {
      strictQty(body,types);const quantities=requireBracketQuantities(body);
      if(!Object.values(quantities).some(n=>n>0))throw new Error('A positive transfer quantity is required.');
      payload={from_technician_id:body.from_technician_id,to_technician_id:body.to_technician_id,quantities,event_id,reason:body.notes,actor};
    } else payload={purchase_id:body.purchase_id || body.id,technician_id:body.technician_id,expected_updated_at:body.expected_updated_at || null,event_id,reason:body.notes,actor};
    const result=await read(db.rpc(action==='bracket_transfer'?'inventory_transfer':'inventory_reassign',{p_payload:payload}));
    if(!result)throw new Error('Inventory operation did not return confirmation.');return res.status(200).json(result);
  }
  if(action==='bracket_record_order') {
    const t=await technician(db,body.technician_id);strictQty(body,types.map(k=>k+'_qty'));
    const ordered=requireBracketQuantities(Object.fromEntries(types.map(k=>[k,body[k+'_qty']])));
    if(!Object.values(ordered).some(n=>n>0))throw new Error('An ordered quantity is required.');
    if(!/^\d{7}-\d{8}$/.test(String(body.order_num || '').trim()))throw new Error('A Walmart order number is required (7 digits, a dash, then 8 digits).');
    const result=await syncBracketOrder(db,{orderNum:String(body.order_num).trim(),event_id,business_id:t.business_id,technician_id:t.id,ordered,
      status:'in_route',expected_absent:true,estimated_delivery:body.estimated_delivery || null,source:'manual',actor,evidence:{notes:body.notes},occurred_at:new Date().toISOString()});
    return res.status(200).json(result);
  }
  if(action==='bracket_receive' || action==='bracket_set_status') {
    const purchase=await read(db.from('bracket_purchases').select('*').eq('id',body.purchase_id || body.id).maybeSingle());
    if(!purchase)throw new Error('Order not found.');
    const payload={orderNum:purchase.walmart_order_num,event_id,business_id:purchase.business_id,technician_id:purchase.technician_id,
      source:'manual',actor,expected_updated_at:body.expected_updated_at || purchase.updated_at,
      evidence:{notes:body.notes,purchase_id:purchase.id},occurred_at:new Date().toISOString()};
    if(action==='bracket_receive') {
      if(!purchase.technician_id)throw new Error('Assign the order to its recipient before recording receipt.');
      strictQty(body,types.map(k=>'received_'+k));
      if(types.some(k=>body['received_'+k]==null))throw new Error('Enter cumulative received counts for all three types.');
      payload.received=requireBracketQuantities(Object.fromEntries(types.map(k=>[k,body['received_'+k]])));
      payload.receipt_scope='cumulative';payload.receipt_verified=true;payload.status=types.every(k=>payload.received[k]>=purchase[k+'_qty'])?'delivered':'in_route';
    } else {
      if(body.status!=='canceled')throw new Error('Confirm actual received quantities using Record received.');
      payload.status='canceled';payload.cancel_unreceived_remainder=true;
    }
    return res.status(200).json(await syncBracketOrder(db,payload));
  }
  return res.status(400).json({error:'Unknown inventory action'});
 } catch(error) { return inventoryError(res,error); }
}
