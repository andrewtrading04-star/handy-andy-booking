/**
 * Techs To You / Asurion Custom Booking Widget v2
 * Flow: ZIP check → Bracket → Services (multi-select) → Calendar/Slots → Customer details
 * Books Steve only. No credit card. All $0 custom services.
 */
(function () {
  'use strict';

  const SELF_SCRIPT = document.currentScript;
  const API_BASE    = 'https://handy-andy-booking.vercel.app/api';
  const TARGET_ID   = 'techs-to-you-widget';

  // ── Numbered booking steps (after zip gate)
  const STEPS = ['bracket', 'services', 'slots', 'customer'];

  // ── Service list from TTY pay card
  const SVC_GROUPS = [
    { label: 'TV & Audio',
      items: ['Television', 'Sound Bar'] },
    { label: 'Security Devices',
      items: ['Alarm Keypad', 'Alarm Range Extender', 'Alarm Panic Button',
              'Flood Sensor', 'Glass Break Sensor', 'Contact Sensor', 'Security Camera'] },
    { label: 'Smart Home',
      items: ['Door Locks', 'Door Bell', 'Smart Hub', 'Thermostat', 'Light Dimmer'] },
    { label: 'Add-ons',
      items: ['Frame TV (Art Style)', 'Special Mount (Articulating or Motion)', 'Extra Man (TV over 50")'] },
  ];

  // ── State
  let phase          = 'zip';   // 'zip' | 'main'
  let zipChecking    = false;
  let zipError       = '';
  let zipVal         = '';
  let matchedTerr    = null;    // { id, name }

  let stepIdx        = 0;
  let specialBracket = null;    // 'yes' | 'no'
  let selServices    = new Set();
  let slotsByDate    = {}, selectedDate = null, selectedSlot = null;
  let calYear        = null, calMonth = null;
  let slotsLoaded    = false;
  let customer       = { first_name:'', last_name:'', email:'', phone:'', address:'', city:'', state:'', zip:'' };
  let submitting     = false;

  // ── Styles
  const S = {
    host: 'display:block!important;visibility:visible!important;position:relative!important;background:#18181c!important;border:1px solid #2d2d34!important;border-radius:14px!important;padding:40px 44px!important;box-shadow:0 20px 60px rgba(0,0,0,0.65)!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;box-sizing:border-box!important;color:#fff!important;-webkit-tap-highlight-color:transparent!important;',
    bar:  'background:#2d2d34!important;height:6px!important;border-radius:3px!important;margin-bottom:14px!important;overflow:hidden!important;display:block!important;',
    fill: p => `background:#ff6600!important;height:100%!important;width:${p}%!important;display:block!important;transition:width .35s!important;`,
    stepLbl: 'color:#71717a!important;font-size:12px!important;text-transform:uppercase!important;letter-spacing:1.2px!important;display:block!important;margin-bottom:20px!important;',
    h1:  'margin:0 0 8px 0!important;font-size:28px!important;font-weight:800!important;color:#fff!important;display:block!important;line-height:1.25!important;',
    sub: 'color:#a0a0ab!important;font-size:14px!important;display:block!important;margin-bottom:22px!important;line-height:1.55!important;',
    inp: 'width:100%!important;padding:13px 16px!important;background:#27272a!important;border:1px solid #3f3f46!important;color:#fff!important;border-radius:8px!important;font-size:16px!important;box-sizing:border-box!important;margin-bottom:12px!important;display:block!important;outline:none!important;',
    pri: 'background:#ff6600!important;color:#fff!important;border:none!important;padding:14px 32px!important;font-size:16px!important;font-weight:700!important;border-radius:8px!important;cursor:pointer!important;display:inline-block!important;',
    sec: 'background:transparent!important;color:#a0a0ab!important;border:1.5px solid #3f3f46!important;padding:12px 24px!important;font-size:15px!important;border-radius:8px!important;cursor:pointer!important;display:inline-block!important;',
    dis: 'background:#2d2d34!important;color:#52525b!important;border:none!important;padding:14px 32px!important;font-size:16px!important;font-weight:700!important;border-radius:8px!important;cursor:not-allowed!important;display:inline-block!important;',
    row: on => `background:${on?'rgba(255,102,0,0.1)':'#27272a'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:8px!important;padding:15px 18px!important;color:#fff!important;display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:10px!important;font-size:15px!important;cursor:pointer!important;user-select:none!important;`,
    chk: on => `background:${on?'rgba(255,102,0,0.08)':'#1f1f23'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:7px!important;padding:10px 13px!important;color:#fff!important;display:flex!important;align-items:center!important;gap:9px!important;font-size:13.5px!important;cursor:pointer!important;user-select:none!important;`,
    grpLbl: 'font-size:11px!important;text-transform:uppercase!important;letter-spacing:1.1px!important;color:#71717a!important;font-weight:700!important;margin:18px 0 8px 0!important;display:block!important;',
    acts: 'display:flex!important;justify-content:space-between!important;align-items:center!important;margin-top:26px!important;',
  };

  // ── Helpers
  function fmtDate(ds) {
    const d  = new Date(ds + 'T12:00:00');
    const dn = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return { long: dn[d.getDay()], date: `${mn[d.getMonth()]} ${d.getDate()}` };
  }

  // ── Render
  function render() {
    const root = document.getElementById(TARGET_ID);
    if (!root) return;
    root.style.cssText = S.host;
    if (phase === 'zip') {
      root.innerHTML = bZip();
    } else {
      const pct  = Math.round((stepIdx + 1) / STEPS.length * 100);
      const prog = `<div style="${S.bar}"><div style="${S.fill(pct)}"></div></div>` +
                   `<div style="${S.stepLbl}">Step ${stepIdx + 1} of ${STEPS.length}</div>`;
      let body = '';
      switch (STEPS[stepIdx]) {
        case 'bracket':  body = bBracket();  break;
        case 'services': body = bServices(); break;
        case 'slots':    body = bSlots();    break;
        case 'customer': body = bCustomer(); break;
      }
      root.innerHTML = prog + body;
    }
    wire(root);
  }

  // ── ZIP step
  function bZip() {
    return `
      <div style="text-align:center!important;padding-bottom:10px!important;">
        <div style="font-size:12px!important;color:#ff6600!important;font-weight:700!important;text-transform:uppercase!important;letter-spacing:1.5px!important;margin-bottom:14px!important;">Asurion / Techs To You</div>
        <h1 style="${S.h1};text-align:center!important;font-size:32px!important;">Custom Booking</h1>
        <p style="${S.sub};text-align:center!important;margin-bottom:28px!important;">Enter your ZIP code to confirm we service your area.</p>
        <div style="max-width:300px!important;margin:0 auto!important;">
          <input type="text" id="zip-input" style="${S.inp};text-align:center!important;font-size:22px!important;letter-spacing:3px!important;margin-bottom:8px!important;" placeholder="ZIP Code" maxlength="10" inputmode="numeric" value="${zipVal}">
          ${zipError ? `<p style="color:#f87171!important;font-size:13px!important;text-align:center!important;margin:0 0 12px 0!important;">${zipError}</p>` : `<div style="height:22px!important;"></div>`}
          <button id="btn-zip" style="${zipChecking ? S.dis : S.pri};width:100%!important;text-align:center!important;" ${zipChecking ? 'disabled' : ''}>${zipChecking ? 'Checking…' : 'Check Area →'}</button>
        </div>
      </div>`;
  }

  // ── Step 1: Bracket
  function bBracket() {
    const ok = specialBracket !== null;
    return `
      <h1 style="${S.h1}">TV Mounting</h1>
      <p style="${S.sub}">Does this job require a special bracket?</p>
      ${mkRow('Yes — Special Bracket (Articulating / Motion)', specialBracket === 'yes', 'tty-bracket', 'data-v="yes"')}
      ${mkRow('No — Standard Bracket', specialBracket === 'no', 'tty-bracket', 'data-v="no"')}
      <div style="${S.acts}">
        <span></span>
        <button id="btn-next" style="${ok ? S.pri : S.dis}" ${!ok ? 'disabled' : ''}>Continue →</button>
      </div>`;
  }
  function mkRow(label, on, cls, data) {
    return `<div class="${cls}" ${data} style="${S.row(on)}">
      <span>${label}</span>
      <span style="color:${on ? '#ff6600' : '#52525b'}!important;font-size:20px!important;">${on ? '●' : '○'}</span>
    </div>`;
  }

  // ── Step 2: Services multi-select
  function bServices() {
    const hasSel = selServices.size > 0;
    let inner = '';
    for (const g of SVC_GROUPS) {
      inner += `<div style="${S.grpLbl}">${g.label}</div>`;
      inner += `<div style="display:grid!important;grid-template-columns:1fr 1fr!important;gap:6px!important;margin-bottom:2px!important;">`;
      for (const item of g.items) {
        const on = selServices.has(item);
        inner += `<div class="tty-svc" data-item="${item.replace(/"/g,'&quot;')}" style="${S.chk(on)}">
          <span style="width:17px!important;height:17px!important;min-width:17px!important;border-radius:4px!important;border:2px solid ${on ? '#ff6600' : '#52525b'}!important;background:${on ? '#ff6600' : 'transparent'}!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:11px!important;font-weight:700!important;color:#fff!important;">${on ? '✓' : ''}</span>
          <span>${item}</span>
        </div>`;
      }
      inner += `</div>`;
    }
    return `
      <h1 style="${S.h1}">What devices / services?</h1>
      <p style="${S.sub}">Select everything that applies to this job — pick as many as needed.</p>
      <div style="max-height:400px!important;overflow-y:auto!important;padding-right:4px!important;">
        ${inner}
      </div>
      <div style="${S.acts}">
        <button id="btn-prev" style="${S.sec}">← Back</button>
        <button id="btn-next" style="${hasSel ? S.pri : S.dis}" ${!hasSel ? 'disabled' : ''}>Continue →</button>
      </div>`;
  }

  // ── Step 3: Calendar/Slots
  function bSlots() {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const allDates = Object.keys(slotsByDate).sort();

    if (!slotsLoaded) {
      return `<h1 style="${S.h1}">Choose a Date & Time</h1>
        <p style="color:#a0a0ab!important;font-size:14px!important;margin-bottom:18px!important;">Loading available dates…</p>
        <div style="${S.acts}"><button id="btn-prev" style="${S.sec}">← Back</button></div>`;
    }
    if (!allDates.length) {
      return `<h1 style="${S.h1}">Choose a Date & Time</h1>
        <p style="color:#a0a0ab!important;font-size:14px!important;margin-bottom:18px!important;">No open dates right now — please call to schedule.</p>
        <div style="${S.acts}"><button id="btn-prev" style="${S.sec}">← Back</button></div>`;
    }

    if (calYear === null) {
      const f = new Date(allDates[0] + 'T12:00:00');
      calYear = f.getFullYear(); calMonth = f.getMonth();
    }
    const availSet   = new Set(allDates);
    const firstDay   = new Date(calYear, calMonth, 1).getDay();
    const daysInMo   = new Date(calYear, calMonth + 1, 0).getDate();
    const todayStr   = new Date().toISOString().slice(0, 10);
    const firstAvail = new Date(allDates[0] + 'T12:00:00');
    const lastAvail  = new Date(allDates[allDates.length - 1] + 'T12:00:00');
    const canPrev    = calYear > firstAvail.getFullYear() || (calYear === firstAvail.getFullYear() && calMonth > firstAvail.getMonth());
    const canNext    = calYear < lastAvail.getFullYear()  || (calYear === lastAvail.getFullYear()  && calMonth < lastAvail.getMonth());

    const dayHdr = DAYS.map(d =>
      `<div style="text-align:center!important;font-size:11px!important;font-weight:600!important;color:#71717a!important;padding:4px 0 8px 0!important;">${d}</div>`
    ).join('');

    let cells = '';
    for (let i = 0; i < firstDay; i++) cells += `<div></div>`;
    for (let d = 1; d <= daysInMo; d++) {
      const ds     = `${calYear}-${String(calMonth + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const has    = availSet.has(ds);
      const isSel  = selectedDate === ds;
      const isToday= ds === todayStr;
      if (has) {
        cells += `<div class="tty-date" data-date="${ds}" style="text-align:center!important;cursor:pointer!important;padding:4px 2px!important;border-radius:8px!important;background:${isSel ? 'rgba(255,102,0,0.12)' : 'transparent'}!important;">
          <div style="width:34px!important;height:34px!important;border-radius:50%!important;margin:0 auto!important;display:flex!important;align-items:center!important;justify-content:center!important;background:${isSel ? '#ff6600' : isToday ? '#27272a' : 'transparent'}!important;font-size:14px!important;font-weight:${isSel || isToday ? 700 : 400}!important;color:${isSel ? '#fff' : isToday ? '#ff6600' : '#fff'}!important;border:${isToday && !isSel ? '1.5px solid #ff6600' : 'none'}!important;">${d}</div>
        </div>`;
      } else {
        cells += `<div style="text-align:center!important;padding:4px 2px!important;"><div style="width:34px!important;height:34px!important;margin:0 auto!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:14px!important;color:#3f3f46!important;">${d}</div></div>`;
      }
    }

    let timeHtml = '';
    if (selectedDate && slotsByDate[selectedDate]) {
      const df       = fmtDate(selectedDate);
      const slotBtns = slotsByDate[selectedDate].map(sl => {
        const on = selectedSlot === sl.id;
        return `<div class="tty-slot" data-id="${sl.id}" style="background:${on ? 'rgba(255,102,0,0.12)' : '#1f1f23'}!important;border:1.5px solid ${on ? '#ff6600' : '#3f3f46'}!important;border-radius:8px!important;padding:15px 10px!important;cursor:pointer!important;text-align:center!important;">
          <div style="font-size:14px!important;font-weight:600!important;color:#fff!important;">${sl.arrival_window}</div>
        </div>`;
      }).join('');
      timeHtml = `<div style="border-top:1px solid #2d2d34!important;margin-top:14px!important;padding-top:14px!important;">
        <p style="font-size:13px!important;color:#a0a0ab!important;margin:0 0 10px 0!important;">${df.long}, ${df.date} — pick a time:</p>
        <div style="display:grid!important;grid-template-columns:repeat(3,1fr)!important;gap:8px!important;">${slotBtns}</div>
      </div>`;
    }

    return `
      <h1 style="${S.h1}">Choose a Date & Time</h1>
      <div style="background:#27272a!important;border:1px solid #3f3f46!important;border-radius:10px!important;padding:16px!important;margin-bottom:16px!important;">
        <div style="display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:12px!important;">
          <button id="cal-prev" style="background:transparent!important;border:1px solid #3f3f46!important;color:${canPrev ? '#fff' : '#3f3f46'}!important;width:32px!important;height:32px!important;border-radius:50%!important;cursor:${canPrev ? 'pointer' : 'default'}!important;font-size:18px!important;display:flex!important;align-items:center!important;justify-content:center!important;" ${!canPrev ? 'disabled' : ''}>‹</button>
          <span style="font-size:16px!important;font-weight:700!important;color:#fff!important;">${MONTHS[calMonth]} ${calYear}</span>
          <button id="cal-next" style="background:transparent!important;border:1px solid #3f3f46!important;color:${canNext ? '#fff' : '#3f3f46'}!important;width:32px!important;height:32px!important;border-radius:50%!important;cursor:${canNext ? 'pointer' : 'default'}!important;font-size:18px!important;display:flex!important;align-items:center!important;justify-content:center!important;" ${!canNext ? 'disabled' : ''}>›</button>
        </div>
        <div style="display:grid!important;grid-template-columns:repeat(7,1fr)!important;">${dayHdr}</div>
        <div style="display:grid!important;grid-template-columns:repeat(7,1fr)!important;">${cells}</div>
        ${timeHtml}
      </div>
      <div style="${S.acts}">
        <button id="btn-prev" style="${S.sec}">← Back</button>
        <button id="btn-next" style="${selectedSlot ? S.pri : S.dis}" ${!selectedSlot ? 'disabled' : ''}>Continue →</button>
      </div>`;
  }

  // ── Step 4: Customer details
  function bCustomer() {
    const services = [...selServices];
    const summaryLines = [
      specialBracket === 'yes' ? 'Special Bracket' : 'Standard Bracket',
      services.length ? services.join(', ') : null,
    ].filter(Boolean).join(' · ');

    return `
      <h1 style="${S.h1}">Please enter your customer's<br>information for the appointment.</h1>
      <div style="background:rgba(255,102,0,0.08)!important;border:1px solid rgba(255,102,0,0.22)!important;border-radius:8px!important;padding:12px 16px!important;margin-bottom:22px!important;font-size:12.5px!important;color:#d4d4d8!important;line-height:1.65!important;">
        📋 <strong style="color:#fff!important;">Job summary:</strong> ${summaryLines}
      </div>
      <div style="display:grid!important;grid-template-columns:1fr 1fr!important;gap:10px!important;">
        <input type="text"  id="c-fn"  style="${S.inp};margin-bottom:0!important;" placeholder="First Name"  value="${customer.first_name}">
        <input type="text"  id="c-ln"  style="${S.inp};margin-bottom:0!important;" placeholder="Last Name"   value="${customer.last_name}">
      </div>
      <div style="height:10px!important;"></div>
      <input type="email" id="c-em"  style="${S.inp}" placeholder="Email Address" value="${customer.email}">
      <input type="tel"   id="c-ph"  style="${S.inp}" placeholder="Phone Number"  value="${customer.phone}">
      <input type="text"  id="c-ad"  style="${S.inp}" placeholder="Street Address" value="${customer.address}">
      <div style="display:grid!important;grid-template-columns:2fr 1fr 1fr!important;gap:10px!important;">
        <input type="text" id="c-city"  style="${S.inp};margin-bottom:0!important;" placeholder="City"  value="${customer.city}">
        <input type="text" id="c-state" style="${S.inp};margin-bottom:0!important;" placeholder="State" value="${customer.state}">
        <input type="text" id="c-zip"   style="${S.inp};margin-bottom:0!important;" placeholder="ZIP"   inputmode="numeric" value="${customer.zip}">
      </div>
      <div style="${S.acts}">
        <button id="btn-prev" style="${S.sec}">← Back</button>
        <button id="btn-submit" style="${S.pri}">Complete Booking ✓</button>
      </div>`;
  }

  // ── Done screen
  function bDone() {
    const root = document.getElementById(TARGET_ID);
    if (!root) return;
    const df   = selectedDate ? fmtDate(selectedDate) : null;
    const slot = (slotsByDate[selectedDate] || []).find(s => s.id === selectedSlot) || {};
    root.style.cssText = S.host;
    root.innerHTML = `
      <div style="text-align:center!important;padding:20px 8px!important;">
        <div style="width:70px!important;height:70px!important;border-radius:50%!important;background:rgba(34,197,94,0.15)!important;border:2px solid #22c55e!important;margin:0 auto 20px auto!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:34px!important;">✓</div>
        <h1 style="${S.h1};text-align:center!important;font-size:26px!important;">Booking Confirmed!</h1>
        <p style="${S.sub};text-align:center!important;">Steve will reach out to confirm the appointment.${df ? `<br><strong style="color:#fff!important;">${df.long}, ${df.date}</strong>${slot.arrival_window ? ` · ${slot.arrival_window}` : ''}` : ''}</p>
        <p style="color:#71717a!important;font-size:13px!important;margin-top:14px!important;">Confirmation sent to ${customer.email || 'your email'}.</p>
      </div>`;
  }

  // ── Event wiring
  function wire(root) {
    // ZIP check
    const zipBtn = root.querySelector('#btn-zip');
    const zipInp = root.querySelector('#zip-input');
    if (zipBtn) zipBtn.addEventListener('click', doZipCheck);
    if (zipInp) {
      zipInp.addEventListener('input', e => { zipVal = e.target.value; });
      zipInp.addEventListener('keydown', e => { if (e.key === 'Enter') doZipCheck(); });
    }

    // Navigation
    root.querySelector('#btn-prev')?.addEventListener('click', () => goBack());
    root.querySelector('#btn-next')?.addEventListener('click', () => goNext());
    root.querySelector('#btn-submit')?.addEventListener('click', () => doSubmit(root));

    // Calendar
    root.querySelector('#cal-prev')?.addEventListener('click', () => {
      if (calMonth !== null) { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } render(); }
    });
    root.querySelector('#cal-next')?.addEventListener('click', () => {
      if (calMonth !== null) { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } render(); }
    });

    // Bracket choice
    root.querySelectorAll('.tty-bracket').forEach(c =>
      c.addEventListener('click', () => { specialBracket = c.dataset.v; render(); })
    );

    // Services multi-select
    root.querySelectorAll('.tty-svc').forEach(c =>
      c.addEventListener('click', () => {
        const item = c.dataset.item;
        if (selServices.has(item)) selServices.delete(item);
        else selServices.add(item);
        render();
      })
    );

    // Dates & slots
    root.querySelectorAll('.tty-date').forEach(c =>
      c.addEventListener('click', () => { selectedDate = c.dataset.date; selectedSlot = null; render(); })
    );
    root.querySelectorAll('.tty-slot').forEach(c =>
      c.addEventListener('click', () => { selectedSlot = c.dataset.id; render(); })
    );
  }

  // ── ZIP check
  async function doZipCheck() {
    if (zipChecking) return;
    const zip = zipVal.trim();
    if (!zip) { zipError = 'Please enter a ZIP code.'; render(); return; }
    zipChecking = true; zipError = ''; render();
    try {
      const r    = await fetch(`${API_BASE}/assurion-area`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.in_service_area) {
        zipError     = 'Sorry, we don\'t currently service that area. Please call us to schedule.';
        zipChecking  = false;
        render(); return;
      }
      matchedTerr = { id: data.territory_id, name: data.territory_name };
      // Pre-fill city/state if returned
      if (data.city)  customer.city  = data.city;
      if (data.state) customer.state = data.state;
      if (zip)        customer.zip   = zip;
      phase      = 'main';
      stepIdx    = 0;
      zipChecking = false;
      // Kick off slot loading immediately
      if (!slotsLoaded) fetchSlots();
      render();
    } catch {
      zipError    = 'Could not check your area. Please try again.';
      zipChecking = false;
      render();
    }
  }

  // ── Navigation
  function goNext() {
    const key = STEPS[stepIdx];
    if (key === 'bracket' && specialBracket === null) return;
    if (key === 'services' && selServices.size === 0)  return;
    if (key === 'slots' && !selectedSlot) return;
    stepIdx++; render();
  }
  function goBack() {
    if (stepIdx === 0) { phase = 'zip'; render(); return; }
    stepIdx = Math.max(0, stepIdx - 1); render();
  }

  // ── Slot loading
  async function fetchSlots() {
    try {
      const tid = matchedTerr?.id || '';
      const r   = await fetch(`${API_BASE}/assurion-slots${tid ? '?territory_id=' + encodeURIComponent(tid) : ''}`);
      const d   = await r.json();
      slotsByDate = {}; calYear = null; calMonth = null;
      for (const day of (d.days || [])) {
        if (day.timeslots && day.timeslots.length) {
          slotsByDate[day.date] = day.timeslots.map(sl => ({ id: sl.id, arrival_window: sl.formatted }));
        }
      }
      const dates = Object.keys(slotsByDate).sort();
      if (dates.length) {
        const f = new Date(dates[0] + 'T12:00:00');
        calYear = f.getFullYear(); calMonth = f.getMonth();
      }
    } catch { slotsByDate = {}; }
    slotsLoaded = true;
    if (STEPS[stepIdx] === 'slots') render();
  }

  // ── Submit
  async function doSubmit(root) {
    if (submitting) return;
    customer.first_name = root.querySelector('#c-fn').value.trim();
    customer.last_name  = root.querySelector('#c-ln').value.trim();
    customer.email      = root.querySelector('#c-em').value.trim();
    customer.phone      = root.querySelector('#c-ph').value.trim();
    customer.address    = root.querySelector('#c-ad').value.trim();
    customer.city       = root.querySelector('#c-city').value.trim();
    customer.state      = root.querySelector('#c-state').value.trim();
    customer.zip        = root.querySelector('#c-zip').value.trim();

    if (!customer.first_name || !customer.last_name) return alert('Please enter the customer\'s full name.');
    if (!customer.email)   return alert('Please enter the customer\'s email address.');
    if (!customer.phone)   return alert('Please enter the customer\'s phone number.');
    if (!customer.address) return alert('Please enter the customer\'s street address.');

    const services = [...selServices];
    const lines    = [
      specialBracket === 'yes' ? 'Special Bracket (Articulating / Motion)' : 'Standard Bracket',
      ...services,
    ];
    const notes = [
      'Asurion / Techs To You Booking (Steve).',
      `Bracket: ${specialBracket === 'yes' ? 'Special (Articulating/Motion)' : 'Standard'}`,
      services.length ? `Services: ${services.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    submitting = true;
    const btn  = root.querySelector('#btn-submit');
    if (btn) { btn.textContent = 'Booking…'; btn.disabled = true; }

    try {
      const r = await fetch(`${API_BASE}/assurion-book`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer, selectedSlot, lines, notes,
          territory_id: matchedTerr?.id || null,
        }),
      });
      if (r.ok) {
        bDone();
      } else {
        submitting = false;
        if (btn) { btn.textContent = 'Complete Booking ✓'; btn.disabled = false; }
        const err = await r.json().catch(() => ({}));
        alert(err.error || 'Booking failed. Please try again.');
      }
    } catch {
      submitting = false;
      if (btn) { btn.textContent = 'Complete Booking ✓'; btn.disabled = false; }
      alert('Connection error. Please try again.');
    }
  }

  // ── Boot
  function ensureContainer() {
    let el = document.getElementById(TARGET_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = TARGET_ID;
    if (SELF_SCRIPT && SELF_SCRIPT.parentNode) {
      SELF_SCRIPT.parentNode.insertBefore(el, SELF_SCRIPT.nextSibling);
    } else {
      document.body.appendChild(el);
    }
    return el;
  }
  function boot() {
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); return; }
    // Responsive sizing: much wider on desktop
    if (!document.getElementById('tty-style-v2')) {
      const s = document.createElement('style');
      s.id    = 'tty-style-v2';
      s.textContent = [
        '#techs-to-you-widget{width:100%!important;box-sizing:border-box!important;}',
        '@media(min-width:600px){#techs-to-you-widget{max-width:760px!important;margin:0 auto!important;}}',
        '@media(min-width:900px){#techs-to-you-widget{max-width:920px!important;}}',
        '#techs-to-you-widget input:focus{border-color:#ff6600!important;box-shadow:0 0 0 3px rgba(255,102,0,0.15)!important;}',
      ].join('');
      document.head.appendChild(s);
    }
    ensureContainer();
    render();
  }
  boot();
})();
