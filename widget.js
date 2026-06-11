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

  // Valid coupon codes → discount in dollars. Must match COUPONS in api/book.js,
  // which is the enforcing copy — this one only gives instant feedback pre-Stripe
  // and shows the discount on the thank-you summary.
  const COUPONS = {
    MCDENVER20: 20, MP10: 10, AUS10: 10, HOU10: 10, DEN10: 10,
    ISREAL15: 15, STEVE15: 15, BATCITY10: 10, FBD15: 15, FB15: 15,
    ANNIVERSARY15: 15, BING10: 10, OLIVE10: 10, STV10: 10, G10TV: 10,
    TV2026: 10, HG20: 20, LA10: 10, AB20: 20, FBA20: 20, FB10: 10,
  };

  // Day-of-week discounts: 0=Sun(-$15), 2=Tue(-$10)
  const WEEKDAY_DISC = { 0:15, 2:10 };
  const TAX_RATE = 0.0825;

  // Zenbooker per-territory price adjustments for the TV Installation service.
  // Mirrors Zenbooker's "Territory Adjustments" so the quoted total matches what
  // Zenbooker charges. Zenbooker applies these to the job automatically — this is
  // DISPLAY ONLY (it is NOT sent to /api/book, which would double-charge).
  // To update: Zenbooker → Services → TV Installation → Territory Adjustments.
  const TERRITORY_ADJUSTMENTS = {
    '1707513178246x806633139915194400': 25, // Denver #2
    '1687393551618x123774611115737090': 35, // Denver #3
    '1723559782141x609094402068185100': 100, // Denver #4 Boulder/Colorado Springs
  };
  function territoryAdjustment(){ return TERRITORY_ADJUSTMENTS[territoryId] || 0; }

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
            {id:'1685657519214x168809705059288930',label:'70"-84"',    price:149,sizecat:'medium'},
            {id:'1693451324278x246099356920840200',label:'85"-97"',    price:179,sizecat:'medium'},
            {id:'1729566606709x280549383678984200',label:'98+',        price:229,sizecat:'large'},
          ]
        },
        {
          stepKey:'bracket', id:'1685657518815x904945567500552400',
          title:'Should we bring a mounting bracket for your TV?', subtitle:'',
          type:'qty_match', required:true,
          options:[
            {id:'1685657519638x296785870103780400',label:'I have my own bracket',                  price:0,  forSize:'any'},
            {id:'1685657519638x151782031594280160',label:'Flat',                                   price:45, forSize:'standard'},
            {id:'1685657519638x293251872070913660',label:'Tilting (recommended)',                  price:55, forSize:'standard'},
            {id:'1685657519638x327788739524076600',label:'Full Motion',                            price:85, forSize:'standard'},
            {id:'1776229587207x710284994703786000',label:'87"-100" TV Flat Bracket',               price:90, forSize:'xl'},
            {id:'1776229598255x578976769128267800',label:'87"-100" TV Tilting Bracket',            price:110,forSize:'xl'},
            {id:'1776229610718x521138691917742100',label:'87"-100" TV Full Motion Bracket',        price:190,forSize:'xl'},
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
            {id:'1747842781494x315473919196528640',label:'My TV is 86 inches or larger',                     price:70,forCat:'large'},
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
            {id:'1724797765604x727281068776260100',label:'32" Or Less',price:89, sizecat:'small'},
            {id:'1724797765604x481821025163112770',label:'33"-59"',    price:99, sizecat:'small'},
            {id:'1724797765604x438257538375731460',label:'60"-69"',    price:109,sizecat:'small'},
            {id:'1724797765604x518845267466906000',label:'70"-84"',    price:139,sizecat:'medium'},
            {id:'1724797765604x143841244367788560',label:'85"-97"',    price:169,sizecat:'medium'},
            {id:'1729568390396x482351028241694700',label:'98+',        price:219,sizecat:'large'},
          ]
        },
        {
          stepKey:'bracket', id:'1724797765050x234498034542901950',
          title:'Should we bring a mounting bracket for your TV?', subtitle:'',
          type:'qty_match', required:true,
          options:[
            {id:'1724797766027x710120034063080800',label:'I have my own bracket',          price:0,  forSize:'any'},
            {id:'1724797766027x695942754553271000',label:'Flat',                           price:35, forSize:'standard'},
            {id:'1724797766027x943964834449722200',label:'Tilting (recommended)',          price:46, forSize:'standard'},
            {id:'1724797766027x264025092172061950',label:'Full Motion',                   price:85, forSize:'standard'},
            {id:'1776229836315x648480753516806100',label:'87"-100" TV Flat Bracket',      price:90, forSize:'xl'},
            {id:'1776229850923x848868840944959500',label:'87"-100" TV Tilting Bracket',   price:110,forSize:'xl'},
            {id:'1776229863741x796966835269926900',label:'87"-100" TV Full Motion Bracket',price:190,forSize:'xl'},
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
            {id:'1724797766922x870013576516632800',label:'Yes, hide the wires OUTSIDE the wall',     price:25},
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
            {id:'1747843192832x310647085776502800',label:'My TV is 86 inches or larger',                    price:70,forCat:'large'},
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
  let customer={first_name:'',last_name:'',email:'',phone:'',address:''};
  let tipAmount=0, couponCode='';
  let optionComments={}; // { [optionId]: "free text" } for Handyman / Other
  // Stripe
  let _stripe=null, _stripeElements=null, _stripeCard=null;

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
      return o&&o.sizecat==='large'&&s.quantity>0;
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
  function needsTwoTechs(){ return territoryId===DENVER_ID && hasLargeTV(); }

  function shouldSkip(k){
    // Skip bracket only if ALL TVs are Frame/Gallery (no regular TVs mixed in)
    if(k==='bracket'){
      const onlyFrame=isFrameTV&&!(selections['__frame_type']||[]).includes('regular');
      if(onlyFrame)return true;
    }
    if(k==='lifting'){
      const cat=getMaxSizeCat();
      if(cat==='small')return true;
      // Skip lifting entirely for large TVs outside Denver (no 2-tech requirement)
      if(cat==='large'&&territoryId!==DENVER_ID)return true;
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
            base:{color:'#fff',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',fontSize:'15px','::placeholder':{color:'#71717a'}},
            invalid:{color:'#ef4444'},
          },
          hidePostalCode:true,
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
  function slotSurcharge(sl){
    const m=sl.arrival_window.match(/^(\d+)(?::\d+)?\s*(AM|PM)/i);
    if(!m)return 0;let h=parseInt(m[1]);
    if(m[2].toUpperCase()==='PM'&&h!==12)h+=12;
    if(m[2].toUpperCase()==='AM'&&h===12)h=0;
    return h>=20?75:0;
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
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  function render(){
    const root=document.getElementById(TARGET_ID); if(!root)return;
    root.style.cssText=S.host;
    const key=STEP_KEYS[stepIdx];
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
      case 'customer': body=bCustomer(); break;
    }
    root.innerHTML=prog+body;
    wire(root);
    // Mount Stripe card element after DOM is ready
    if(key==='customer'){
      ensureStripe().then(mountStripeCard);
    }
  }

  // ─── Step builders ────────────────────────────────────────────────────────

  function bZip(){
    return `
      <div style="text-align:center!important;">
        <h1 style="${S.h1};font-size:26px!important;text-align:center!important;">Do we service your area?</h1>
        <p style="${S.sub};text-align:center!important;font-size:15px!important;">Enter your zip code to see.</p>
        <input type="text" id="ha-zip" style="${S.input}" placeholder="e.g. 77001" maxlength="5" inputmode="numeric">
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
      <div class="ha-tv-type" data-type="frame" style="${S.card(frameOn)}">
        <span>I have a Samsung Frame TV or LG Gallery TV</span>
        <span style="color:${frameOn?'#ff6600':'#52525b'}!important;font-size:18px!important;">${frameOn?'✓':'☐'}</span>
      </div>
      <div class="ha-tv-type" data-type="regular" style="${S.card(regOn)}">
        <span>I have a regular TV</span>
        <span style="color:${regOn?'#ff6600':'#52525b'}!important;font-size:18px!important;">${regOn?'✓':'☐'}</span>
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
        <span style="flex:1!important;">${o.label}${S.price(o.price)}</span>
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
    return `<h1 style="${S.h1}">${sec.title}</h1><p style="${S.sub}">${subtitle}</p>${banner}${opts}
      <div style="${S.actions}">
        <button id="btn-prev" style="${S.btnSec}">← Back</button>
        <button id="btn-next" style="${ok?S.btnPri:S.btnDis}" ${!ok?'disabled':''}>Continue →</button>
      </div>`;
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
          <span style="flex:1!important;">${o.label}${S.price(o.price)}</span>
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
          <span>${o.label}${S.price(o.price)}</span>
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
    // Large TV: auto-selected, show message only
    if(cat==='large'){
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
        <span>${displayLabel}${S.price(o.price)}</span>
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
        const on=selectedSlot===sl.id, sur=slotSurcharge(sl);
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
    const base=calcTotal()+adj;
    const tips=[0,5,10,15,20];
    const tipHtml=tips.map(t=>`<button class="ha-tip" data-tip="${t}"
      style="background:${tipAmount===t?'#ff6600':'#27272a'}!important;color:#fff!important;border:1.5px solid ${tipAmount===t?'#ff6600':'#3f3f46'}!important;border-radius:6px!important;padding:8px 14px!important;font-size:14px!important;cursor:pointer!important;flex:1!important;">
      ${t===0?'No Tip':`$${t}`}
    </button>`).join('');
    return `
      <h1 style="${S.h1};color:#ff6600!important;">Almost Done! Last Step…</h1>
      <div style="background:rgba(34,197,94,0.08)!important;border:1px solid rgba(34,197,94,0.2)!important;border-radius:8px!important;padding:12px 14px!important;margin-bottom:18px!important;font-size:12px!important;color:#a0a0ab!important;line-height:1.6!important;">
        💳 <strong style="color:#fff!important;">Your card will not be charged until after the job is complete.</strong>
        Payment is taken at time of service by the technician.
        Card is only needed now to hold the appointment.
        We will only charge you after your services have been completed.
      </div>
      <input type="text"  id="c-fn" style="${S.inputL}" placeholder="First Name"     value="${customer.first_name}">
      <input type="text"  id="c-ln" style="${S.inputL}" placeholder="Last Name"      value="${customer.last_name}">
      <input type="email" id="c-em" style="${S.inputL}" placeholder="Email Address"  value="${customer.email}">
      <input type="tel"   id="c-ph" style="${S.inputL}" placeholder="Phone Number"   value="${customer.phone}">
      <input type="text"  id="c-ad" style="${S.inputL}" placeholder="Street Address" value="${customer.address}">
      <div style="background:#27272a!important;border:1px solid #3f3f46!important;border-radius:8px!important;padding:14px!important;margin-bottom:14px!important;">
        <div style="font-size:11px!important;color:#a0a0ab!important;margin-bottom:12px!important;font-weight:600!important;text-transform:uppercase!important;letter-spacing:0.5px!important;">💳 Card to Hold Appointment</div>
        <div id="stripe-card-element" style="background:#1a1a1e!important;border:1px solid #3f3f46!important;border-radius:6px!important;padding:14px!important;min-height:44px!important;"></div>
        <p style="font-size:11px!important;color:#52525b!important;margin:8px 0 0 0!important;">🔒 Secured by Stripe. Payment collected by technician at time of service.</p>
      </div>
      <div style="margin-bottom:14px!important;">
        <div style="font-size:13px!important;color:#a0a0ab!important;margin-bottom:8px!important;">Tip your technician (optional)</div>
        <div style="display:flex!important;gap:6px!important;">${tipHtml}</div>
      </div>
      <div style="margin-bottom:20px!important;">
        <input type="text" id="c-coupon" style="${S.inputL};margin-bottom:0!important;" placeholder="Coupon code (optional)" value="${couponCode}">
      </div>
      <div style="background:rgba(34,197,94,0.08)!important;border:1.5px solid rgba(34,197,94,0.25)!important;border-radius:10px!important;padding:16px 18px!important;margin-bottom:18px!important;">
        <div style="font-size:13px!important;color:#a0a0ab!important;margin-bottom:8px!important;">
          <div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Subtotal</span>
            <span id="ha-subtotal" style="color:#fff!important;">$${Math.round(calcTotal()*100)/100}</span>
          </div>
          ${adj>0?`<div style="display:flex!important;justify-content:space-between!important;margin-bottom:4px!important;">
            <span>Service area surcharge</span>
            <span style="color:#fff!important;">+$${adj}</span>
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
    root.querySelectorAll('.ha-tip').forEach(b=>b.addEventListener('click',()=>{tipAmount=parseInt(b.dataset.tip);render();}));
    root.querySelectorAll('.ha-comment').forEach(t=>t.addEventListener('input',e=>{optionComments[e.target.dataset.o]=e.target.value;}));
    // Card inputs replaced by Stripe Elements — no manual binding needed
  }

  // ─── Navigation ───────────────────────────────────────────────────────────
  function goNext(){
    let ni=stepIdx+1;
    while(ni<STEP_KEYS.length&&shouldSkip(STEP_KEYS[ni]))ni++;
    // If entering slots, fetch them
    if(STEP_KEYS[ni]==='slots')fetchSlots();
    // If entering lifting and cat is large, auto-select
    if(STEP_KEYS[ni]==='lifting'&&getMaxSizeCat()==='large'&&territoryId===DENVER_ID){
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
    try{
      const r=await fetch(`${API_BASE}/service-area`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zip})});
      const d=await r.json();
      if(!d.territory_id){btn.textContent='Check Area →';btn.disabled=false;return alert('It appears this area is a little far for us. But you should call to confirm. 713-876-9032');}
      territoryId=d.territory_id; enteredZip=zip;
      areaCity=d.city||''; areaState=d.state||'';
      serviceConfig=SERVICE_CONFIGS[TERRITORY_CONFIG_MAP[territoryId]||'default'];
      stepIdx=1; render();
    }catch{btn.textContent='Check Area →';btn.disabled=false;alert('Network error. Please try again.');}
  }

  // ─── Slots fetch ──────────────────────────────────────────────────────────
  async function fetchSlots(){
    try{
      const provReq=needsTwoTechs()?2:1;
      const r=await fetch(`${API_BASE}/slots?territory_id=${territoryId}&duration=120&days=30&min_providers_needed=${provReq}`);
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
      render();
    }catch{slotsByDate={};render();}
  }

  // ─── Submit ───────────────────────────────────────────────────────────────
  async function doSubmit(root){
    customer.first_name=root.querySelector('#c-fn').value.trim();
    customer.last_name=root.querySelector('#c-ln').value.trim();
    customer.email=root.querySelector('#c-em').value.trim();
    customer.phone=root.querySelector('#c-ph').value.trim();
    customer.address=root.querySelector('#c-ad').value.trim();
    couponCode=root.querySelector('#c-coupon')?.value.trim().toUpperCase()||'';
    if(!customer.email)return alert('Please enter your email address.');
    if(!customer.phone)return alert('Please enter your phone number.');
    if(!customer.address)return alert('Please enter your street address.');
    if(couponCode&&!(couponCode in COUPONS))return alert('That coupon code isn\'t valid. Please check it or clear the coupon field.');

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
          address:{line1:customer.address},
        },
      });
      if(error){
        if(submitBtn){submitBtn.textContent='Complete My Booking ✓';submitBtn.disabled=false;}
        return alert(error.message);
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
    const payload={
      territory_id:territoryId, service_id:serviceConfig.service_id,
      selectedSlot, customer:{...customer,zip:enteredZip},
      city:loc.city, state:loc.state, postal_code:enteredZip,
      zbk_selections, tip:tipAmount, coupon:couponCode,payment_method_id:stripePaymentMethodId,
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
          const slot=(slotsByDate[selectedDate]||[]).find(s=>s.id===selectedSlot)||{};
          const df=selectedDate?fmtDate(selectedDate):null;
          const lines=[];
          for(const sec of serviceConfig.sections){
            for(const sel of(selections[sec.id]||[])){
              const opt=sec.options.find(o=>o.id===sel.option_id);
              if(opt&&sel.quantity>0)lines.push({label:opt.label,qty:sel.quantity,amount:(opt.price||0)*sel.quantity});
            }
          }
          if(territoryAdjustment()>0)lines.push({label:'Service area surcharge',qty:1,amount:territoryAdjustment()});
          const couponDisc=COUPONS[couponCode]||0;
          if(couponDisc>0)lines.push({label:`Coupon ${couponCode}`,qty:1,amount:-couponDisc});
          const loc=resolveLocation();
          localStorage.setItem('ha_booking',JSON.stringify({
            firstName:customer.first_name||'',
            name:`${customer.first_name||''} ${customer.last_name||''}`.trim(),
            email:customer.email||'', phone:customer.phone||'',
            address:customer.address||'', city:loc.city, state:loc.state, zip:enteredZip||'',
            dateISO:selectedDate||'', dateLong:df?`${df.long}, ${df.date}`:'',
            timeWindow:slot.arrival_window||'',
            lines, total:calcTotal()+territoryAdjustment()-couponDisc, tip:tipAmount||0,
            twoTechs:typeof needsTwoTechs==='function'?needsTwoTechs():false,
            jobId:(res&&(res.job_id||res.id))||'',
            rescheduleUrl:(res&&res.reschedule_url)||'',
            ts:Date.now()
          }));
        }catch(e){}
        window.location.href=THANKYOU_URL;
      }else{
        if(submitBtn){submitBtn.textContent='Complete My Booking ✓';submitBtn.disabled=false;}
        const err=await r.json().catch(()=>({}));
        alert(err.error||'Booking failed. Please try again.');
      }
    }catch{
      if(submitBtn){submitBtn.textContent='Complete My Booking ✓';submitBtn.disabled=false;}
      alert('Connection error. Please try again.');
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
