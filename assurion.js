/**
 * Techs To You Custom Booking Widget
 * Books with Steve only. Simple flow: Special bracket? → Custom notes → Calendar → Customer details
 * No pre-built selections, no credit card.
 */
(function () {
  'use strict';

  const SELF_SCRIPT = document.currentScript;
  const API_BASE  = 'https://handy-andy-booking.vercel.app/api';
  const TARGET_ID = 'techs-to-you-widget';

  const STEP_KEYS = ['bracket', 'custom', 'slots', 'customer'];

  // ─── State ──────────────────────────────────────────────────────────────
  let stepIdx = 0;
  let specialBracket = null;      // 'yes' | 'no'
  let customNotes = '';           // free-text input
  let slotsByDate = {}, selectedDate = null, selectedSlot = null, calYear = null, calMonth = null;
  let slotsLoaded = false;
  let customer = { first_name:'', last_name:'', email:'', phone:'', address:'', city:'', state:'', zip:'' };
  let submitting = false;

  // ─── Styles (matches Handy Andy) ──────────────────────────────────────────
  const S = {
    host:'display:block!important;visibility:visible!important;position:relative!important;background:#18181c!important;border:1px solid #2d2d34!important;border-radius:12px!important;padding:28px!important;box-shadow:0 10px 30px rgba(0,0,0,0.5)!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;box-sizing:border-box!important;color:#fff!important;-webkit-tap-highlight-color:transparent!important;',
    bar:'background:#2d2d34!important;height:6px!important;border-radius:3px!important;margin-bottom:16px!important;overflow:hidden!important;display:block!important;',
    fill:p=>`background:#ff6600!important;height:100%!important;width:${p}%!important;display:block!important;transition:width .3s!important;`,
    step:'color:#71717a!important;font-size:12px!important;text-transform:uppercase!important;letter-spacing:1px!important;display:block!important;margin-bottom:18px!important;',
    h1:'margin:0 0 8px 0!important;font-size:22px!important;font-weight:800!important;color:#fff!important;display:block!important;line-height:1.3!important;',
    h2:'margin:0 0 6px 0!important;font-size:16px!important;font-weight:700!important;color:#fff!important;display:block!important;line-height:1.3!important;',
    sub:'color:#a0a0ab!important;font-size:13px!important;display:block!important;margin-bottom:16px!important;line-height:1.5!important;',
    inputL:'width:100%!important;padding:11px 14px!important;background:#27272a!important;border:1px solid #3f3f46!important;color:#fff!important;border-radius:6px!important;font-size:15px!important;box-sizing:border-box!important;margin-bottom:12px!important;display:block!important;',
    textarea:'width:100%!important;padding:11px 14px!important;background:#27272a!important;border:1px solid #3f3f46!important;color:#fff!important;border-radius:6px!important;font-size:14px!important;box-sizing:border-box!important;margin-bottom:12px!important;display:block!important;resize:vertical!important;min-height:90px!important;font-family:inherit!important;',
    btnPri:'background:#ff6600!important;color:#fff!important;border:none!important;padding:13px 26px!important;font-size:15px!important;font-weight:700!important;border-radius:8px!important;cursor:pointer!important;display:inline-block!important;-webkit-tap-highlight-color:transparent!important;',
    btnSec:'background:transparent!important;color:#a0a0ab!important;border:1px solid #3f3f46!important;padding:10px 20px!important;font-size:14px!important;border-radius:6px!important;cursor:pointer!important;display:inline-block!important;',
    btnDis:'background:#2d2d34!important;color:#52525b!important;border:none!important;padding:13px 26px!important;font-size:15px!important;font-weight:700!important;border-radius:8px!important;cursor:not-allowed!important;display:inline-block!important;',
    actions:'display:flex!important;justify-content:space-between!important;align-items:center!important;margin-top:20px!important;',
    card:on=>`background:${on?'rgba(255,102,0,0.1)':'#27272a'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:8px!important;padding:13px 15px!important;color:#fff!important;display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:8px!important;font-size:14px!important;cursor:pointer!important;user-select:none!important;`,
  };

  // ─── Helpers ────────────────────────────────────────────────────────────
  function fmtDate(ds){
    const d=new Date(ds+'T12:00:00');
    const dn=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const mn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return { long:dn[d.getDay()], date:`${mn[d.getMonth()]} ${d.getDate()}` };
  }
  function visibleStepNum(){ return stepIdx+1; }

  // ─── Render ─────────────────────────────────────────────────────────────
  function render(){
    const root=document.getElementById(TARGET_ID); if(!root)return;
    root.style.cssText=S.host;
    const key=STEP_KEYS[stepIdx];
    const pct=Math.round(visibleStepNum()/STEP_KEYS.length*100);
    const prog=`<div style="${S.bar}"><div style="${S.fill(pct)}"></div></div><div style="${S.step}">Step ${visibleStepNum()} of ${STEP_KEYS.length}</div>`;
    let body='';
    switch(key){
      case 'bracket': body=bBracket();  break;
      case 'custom':  body=bCustom();   break;
      case 'slots':   body=bSlots();    break;
      case 'customer':body=bCustomer(); break;
    }
    root.innerHTML=prog+body;
    wire(root);
  }

  function pickRow(label, on, cls, data){
    return `<div class="${cls}" ${data} style="${S.card(on)}">
      <span>${label}</span>
      <span style="color:${on?'#ff6600':'#52525b'}!important;font-size:18px!important;">${on?'●':'○'}</span>
    </div>`;
  }

  function bBracket(){
    const ok=specialBracket!==null;
    return `
      <h1 style="${S.h1}">TV Mounting</h1>
      <p style="${S.sub}">Do you need a special bracket?</p>
      ${pickRow('Yes — Special Bracket (Articulating / Motion)', specialBracket==='yes', 'tty-bracket', 'data-v="yes"')}
      ${pickRow('No — Standard Bracket', specialBracket==='no', 'tty-bracket', 'data-v="no"')}
      <div style="${S.actions}">
        <span></span>
        <button id="btn-next" style="${ok?S.btnPri:S.btnDis}" ${!ok?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bCustom(){
    return `
      <h1 style="${S.h1}">Anything else?</h1>
      <p style="${S.sub}">Describe any additional work or custom services you need.</p>
      <textarea id="custom-notes" style="${S.textarea}" placeholder="e.g., Install soundbar, hide wires behind wall, remove old TV, etc.">${customNotes}</textarea>
      <p style="color:#71717a!important;font-size:11px!important;margin-top:-8px!important;margin-bottom:12px!important;">Optional — leave blank if just the mount.</p>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${S.btnPri}">Continue →</button>
      </div>`;
  }

  function bSlots(){
    const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const allDates=Object.keys(slotsByDate).sort();
    if(!slotsLoaded){
      return `<h1 style="${S.h1}">What day works?</h1>
        <p style="color:#a0a0ab!important;font-size:14px!important;margin-bottom:16px!important;">Loading available dates…</p>
        <div style="${S.actions}"><button id="btn-prev" style="${S.btnSec}">← Back</button></div>`;
    }
    if(!allDates.length){
      return `<h1 style="${S.h1}">What day works?</h1>
        <p style="color:#a0a0ab!important;font-size:14px!important;margin-bottom:16px!important;">No open dates right now — please call to schedule.</p>
        <div style="${S.actions}"><button id="btn-prev" style="${S.btnSec}">← Back</button></div>`;
    }
    if(calYear===null){ const f=new Date(allDates[0]+'T12:00:00'); calYear=f.getFullYear(); calMonth=f.getMonth(); }
    const availSet=new Set(allDates);
    const firstDay=new Date(calYear,calMonth,1).getDay();
    const daysInMonth=new Date(calYear,calMonth+1,0).getDate();
    const todayStr=new Date().toISOString().slice(0,10);
    const firstAvail=new Date(allDates[0]+'T12:00:00');
    const lastAvail=new Date(allDates[allDates.length-1]+'T12:00:00');
    const canPrev=calYear>firstAvail.getFullYear()||(calYear===firstAvail.getFullYear()&&calMonth>firstAvail.getMonth());
    const canNext=calYear<lastAvail.getFullYear()||(calYear===lastAvail.getFullYear()&&calMonth<lastAvail.getMonth());
    const dayHdr=DAYS.map(d=>`<div style="text-align:center!important;font-size:11px!important;font-weight:600!important;color:#71717a!important;padding:4px 0 8px 0!important;">${d}</div>`).join('');
    let cells='';
    for(let i=0;i<firstDay;i++)cells+=`<div></div>`;
    for(let d=1;d<=daysInMonth;d++){
      const ds=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const has=availSet.has(ds),isSel=selectedDate===ds,isToday=ds===todayStr;
      if(has){
        cells+=`<div class="tty-date" data-date="${ds}" style="text-align:center!important;cursor:pointer!important;padding:4px 2px!important;border-radius:8px!important;background:${isSel?'rgba(255,102,0,0.12)':'transparent'}!important;">
          <div style="width:32px!important;height:32px!important;border-radius:50%!important;margin:0 auto!important;display:flex!important;align-items:center!important;justify-content:center!important;background:${isSel?'#ff6600':isToday?'#27272a':'transparent'}!important;font-size:14px!important;font-weight:${isSel||isToday?700:400}!important;color:${isSel?'#fff':isToday?'#ff6600':'#fff'}!important;border:${isToday&&!isSel?'1.5px solid #ff6600':'none'}!important;">${d}</div>
        </div>`;
      }else{
        cells+=`<div style="text-align:center!important;padding:4px 2px!important;"><div style="width:32px!important;height:32px!important;margin:0 auto!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:14px!important;color:#3f3f46!important;">${d}</div></div>`;
      }
    }
    let timeHtml='';
    if(selectedDate&&slotsByDate[selectedDate]){
      const df=fmtDate(selectedDate);
      const slotBtns=slotsByDate[selectedDate].map(sl=>{
        const on=selectedSlot===sl.id;
        return `<div class="tty-slot" data-id="${sl.id}" style="background:${on?'rgba(255,102,0,0.12)':'#1f1f23'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:8px!important;padding:14px 10px!important;cursor:pointer!important;text-align:center!important;">
          <div style="font-size:13px!important;font-weight:600!important;color:#fff!important;">${sl.arrival_window}</div>
        </div>`;
      }).join('');
      timeHtml=`<div style="border-top:1px solid #2d2d34!important;margin-top:12px!important;padding-top:12px!important;">
        <p style="font-size:13px!important;color:#a0a0ab!important;margin:0 0 10px 0!important;">${df.long}, ${df.date} — select a time:</p>
        <div style="display:grid!important;grid-template-columns:1fr 1fr!important;gap:8px!important;">${slotBtns}</div>
      </div>`;
    }
    return `
      <h1 style="${S.h1}">What day works?</h1>
      <div style="background:#27272a!important;border:1px solid #3f3f46!important;border-radius:10px!important;padding:14px!important;margin-bottom:14px!important;">
        <div style="display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:10px!important;">
          <button id="cal-prev" style="background:transparent!important;border:1px solid #3f3f46!important;color:${canPrev?'#fff':'#3f3f46'}!important;width:30px!important;height:30px!important;border-radius:50%!important;cursor:${canPrev?'pointer':'default'}!important;font-size:16px!important;display:flex!important;align-items:center!important;justify-content:center!important;" ${!canPrev?'disabled':''}>‹</button>
          <span style="font-size:15px!important;font-weight:700!important;color:#fff!important;">${MONTHS[calMonth]} ${calYear}</span>
          <button id="cal-next" style="background:transparent!important;border:1px solid #3f3f46!important;color:${canNext?'#fff':'#3f3f46'}!important;width:30px!important;height:30px!important;border-radius:50%!important;cursor:${canNext?'pointer':'default'}!important;font-size:16px!important;display:flex!important;align-items:center!important;justify-content:center!important;" ${!canNext?'disabled':''}>›</button>
        </div>
        <div style="display:grid!important;grid-template-columns:repeat(7,1fr)!important;">${dayHdr}</div>
        <div style="display:grid!important;grid-template-columns:repeat(7,1fr)!important;">${cells}</div>
        ${timeHtml}
      </div>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${selectedSlot?S.btnPri:S.btnDis}" ${!selectedSlot?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bCustomer(){
    const summary=['TV Mounting',
      specialBracket==='yes'?'Special Bracket':'Standard Bracket',
      customNotes?`Custom: ${customNotes.slice(0,50)}${customNotes.length>50?'...':''}`:null].filter(Boolean).join(' · ');
    return `
      <h1 style="${S.h1};color:#ff6600!important;">Your details</h1>
      <div style="background:rgba(255,102,0,0.08)!important;border:1px solid rgba(255,102,0,0.25)!important;border-radius:8px!important;padding:12px 14px!important;margin-bottom:18px!important;font-size:12px!important;color:#d4d4d8!important;line-height:1.6!important;">
        📋 <strong style="color:#fff!important;">Your request:</strong> ${summary}
      </div>
      <input type="text"  id="c-fn" style="${S.inputL}" placeholder="First Name"     value="${customer.first_name}">
      <input type="text"  id="c-ln" style="${S.inputL}" placeholder="Last Name"      value="${customer.last_name}">
      <input type="email" id="c-em" style="${S.inputL}" placeholder="Email Address"  value="${customer.email}">
      <input type="tel"   id="c-ph" style="${S.inputL}" placeholder="Phone Number"   value="${customer.phone}">
      <input type="text"  id="c-ad" style="${S.inputL}" placeholder="Street Address" value="${customer.address}">
      <div style="display:flex!important;gap:8px!important;">
        <input type="text" id="c-city" style="${S.inputL};flex:2!important;" placeholder="City"  value="${customer.city}">
        <input type="text" id="c-state" style="${S.inputL};flex:1!important;" placeholder="State" value="${customer.state}">
        <input type="text" id="c-zip" style="${S.inputL};flex:1!important;" placeholder="ZIP" inputmode="numeric" value="${customer.zip}">
      </div>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-submit" style="${S.btnPri}">Complete Booking ✓</button>
      </div>`;
  }

  function bDone(){
    const root=document.getElementById(TARGET_ID); if(!root)return;
    const df=selectedDate?fmtDate(selectedDate):null;
    const slot=(slotsByDate[selectedDate]||[]).find(s=>s.id===selectedSlot)||{};
    root.style.cssText=S.host;
    root.innerHTML=`
      <div style="text-align:center!important;padding:14px 6px!important;">
        <div style="width:64px!important;height:64px!important;border-radius:50%!important;background:rgba(34,197,94,0.15)!important;border:2px solid #22c55e!important;margin:0 auto 16px auto!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:32px!important;">✓</div>
        <h1 style="${S.h1};text-align:center!important;">Booking confirmed!</h1>
        <p style="${S.sub};text-align:center!important;">Steve will reach out to confirm.${df?` <br><strong style="color:#fff!important;">${df.long}, ${df.date}</strong>${slot.arrival_window?` · ${slot.arrival_window}`:''}`:''}</p>
        <p style="color:#71717a!important;font-size:12px!important;margin-top:12px!important;">Confirmation sent to ${customer.email||'your email'}.</p>
      </div>`;
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────
  function wire(root){
    root.querySelector('#btn-prev')?.addEventListener('click',()=>goBack());
    root.querySelector('#btn-next')?.addEventListener('click',()=>goNext());
    root.querySelector('#btn-submit')?.addEventListener('click',()=>doSubmit(root));
    root.querySelector('#cal-prev')?.addEventListener('click',()=>{if(calMonth!==null){calMonth--;if(calMonth<0){calMonth=11;calYear--;}render();}});
    root.querySelector('#cal-next')?.addEventListener('click',()=>{if(calMonth!==null){calMonth++;if(calMonth>11){calMonth=0;calYear++;}render();}});
    root.querySelectorAll('.tty-bracket').forEach(c=>c.addEventListener('click',()=>{specialBracket=c.dataset.v;render();}));
    root.querySelector('#custom-notes')?.addEventListener('input',e=>{customNotes=e.target.value;});
    root.querySelectorAll('.tty-date').forEach(c=>c.addEventListener('click',()=>{selectedDate=c.dataset.date;selectedSlot=null;render();}));
    root.querySelectorAll('.tty-slot').forEach(c=>c.addEventListener('click',()=>{selectedSlot=c.dataset.id;render();}));
  }

  function goNext(){
    const key=STEP_KEYS[stepIdx];
    if(key==='bracket'&&specialBracket===null)return;
    const ni=stepIdx+1;
    if(STEP_KEYS[ni]==='slots'&&!slotsLoaded)fetchSlots();
    stepIdx=ni; render();
  }
  function goBack(){ stepIdx=Math.max(0,stepIdx-1); render(); }

  // ─── Slots ──────────────────────────────────────────────────────────────
  async function fetchSlots(){
    try{
      const r=await fetch(`${API_BASE}/assurion-slots`);
      const d=await r.json();
      slotsByDate={}; calYear=null; calMonth=null;
      for(const day of (d.days||[])){
        slotsByDate[day.date]=(day.timeslots||[]).map(sl=>({ id:sl.id, arrival_window:sl.formatted }));
      }
      const dates=Object.keys(slotsByDate).sort();
      if(dates.length){ const f=new Date(dates[0]+'T12:00:00'); calYear=f.getFullYear(); calMonth=f.getMonth(); }
    }catch(e){ slotsByDate={}; }
    slotsLoaded=true; render();
  }

  // ─── Submit ─────────────────────────────────────────────────────────────
  async function doSubmit(root){
    if(submitting)return;
    customer.first_name=root.querySelector('#c-fn').value.trim();
    customer.last_name=root.querySelector('#c-ln').value.trim();
    customer.email=root.querySelector('#c-em').value.trim();
    customer.phone=root.querySelector('#c-ph').value.trim();
    customer.address=root.querySelector('#c-ad').value.trim();
    customer.city=root.querySelector('#c-city').value.trim();
    customer.state=root.querySelector('#c-state').value.trim();
    customer.zip=root.querySelector('#c-zip').value.trim();
    if(!customer.first_name||!customer.last_name)return alert('Please enter your name.');
    if(!customer.email)return alert('Please enter your email address.');
    if(!customer.phone)return alert('Please enter your phone number.');
    if(!customer.address)return alert('Please enter your street address.');

    const lines=['TV Mounting',
      specialBracket==='yes'?'Special Bracket (Articulating / Motion)':'Standard Bracket',
      customNotes?`Custom: ${customNotes.trim()}`:null].filter(Boolean);

    const notes='Techs To You Custom Booking (Steve).\n'
      +`Bracket: ${specialBracket==='yes'?'Special (Articulating/Motion)':'Standard'}\n`
      +`${customNotes?`Custom notes:\n${customNotes}`:''}\n`;

    submitting=true;
    const btn=root.querySelector('#btn-submit');
    if(btn){btn.textContent='Booking…';btn.disabled=true;}
    try{
      const r=await fetch(`${API_BASE}/assurion-book`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ customer, selectedSlot, lines, notes }),
      });
      if(r.ok){
        bDone();
      }else{
        submitting=false;
        if(btn){btn.textContent='Complete Booking ✓';btn.disabled=false;}
        const err=await r.json().catch(()=>({}));
        alert(err.error||'Booking failed. Please try again.');
      }
    }catch{
      submitting=false;
      if(btn){btn.textContent='Complete Booking ✓';btn.disabled=false;}
      alert('Connection error. Please try again.');
    }
  }

  // ─── Boot ───────────────────────────────────────────────────────────────
  function ensureContainer(){
    let el=document.getElementById(TARGET_ID);
    if(el)return el;
    el=document.createElement('div');
    el.id=TARGET_ID;
    el.style.cssText='max-width:580px;width:100%;margin:0 auto;';
    if(SELF_SCRIPT&&SELF_SCRIPT.parentNode){SELF_SCRIPT.parentNode.insertBefore(el,SELF_SCRIPT.nextSibling);}
    else{document.body.appendChild(el);}
    return el;
  }
  function boot(){
    if(!document.getElementById('tty-widget-style')){
      const s=document.createElement('style');
      s.id='tty-widget-style';
      s.textContent='@media(min-width:768px){#techs-to-you-widget{max-width:638px!important;}}';
      document.head.appendChild(s);
    }
    if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',boot);return;}
    ensureContainer();
    render();
  }
  boot();
})();
