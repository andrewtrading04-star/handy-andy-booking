const DAY = 86400000;
const phoneKey = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// Complete UTC days keep averages comparable across lines and avoid a partial day.
export async function numberVolumes(db, numbers, now = new Date()) {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(until.getTime() - 90 * DAY);
  const volumes = new Map(numbers.map(n => [phoneKey(n.phone), {
    total: 0, answered: 0, missed: 0, unknown: 0, latest: null,
    daily: Array.from({length:90}, (_, i) => ({date:new Date(+since+i*DAY).toISOString().slice(0,10), calls:0})),
  }]));
  // Paginate: PostgREST's default row cap must never silently undercount volume.
  for (let offset = 0; ; offset += 1000) {
    const {data, error} = await db.from('calls')
      .select('id, grasshopper_number, occurred_at, answered')
      .eq('source', 'twilio').eq('kind', 'inbound')
      .gte('occurred_at', since.toISOString()).lt('occurred_at', until.toISOString())
      .order('occurred_at').order('id').range(offset, offset+999);
    if (error) throw error;
    for (const call of data || []) {
      const v = volumes.get(phoneKey(call.grasshopper_number));
      const day = Math.floor((Date.parse(call.occurred_at)-since)/DAY);
      if (!v || day<0 || day>=90 || !Number.isFinite(day)) continue;
      v.total++; v.daily[day].calls++;
      if (call.answered===true) v.answered++;
      else if (call.answered===false) v.missed++;
      else v.unknown++;
      if (!v.latest || call.occurred_at>v.latest) v.latest=call.occurred_at;
    }
    if ((data || []).length<1000) break;
  }
  return Object.fromEntries(numbers.map(n => {
    const v=volumes.get(phoneKey(n.phone));
    return [n.phone, {...v, average_daily:Math.round(v.total/90*10)/10,
      answer_rate:v.answered+v.missed ? Math.round(v.answered/(v.answered+v.missed)*100) : null,
      from:since.toISOString().slice(0,10), to:new Date(+until-DAY).toISOString().slice(0,10)}];
  }));
}
