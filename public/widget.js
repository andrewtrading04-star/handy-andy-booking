/**
 * Handy Andy TV Mounting — Booking Widget v5
 */
(function () {
  'use strict';

  // Capture this script tag NOW (currentScript is null inside later callbacks)
  const SELF_SCRIPT = document.currentScript;

  const API_BASE    = 'https://handy-andy-booking.vercel.app/api';
  const TARGET_ID   = 'ha-widget';
  const DENVER_ID   = '1685582903241x973573877706522600'; // Only Denver requires 2 techs for 98"+ TVs
  const STRIPE_KEY  = 'pk_live_51Olvl3IqRVZvLFqu9lmppvTG7bOYTjAY30EoaDZXwKciPfGw5G24kAwVzU91FmgzypjfQfcmXFyGdc3UMBD3dOgF00DZZutNIA';
  const THANKYOU_URL= 'https://www.ihandyandy.com/thankyou/';

  // ── Native (off-Zenbooker) booking mode ──────────────────────────────────
  // When on, the widget books through the CRM's own service-area / slots / book
  // engine (business=handy-andy) instead of Zenbooker. During rollout it's
  // OPT-IN via ?native=1 on the host page (so real traffic is unaffected); flip
  // NATIVE_DEFAULT to true to make it the default for everyone, or use ?native=0
  // to force the old Zenbooker path as a fallback.
  const NATIVE_DEFAULT = true;   // Handy Andy booking now runs on the CRM, not Zenbooker. Use ?native=0 to force the old path.
  let NATIVE = NATIVE_DEFAULT;
  try { const _np = new URLSearchParams(location.search).get('native'); if (_np === '1') NATIVE = true; if (_np === '0') NATIVE = false; } catch (e) {}
  // Set from the native zip check; used by slots, surcharge, and tech scoping.
  let serviceAreaId = null, nativeSurcharge = 0, areaName = '';
  const isDenver = () => NATIVE ? /denver/i.test(areaName) : territoryId === DENVER_ID;

  // Fallback only — the zip check returns the customer's real city/state, which takes priority.
  const TERRITORY_LOCATION = {
    '1707514546803x280800015001583600': { city:'Houston',     state:'TX' }, // Houston #1
    '1685582903241x973573877706522600': { city:'Denver',      state:'CO' }, // Denver #1
    '1707513178246x806633139915194400': { city:'Denver',      state:'CO' }, // Denver #2
    '1687393551618x123774611115737090': { city:'Denver',      state:'CO' }, // Denver #3
    '1723559782141x609094402068185100': { city:'Denver',      state:'CO' }, // Denver #4 Boulder/CS
    '1724797832896x339501352491155460': { city:'Austin',      state:'TX' },
    '1760944311332x492178768310304800': { city:'Los Angeles', state:'CA' },
  };
  function resolveLocation(){
    const fall=TERRITORY_LOCATION[territoryId]||{city:'',state:''};
    return { city:areaCity||fall.city, state:areaState||fall.state };
  }

  const TERRITORY_CONFIG_MAP = {
    '1724797832896x339501352491155460': 'austin',
  };

  // Valid coupon codes → discount in dollars. Must match HA_COUPONS in
  // api/book.js, which is the enforcing copy — this one only gives instant
  // feedback pre-Stripe and shows the discount on the thank-you summary.
  const COUPONS = {
    MCDENVER20: 20, MP10: 10, AUS10: 10, HOU10: 10, DEN10: 10,
    ISREAL15: 15, STEVE15: 15, BATCITY10: 10, FBD15: 15, FB15: 15,
    ANNIVERSARY15: 15, BING10: 10, OLIVE10: 10, STV10: 10, G10TV: 10,
    TV2026: 10, HG20: 20, LA10: 10, AB20: 20, FBA20: 20, FB10: 10,
    LASTCHANCE10: 10,   // exit-intent offer
  };

  // Analytics tracking — session id is "<visitorId>.<sessionId>" so repeat visitors can be identified
  let _vid = '';
  try {
    _vid = localStorage.getItem('ha_vid') || '';
    if (!_vid) { _vid = Math.random().toString(36).slice(2, 10); localStorage.setItem('ha_vid', _vid); }
  } catch (e) {}
  const SESSION_ID = (_vid ? _vid + '.' : '') + Math.random().toString(36).slice(2, 10);
  function trafficSource() {
    try {
      const p = new URLSearchParams(window.location.search);
      const s = p.get('source') || p.get('utm_source');
      if (s) return s;
      if (document.referrer) {
        const h = new URL(document.referrer).hostname.replace(/^www\./, '');
        if (h && h !== location.hostname.replace(/^www\./, '')) return h;
      }
    } catch (e) {}
    return 'direct';
  }
  const TRAFFIC_SOURCE = trafficSource();
  async function logEvent(event_type, step_name, value = null, error_message = null) {
    try {
      const loc = resolveLocation();
      await fetch('https://handy-andy-booking.vercel.app/api/log-event', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: SESSION_ID,
          event_type,
          step_name,
          value,
          device_type: /Mobile/.test(navigator.userAgent) ? 'mobile' : 'desktop',
          traffic_source: TRAFFIC_SOURCE,
          city: loc.city,
          state: loc.state,
          zip_code: customer.zip || enteredZip || null,
          // Once the customer enters their name, every later event carries it so
          // the booking analytics can show who the session belongs to.
          customer_name: `${customer.first_name||''} ${customer.last_name||''}`.trim() || null,
          error_message,
        }),
      });
    } catch (e) { console.error('[analytics] log failed', e); }
  }
  // Log each step the first time the visitor reaches it — powers the drop-off funnel
  const _seenSteps = new Set();
  function trackStep(key) {
    if (_seenSteps.has(key)) return;
    _seenSteps.add(key);
    logEvent('step_view', key, STEP_KEYS.indexOf(key));
  }
  // Log what the visitor chose on the step they're leaving — powers per-question analytics
  function logStepAnswers(key) {
    try {
      if (key === 'frame_tv') {
        (selections['__frame_type'] || []).forEach(t =>
          logEvent('answer', 'frame_tv:' + (t === 'frame' ? 'Frame/Gallery TV' : 'Regular TV'), 1));
        return;
      }
      if (key === 'slots') {
        if (selectedDate) {
          const sl = (slotsByDate[selectedDate] || []).find(s => s.id === selectedSlot);
          logEvent('answer', 'slot:' + (sl ? sl.arrival_window : '') + ' on ' + selectedDate);
          const d = new Date(selectedDate + 'T12:00:00');
          logEvent('answer', 'slot_day:' + ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]);
        }
        return;
      }
      if (key === 'terms' || key === 'zip' || key === 'customer') return;
      const sec = getSec(key);
      if (!sec) return;
      for (const sel of (selections[sec.id] || [])) {
        const opt = sec.options.find(o => o.id === sel.option_id);
        if (opt && sel.quantity > 0) logEvent('answer', key + ':' + opt.label, sel.quantity);
      }
    } catch (e) {}
  }

  // Day-of-week discounts: 0=Sun(-$15), 2=Tue(-$10)
  const WEEKDAY_DISC = { 0:15, 2:10 };
  const TAX_RATE = 0.0825;

  // Per-territory distance surcharge for the outer Denver territories. This drives
  // the on-screen "Service area surcharge" line. Zenbooker has the same values
  // configured (Services → TV Installation → Territory Adjustments) but only applies
  // them through its hosted booking flow — NOT to API-created jobs — so api/book.js
  // charges the matching amount from territory_id. Keep these two maps in sync.
  const TERRITORY_ADJUSTMENTS = {
    '1707513178246x806633139915194400': 25, // Denver #2
    '1687393551618x123774611115737090': 35, // Denver #3
    '1723559782141x609094402068185100': 100, // Denver #4 Boulder/Colorado Springs
  };
  function territoryAdjustment(){ return NATIVE ? nativeSurcharge : (TERRITORY_ADJUSTMENTS[territoryId] || 0); }
  const ZIP_DISCOUNTS = { '77011': 10 };
  function zipDiscount(){ return ZIP_DISCOUNTS[customer.zip] || 0; }

  const STEP_KEYS = ['zip','frame_tv','size','bracket','fireplace','surface','wires','lifting','dismount','extras','terms','slots','customer'];

  // ─── Service configs (sections in DISPLAY order — surface before wires) ───
  const SERVICE_CONFIGS = {

    default: {
      service_id: '1685657518404x705274829881212200',
      minPrice: 139,
      frameBracketSectionId: '1685657518815x904945567500552400',
      frameBracketOptionId:  '1736123941131x483930420018151400',
      oneConnectSectionId:   '1698905037955x927897010830311400',
      oneConnectOptionId:    '1736124404151x401859929508413400',
      sections: [
        {
          stepKey:'size', id:'1685657518815x738855546477936600',
          title:'What size is your TV?', subtitle:'Tap + to add each TV you want mounted.',
          type:'qty_multi', required:true,
          options:[
            {id:'1685657519214x408615950244710660',label:'32" Or Less',price:99, sizecat:'small'},
            {id:'1685657519214x406129807645840830',label:'33"-59"',    price:109,sizecat:'small'},
            {id:'1685657519214x241977595988204900',label:'60"-69"',    price:119,sizecat:'small'},
            {id:'1685657519214x168809705059288930',label:'70"-85"',    price:149,sizecat:'medium'},
            {id:'1693451324278x246099356920840200',label:'86"-97"',    price:179,sizecat:'large'},
            {id:'1729566606709x280549383678984200',label:'98+',        price:229,sizecat:'xlarge'},
          ]
        },
        {
          stepKey:'bracket', id:'1685657518815x904945567500552400',
          title:'Should we bring a mounting bracket for your TV?', subtitle:'',
          type:'qty_match', required:true,
          options:[
            {id:'1685657519638x296785870103780400',label:'I have my own bracket',                  price:0,  forSize:'any'},
            {id:'1685657519638x151782031594280160',label:'Flat',                                   price:45, forSize:'standard'},
            {id:'1685657519638x293251872070913660',label:'Tilting (recommended)',                  price:60, forSize:'standard'},
            {id:'1685657519638x327788739524076600',label:'Full Motion',                            price:110, forSize:'standard'},
            {id:'1776229587207x710284994703786000',label:'85"-100" TV Flat Bracket',               price:90, forSize:'xl'},
            {id:'1776229598255x578976769128267800',label:'85"-100" TV Tilting Bracket',            price:110,forSize:'xl'},
            {id:'1776229610718x521138691917742100',label:'85"-100" TV Full Motion Bracket',        price:190,forSize:'xl'},
            {id:'1736123941131x483930420018151400',label:'I will be using the bracket that comes in the box (Samsung Frame TV)',price:25,forSize:'frame'},
          ]
        },
        {
          stepKey:'fireplace', id:'1690749164365x325157862659588100',
          title:'How many TVs are above a fireplace?',
          subtitle:'Built-in fireplaces only. Electric wall-mounted fireplaces do not count.',
          type:'qty_multi', required:true, enforceTVCount:true,
          options:[
            {id:'1690749164365x391343451869544450',label:'I have 1 TV not over a fireplace',price:0},
            {id:'1690749240392x103535038030413820',label:'I have 1 TV above a fireplace',   price:30},
          ]
        },
        {
          stepKey:'surface', id:'1685657518815x983733415074440800',
          title:'What Type Of Surface Will The TV Be Mounted To?',
          subtitle:'Metal studs (found in high-rises over 5 stories) are no extra charge.',
          type:'qty_multi', required:false, enforceTVCount:true,
          options:[
            {id:'1685657520672x628368921210809000',label:'Drywall',            price:0, isDrywall:true},
            {id:'1685657520672x962594124305617300',label:'Brick',              price:35},
            {id:'1685658012495x711713122836807700',label:'Uneven Stone or Tile',price:50},
            {id:'1692765788131x467716510198005800',label:'Outdoor/Stucco',     price:45},
          ]
        },
        {
          stepKey:'wires', id:'1685657518815x885290156996575900',
          title:'Would you like to hide the wires?',
          subtitle:'Select one per TV if needed.',
          type:'qty_multi', required:false,
          options:[
            {id:'1685657520215x679178310990983400',label:'Yes, hide the wires BEHIND the wall',      price:75, needsDrywall:true},
            {id:'1685657520215x860675929308834800',label:'Yes, hide the wires OUTSIDE the wall',     price:25},
            {id:'1685657520215x846697647726538900',label:'My wall already has a plug behind the TV', price:0,  hideForFrame:true},
            {id:'1696472636219x934279187941818400',label:'I want my wires to hang under the TV',     price:0},
          ]
        },
        {
          stepKey:'lifting', id:'1685657518815x490739273297617660',
          title:'TV Size & Lifting', subtitle:'',
          type:'single_select', required:true,
          options:[
            {id:'1685657521270x971699776821509000',label:'My TV is under 70 inches',                         price:0, forCat:'small'},
            {id:'1685657521270x242389337506608420',label:'My TV is 70–85 inches and I can help lift it',     price:0, forCat:'medium'},
            {id:'1685657521270x264421370121691100',label:'My TV is 70–85 inches and I cannot help lift it',  price:70,forCat:'medium'},
            {id:'1747842781494x315473919196528640',label:'My TV is 85 inches or larger',                     price:70,forCat:'large'},
          ]
        },
        {
          stepKey:'dismount', id:'1685657518815x122457217974422320',
          title:'Guaranteed Dismount Service', subtitle:'',
          type:'single_select', required:true,
          options:[
            {id:'1685657521717x559414519649398460',label:'Guaranteed Dismount Service',       price:35},
            {id:'1751646796269x538012740525228000',label:"No, I'll handle TV removal myself", price:0},
          ]
        },
        {
          stepKey:'extras', id:'1698905037955x927897010830311400',
          title:'Anything else?', subtitle:'Optional add-ons.',
          type:'qty_multi', required:false,
          options:[
            {id:'1736124404151x401859929508413400',label:'Install Samsung Frame OneConnect box behind the TV',price:350,frameOnly:true},
            {id:'1711776157524x348981049297469440',label:'Apple TV installation, mounting bracket included',  price:25},
            {id:'1698905037955x771952325080383500',label:'Soundbar Installation',                             price:50},
            {id:'1698905090848x173584167038615550',label:'Install shelf under TV',                            price:45},
            {id:'1698905111338x528324964985864200',label:'LED Lights',                                        price:50},
            {id:'1715820772054x920882061736149000',label:'1 hour of Handyman Labor',                          price:85,allowText:true},
            {id:'1698905159794x117137493532868600',label:'Other',                                             price:0,allowText:true},
          ]
        },
        {
          stepKey:'terms', id:'1685657518815x799846849511140000',
          title:'Terms of Service',
          subtitle:"Our technician will help determine the best TV mounting height during installation, but ultimately it's up to you. If you need to make any adjustments after the technician leaves, there'll be an extra charge. You can reschedule anytime unless within 24 hours of your appointment. Cancellations within 24 hours incur a $50 fee.",
          type:'terms', required:true,
          options:[{id:'1685657522669x480769611787828600',label:'I agree to the Terms of Service',price:0}]
        },
      ]
    },

    austin: {
      service_id: '1724797764673x959123834234875100',
      minPrice: 119,
      frameBracketSectionId: '1724797765050x234498034542901950',
      frameBracketOptionId:  '1736124206975x556289593228656640',
      oneConnectSectionId:   '1724797765050x213192360935727360',
      oneConnectOptionId:    '1741212168056x241358652217229300',
      sections: [
        {
          stepKey:'size', id:'1724797765050x841129871559158100',
          title:'What size is your TV?', subtitle:'Tap + to add each TV you want mounted.',
          type:'qty_multi', required:true,
          options:[
            {id:'1724797765604x727281068776260100',label:'32" Or Less',price:99, sizecat:'small'},
            {id:'1724797765604x481821025163112770',label:'33"-59"',    price:109, sizecat:'small'},
            {id:'1724797765604x438257538375731460',label:'60"-69"',    price:119,sizecat:'small'},
            {id:'1724797765604x518845267466906000',label:'70"-84"',    price:149,sizecat:'medium'},
            {id:'1724797765604x143841244367788560',label:'85"-97"',    price:179,sizecat:'large'},
            {id:'1729568390396x482351028241694700',label:'98+',        price:229,sizecat:'xlarge'},
          ]
        },
        {
          stepKey:'bracket', id:'1724797765050x234498034542901950',
          title:'Should we bring a mounting bracket for your TV?', subtitle:'',
          type:'qty_match', required:true,
          options:[
            {id:'1724797766027x710120034063080800',label:'I have my own bracket',          price:0,  forSize:'any'},
            {id:'1724797766027x695942754553271000',label:'Flat',                           price:35, forSize:'standard'},
            {id:'1724797766027x943964834449722200',label:'Tilting (recommended)',          price:50, forSize:'standard'},
            {id:'1724797766027x264025092172061950',label:'Full Motion',                   price:85, forSize:'standard'},
            {id:'1776229836315x648480753516806100',label:'85"-100" TV Flat Bracket',      price:90, forSize:'xl'},
            {id:'1776229850923x848868840944959500',label:'85"-100" TV Tilting Bracket',   price:110,forSize:'xl'},
            {id:'1776229863741x796966835269926900',label:'85"-100" TV Full Motion Bracket',price:190,forSize:'xl'},
            {id:'1736124206975x556289593228656640',label:'I will be using the bracket that comes in the box (Samsung Frame TV)',price:25,forSize:'frame'},
          ]
        },
        {
          stepKey:'fireplace', id:'1724797765050x593496857537082900',
          title:'How many TVs are above a fireplace?',
          subtitle:'Built-in fireplaces only. Electric wall-mounted fireplaces do not count.',
          type:'qty_multi', required:true, enforceTVCount:true,
          options:[
            {id:'1724797766490x787769899631215200',label:'I have 1 TV not over a fireplace',price:0},
            {id:'1724797766490x438470170995459460',label:'I have 1 TV above a fireplace',   price:35},
          ]
        },
        {
          stepKey:'surface', id:'1724797765050x772248118717189900',
          title:'What Type Of Surface Will The TV Be Mounted To?',
          subtitle:'Metal studs are no extra charge.',
          type:'qty_multi', required:false, enforceTVCount:true,
          options:[
            {id:'1724797767239x185050352406898050',label:'Drywall',             price:0, isDrywall:true},
            {id:'1724797767239x584976221219833100',label:'Brick',               price:35},
            {id:'1724797767239x159866758831751040',label:'Uneven Stone or Tile',price:50},
            {id:'1724797767239x571833870984715500',label:'Outdoor/Stucco',      price:45},
          ]
        },
        {
          stepKey:'wires', id:'1724797765050x927635225756017200',
          title:'Would you like to hide the wires?', subtitle:'',
          type:'qty_multi', required:false,
          options:[
            {id:'1724797766922x649390430397306400',label:'Yes, hide the wires BEHIND the wall',      price:65,needsDrywall:true},
            {id:'1724797766922x870013576516632800',label:'Yes, hide the wires OUTSIDE the wall',     price:30},
            {id:'1724797766922x460684749103141800',label:'My wall already has a plug behind the TV', price:0, hideForFrame:true},
            {id:'1724797766922x646841379925741600',label:'I want my wires to hang under the TV',     price:0},
          ]
        },
        {
          stepKey:'lifting', id:'1724797765050x175556423249628740',
          title:'TV Size & Lifting', subtitle:'',
          type:'single_select', required:true,
          options:[
            {id:'1724797767615x862955223994130700',label:'My TV is under 70 inches',                        price:0, forCat:'small'},
            {id:'1724797767615x715957457515909400',label:'My TV is 70–85 inches and I can help lift it',    price:0, forCat:'medium'},
            {id:'1727409857684x617202431885574100',label:'My TV is 70–85 inches and I cannot help lift it', price:70,forCat:'medium'},
            {id:'1747843192832x310647085776502800',label:'My TV is 85 inches or larger',                    price:70,forCat:'large'},
          ]
        },
        {
          stepKey:'dismount', id:'1724797765050x244604568865458100',
          title:'Guaranteed Dismount Service', subtitle:'',
          type:'single_select', required:true,
          options:[
            {id:'1724797767881x240367043608421540',label:'Guaranteed Dismount Service',       price:35},
            {id:'1751646857916x242648686812463100',label:"No, I'll handle TV removal myself", price:0},
          ]
        },
        {
          stepKey:'extras', id:'1724797765050x213192360935727360',
          title:'Anything else?', subtitle:'Optional add-ons.',
          type:'qty_multi', required:false,
          options:[
            {id:'1741212168056x241358652217229300',label:'Install Samsung Frame OneConnect box behind the TV',price:350,frameOnly:true},
            {id:'1724797768116x299580540855954900',label:'Soundbar Installation', price:45},
            {id:'1724797768116x917721356073396700',label:'Install shelf under TV', price:45},
            {id:'1724797768116x423659180367796740',label:'LED Lights',             price:45},
            {id:'1724797768116x234539799179230620',label:'1 hour of Handyman Labor',price:85,allowText:true},
            {id:'1724797768116x790768026842265000',label:'Other',                  price:0,allowText:true},
          ]
        },
        {
          stepKey:'terms', id:'1724797765050x430508661186572740',
          title:'Terms of Service',
          subtitle:'Our technician will help determine the best TV mounting height. Adjustments after they leave incur an extra charge. Cancellations within 24 hours incur a $50 fee.',
          type:'terms', required:true,
          options:[{id:'1724797768519x561520623913572350',label:'I agree to the Terms of Service',price:0}]
        },
      ]
    }
  };

  // ─── State ────────────────────────────────────────────────────────────────
  let stepIdx=0, isFrameTV=false, territoryId='', enteredZip='', areaCity='', areaState='';
  let serviceConfig=null, selections={}, selectedSlot=null;
  let slotsByDate={}, selectedDate=null, calYear=null, calMonth=null;
  let customer={first_name:'',last_name:'',email:'',phone:'',address:'',address_line2:''};
  let tipAmount=0, couponCode='';
  let optionComments={}; // { [optionId]: "free text" } for Handyman / Other
  // Hard guard against double-booking: once a booking POST is in flight we never
  // fire a second one, so repeated "Complete My Booking" clicks can't create
  // duplicate Zenbooker jobs (especially when the server is slow to respond).
  let isSubmitting=false;
  // Stable per-page idempotency key, reused across retries of the same booking so
  // the server can recognize a repeat submission instead of creating a new job.
  const BOOKING_IDEM_KEY='ha_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  // Stripe
  let _stripe=null, _stripeElements=null, _stripeCard=null;
  // Live card validity, driven by the Element's `change` event. Lets us block a
  // submit on an incomplete card BEFORE calling Stripe (the #1 checkout failure
  // was "card number is incomplete" — people tapping Complete with a half-filled
  // card, especially on mobile) and show the error inline instead of an alert.
  let _cardComplete=false;

  // ─── State helpers ────────────────────────────────────────────────────────
  function getSec(k){ return serviceConfig?.sections.find(s=>s.stepKey===k); }
  function getQty(sid,oid){ return(selections[sid]||[]).find(x=>x.option_id===oid)?.quantity||0; }
  function setQty(sid,oid,q){
    if(!selections[sid])selections[sid]=[];
    const i=selections[sid].findIndex(x=>x.option_id===oid);
    if(q<=0){if(i!==-1)selections[sid].splice(i,1);}
    else if(i!==-1)selections[sid][i].quantity=q;
    else selections[sid].push({option_id:oid,quantity:q});
  }
  function toggleOpt(sid,oid){setQty(sid,oid,getQty(sid,oid)>0?0:1);}
  function selectOnly(sid,oid){selections[sid]=[{option_id:oid,quantity:1}];}

  function getMaxSizeCat(){
    const sec=getSec('size'); if(!sec)return 'small';
    const sels=selections[sec.id]||[];
    for(const s of sels){if(sec.options.find(o=>o.id===s.option_id)?.sizecat==='xlarge')return 'xlarge';}
    for(const s of sels){if(sec.options.find(o=>o.id===s.option_id)?.sizecat==='large')return 'large';}
    for(const s of sels){if(sec.options.find(o=>o.id===s.option_id)?.sizecat==='medium')return 'medium';}
    return 'small';
  }
  // Independent size checks — both can be true for mixed orders
  function hasStandardTV(){
    const sec=getSec('size');if(!sec)return false;
    return(selections[sec.id]||[]).some(s=>{
      const o=sec.options.find(x=>x.id===s.option_id);
      return o&&(o.sizecat==='small'||o.sizecat==='medium')&&s.quantity>0;
    });
  }
  function hasLargeTV(){
    const sec=getSec('size');if(!sec)return false;
    return(selections[sec.id]||[]).some(s=>{
      const o=sec.options.find(x=>x.id===s.option_id);
      return o&&(o.sizecat==='large'||o.sizecat==='xlarge')&&s.quantity>0;
    });
  }
  function hasXLargeTV(){
    const sec=getSec('size');if(!sec)return false;
    return(selections[sec.id]||[]).some(s=>{
      const o=sec.options.find(x=>x.id===s.option_id);
      return o&&o.sizecat==='xlarge'&&s.quantity>0;
    });
  }
  function totalTVs(){
    const sec=getSec('size'); if(!sec)return 0;
    return(selections[sec.id]||[]).reduce((s,x)=>s+x.quantity,0);
  }
  function hasFireplace(){
    const sec=getSec('fireplace'); if(!sec)return false;
    return(selections[sec.id]||[]).some(s=>{
      const opt=sec.options.find(o=>o.id===s.option_id);
      return opt&&opt.price>0&&s.quantity>0;
    });
  }
  function hasDrywall(){
    const sec=getSec('surface'); if(!sec)return true;
    const sels=selections[sec.id]||[]; if(!sels.length)return true;
    const did=sec.options.find(o=>o.isDrywall)?.id;
    return sels.some(s=>s.option_id===did&&s.quantity>0);
  }
  // Show "behind the wall" if ANY TV has drywall AND no TVs are above a fireplace (can't run wires behind fireplaces)
  function canHideBehindWall(){ return hasDrywall() && !hasFireplace(); }
  // Denver requires 2 techs for 98"+ TVs (techs work solo there; other cities have helpers)
  function needsTwoTechs(){ return isDenver() && hasXLargeTV(); }

  function shouldSkip(k){
    // Skip bracket only if ALL TVs are Frame/Gallery (no regular TVs mixed in)
    if(k==='bracket'){
      const onlyFrame=isFrameTV&&!(selections['__frame_type']||[]).includes('regular');
      if(onlyFrame)return true;
    }
    if(k==='lifting'){
      const cat=getMaxSizeCat();
      if(cat==='small')return true;
      // Skip lifting entirely for 98"+ TVs outside Denver (no 2-tech requirement there)
      if(cat==='xlarge'&&territoryId!==DENVER_ID)return true;
    }
    return false;
  }
  function visibleStepNum(){let n=0;for(let i=0;i<=stepIdx;i++)if(!shouldSkip(STEP_KEYS[i]))n++;return n;}
  function totalVisibleSteps(){let n=0;for(const k of STEP_KEYS)if(!shouldSkip(k))n++;return n;}

  function getDateDiscount(ds){
    const d=new Date(ds+'T12:00:00'), h=(d-new Date())/3600000;
    let disc=WEEKDAY_DISC[d.getDay()]||0;
    if(h>=251)disc+=20; else if(h>=150)disc+=10;
    return disc;
  }
  function fmtDate(ds){
    const d=new Date(ds+'T12:00:00');
    const dn=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const mn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return{short:dn[d.getDay()],long:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()],date:`${mn[d.getMonth()]} ${d.getDate()}`};
  }

  function ensureStripe(){
    return new Promise(resolve=>{
      if(_stripe){resolve();return;}
      function init(){
        _stripe=window.Stripe(STRIPE_KEY);
        _stripeElements=_stripe.elements();
        _stripeCard=_stripeElements.create('card',{
          style:{
            base:{color:'#fff',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',fontSize:'16px','::placeholder':{color:'#71717a'}},
            invalid:{color:'#ef4444'},
          },
          hidePostalCode:true,
        });
        // Live feedback: reflect the Element's validity into the inline error line
        // under the field (created at render time) and track completeness so the
        // submit handler can stop an incomplete card before it ever hits Stripe.
        _stripeCard.on('change',(ev)=>{
          _cardComplete=!!ev.complete;
          const errEl=document.getElementById('stripe-card-errors');
          if(errEl) errEl.textContent = (ev.error && ev.error.message) ? ev.error.message : '';
        });
        resolve();
      }
      if(window.Stripe){init();return;}
      const s=document.createElement('script');
      s.src='https://js.stripe.com/v3/';
      s.onload=init;
      document.head.appendChild(s);
    });
  }
  function mountStripeCard(){
    const el=document.getElementById('stripe-card-element');
    if(!el||!_stripeCard)return;
    // Stripe auto-unmounts from old node and re-mounts here
    _stripeCard.mount(el);
  }
  function calcTotal(){
    if(!serviceConfig)return 0;
    let sum=0;
    for(const sec of serviceConfig.sections){
      for(const sel of(selections[sec.id]||[])){
        const opt=sec.options.find(o=>o.id===sel.option_id);
        if(opt)sum+=(opt.price||0)*sel.quantity;
      }
    }
    // Also count OneConnect if selected on wires card (stored in extras section)
    // — already included above since extras section is iterated
    return Math.max(sum, serviceConfig.minPrice||139);
  }
  // Customer-facing itemized line items for the checkout summary AND the thank-you page.
  // Only options that actually cost money are listed — a $0 selection (e.g. "I can help
  // lift it / no second technician needed") is omitted so it never looks like a free add-on.
  // The paid lifting option is relabeled "Second Technician" so the receipt reads cleanly.
  function buildLineItems(){
    if(!serviceConfig)return [];
    const liftSec=getSec('lifting');
    const items=[];
    for(const sec of serviceConfig.sections){
      for(const sel of(selections[sec.id]||[])){
        const opt=sec.options.find(o=>o.id===sel.option_id);
        if(!opt)continue;
        const amount=Math.round((opt.price||0)*sel.quantity*100)/100;
        if(amount<=0)continue; // hide $0 selections (incl. the "no second technician" choice)
        const label=(liftSec&&sec.id===liftSec.id)?'Second Technician':opt.label;
        items.push({label,qty:sel.quantity,amount});
      }
    }
    // Reconcile with the service minimum so the lines always sum to the subtotal.
    const sum=items.reduce((s,it)=>s+it.amount,0);
    const floored=calcTotal();
    if(floored>sum+0.001)items.push({label:'Service minimum',qty:1,amount:Math.round((floored-sum)*100)/100});
    return items;
  }
  // Running total shown in the sticky footer bar on every step (except zip,
  // before we know the service area, and customer, which already shows its own
  // full breakdown). Mirrors the exact formula bCustomer() uses for its
  // subtotal, so the number the customer watches grow never disagrees with the
  // one they see at checkout.
  function footerTotal(){
    return calcTotal()+territoryAdjustment()-zipDiscount()+selectedSlotSurcharge();
  }
  function slotSurcharge(sl,ds){
    const m=sl.arrival_window.match(/^(\d+)(?::\d+)?\s*(AM|PM)/i);
    if(!m)return 0;let h=parseInt(m[1]);
    if(m[2].toUpperCase()==='PM'&&h!==12)h+=12;
    if(m[2].toUpperCase()==='AM'&&h===12)h=0;
    if(h<20)return 0;
    // After-hours fee mirrors Zenbooker: $100 on Sundays, $75 every other day.
    const isSunday=ds?new Date(ds+'T12:00:00').getDay()===0:false;
    return isSunday?100:75;
  }
  // After-hours fee for the currently selected slot. $75 for any job starting at
  // 8 PM or later. The server (api/book.js) independently recomputes & enforces
  // this so it is charged even if a stale cached widget doesn't send it.
  function selectedSlotSurcharge(){
    if(!selectedSlot||!selectedDate)return 0;
    const sl=(slotsByDate[selectedDate]||[]).find(s=>s.id===selectedSlot);
    return sl?slotSurcharge(sl,selectedDate):0;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────
  const S={
    host:'display:block!important;visibility:visible!important;position:relative!important;z-index:999999!important;background:#18181c!important;border:1px solid #2d2d34!important;border-radius:12px!important;padding:28px!important;box-shadow:0 10px 30px rgba(0,0,0,0.5)!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;box-sizing:border-box!important;color:#fff!important;',
    bar:'background:#2d2d34!important;height:6px!important;border-radius:3px!important;margin-bottom:16px!important;overflow:hidden!important;display:block!important;',
    fill:p=>`background:#ff6600!important;height:100%!important;width:${p}%!important;display:block!important;transition:width .3s!important;`,
    step:'color:#71717a!important;font-size:12px!important;text-transform:uppercase!important;letter-spacing:1px!important;display:block!important;margin-bottom:18px!important;',
    h1:'margin:0 0 8px 0!important;font-size:22px!important;font-weight:800!important;color:#fff!important;display:block!important;line-height:1.3!important;',
    sub:'color:#a0a0ab!important;font-size:13px!important;display:block!important;margin-bottom:16px!important;line-height:1.5!important;',
    input:'width:100%!important;padding:14px 16px!important;background:#27272a!important;border:1px solid #3f3f46!important;color:#fff!important;border-radius:8px!important;font-size:17px!important;box-sizing:border-box!important;margin-bottom:20px!important;display:block!important;text-align:center!important;',
    inputL:'width:100%!important;padding:11px 14px!important;background:#27272a!important;border:1px solid #3f3f46!important;color:#fff!important;border-radius:6px!important;font-size:15px!important;box-sizing:border-box!important;margin-bottom:12px!important;display:block!important;',
    btnPri:'background:#ff6600!important;color:#fff!important;border:none!important;padding:13px 26px!important;font-size:15px!important;font-weight:700!important;border-radius:8px!important;cursor:pointer!important;display:inline-block!important;',
    btnSec:'background:transparent!important;color:#a0a0ab!important;border:1px solid #3f3f46!important;padding:10px 20px!important;font-size:14px!important;border-radius:6px!important;cursor:pointer!important;display:inline-block!important;',
    btnDis:'background:#2d2d34!important;color:#52525b!important;border:none!important;padding:13px 26px!important;font-size:15px!important;font-weight:700!important;border-radius:8px!important;cursor:not-allowed!important;display:inline-block!important;',
    actions:'display:flex!important;justify-content:space-between!important;align-items:center!important;margin-top:20px!important;',
    card:on=>`background:${on?'rgba(255,102,0,0.1)':'#27272a'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:8px!important;padding:13px 15px!important;color:#fff!important;display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:8px!important;font-size:14px!important;cursor:pointer!important;`,
    qRow:on=>`background:${on?'rgba(255,102,0,0.1)':'#27272a'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:8px!important;padding:11px 14px!important;color:#fff!important;display:flex!important;align-items:center!important;margin-bottom:8px!important;font-size:14px!important;`,
    qBtn:'background:#3f3f46!important;color:#fff!important;border:none!important;width:30px!important;height:30px!important;border-radius:6px!important;font-size:18px!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0!important;',
    qNum:'color:#ff6600!important;font-weight:700!important;font-size:17px!important;min-width:22px!important;text-align:center!important;display:inline-block!important;',
    info:'background:rgba(255,102,0,0.1)!important;border:1px solid rgba(255,102,0,0.35)!important;border-radius:7px!important;padding:10px 14px!important;margin-bottom:14px!important;font-size:13px!important;color:#ff9944!important;display:block!important;',
    ok:'background:rgba(34,197,94,0.1)!important;border:1px solid rgba(34,197,94,0.35)!important;border-radius:7px!important;padding:10px 14px!important;margin-bottom:14px!important;font-size:13px!important;color:#4ade80!important;display:block!important;',
    price:p=>p>0?` <span style="color:#a0a0ab!important;font-size:12px!important;">(+$${p})</span>`:'',
    // Bracket-comparison help link, shown above the bracket step's options only.
    helpLink:'color:#ff9955!important;font-size:12.5px!important;text-decoration:underline!important;cursor:pointer!important;display:inline-block!important;margin-bottom:14px!important;background:none!important;border:none!important;padding:0!important;font-family:inherit!important;',
    // Sticky running-total footer — bleeds to the host's own edges (host padding
    // is 28px, so -28px margins here reach the card's border) and sits as the
    // last thing on every step so the price a customer is building stays visible
    // the whole time, instead of arriving as one number at the very end.
    footerBar:t=>`<div style="margin:18px -28px -28px!important;padding:12px 28px!important;background:#0e0e10!important;border-top:1px solid #2d2d34!important;display:flex!important;justify-content:space-between!important;align-items:center!important;font-size:13px!important;">
      <span style="color:#a0a0ab!important;">Estimated total</span>
      <span style="font-weight:800!important;font-size:17px!important;color:#ff9944!important;">$${t}</span>
    </div>`,
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  function render(){
    const root=document.getElementById(TARGET_ID); if(!root)return;
    root.style.cssText=S.host;
    const key=STEP_KEYS[stepIdx];
    trackStep(key);
    const pct=Math.round(visibleStepNum()/totalVisibleSteps()*100);
    const prog=key==='zip'?'':`<div style="${S.bar}"><div style="${S.fill(pct)}"></div></div><div style="${S.step}">Step ${visibleStepNum()} of ${totalVisibleSteps()}</div>`;
    let body='';
    switch(key){
      case 'zip':      body=bZip();      break;
      case 'frame_tv': body=bFrameTV();  break;
      case 'size':     body=bSize();     break;
      case 'bracket':  body=bBracket();  break;
      case 'fireplace':body=bGeneric(getSec('fireplace')); break;
      case 'surface':  body=bGeneric(getSec('surface'));   break;
      case 'wires':    body=bWires();    break;
      case 'lifting':  body=bLifting();  break;
      case 'dismount': body=bDismount(); break;
      case 'extras':   body=bExtras();   break;
      case 'terms':    body=bTerms();    break;
      case 'slots':    body=bSlots();    break;
      case 'customer': body=bCustomer(); logEvent('price_displayed', 'customer', calcTotal()+territoryAdjustment()); break;
    }
    // Running total on every step except 'zip' (service area/pricing profile
    // isn't known yet) and 'customer' (bCustomer() already shows its own full
    // itemized breakdown, so a second total would be redundant there).
    const footer=(key==='zip'||key==='customer')?'':S.footerBar(Math.round(footerTotal()*100)/100);
    root.innerHTML=prog+body+footer;
    wire(root);
    // Mount Stripe card element after DOM is ready
    if(key==='customer'){
      ensureStripe().then(mountStripeCard);
      armExitIntent();
    }
  }

  // ─── Exit intent (customer/checkout step only, once per page load) ────────
  // Two device-native triggers for the same offer: desktop mouse exits upward
  // through the top of the viewport (mouseout with no relatedTarget); back
  // button / back-swipe on mobile or desktop, via a trapped history entry.
  // Whichever fires first shows the modal; only once per session.
  let exitIntentArmed=false, exitIntentShown=false;
  const EXIT_COUPON='LASTCHANCE10';
  function armExitIntent(){
    if(exitIntentArmed||exitIntentShown)return;
    exitIntentArmed=true;
    document.addEventListener('mouseout',onExitMouseOut);
    try{ history.pushState({haExitTrap:true},'',location.href); }catch(e){}
    window.addEventListener('popstate',onExitPopState);
  }
  function onExitMouseOut(e){
    if(!e.relatedTarget&&!e.toElement&&e.clientY<=0)showExitIntentModal();
  }
  function onExitPopState(){
    if(exitIntentShown)return;
    try{ history.pushState({haExitTrap:true},'',location.href); }catch(e){}
    showExitIntentModal();
  }
  function disarmExitIntent(){
    exitIntentArmed=false;
    document.removeEventListener('mouseout',onExitMouseOut);
    window.removeEventListener('popstate',onExitPopState);
  }
  function showExitIntentModal(){
    if(exitIntentShown)return;
    exitIntentShown=true;
    disarmExitIntent();
    logEvent('answer','exit_intent_shown');
    const ov=document.createElement('div');
    ov.id='ha-exit-ov';
    ov.style.cssText='position:fixed!important;inset:0!important;z-index:9999999!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;background:rgba(10,9,8,0.75)!important;';
    ov.innerHTML=`
      <div style="position:relative!important;width:100%!important;max-width:360px!important;background:#18181c!important;border:1px solid #2d2d34!important;border-radius:12px!important;padding:26px 22px!important;box-shadow:0 14px 30px rgba(0,0,0,0.5)!important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif!important;color:#fff!important;text-align:center!important;">
        <button id="ha-exit-x" aria-label="Close" style="position:absolute!important;top:10px!important;right:12px!important;background:none!important;border:none!important;color:#a0a0ab!important;font-size:18px!important;cursor:pointer!important;padding:4px!important;">✕</button>
        <div style="font-size:17px!important;font-weight:800!important;margin:0 0 6px!important;">Wait — don't lose your spot</div>
        <div style="font-size:13px!important;color:#a0a0ab!important;margin:0 0 16px!important;line-height:1.5!important;">Here's $10 off to lock in today's price.</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace!important;font-weight:800!important;letter-spacing:0.05em!important;background:rgba(255,102,0,0.14)!important;border:1px solid rgba(255,102,0,0.4)!important;color:#ff9944!important;padding:7px 15px!important;border-radius:8px!important;display:inline-block!important;margin-bottom:16px!important;font-size:13.5px!important;">${EXIT_COUPON}</div>
        <div>
          <button id="ha-exit-apply" style="${S.btnPri};width:100%!important;">Apply $10 off &amp; continue</button>
          <button id="ha-exit-close" style="${S.btnSec};width:100%!important;margin-top:9px!important;">No thanks</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close=reason=>{ ov.remove(); logEvent('answer','exit_intent_'+reason); };
    ov.querySelector('#ha-exit-x').addEventListener('click',()=>close('dismissed'));
    ov.querySelector('#ha-exit-close').addEventListener('click',()=>close('dismissed'));
    ov.querySelector('#ha-exit-apply').addEventListener('click',()=>{
      couponCode=EXIT_COUPON;
      const f=document.getElementById('c-coupon'); if(f)f.value=EXIT_COUPON;
      close('applied');
    });
  }

  // ─── Step builders ────────────────────────────────────────────────────────

  function bZip(){
    return `
      <div style="text-align:center!important;">
        <h1 style="${S.h1};font-size:26px!important;text-align:center!important;">Do we service your area?</h1>
        <p style="${S.sub};text-align:center!important;font-size:15px!important;">Enter your zip code to see.</p>
        <input type="text" id="ha-zip" style="${S.input}" placeholder="e.g. 77001" maxlength="5" inputmode="numeric" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,5)">
        <div style="text-align:center!important;">
          <button id="btn-zip" style="${S.btnPri};padding:12px 36px!important;font-size:16px!important;">Check Area →</button>
        </div>
      </div>`;
  }

  function bFrameTV(){
    // Multi-select: customer can have Frame TVs, regular TVs, or both
    const frameOn=(selections['__frame_type']||[]).includes('frame');
    const regOn=(selections['__frame_type']||[]).includes('regular');
    const anySelected=frameOn||regOn;
    return `
      <h1 style="${S.h1}">What type of TV(s) are you mounting?</h1>
      <p style="${S.sub}">Select all that apply. Samsung Frame and LG Gallery TVs use the bracket that comes in the box.</p>
      <div class="ha-tv-type" data-type="regular" style="${S.card(regOn)}">
        <span>I have a regular TV</span>
        <span style="color:${regOn?'#ff6600':'#52525b'}!important;font-size:18px!important;">${regOn?'✓':'☐'}</span>
      </div>
      <div class="ha-tv-type" data-type="frame" style="${S.card(frameOn)}">
        <span>I have a Samsung Frame TV or LG Gallery TV</span>
        <span style="color:${frameOn?'#ff6600':'#52525b'}!important;font-size:18px!important;">${frameOn?'✓':'☐'}</span>
      </div>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${anySelected?S.btnPri:S.btnDis}" ${!anySelected?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bSize(){
    const sec=getSec('size');
    const opts=sec.options.map(o=>{
      const q=getQty(sec.id,o.id);
      return `<div style="${S.qRow(q>0)}">
        <span style="flex:1!important;">${o.label}</span>
        <div style="display:flex!important;align-items:center!important;gap:8px!important;flex-shrink:0!important;">
          <button class="ha-dec" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">−</button>
          <span style="${S.qNum}">${q}</span>
          <button class="ha-inc" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">+</button>
        </div>
      </div>`;
    }).join('');
    const ok=totalTVs()>0;
    return `<h1 style="${S.h1}">${sec.title}</h1><p style="${S.sub}">${sec.subtitle}</p>${opts}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${ok?S.btnPri:S.btnDis}" ${!ok?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bBracket(){
    const sec=getSec('bracket');
    const tvs=totalTVs(), brks=(selections[sec.id]||[]).reduce((s,x)=>s+x.quantity,0);
    const showStd=hasStandardTV(), showXL=hasLargeTV();
    const mixed=showStd&&showXL;
    const hasRegularTV=!(selections['__frame_type']||[]).length||((selections['__frame_type']||[]).includes('regular'));
    // Show standard brackets if any standard TV, XL brackets if any large TV, frame bracket if any Frame TV
    const visible=sec.options.filter(o=>{
      if(o.forSize==='frame')return isFrameTV; // show frame bracket if they have a Frame TV
      if(o.forSize==='any')return hasRegularTV; // "own bracket" only relevant for regular TVs
      if(o.forSize==='standard')return showStd&&hasRegularTV;
      if(o.forSize==='xl')return showXL&&hasRegularTV;
      return true;
    });
    const banner=brks<tvs
      ?`<div style="${S.info}">📺 You have <strong>${tvs} TV${tvs>1?'s':''}</strong> — select <strong>${tvs-brks}</strong> more bracket${tvs-brks>1?'s':''}.</div>`
      :`<div style="${S.ok}">✓ All ${tvs} TV${tvs>1?'s':''} have a bracket assigned.</div>`;
    const subtitle=`You have ${tvs} TV${tvs>1?'s':''} — select ${tvs} bracket${tvs>1?'s':''} total.${mixed?' Both standard and large bracket options are shown for your mixed TV sizes.':''}`;
    const opts=visible.map(o=>{
      const q=getQty(sec.id,o.id);
      return `<div style="${S.qRow(q>0)}">
        <span style="flex:1!important;">${o.label}${S.price(o.price)}</span>
        <div style="display:flex!important;align-items:center!important;gap:8px!important;flex-shrink:0!important;">
          <button class="ha-dec" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">−</button>
          <span style="${S.qNum}">${q}</span>
          <button class="ha-inc" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">+</button>
        </div>
      </div>`;
    }).join('');
    const ok=brks===tvs&&tvs>0;
    // Resolve which visible option id is Flat/Tilting/Full Motion (standard or
    // XL wording both match) so the help popup's "Add to my order" buttons can
    // target the right option no matter which TV size is in play.
    const findBracket=name=>{
      const o=visible.find(o=>o.label===name||o.label.endsWith(name+' Bracket'));
      return o?o.id:'';
    };
    const helpIds=`data-sec="${sec.id}" data-flat="${findBracket('Flat')}" data-tilt="${findBracket('Tilting (recommended)')}" data-full="${findBracket('Full Motion')}"`;
    return `<h1 style="${S.h1}">${sec.title}</h1><p style="${S.sub}">${subtitle}</p>
      <button id="ha-bracket-help" ${helpIds} style="${S.helpLink}">Which bracket is right for me</button>
      ${banner}${opts}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${ok?S.btnPri:S.btnDis}" ${!ok?'disabled':''}>Continue →</button>
      </div>`;
  }

  // ─── Bracket comparison popup ───────────────────────────────────────────────
  // Educational modal shown from the bracket step so a customer who has never
  // shopped for a TV mount can see the difference between Flat/Tilting/Full
  // Motion before picking. Each panel has its own "Add to my order" button that
  // sets that bracket type's quantity directly (capped at how many are still
  // needed) so a customer can decide and act without leaving the popup, then
  // hits Continue back on the step once they close it.
  function bracketHelpPanel(numLabel,numBg,title,tagBg,tagColor,tagText,barBg,diagramBg,diagramSvg,desc,pros,cons,optId,sectionId,btnLabel){
    const prosHtml=pros.map(p=>`<li>${p}</li>`).join('');
    const consHtml=cons.map(c=>`<li>${c}</li>`).join('');
    const addBtn=optId?`<button class="ha-bracket-add" data-s="${sectionId}" data-o="${optId}" style="margin-top:12px!important;width:100%!important;background:#f07422!important;color:#fff!important;border:none!important;padding:10px!important;border-radius:8px!important;font-weight:700!important;font-size:13px!important;cursor:pointer!important;">${btnLabel}</button>`:'';
    return `<div style="padding:20px 20px 24px;border-bottom:1px solid #e7eaf3;">
      <div style="height:5px;border-radius:3px;margin-bottom:14px;background:${barBg};"></div>
      <div style="border-radius:12px;height:150px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;background:${diagramBg};">${diagramSvg}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="width:22px;height:22px;border-radius:50%;background:${numBg};color:#fff;font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;">${numLabel}</span>
        <span style="font-size:18px;font-weight:800;color:#1a2f6b;">${title}</span>
      </div>
      <span style="display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.06em;padding:4px 11px;border-radius:20px;margin-bottom:12px;text-transform:uppercase;background:${tagBg};color:${tagColor};">${tagText}</span>
      <div style="font-size:13.5px;line-height:1.4;color:#33415f;margin-bottom:10px;">${desc}</div>
      <div style="font-size:11px;letter-spacing:.1em;margin:0 0 6px;color:#1e9e5a;">PROS</div>
      <ul style="list-style:none;margin-bottom:8px;">${prosHtml.replace(/<li>/g,'<li style="font-size:13.5px;line-height:1.4;padding:3px 0 3px 20px;position:relative;color:#33415f;"><span style="position:absolute;left:0;color:#1e9e5a;font-weight:700;">&#10003;</span>')}</ul>
      <div style="font-size:11px;letter-spacing:.1em;margin:0 0 6px;color:#d94141;">CONS</div>
      <ul style="list-style:none;">${consHtml.replace(/<li>/g,'<li style="font-size:13.5px;line-height:1.4;padding:3px 0 3px 20px;position:relative;color:#33415f;"><span style="position:absolute;left:0;color:#d94141;font-weight:700;">&#10007;</span>')}</ul>
      ${addBtn}
    </div>`;
  }

  const BRACKET_SVGS={
    flat:`<svg viewBox="0 0 300 190" width="100%" height="100%">
      <rect x="20" y="10" width="16" height="170" fill="#8fa2cc"/>
      <line x1="24" y1="25" x2="32" y2="17" stroke="#748ac0" stroke-width="2"/>
      <line x1="24" y1="65" x2="32" y2="57" stroke="#748ac0" stroke-width="2"/>
      <line x1="24" y1="105" x2="32" y2="97" stroke="#748ac0" stroke-width="2"/>
      <line x1="24" y1="145" x2="32" y2="137" stroke="#748ac0" stroke-width="2"/>
      <rect x="36" y="55" width="7" height="80" rx="2" fill="#1a2f6b"/>
      <rect x="43" y="30" width="14" height="130" rx="3" fill="#22304f"/>
      <rect x="57" y="34" width="4" height="122" rx="2" fill="#3d4f78"/>
      <line x1="70" y1="95" x2="150" y2="95" stroke="#1a2f6b" stroke-width="2" stroke-dasharray="5 4"/>
      <polygon points="70,95 80,90 80,100" fill="#1a2f6b"/>
      <text x="158" y="100" font-size="16" font-weight="700" fill="#1a2f6b" font-family="Arial">FLUSH</text>
      <text x="158" y="118" font-size="11" fill="#5b6a8c" font-family="Arial">sits about 1 inch from wall</text>
    </svg>`,
    tilt:`<svg viewBox="0 0 300 190" width="100%" height="100%">
      <rect x="20" y="10" width="16" height="170" fill="#e8b48c"/>
      <line x1="24" y1="25" x2="32" y2="17" stroke="#d99a68" stroke-width="2"/>
      <line x1="24" y1="65" x2="32" y2="57" stroke="#d99a68" stroke-width="2"/>
      <line x1="24" y1="105" x2="32" y2="97" stroke="#d99a68" stroke-width="2"/>
      <line x1="24" y1="145" x2="32" y2="137" stroke="#d99a68" stroke-width="2"/>
      <rect x="36" y="70" width="14" height="50" rx="3" fill="#f07422"/>
      <circle cx="56" cy="95" r="7" fill="#c05a10"/>
      <g transform="rotate(-14 56 95)" opacity="0.28"><rect x="56" y="35" width="13" height="120" rx="3" fill="#f07422"/></g>
      <g transform="rotate(14 56 95)" opacity="0.28"><rect x="56" y="35" width="13" height="120" rx="3" fill="#f07422"/></g>
      <rect x="56" y="35" width="13" height="120" rx="3" fill="#f07422"/>
      <rect x="69" y="39" width="4" height="112" rx="2" fill="#f5a06a"/>
      <path d="M 110 55 A 55 55 0 0 1 122 95" fill="none" stroke="#c05a10" stroke-width="4" stroke-linecap="round"/>
      <polygon points="112,49 100,58 116,64" fill="#c05a10"/>
      <path d="M 122 95 A 55 55 0 0 1 110 135" fill="none" stroke="#c05a10" stroke-width="4" stroke-linecap="round"/>
      <polygon points="112,141 100,132 116,126" fill="#c05a10"/>
      <text x="140" y="70" font-size="14" font-weight="700" fill="#c05a10" font-family="Arial">TILT UP</text>
      <text x="140" y="130" font-size="14" font-weight="700" fill="#c05a10" font-family="Arial">TILT DOWN</text>
    </svg>`,
    full:`<svg viewBox="0 0 300 190" width="100%" height="100%">
      <rect x="14" y="10" width="16" height="170" fill="#8fa2cc"/>
      <line x1="18" y1="25" x2="26" y2="17" stroke="#748ac0" stroke-width="2"/>
      <line x1="18" y1="65" x2="26" y2="57" stroke="#748ac0" stroke-width="2"/>
      <line x1="18" y1="105" x2="26" y2="97" stroke="#748ac0" stroke-width="2"/>
      <line x1="18" y1="145" x2="26" y2="137" stroke="#748ac0" stroke-width="2"/>
      <rect x="30" y="86" width="10" height="20" rx="2" fill="#1a2f6b"/>
      <line x1="40" y1="96" x2="80" y2="82" stroke="#1a2f6b" stroke-width="8" stroke-linecap="round"/>
      <circle cx="80" cy="82" r="6" fill="#f07422"/>
      <line x1="80" y1="82" x2="122" y2="96" stroke="#1a2f6b" stroke-width="8" stroke-linecap="round"/>
      <circle cx="122" cy="96" r="6" fill="#f07422"/>
      <g transform="rotate(-8 130 96)">
        <rect x="126" y="42" width="14" height="108" rx="3" fill="#22304f"/>
        <rect x="140" y="46" width="4" height="100" rx="2" fill="#3d4f78"/>
      </g>
      <line x1="34" y1="170" x2="130" y2="170" stroke="#f07422" stroke-width="2"/>
      <line x1="34" y1="164" x2="34" y2="176" stroke="#f07422" stroke-width="2"/>
      <line x1="130" y1="164" x2="130" y2="176" stroke="#f07422" stroke-width="2"/>
      <text x="52" y="164" font-size="13" font-weight="700" fill="#c05a10" font-family="Arial">16 INCH EXTENSION</text>
      <path d="M 190 60 A 45 45 0 0 1 200 96" fill="none" stroke="#1a2f6b" stroke-width="3.5" stroke-linecap="round"/>
      <polygon points="192,54 181,62 195,68" fill="#1a2f6b"/>
      <path d="M 200 96 A 45 45 0 0 1 190 132" fill="none" stroke="#1a2f6b" stroke-width="3.5" stroke-linecap="round"/>
      <polygon points="192,138 181,130 195,124" fill="#1a2f6b"/>
      <text x="210" y="66" font-size="11" font-weight="700" fill="#1a2f6b" font-family="Arial">TILT UP</text>
      <text x="210" y="132" font-size="11" font-weight="700" fill="#1a2f6b" font-family="Arial">TILT DOWN</text>
      <path d="M 218 90 L 238 90" stroke="#f07422" stroke-width="3.5" stroke-linecap="round"/>
      <polygon points="244,90 234,84 234,96" fill="#f07422"/>
      <path d="M 218 104 L 238 104" stroke="#f07422" stroke-width="3.5" stroke-linecap="round" transform="rotate(180 228 104)"/>
      <polygon points="212,104 222,98 222,110" fill="#f07422"/>
      <text x="248" y="88" font-size="11" font-weight="700" fill="#c05a10" font-family="Arial">SWIVEL</text>
      <text x="248" y="102" font-size="11" font-weight="700" fill="#c05a10" font-family="Arial">L / R</text>
    </svg>`,
  };

  function showBracketHelp(sectionId,flatId,tiltId,fullId){
    const ov=document.createElement('div');
    ov.id='ha-bracket-help-ov';
    ov.style.cssText='position:fixed!important;inset:0!important;z-index:9999999!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;background:rgba(10,9,8,0.75)!important;';
    const panels=
      bracketHelpPanel('1','#1a2f6b','Flat Brackets','#e8edf9','#1a2f6b','Sleek and Flush','#1a2f6b','#e8edf9',BRACKET_SVGS.flat,
        'The TV hugs the wall like a picture frame. No movement, just the cleanest, slimmest look you can get. A favorite over fireplaces and on tile.',
        ['Ultra slim profile, sits tight against the wall','Great for tile installations','Cleanest look of all brackets'],
        ['Minimal space behind TV for cables','No movement at all'],
        flatId,sectionId,'Add a Flat Bracket to my order')
      +bracketHelpPanel('2','#f07422','Tilting Brackets','#fdeadd','#c05a10','Most Popular','#f07422','#fdeadd',BRACKET_SVGS.tilt,
        'The TV angles up or down on a pivot, perfect for mounting above eye level or killing window glare. It stays put side to side.',
        ['Most common bracket on the market','Tilts up and down for the perfect angle','Easy cable hiding behind the TV'],
        ["Doesn't move left or right"],
        tiltId,sectionId,'Add a Tilting Bracket to my order')
      +bracketHelpPanel('3','#f07422','Full Motion Brackets','#f07422','#fff','Maximum Flexibility','linear-gradient(90deg,#1a2f6b,#f07422)','#e8edf9',BRACKET_SVGS.full,
        'An articulating arm does it all: tilts up and down, swivels left and right, and pulls the TV a full 16 inches off the wall so every seat gets the perfect angle.',
        ['Tilts up and down, swivels left and right','Pulls out 16 inches from the wall','Total viewing flexibility from any seat'],
        ["Sticks off the wall, doesn't sit flush"],
        fullId,sectionId,'Add a Full Motion Bracket to my order');
    ov.innerHTML=`
      <div style="position:relative!important;width:100%!important;max-width:480px!important;max-height:88vh!important;overflow-y:auto!important;border-radius:14px!important;box-shadow:0 14px 30px rgba(0,0,0,0.5)!important;background:#fff!important;font-family:'Segoe UI',Arial,Helvetica,sans-serif!important;">
        <button id="ha-bracket-help-x" aria-label="Close" style="position:absolute!important;top:10px!important;right:10px!important;z-index:2!important;background:rgba(0,0,0,0.35)!important;border:none!important;color:#fff!important;font-size:16px!important;width:28px!important;height:28px!important;border-radius:50%!important;cursor:pointer!important;">&#10005;</button>
        <div style="background:linear-gradient(135deg,#1a2f6b 0%,#12224f 100%);padding:26px 24px 22px;position:relative;overflow:hidden;">
          <h1 style="color:#fff;font-size:22px;line-height:1.15;font-weight:800;position:relative;margin:0;">The Difference Between<br><span style="color:#f07422;">TV Brackets</span></h1>
          <p style="color:#c3cdea;margin-top:6px;font-size:13px;position:relative;">Everything you need to know before choosing your mount</p>
        </div>
        ${panels}
        <div style="padding:16px 20px;background:#f2f4f9;">
          <button id="ha-bracket-help-close" style="background:#f07422!important;color:#fff!important;border:none!important;padding:12px!important;width:100%!important;border-radius:8px!important;font-weight:700!important;font-size:14px!important;cursor:pointer!important;">Got it, back to my order</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close=()=>ov.remove();
    ov.querySelector('#ha-bracket-help-x').addEventListener('click',close);
    ov.querySelector('#ha-bracket-help-close').addEventListener('click',close);
    ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
    // "Add to my order" buttons: bump that bracket type's qty (capped at how
    // many brackets are still needed for the TVs on this order), then close
    // the popup and re-render so the stepper reflects the pick immediately.
    ov.querySelectorAll('.ha-bracket-add').forEach(b=>b.addEventListener('click',()=>{
      const sid=b.dataset.s, oid=b.dataset.o;
      const tvs=totalTVs();
      const brksNow=(selections[sid]||[]).reduce((s,x)=>s+x.quantity,0);
      const remaining=Math.max(0,tvs-brksNow);
      setQty(sid,oid,getQty(sid,oid)+Math.max(1,remaining||1));
      close();
      render();
    }));
  }

  function bGeneric(sec){
    if(!sec)return '';
    const tvs=totalTVs();
    const total=(selections[sec.id]||[]).reduce((s,x)=>s+x.quantity,0);
    // TV-count enforcement banner (fireplace, surface)
    let banner='';
    if(sec.enforceTVCount&&tvs>0){
      banner=total<tvs
        ?`<div style="${S.info}">📺 You have <strong>${tvs} TV${tvs>1?'s':''}</strong> — select options totalling ${tvs} (${total} of ${tvs} done).</div>`
        :`<div style="${S.ok}">✓ All ${tvs} TV${tvs>1?'s':''} accounted for.</div>`;
    }
    let optsHtml='';
    if(sec.type==='qty_multi'){
      optsHtml=sec.options.map(o=>{
        const q=getQty(sec.id,o.id);
        return `<div style="${S.qRow(q>0)}">
          <span style="flex:1!important;">${o.label}</span>
          <div style="display:flex!important;align-items:center!important;gap:8px!important;flex-shrink:0!important;">
            <button class="ha-dec" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">−</button>
            <span style="${S.qNum}">${q}</span>
            <button class="ha-inc" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">+</button>
          </div>
        </div>`;
      }).join('');
    } else if(sec.type==='multi_select'){
      optsHtml=sec.options.map(o=>{
        const on=getQty(sec.id,o.id)>0;
        return `<div class="ha-tog" data-s="${sec.id}" data-o="${o.id}" style="${S.card(on)}">
          <span>${o.label}</span>
          <span style="color:${on?'#ff6600':'#52525b'}!important;font-size:18px!important;">${on?'✓':'○'}</span>
        </div>`;
      }).join('');
    }
    // ok = required + (TV count match if enforced, else just > 0)
    const countOk=sec.enforceTVCount?(tvs===0||total===tvs):true;
    const ok=(!sec.required||total>0)&&countOk;
    return `<h1 style="${S.h1}">${sec.title}</h1><p style="${S.sub}">${sec.subtitle}</p>${banner}${optsHtml}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${ok?S.btnPri:S.btnDis}" ${!ok?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bWires(){
    const sec=getSec('wires');
    const tvs=totalTVs();
    const oneConnectId=serviceConfig.oneConnectOptionId;
    const oneConnectSid=serviceConfig.oneConnectSectionId;
    // Build visible options list
    const visibleOpts=sec.options.filter(o=>{
      if(o.needsDrywall&&!canHideBehindWall())return false;
      if(o.hideForFrame&&isFrameTV)return false;
      return true;
    });
    // OneConnect: only show if Frame TV AND drywall surface
    if(isFrameTV&&hasDrywall()){
      visibleOpts.push({
        id:oneConnectId, label:'Install Samsung Frame OneConnect box behind the TV',
        price:350, _altSection:oneConnectSid,
      });
    }
    const wireTotal=(selections[sec.id]||[]).reduce((s,x)=>s+x.quantity,0);
    const wireBanner=tvs>0
      ?(wireTotal<tvs
        ?`<div style="${S.info}">📺 You have <strong>${tvs} TV${tvs>1?'s':''}</strong> — select a wire option for each (${wireTotal} of ${tvs} done).</div>`
        :`<div style="${S.ok}">✓ All ${tvs} TV${tvs>1?'s':''} have a wire option.</div>`)
      :'';
    const opts=visibleOpts.map(o=>{
      const sid=o._altSection||sec.id;
      const q=getQty(sid,o.id);
      return `<div style="${S.qRow(q>0)}">
        <span style="flex:1!important;">${o.label}${S.price(o.price)}</span>
        <div style="display:flex!important;align-items:center!important;gap:8px!important;flex-shrink:0!important;">
          <button class="ha-dec" data-s="${sid}" data-o="${o.id}" style="${S.qBtn}">−</button>
          <span style="${S.qNum}">${q}</span>
          <button class="ha-inc" data-s="${sid}" data-o="${o.id}" style="${S.qBtn}">+</button>
        </div>
      </div>`;
    }).join('');
    const wireOk=tvs===0||wireTotal===tvs;
    return `<h1 style="${S.h1}">${sec.title}</h1><p style="${S.sub}">Select one per TV.</p>${wireBanner}${opts}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${wireOk?S.btnPri:S.btnDis}" ${!wireOk?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bLifting(){
    const sec=getSec('lifting');
    const cat=getMaxSizeCat();
    // 98"+ TV: auto-selected, show 2-tech required message
    if(cat==='xlarge'){
      const autoOpt=sec.options.find(o=>o.forCat==='large');
      if(autoOpt)selectOnly(sec.id,autoOpt.id);
      return `
        <h1 style="${S.h1}">Two Technicians Required</h1>
        <div style="background:rgba(255,102,0,0.1)!important;border:1.5px solid rgba(255,102,0,0.4)!important;border-radius:10px!important;padding:20px!important;margin-bottom:20px!important;text-align:center!important;">
          <div style="font-size:36px!important;margin-bottom:10px!important;">💪</div>
          <p style="font-size:15px!important;color:#fff!important;margin:0!important;line-height:1.6!important;">
            Because your TV is <strong>86 inches or larger</strong>, two technicians are required for proper and safe installation.
          </p>
          <p style="font-size:13px!important;color:#a0a0ab!important;margin-top:8px!important;margin-bottom:0!important;">
            A second technician fee of +$70 has been added.
          </p>
        </div>
        <div style="${S.actions}">
          <button id="btn-prev" style="${S.btnSec}">← Back</button>
          <button id="btn-next" style="${S.btnPri}">Continue →</button>
        </div>`;
    }
    // Medium TV: show 2 options with display-only label overrides
    const medOpts=sec.options.filter(o=>o.forCat==='medium');
    const LIFT_LABELS={
      '1685657521270x242389337506608420':'I can help lift the TV into place',
      '1685657521270x264421370121691100':'I cannot help lift the TV into place',
      '1724797767615x715957457515909400':'I can help lift the TV into place',
      '1727409857684x617202431885574100':'I cannot help lift the TV into place',
    };
    const cur=(selections[sec.id]||[])[0]?.option_id;
    const opts=medOpts.map(o=>{
      const on=cur===o.id;
      const displayLabel=LIFT_LABELS[o.id]||o.label;
      return `<div class="ha-sel" data-s="${sec.id}" data-o="${o.id}" style="${S.card(on)}">
        <span>${displayLabel}</span>
        <span style="color:${on?'#ff6600':'#52525b'}!important;font-size:18px!important;">${on?'●':'○'}</span>
      </div>`;
    }).join('');
    const ok=!!cur;
    return `<h1 style="${S.h1}">How many technicians would you prefer we bring?</h1>
      <p style="${S.sub}">1 or more of your TV's are in the 70–85" range. Can you assist the technician with lifting on to the bracket?</p>
      ${opts}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${ok?S.btnPri:S.btnDis}" ${!ok?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bDismount(){
    const sec=getSec('dismount');
    const cur=(selections[sec.id]||[])[0]?.option_id;
    const yesId=sec.options[0].id, noId=sec.options[1].id;
    const yesOn=cur===yesId;
    const gold='#f59e0b';
    return `
      <h1 style="margin:0 0 10px 0!important;font-size:26px!important;font-weight:800!important;color:#fff!important;display:block!important;line-height:1.2!important;">Dismount Service</h1>
      <p style="font-size:13px!important;color:#d4d4d8!important;margin:0 0 14px 0!important;line-height:1.6!important;">
        <strong style="color:#fff!important;">Removing a TV can cost you over $100!</strong> However, you can have your TV removed <strong style="color:${gold}!important;">completely free of charge</strong> when you choose our Guaranteed Dismount Service.
      </p>

      <div style="background:#1f1f23!important;border:1px solid #3f3f46!important;border-radius:10px!important;padding:14px!important;margin-bottom:12px!important;">
        <div style="font-size:14px!important;font-weight:700!important;color:#fff!important;margin-bottom:10px!important;">How It Works</div>
        ${['We remove your TV at <strong style="color:#fff!important;">no additional cost</strong>','We even patch the bolt holes for you!'].map(t=>`<div style="display:flex!important;gap:8px!important;align-items:flex-start!important;font-size:13px!important;color:#d4d4d8!important;margin-bottom:7px!important;"><span style="color:${gold}!important;font-size:15px!important;line-height:1.3!important;flex-shrink:0!important;">✔</span><span>${t}</span></div>`).join('')}
      </div>

      <div style="display:grid!important;grid-template-columns:1fr 1fr 1fr!important;gap:8px!important;margin-bottom:12px!important;">
        <div style="background:#1f1f23!important;border:1.5px solid ${gold}!important;border-radius:8px!important;padding:12px 6px!important;text-align:center!important;">
          <div style="font-size:20px!important;font-weight:800!important;color:${gold}!important;">$0</div>
          <div style="font-size:10px!important;color:#a0a0ab!important;margin-top:3px!important;">Removal Cost</div>
        </div>
        <div style="background:#1f1f23!important;border:1.5px solid ${gold}!important;border-radius:8px!important;padding:12px 6px!important;text-align:center!important;">
          <div style="font-size:13px!important;font-weight:700!important;color:${gold}!important;line-height:1.3!important;">Professional</div>
          <div style="font-size:10px!important;color:#a0a0ab!important;margin-top:3px!important;">Dismounting</div>
        </div>
        <div style="background:#1f1f23!important;border:1.5px solid ${gold}!important;border-radius:8px!important;padding:12px 6px!important;text-align:center!important;">
          <div style="font-size:18px!important;color:${gold}!important;line-height:1.2!important;">✓</div>
          <div style="font-size:10px!important;color:#a0a0ab!important;margin-top:3px!important;">Holes Patched Free</div>
        </div>
      </div>

      <div style="border:1px solid #3f3f46!important;border-radius:10px!important;padding:12px 14px!important;margin-bottom:14px!important;display:flex!important;align-items:center!important;gap:10px!important;">
        <span style="font-size:20px!important;">🛡️</span>
        <div>
          <div style="font-size:13px!important;font-weight:700!important;color:#fff!important;">No Catch. No Fees. No Charge.</div>
          <div style="font-size:11px!important;color:#a0a0ab!important;">Our commitment to exceptional service and peace of mind.</div>
        </div>
      </div>

      <button id="btn-dis-yes" style="background:${yesOn?'#ff6600':'rgba(255,102,0,0.85)'}!important;color:#fff!important;border:${yesOn?'2px solid #fff':'none'}!important;padding:15px!important;border-radius:10px!important;font-size:15px!important;font-weight:700!important;cursor:pointer!important;width:100%!important;display:block!important;text-align:center!important;box-sizing:border-box!important;margin-bottom:10px!important;">
        ${yesOn?'✓ ':''}Add Guaranteed Dismount Service — Only $35
      </button>
      <div style="text-align:center!important;margin-bottom:8px!important;">
        <button id="btn-dis-no" style="background:${cur===noId?'rgba(255,255,255,0.06)':'transparent'}!important;color:${cur===noId?'#fff':'#71717a'}!important;border:none!important;font-size:13px!important;cursor:pointer!important;text-decoration:underline!important;padding:8px 16px!important;">
          ${cur===noId?'✓ ':''}No thanks, I'll handle TV removal myself
        </button>
      </div>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${cur?S.btnPri:S.btnDis}" ${!cur?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bExtras(){
    const sec=getSec('extras');
    const visible=sec.options.filter(o=>!o.frameOnly);
    // Each option renders; if it allows text AND is selected, a textarea drops in beneath it
    const opts=visible.map(o=>{
      const q=getQty(sec.id,o.id);
      const row=`<div style="${S.qRow(q>0)}">
        <span style="flex:1!important;">${o.label}${S.price(o.price)}</span>
        <div style="display:flex!important;align-items:center!important;gap:8px!important;flex-shrink:0!important;">
          <button class="ha-dec" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">−</button>
          <span style="${S.qNum}">${q}</span>
          <button class="ha-inc" data-s="${sec.id}" data-o="${o.id}" style="${S.qBtn}">+</button>
        </div>
      </div>`;
      const showText=o.allowText&&q>0;
      const ph=o.label==='Other'?'e.g. I need some curtains hung...':'Tell us what you need the handyman for...';
      const textBox=showText?`<div style="margin:-2px 0 10px 0!important;">
        <textarea class="ha-comment" data-o="${o.id}" rows="2" style="width:100%!important;padding:10px 12px!important;background:#27272a!important;border:1px solid #ff6600!important;color:#fff!important;border-radius:6px!important;font-size:14px!important;box-sizing:border-box!important;resize:vertical!important;font-family:inherit!important;" placeholder="${ph}">${optionComments[o.id]||''}</textarea>
      </div>`:'';
      return row+textBox;
    }).join('');
    return `<h1 style="${S.h1}">${sec.title}</h1><p style="${S.sub}">${sec.subtitle}</p>${opts}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${S.btnPri}">Continue →</button>
      </div>`;
  }

  function bTerms(){
    const sec=getSec('terms');
    const agreed=(selections[sec.id]||[])[0]?.option_id===sec.options[0].id;
    return `
      <h1 style="${S.h1}">${sec.title}</h1>
      <div style="background:#27272a!important;border:1px solid #3f3f46!important;border-radius:8px!important;padding:16px!important;margin-bottom:20px!important;font-size:13px!important;color:#a0a0ab!important;line-height:1.7!important;max-height:130px!important;overflow-y:auto!important;">
        ${sec.subtitle}
      </div>
      <div style="display:flex!important;justify-content:center!important;margin-bottom:20px!important;">
        <div class="ha-sel" data-s="${sec.id}" data-o="${sec.options[0].id}"
          style="background:${agreed?'rgba(34,197,94,0.1)':'#27272a'}!important;border:1.5px solid ${agreed?'#22c55e':'#3f3f46'}!important;border-radius:8px!important;padding:12px 24px!important;color:#fff!important;display:inline-flex!important;align-items:center!important;gap:10px!important;font-size:14px!important;cursor:pointer!important;">
          <span style="font-size:20px!important;">${agreed?'☑':'☐'}</span>
          <span>${sec.options[0].label}</span>
        </div>
      </div>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${agreed?S.btnPri:S.btnDis}" ${!agreed?'disabled':''}>Continue →</button>
      </div>`;
  }

  function bSlots(){
    const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const allDates=Object.keys(slotsByDate).sort();
    if(!allDates.length){
      return `<h1 style="${S.h1}">What day works best for you?</h1>
        <p style="color:#a0a0ab!important;font-size:14px!important;margin-bottom:16px!important;">Loading available dates…</p>
        <div style="${S.actions}"><button id="btn-prev" style="${S.btnSec}">← Back</button></div>`;
    }
    // Initialise calendar to first available month
    if(calYear===null){
      const f=new Date(allDates[0]+'T12:00:00');
      calYear=f.getFullYear(); calMonth=f.getMonth();
    }
    const availSet=new Set(allDates);
    const firstDay=new Date(calYear,calMonth,1).getDay();
    const daysInMonth=new Date(calYear,calMonth+1,0).getDate();
    const todayStr=new Date().toISOString().slice(0,10);
    const firstAvail=new Date(allDates[0]+'T12:00:00');
    const lastAvail=new Date(allDates[allDates.length-1]+'T12:00:00');
    const canPrev=calYear>firstAvail.getFullYear()||(calYear===firstAvail.getFullYear()&&calMonth>firstAvail.getMonth());
    const canNext=calYear<lastAvail.getFullYear()||(calYear===lastAvail.getFullYear()&&calMonth<lastAvail.getMonth());

    // Day headers
    const dayHdr=DAYS.map(d=>`<div style="text-align:center!important;font-size:11px!important;font-weight:600!important;color:#71717a!important;padding:4px 0 8px 0!important;">${d}</div>`).join('');

    // Date cells
    let cells='';
    for(let i=0;i<firstDay;i++)cells+=`<div></div>`;
    for(let d=1;d<=daysInMonth;d++){
      const ds=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const has=availSet.has(ds),isSel=selectedDate===ds,isToday=ds===todayStr;
      // disc intentionally removed — no discount display on calendar
      if(has){
        cells+=`<div class="ha-date" data-date="${ds}" style="text-align:center!important;cursor:pointer!important;padding:4px 2px!important;border-radius:8px!important;background:${isSel?'rgba(255,102,0,0.12)':'transparent'}!important;">
          <div style="width:32px!important;height:32px!important;border-radius:50%!important;margin:0 auto!important;display:flex!important;align-items:center!important;justify-content:center!important;background:${isSel?'#ff6600':isToday?'#27272a':'transparent'}!important;font-size:14px!important;font-weight:${isSel||isToday?700:400}!important;color:${isSel?'#fff':isToday?'#ff6600':'#fff'}!important;border:${isToday&&!isSel?'1.5px solid #ff6600':'none'}!important;">${d}</div>
        </div>`;
      }else{
        cells+=`<div style="text-align:center!important;padding:4px 2px!important;">
          <div style="width:32px!important;height:32px!important;margin:0 auto!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:14px!important;color:#3f3f46!important;">${d}</div>
        </div>`;
      }
    }

    // Time slots for selected date (shown inline below calendar)
    let timeHtml='';
    if(selectedDate&&slotsByDate[selectedDate]){
      const slots=slotsByDate[selectedDate];
      const df=fmtDate(selectedDate);
      const slotBtns=slots.map(sl=>{
        const on=selectedSlot===sl.id, sur=slotSurcharge(sl,selectedDate);
        return `<div class="ha-slot" data-id="${sl.id}" style="background:${on?'rgba(255,102,0,0.12)':'#1f1f23'}!important;border:1.5px solid ${on?'#ff6600':'#3f3f46'}!important;border-radius:8px!important;padding:14px 10px!important;cursor:pointer!important;text-align:center!important;">
          <div style="font-size:13px!important;font-weight:600!important;color:#fff!important;">${sl.arrival_window}${sur>0?` <span style="color:#ff9944!important;font-size:11px!important;">+$${sur}</span>`:''}</div>
        </div>`;
      }).join('');
      timeHtml=`<div style="border-top:1px solid #2d2d34!important;margin-top:12px!important;padding-top:12px!important;">
        <p style="font-size:13px!important;color:#a0a0ab!important;margin:0 0 10px 0!important;">${df.long}, ${df.date} — select a time:</p>
        <div style="display:grid!important;grid-template-columns:1fr 1fr!important;gap:8px!important;">${slotBtns}</div>
      </div>`;
    }

    return `
      <h1 style="${S.h1}">What day works best for you?</h1>
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
    const adj=territoryAdjustment();
    const zipDisc=zipDiscount();
    const ah=selectedSlotSurcharge();
    const base=calcTotal()+adj-zipDisc+ah;
    const items=buildLineItems();
    const itemsHtml=items.map(it=>`<div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>${it.label}${it.qty>1?` ×${it.qty}`:''}</span>
            <span style="color:#fff!important;">$${it.amount}</span>
          </div>`).join('');
    return `
      <h1 style="${S.h1};color:#ff6600!important;">Almost Done! Last Step…</h1>
      <div style="background:rgba(34,197,94,0.13)!important;border:1px solid rgba(34,197,94,0.4)!important;border-radius:8px!important;padding:14px!important;margin-bottom:18px!important;font-size:12px!important;color:#a0a0ab!important;line-height:1.6!important;">
        💳 <strong style="color:#fff!important;">Your card will not be charged until after the job is complete.</strong>
        <div style="background:#e9fbef!important;border:1px solid rgba(22,163,74,0.55)!important;border-radius:7px!important;padding:10px 12px!important;margin:10px 0 8px!important;color:#0f5132!important;font-weight:800!important;font-size:15.5px!important;line-height:1.4!important;">Payment is taken at time of service — your card only holds the appointment.</div>
        We will only charge you after your services have been completed.
      </div>
      <input type="text"  id="c-fn" style="${S.inputL}" placeholder="First Name"     value="${customer.first_name}">
      <input type="text"  id="c-ln" style="${S.inputL}" placeholder="Last Name"      value="${customer.last_name}">
      <input type="email" id="c-em" style="${S.inputL}" placeholder="Email Address"  value="${customer.email}">
      <input type="tel"   id="c-ph" style="${S.inputL}" placeholder="Phone Number"   value="${customer.phone}">
      <input type="text"  id="c-ad" style="${S.inputL}" placeholder="Street Address" value="${customer.address}">
      <input type="text"  id="c-ad2" style="${S.inputL}" placeholder="Apt, suite, or unit number (optional)" value="${customer.address_line2}">
      <div style="background:#27272a!important;border:1px solid #3f3f46!important;border-radius:8px!important;padding:14px!important;margin-bottom:14px!important;">
        <div style="font-size:11px!important;color:#a0a0ab!important;margin-bottom:12px!important;font-weight:600!important;text-transform:uppercase!important;letter-spacing:0.5px!important;">💳 Card to Hold Appointment</div>
        <div id="stripe-card-element" style="background:#1a1a1e!important;border:1px solid #3f3f46!important;border-radius:6px!important;padding:14px!important;min-height:44px!important;"></div>
        <div id="stripe-card-errors" role="alert" aria-live="polite" style="color:#ef4444!important;font-size:12px!important;line-height:1.4!important;margin:8px 0 0 0!important;"></div>
        <p style="font-size:11px!important;color:#52525b!important;margin:8px 0 0 0!important;">🔒 Secured by Stripe. Payment collected by technician at time of service.</p>
      </div>
      <div style="margin-bottom:20px!important;">
        <input type="text" id="c-coupon" style="${S.inputL};margin-bottom:0!important;" placeholder="Coupon code (optional)" value="${couponCode}">
      </div>
      <div style="background:rgba(34,197,94,0.08)!important;border:1.5px solid rgba(34,197,94,0.25)!important;border-radius:10px!important;padding:16px 18px!important;margin-bottom:18px!important;">
        <div style="font-size:13px!important;color:#a0a0ab!important;margin-bottom:8px!important;">
          ${itemsHtml}
          <div style="border-top:1px solid rgba(255,255,255,0.08)!important;margin:8px 0!important;"></div>
          <div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Subtotal</span>
            <span id="ha-subtotal" style="color:#fff!important;">$${Math.round(calcTotal()*100)/100}</span>
          </div>
          ${adj>0?`<div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Service area surcharge</span>
            <span style="color:#fff!important;">+$${adj}</span>
          </div>`:''}
          ${ah>0?`<div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>After-hours fee (8 PM)</span>
            <span style="color:#fff!important;">+$${ah}</span>
          </div>`:''}
          ${zipDisc>0?`<div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Location</span>
            <span style="color:#4ade80!important;">-$${zipDisc}</span>
          </div>`:''}
          <div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Tax (8.25%)</span>
            <span id="ha-tax" style="color:#fff!important;">$${Math.round(base*TAX_RATE*100)/100}</span>
          </div>
          ${tipAmount>0?`<div id="ha-tip-row" style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Tip</span>
            <span id="ha-tip-amt" style="color:#fff!important;">$${tipAmount}</span>
          </div>`:`<div id="ha-tip-row" style="display:none!important;"></div>`}
        </div>
        <div style="border-top:1px solid rgba(34,197,94,0.3)!important;padding-top:8px!important;display:flex!important;justify-content:space-between!important;align-items:center!important;">
          <div style="font-size:14px!important;font-weight:700!important;color:#fff!important;">Total</div>
          <div id="ha-total" style="font-size:26px!important;font-weight:800!important;color:#4ade80!important;">$${Math.round((base*(1+TAX_RATE)+tipAmount)*100)/100}</div>
        </div>
      </div>
      <label for="c-sms-consent" style="display:flex!important;align-items:flex-start!important;gap:9px!important;background:#1a1a1e!important;border:1px solid #3f3f46!important;border-radius:8px!important;padding:11px 12px!important;margin-bottom:16px!important;cursor:pointer!important;">
        <input type="checkbox" id="c-sms-consent" style="margin:2px 0 0 0!important;flex:0 0 auto!important;width:16px!important;height:16px!important;accent-color:#ff6600!important;cursor:pointer!important;">
        <span style="font-size:10.5px!important;color:#8b8b93!important;line-height:1.55!important;">I agree to receive appointment and service text messages (booking confirmations, reminders, technician arrival/ETA updates, and follow-ups) from Handy Andy TV Mounting. Reply STOP to unsubscribe.</span>
      </label>
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-submit" style="${S.btnPri}">Complete My Booking ✓</button>
      </div>`;
  }

  // ─── Event wiring ─────────────────────────────────────────────────────────
  function wire(root){
    root.querySelector('#btn-zip')?.addEventListener('click',()=>doZip(root));
    root.querySelector('#ha-zip')?.addEventListener('keypress',e=>{if(e.key==='Enter')doZip(root);});
    root.querySelector('#btn-prev')?.addEventListener('click',()=>goBack());
    { const helpBtn=root.querySelector('#ha-bracket-help'); if(helpBtn) helpBtn.addEventListener('click',()=>showBracketHelp(helpBtn.dataset.sec,helpBtn.dataset.flat,helpBtn.dataset.tilt,helpBtn.dataset.full)); }
    root.querySelector('#btn-next')?.addEventListener('click',()=>goNext());
    root.querySelector('#btn-submit')?.addEventListener('click',()=>doSubmit(root));
    root.querySelector('#btn-date-back')?.addEventListener('click',()=>{selectedDate=null;selectedSlot=null;render();});
    root.querySelector('#cal-prev')?.addEventListener('click',()=>{calMonth--;if(calMonth<0){calMonth=11;calYear--;}render();});
    root.querySelector('#cal-next')?.addEventListener('click',()=>{calMonth++;if(calMonth>11){calMonth=0;calYear++;}render();});

    // Dismount — dedicated handlers so selection is always registered
    root.querySelector('#btn-dis-yes')?.addEventListener('click',()=>{
      const s=getSec('dismount');if(s)selectOnly(s.id,s.options[0].id);render();
    });
    root.querySelector('#btn-dis-no')?.addEventListener('click',()=>{
      const s=getSec('dismount');if(s)selectOnly(s.id,s.options[1].id);render();
    });

    root.querySelectorAll('.ha-tv-type').forEach(c=>c.addEventListener('click',()=>{
      const type=c.dataset.type;
      if(!selections['__frame_type'])selections['__frame_type']=[];
      const idx=selections['__frame_type'].indexOf(type);
      if(idx!==-1)selections['__frame_type'].splice(idx,1);
      else selections['__frame_type'].push(type);
      isFrameTV=selections['__frame_type'].includes('frame');
      // Frame bracket qty = number of TVs if ALL are frame, else 0 (mixed handled in bracket step)
      const onlyFrame=isFrameTV&&!selections['__frame_type'].includes('regular');
      if(onlyFrame){
        setQty(serviceConfig.frameBracketSectionId,serviceConfig.frameBracketOptionId,totalTVs()||1);
      } else {
        setQty(serviceConfig.frameBracketSectionId,serviceConfig.frameBracketOptionId,0);
      }
      render();
    }));

    root.querySelectorAll('.ha-inc').forEach(b=>b.addEventListener('click',()=>{setQty(b.dataset.s,b.dataset.o,getQty(b.dataset.s,b.dataset.o)+1);render();}));
    root.querySelectorAll('.ha-dec').forEach(b=>b.addEventListener('click',()=>{setQty(b.dataset.s,b.dataset.o,Math.max(0,getQty(b.dataset.s,b.dataset.o)-1));render();}));
    root.querySelectorAll('.ha-tog').forEach(c=>c.addEventListener('click',()=>{toggleOpt(c.dataset.s,c.dataset.o);render();}));
    root.querySelectorAll('.ha-sel').forEach(c=>c.addEventListener('click',()=>{selectOnly(c.dataset.s,c.dataset.o);render();}));
    root.querySelectorAll('.ha-slot').forEach(c=>c.addEventListener('click',()=>{selectedSlot=c.dataset.id;render();}));
    root.querySelectorAll('.ha-date').forEach(c=>c.addEventListener('click',()=>{selectedDate=c.dataset.date;selectedSlot=null;render();}));
    root.querySelectorAll('.ha-comment').forEach(t=>t.addEventListener('input',e=>{optionComments[e.target.dataset.o]=e.target.value;}));
    // Capture the customer's name as soon as they type it (on blur) so the booking
    // analytics shows who the session belongs to, even if they don't finish booking.
    const fnEl=root.querySelector('#c-fn'), lnEl=root.querySelector('#c-ln');
    const captureName=()=>{ if(fnEl)customer.first_name=fnEl.value.trim(); if(lnEl)customer.last_name=lnEl.value.trim(); if(customer.first_name||customer.last_name) logEvent('answer','customer_name'); };
    if(fnEl)fnEl.addEventListener('blur',captureName);
    if(lnEl)lnEl.addEventListener('blur',captureName);
    attachAddrAutocomplete(root);
    // Card inputs replaced by Stripe Elements — no manual binding needed
  }

  // Google Places autocomplete on the Street Address field, via the public proxy
  // in api/book.js. Guides the customer to a real, verified address (so they
  // can't drop their email/phone in the box) and fills the street line on select.
  function attachAddrAutocomplete(root){
    const input=root.querySelector('#c-ad'); if(!input||input._acWired)return; input._acWired=true;
    const box=document.createElement('div'); box.style.cssText='position:relative!important;width:100%!important;';
    const list=document.createElement('div');
    list.style.cssText='display:none;position:absolute!important;left:0;right:0;top:2px;z-index:1000000!important;background:#18181c!important;border:1px solid #3f3f46!important;border-radius:8px!important;overflow:hidden!important;box-shadow:0 8px 24px rgba(0,0,0,0.5)!important;';
    input.parentNode.insertBefore(box,input.nextSibling); box.appendChild(list);
    let session=Math.random().toString(36).slice(2)+Date.now().toString(36), timer=null;
    const hide=()=>{ list.style.display='none'; list.innerHTML=''; };
    const pick=async(pred)=>{
      hide();
      try{
        const dj=await (await fetch(API_BASE+'/book?action=place_details&place_id='+encodeURIComponent(pred.place_id)+'&session='+session)).json();
        session=Math.random().toString(36).slice(2)+Date.now().toString(36);
        const a=dj&&dj.address;
        const v=(a&&a.line1)?a.line1:pred.description;
        input.value=v; customer.address=v;
      }catch(_){ input.value=pred.description; customer.address=pred.description; }
    };
    const search=async(q)=>{
      try{
        const j=await (await fetch(API_BASE+'/book?action=places_autocomplete&input='+encodeURIComponent(q)+'&session='+session)).json();
        const preds=(j&&j.predictions)||[];
        if(!preds.length){ hide(); return; }
        list.innerHTML=preds.map((p,i)=>'<div data-i="'+i+'" style="padding:11px 12px!important;font-size:14px!important;color:#e4e4e7!important;cursor:pointer!important;border-bottom:1px solid #27272a!important;">'+String(p.description).replace(/</g,'&lt;')+'</div>').join('');
        list.style.display='block';
        list.querySelectorAll('[data-i]').forEach(el=>el.addEventListener('mousedown',e=>{ e.preventDefault(); pick(preds[+el.dataset.i]); }));
      }catch(_){ hide(); }
    };
    input.addEventListener('input',()=>{
      customer.address=input.value; const q=input.value.trim();
      clearTimeout(timer);
      if(q.length<3){ hide(); return; }
      timer=setTimeout(()=>search(q),250);
    });
    input.addEventListener('blur',()=>setTimeout(hide,150));
  }

  // ─── Navigation ───────────────────────────────────────────────────────────
  function goNext(){
    logStepAnswers(STEP_KEYS[stepIdx]);
    let ni=stepIdx+1;
    while(ni<STEP_KEYS.length&&shouldSkip(STEP_KEYS[ni]))ni++;
    // If entering slots, fetch them
    if(STEP_KEYS[ni]==='slots')fetchSlots();
    // If entering lifting and cat is large, auto-select
    if(STEP_KEYS[ni]==='lifting'&&getMaxSizeCat()==='xlarge'&&isDenver()){
      const sec=getSec('lifting');
      const opt=sec?.options.find(o=>o.forCat==='large');
      if(opt)selectOnly(sec.id,opt.id);
    }
    // Update frame bracket qty to match TV count if frame TV
    if(isFrameTV){
      setQty(serviceConfig.frameBracketSectionId,serviceConfig.frameBracketOptionId,totalTVs());
    }
    stepIdx=ni; render();
  }

  function goBack(){
    let pi=stepIdx-1;
    while(pi>0&&shouldSkip(STEP_KEYS[pi]))pi--;
    stepIdx=Math.max(0,pi); render();
  }

  // ─── Zip check ────────────────────────────────────────────────────────────
  async function doZip(root){
    const zip=root.querySelector('#ha-zip')?.value.trim();
    if(!zip||zip.length<5)return alert('Please enter a valid 5-digit zip code.');
    const btn=root.querySelector('#btn-zip');
    btn.textContent='Checking…'; btn.disabled=true;
    customer.zip=zip;
    try{
      const r=await fetch(`${API_BASE}/service-area`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(NATIVE?{zip,business:'handy-andy'}:{zip})});
      const d=await r.json();
      if(!d.territory_id){btn.textContent='Check Area →';btn.disabled=false;logEvent('zip_check','unserved',null,zip);return alert('It appears this area is a little far for us. But you should call to confirm. 713-876-9032');}
      territoryId=d.territory_id; enteredZip=zip;
      areaCity=d.city||''; areaState=d.state||'';
      if(NATIVE){
        // Native: the surcharge + metro come from the CRM zip check, and the
        // pricing profile is chosen by metro name (Austin is cheaper).
        serviceAreaId=d.service_area_id||d.territory_id; nativeSurcharge=Number(d.surcharge)||0; areaName=d.territory_name||'';
        serviceConfig=SERVICE_CONFIGS[/austin/i.test(areaName)?'austin':'default'];
      } else {
        serviceConfig=SERVICE_CONFIGS[TERRITORY_CONFIG_MAP[territoryId]||'default'];
      }
      logEvent('zip_check','served',null,zip);
      stepIdx=1; render();
    }catch{btn.textContent='Check Area →';btn.disabled=false;logEvent('error','zip',null,'zip network error');alert('Network error. Please try again.');}
  }

  // ─── Slots fetch ──────────────────────────────────────────────────────────
  async function fetchSlots(){
    try{
      const provReq=needsTwoTechs()?2:1;
      const slotsUrl=NATIVE
        ?`${API_BASE}/slots?business=handy-andy&service_area_id=${encodeURIComponent(serviceAreaId)}&days=92`
        :`${API_BASE}/slots?territory_id=${territoryId}&duration=120&days=92&min_providers_needed=${provReq}`;
      const r=await fetch(slotsUrl);
      const d=await r.json();
      slotsByDate={};calYear=null;calMonth=null;
      for(const day of(d.days||[])){
        slotsByDate[day.date]=(day.timeslots||[]).map(sl=>({
          id:sl.id, arrival_window:sl.formatted,
        }));
      }
      // Init calendar to first available month
      const dates=Object.keys(slotsByDate).sort();
      if(dates.length){const f=new Date(dates[0]+'T12:00:00');calYear=f.getFullYear();calMonth=f.getMonth();}
      else logEvent('error','slots',null,'no slots returned');
      render();
    }catch{slotsByDate={};logEvent('error','slots',null,'slots fetch failed');render();}
  }

  // ─── Submit ───────────────────────────────────────────────────────────────
  async function doSubmit(root){
    if(isSubmitting)return; // already booking — ignore extra clicks so we don't double-book
    customer.first_name=root.querySelector('#c-fn').value.trim();
    customer.last_name=root.querySelector('#c-ln').value.trim();
    customer.email=root.querySelector('#c-em').value.trim();
    customer.phone=root.querySelector('#c-ph').value.trim();
    customer.address=root.querySelector('#c-ad').value.trim();
    customer.address_line2=root.querySelector('#c-ad2')?.value.trim()||'';
    couponCode=root.querySelector('#c-coupon')?.value.trim().toUpperCase()||'';
    // SMS-consent checkbox — opt-in, not required to book; recorded with the order.
    const smsConsent=!!(root.querySelector('#c-sms-consent')||{}).checked;
    if(!customer.email){logEvent('form_error','customer',null,'missing email');return alert('Please enter your email address.');}
    if(!customer.phone){logEvent('form_error','customer',null,'missing phone');return alert('Please enter your phone number.');}
    if(!customer.address){logEvent('form_error','customer',null,'missing address');return alert('Please enter your street address.');}
    if(/@/.test(customer.address)||!/\d/.test(customer.address)||customer.address.length<5){logEvent('form_error','customer',null,'invalid address');return alert('Please enter a valid street address with a house number — not an email or phone number.');}
    if(couponCode&&!(couponCode in COUPONS)){logEvent('form_error','customer',null,'invalid coupon: '+couponCode);return alert('That coupon code isn\'t valid. Please check it or clear the coupon field.');}
    if(tipAmount>0)logEvent('answer','tip:$'+tipAmount,tipAmount);
    if(couponCode)logEvent('answer','coupon:'+couponCode);

    // Card must be fully entered before we lock in or call Stripe. This is the
    // biggest checkout leak: people tap Complete with a half-filled card and hit
    // "card number is incomplete". Show the error inline, scroll to + focus the
    // field, and stop — no alert, no wasted Stripe round-trip, no double-book lock.
    if(_stripe&&_stripeCard&&!_cardComplete){
      const errEl=document.getElementById('stripe-card-errors');
      if(errEl&&!errEl.textContent) errEl.textContent='Please finish entering your card number, expiry date, and CVC.';
      const cardBox=document.getElementById('stripe-card-element');
      if(cardBox&&cardBox.scrollIntoView) cardBox.scrollIntoView({behavior:'smooth',block:'center'});
      try{_stripeCard.focus();}catch(e){}
      logEvent('form_error','customer',null,'card incomplete (blocked pre-submit)');
      return;
    }

    // Lock now — all validation passed, we're committing to a single booking attempt.
    isSubmitting=true;

    // Tokenize card with Stripe
    let stripePaymentMethodId=null;
    if(_stripe&&_stripeCard){
      const submitBtn=root.querySelector('#btn-submit');
      if(submitBtn){submitBtn.textContent='Processing…';submitBtn.disabled=true;}
      const{paymentMethod,error}=await _stripe.createPaymentMethod({
        type:'card',
        card:_stripeCard,
        billing_details:{
          name:`${customer.first_name} ${customer.last_name}`.trim(),
          email:customer.email,
          phone:customer.phone,
          address:{line1:customer.address,line2:customer.address_line2||undefined},
        },
      });
      if(error){
        isSubmitting=false; // no job created yet — let them fix the card and retry
        if(submitBtn){submitBtn.textContent='Complete My Booking ✓';submitBtn.disabled=false;}
        logEvent('booking_failed','customer',null,'card: '+error.message);
        const errEl=document.getElementById('stripe-card-errors');
        if(errEl) errEl.textContent=error.message;
        const cardBox=document.getElementById('stripe-card-element');
        if(cardBox&&cardBox.scrollIntoView) cardBox.scrollIntoView({behavior:'smooth',block:'center'});
        try{_stripeCard.focus();}catch(e){}
        return;
      }
      stripePaymentMethodId=paymentMethod.id;
    }

    const multiTypes=new Set(['qty_multi','qty_match','multi_select']);
    const zbk_selections=serviceConfig.sections.map(sec=>{
      const opts=(selections[sec.id]||[]).filter(o=>o.quantity>0)
        // Attach customer free-text as `comments` on the option (Handyman / Other)
        .map(o=>{const c=(optionComments[o.option_id]||'').trim();return c?{...o,comments:c}:o;});
      if(!opts.length)return null;
      return multiTypes.has(sec.type)
        ?{section_id:sec.id,selected_options:opts}
        :{section_id:sec.id,option_id:opts[0].option_id};
    }).filter(Boolean);

    const loc=resolveLocation();
    // Build the booking summary up-front so it can be (a) sent to the server for
    // the branded confirmation email and (b) saved for the thank-you page — both
    // show identical details.
    const _slot=(slotsByDate[selectedDate]||[]).find(s=>s.id===selectedSlot)||{};
    const _df=selectedDate?fmtDate(selectedDate):null;
    const _lines=buildLineItems();
    if(territoryAdjustment()>0)_lines.push({label:'Service area surcharge',qty:1,amount:territoryAdjustment()});
    const _ahFee=selectedSlotSurcharge();
    if(_ahFee>0)_lines.push({label:'After-hours fee (8 PM)',qty:1,amount:_ahFee});
    if(zipDiscount()>0)_lines.push({label:'Location',qty:1,amount:-zipDiscount()});
    // Sales tax on the taxable subtotal (matches the checkout screen's base).
    const _taxBase=calcTotal()+territoryAdjustment()+_ahFee-zipDiscount();
    const _tax=Math.round(_taxBase*TAX_RATE*100)/100;
    if(_tax>0)_lines.push({label:'Tax (8.25%)',qty:1,amount:_tax});
    const _couponDisc=COUPONS[couponCode]||0;
    if(_couponDisc>0)_lines.push({label:`Coupon ${couponCode}`,qty:1,amount:-_couponDisc});
    const bookingSummary={
      firstName:customer.first_name||'',
      name:`${customer.first_name||''} ${customer.last_name||''}`.trim(),
      email:customer.email||'', phone:customer.phone||'',
      address:[customer.address,customer.address_line2].filter(Boolean).join(', '), city:loc.city, state:loc.state, zip:enteredZip||'',
      dateISO:selectedDate||'', dateLong:_df?`${_df.long}, ${_df.date}`:'',
      timeWindow:_slot.arrival_window||'',
      lines:_lines, total:_taxBase+_tax-_couponDisc, tip:tipAmount||0,
      twoTechs:typeof needsTwoTechs==='function'?needsTwoTechs():false,
    };
    const payload={
      territory_id:territoryId, service_id:serviceConfig.service_id,
      selectedSlot, customer:{...customer,zip:enteredZip},
      city:loc.city, state:loc.state, postal_code:enteredZip,
      zbk_selections, tip:tipAmount, coupon:couponCode,payment_method_id:stripePaymentMethodId,
      sms_consent:smsConsent,
      idempotency_key:BOOKING_IDEM_KEY,
      email_summary:bookingSummary,
      ...(NATIVE&&{business:'handy-andy'}),
      // Denver 98"+ → require & auto-assign 2 technicians
      ...(needsTwoTechs()&&{min_providers_needed:'2',assignment_method:'auto'}),
    };
    const submitBtn=root.querySelector('#btn-submit');
    if(submitBtn){submitBtn.textContent='Booking…';submitBtn.disabled=true;}
    try{
      const r=await fetch(`${API_BASE}/book`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(r.ok){
        // Save a booking summary for the thank-you page (stays in the browser only — never in the URL)
        try{
          const res=await r.json().catch(()=>({}));
          localStorage.setItem('ha_booking',JSON.stringify({
            ...bookingSummary,
            jobId:(res&&(res.job_id||res.id))||'',
            rescheduleUrl:(res&&res.reschedule_url)||'',
            ts:Date.now()
          }));
        }catch(e){}
        logEvent('booking_confirmed', 'customer', calcTotal()+territoryAdjustment()+selectedSlotSurcharge()-(COUPONS[couponCode]||0));
        window.location.href=THANKYOU_URL;
      }else{
        // Server returned an error status — the job was not created, so it's safe
        // to unlock and let the customer correct the issue and try again.
        isSubmitting=false;
        if(submitBtn){submitBtn.textContent='Complete My Booking ✓';submitBtn.disabled=false;}
        const err=await r.json().catch(()=>({}));
        logEvent('booking_failed','customer',null,err.error||('HTTP '+r.status));
        alert(err.error||'Booking failed. Please try again.');
      }
    }catch{
      // Ambiguous failure (timeout / dropped connection): the request may have
      // reached the server and CREATED the job even though we got no response.
      // Re-submitting here is exactly what produces duplicate bookings, so we keep
      // the button locked and tell the customer not to click again.
      if(submitBtn){submitBtn.textContent='Confirming your booking…';submitBtn.disabled=true;}
      logEvent('booking_failed','customer',null,'connection error (locked to avoid duplicate booking)');
      alert('Your booking is being confirmed and may already be received — please do NOT submit again. Check your email for a confirmation, or call us at 713-876-9032 to verify.');
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  function ensureContainer(){
    let el=document.getElementById(TARGET_ID);
    if(el)return el;
    // Auto-create the container next to this script tag (or at end of body)
    el=document.createElement('div');
    el.id=TARGET_ID;
    el.style.cssText='max-width:580px;width:100%;margin:0 auto;';
    if(SELF_SCRIPT&&SELF_SCRIPT.parentNode){SELF_SCRIPT.parentNode.insertBefore(el,SELF_SCRIPT.nextSibling);}
    else{document.body.appendChild(el);}
    return el;
  }
  function boot(){
    logEvent('page_view', 'zip_verify');
    if(!document.getElementById('ha-widget-style')){
      const s=document.createElement('style');
      s.id='ha-widget-style';
      s.textContent='@media(min-width:768px){#ha-widget{max-width:638px!important;}}';
      document.head.appendChild(s);
    }
    if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',boot);return;}
    ensureContainer();
    render();
  }
  boot();
})();
