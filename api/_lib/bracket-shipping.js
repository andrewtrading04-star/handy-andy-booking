// Shared by the address editor and supplier intake. Deliberately do not expand
// street abbreviations or drop apartment numbers: a non-match requests review.
export function normalizeBracketShippingAddress(address) {
  return String(address || '').normalize('NFKC').toLowerCase()
    .replace(/\b(?:united states(?: of america)?|usa)\b/g,'')
    .replace(/\b(\d{5})-\d{4}\b/g,'$1').replace(/[.,]/g,' ')
    .replace(/\s+/g,' ').trim();
}
export function validBracketShippingAddress(address) {
  const value = String(address || '').trim().replace(/\r?\n/g,', ');
  return value.length <= 400 && /^\d{1,6}\s+[A-Za-z]/.test(value)
    && /,\s*[A-Za-z .'\-]{2,40},?\s+[A-Z]{2}\s*,?\s*\d{5}(?:-\d{4})?\b/i.test(value);
}
export async function matchBracketShippingAddress(db,address) {
  if (!validBracketShippingAddress(address)) return null;
  const {data,error} = await db.from('bracket_shipping_addresses')
    .select('id,technician_id').eq('normalized_address',normalizeBracketShippingAddress(address)).eq('active',true).limit(2);
  if (error) throw error;
  if (!data || data.length !== 1) return null;
  const {data:tech,error:techError} = await db.from('technicians').select('id,business_id,name,active').eq('id',data[0].technician_id).maybeSingle();
  if (techError) throw techError;
  return tech && tech.active !== false ? {...tech,shipping_address_id:data[0].id} : null;
}

export async function saveBracketShippingAddress(db,{id=null,technicianId,address,active=true,requestId,expectedUpdatedAt=null,actor='owner'}) {
  if (!technicianId || !validBracketShippingAddress(address)) throw new Error('A technician and complete shipping address are required.');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length>250) throw new Error('A stable address operation ID is required.');
  if (typeof active !== 'boolean') throw new Error('Invalid address active state.');
  if (id && !expectedUpdatedAt) throw new Error('Refresh the address before editing; its current version is required.');
  const {data,error}=await db.rpc('inventory_shipping_address_save',{p_payload:{
    id,technician_id:technicianId,address:String(address).trim(),normalized_address:normalizeBracketShippingAddress(address),
    active,event_id:requestId,expected_updated_at:expectedUpdatedAt,actor,
  }});
  if(error)throw error;
  const result=Array.isArray(data)?data[0]:data;
  if(!result?.ok || !result.address?.id)throw new Error('Address operation did not confirm persistence.');
  return result;
}
