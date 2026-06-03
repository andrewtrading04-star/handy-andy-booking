// /api/book.js
// Creates a Zenbooker job from the widget's submission.

const SERVICE_BY_TERRITORY = {
  '1707514546803x280800015001583600': 'tv_mounting_default',
  '1685582903241x973573877706522600': 'mile_high_tv',
  '1724797832896x339501352491155460': 'tv_mounting_austin',
  '1760944311332x492178768310304800': 'tv_installation_la',
};

const ZENBOOKER_MAPS = {
  tv_mounting_default: {
    service_id: '1653587266109x109705534410984510',
    sections: {
      size: {
        section_id: '1653587266762x644740117412491400', multi: true,
        options: {
          under_32:   { id: '1693451191904x564182300541059100', price: 89  },
          size_33_59: { id: '1653587267119x242710235897085200', price: 99  },
          size_60_69: { id: '1658018256443x779172072221311000', price: 109 },
          size_70_84: { id: '1653587267119x864105256594568200', price: 139 },
          size_85_97: { id: '1653590763425x524447724863225860', price: 159 },
          size_98_up: { id: '1729567496521x618831962825031700', price: 199 },
        },
      },
      bracket: {
        section_id: '1653587266762x547068990139036900', multi: true,
        options: {
          flat:           { id: '1653587268118x708748614388152000', price: 45  },
          tilting:        { id: '1653587268118x712835014405049100', price: 55  },
          full_motion:    { id: '1653587268118x528350653267204860', price: 95  },
          mantel_mount:   { id: '1736123066445x224986409018327040', price: 195 },
          frame_box:      { id: '1736123879216x657973986728345600', price: 25  },
          flat_xl:        { id: '1776229293599x430560602421461000', price: 90  },
          tilting_xl:     { id: '1776229338933x444263378803752960', price: 110 },
          full_motion_xl: { id: '1776229355305x926132429999833100', price: 190 },
          own:            { id: '1653587268118x508374258862357440', price: 0   },
        },
      },
      fireplace: {
        section_id: '1693450777428x891835261005594600', multi: true,
        options: {
          not_over_fp: { id: '1693450777428x878253383430963200', price: 0  },
          over_fp:     { id: '1693450854449x547232971573690400', price: 35 },
        },
      },
      wires: {
        section_id: '1653609304556x656354672724410400', multi: true,
        options: {
          behind_wall:   { id: '1653609304556x761616600253595600', price: 65 },
          outside_wall:  { id: '1653609378728x179148272858038270', price: 25 },
          existing_plug: { id: '1661374985250x117976402407718910', price: 0  },
          hang_under:    { id: '1661375006315x794142424076648400', price: 0  },
        },
      },
      surface: {
        section_id: '1653592844995x671476707651485700', multi: true,
        options: {
          drywall:     { id: '1653592844995x766803590290079700', price: 0  },
          brick_stone: { id: '1653594047290x505179172377198600', price: 35 },
          tile:        { id: '1685667891864x869573216125321200', price: 60 },
          stucco:      { id: '1690763636163x339535244234850300', price: 45 },
        },
      },
      lift: {
        section_id: '1653706185664x743252558441611300', multi: false,
        options: {
          under_70:       { id: '1752594635492x804798317425590300', price: 0  },
          large_can_help: { id: '1752594680275x636157812380794900', price: 0  },
          large_no_help:  { id: '1752594649666x436862259913031700', price: 70 },
          xl:             { id: '1752594693466x866394038673866800', price: 70 },
        },
      },
      dismount: {
        section_id: '1764627800644x576981752041963500', multi: false,
        options: {
          yes_dismount: { id: '1764627800644x550817650394005500', price: 35 },
          no_dismount:  { id: '1764627838473x178730265001590800', price: 0  },
        },
      },
      extras: {
        section_id: '1698905965711x853573984575815700', multi: true,
        options: {
          frame_oneconnect: { id: '1715224494528x832386021404442600', price: 350 },
          soundbar:         { id: '1698905965711x236676060701523970', price: 45  },
          shelf:            { id: '1698905980513x999576498693472300', price: 45  },
          led:              { id: '1698905982723x340200038207324160', price: 45  },
          handyman_hour:    { id: '1715825659467x210424456712028160', price: 85  },
          other:            { id: '1698905983807x528888757616640000', price: 0   },
        },
      },
      terms: {
        section_id: '1670478884078x702181431380541400', multi: false,
        options: { agree: { id: '1670479066408x591293641919823900', price: 0 } },
      },
    },
  },

  mile_high_tv: {
    service_id: '1687239047599x954077707121459200',
    sections: {
      size: {
        section_id: '1687239302060x918328183325982700', multi: true,
        options: {
          under_32:   { id: '1687239302060x219350691337994240', price: 99  },
          size_33_59: { id: '1687239458945x265901255795671040', price: 109 },
          size_60_69: { id: '1687239478313x995123678208852000', price: 119 },
          size_70_84: { id: '1687239494804x144508271821848580', price: 149 },
          size_85_97: { id: '1722017207331x890752902291783700', price: 179 },
          size_98_up: { id: '1729566666924x943393577940811800', price: 229 },
        },
      },
      bracket: {
        section_id: '1687394770856x900651816848719900', multi: true,
        options: {
          flat:           { id: '1687394770856x465440116442923000', price: 50  },
          tilting:        { id: '1687394895262x652848035361194000', price: 60  },
          full_motion:    { id: '1687394950262x561025634666020860', price: 95  },
          mantel_mount:   { id: '1736124078363x706985458161418200', price: 195 },
          frame_box:      { id: '1736124052699x930312737332920300', price: 25  },
          own:            { id: '1687394983091x181479080471298050', price: 0   },
          flat_xl:        { id: '1776229741294x782853377585053700', price: 90  },
          tilting_xl:     { id: '1776229750784x379738444583141400', price: 110 },
          full_motion_xl: { id: '1776229763779x311631909865127940', price: 190 },
        },
      },
      fireplace: {
        section_id: '1687395055986x240989237861941250', multi: true,
        options: {
          not_over_fp: { id: '1687395055986x611152148781072400', price: 0  },
          over_fp:     { id: '1687395241090x161488536174329860', price: 30 },
        },
      },
      wires: {
        section_id: '1687395357375x164288345280348160', multi: true,
        options: {
          behind_wall:   { id: '1687395357375x579277725405020200', price: 75 },
          outside_wall:  { id: '1687395435106x122985778437685250', price: 25 },
          existing_plug: { id: '1687395484393x753639629702037500', price: 0  },
          hang_under:    { id: '1696473898634x958734780351381500', price: 0  },
        },
      },
      surface: {
        section_id: '1696474023958x953404285446258700', multi: true,
        options: {
          drywall:     { id: '1696474023958x268232434922553340', price: 0  },
          brick_stone: { id: '1696474035708x301472138458824700', price: 35 },
          tile:        { id: '1696474037070x135298513687805950', price: 50 },
          stucco:      { id: '1696474037964x730032387267231700', price: 45 },
        },
      },
      lift: {
        section_id: '1695956423203x498248126749999100', multi: false,
        options: {
          under_70:       { id: '1695956465986x871311950618820600', price: 0  },
          large_can_help: { id: '1695956423203x463178543329181700', price: 0  },
          large_no_help:  { id: '1695956447367x530968873533964300', price: 70 },
          xl:             { id: '1747843071110x325171063309991940', price: 70 },
        },
      },
      dismount: {
        section_id: '1694194002656x228290383220047870', multi: false,
        options: {
          yes_dismount: { id: '1694194091702x773754410507173900', price: 35 },
          no_dismount:  { id: '1751647382728x318052542116528100', price: 0  },
        },
      },
      extras: {
        section_id: '1698905535987x751833911343710200', multi: true,
        options: {
          frame_oneconnect: { id: '1720021056096x935374111686787100', price: 350 },
          apple_tv:         { id: '1720021029008x509848067729260540', price: 25  },
          soundbar:         { id: '1698905535987x341279390231429100', price: 50  },
          shelf:            { id: '1698905589704x586204997703172100', price: 45  },
          led:              { id: '1698905591026x346046598604652540', price: 55  },
          handyman_hour:    { id: '1720021066394x976834830813102000', price: 85  },
          other:            { id: '1698905591912x241343261961093120', price: 0   },
        },
      },
      terms: {
        section_id: '1687548935154x145847833692471300', multi: false,
        options: { agree: { id: '1687548944036x955489678238679000', price: 0 } },
      },
    },
  },

  tv_mounting_austin: {
    service_id: '1724797764673x959123834234875100',
    sections: {
      size: {
        section_id: '1724797765050x841129871559158100', multi: true,
        options: {
          under_32:   { id: '1724797765604x727281068776260100', price: 89  },
          size_33_59: { id: '1724797765604x481821025163112770', price: 99  },
          size_60_69: { id: '1724797765604x438257538375731460', price: 109 },
          size_70_84: { id: '1724797765604x518845267466906000', price: 139 },
          size_85_97: { id: '1724797765604x143841244367788560', price: 169 },
          size_98_up: { id: '1729568390396x482351028241694700', price: 219 },
        },
      },
      bracket: {
        section_id: '1724797765050x234498034542901950', multi: true,
        options: {
          flat:           { id: '1724797766027x695942754553271000', price: 35  },
          tilting:        { id: '1724797766027x943964834449722200', price: 46  },
          full_motion:    { id: '1724797766027x264025092172061950', price: 85  },
          mantel_mount:   { id: '1736124243144x720870692012425200', price: 195 },
          frame_box:      { id: '1736124206975x556289593228656640', price: 25  },
          own:            { id: '1724797766027x710120034063080800', price: 0   },
          flat_xl:        { id: '1776229836315x648480753516806100', price: 90  },
          tilting_xl:     { id: '1776229850923x848868840944959500', price: 110 },
          full_motion_xl: { id: '1776229863741x796966835269926900', price: 190 },
        },
      },
      fireplace: {
        section_id: '1724797765050x593496857537082900', multi: true,
        options: {
          not_over_fp: { id: '1724797766490x787769899631215200', price: 0  },
          over_fp:     { id: '1724797766490x438470170995459460', price: 35 },
        },
      },
      wires: {
        section_id: '1724797765050x927635225756017200', multi: true,
        options: {
          behind_wall:   { id: '1724797766922x649390430397306400', price: 65 },
          outside_wall:  { id: '1724797766922x870013576516632800', price: 25 },
          existing_plug: { id: '1724797766922x460684749103141800', price: 0  },
          hang_under:    { id: '1724797766922x646841379925741600', price: 0  },
        },
      },
      surface: {
        section_id: '1724797765050x772248118717189900', multi: true,
        options: {
          drywall:     { id: '1724797767239x185050352406898050', price: 0  },
          brick_stone: { id: '1724797767239x584976221219833100', price: 35 },
          tile:        { id: '1724797767239x159866758831751040', price: 50 },
          stucco:      { id: '1724797767239x571833870984715500', price: 45 },
        },
      },
      lift: {
        section_id: '1724797765050x175556423249628740', multi: false,
        options: {
          under_70:       { id: '1724797767615x862955223994130700', price: 0  },
          large_can_help: { id: '1724797767615x715957457515909400', price: 0  },
          large_no_help:  { id: '1727409857684x617202431885574100', price: 70 },
          xl:             { id: '1747843192832x310647085776502800', price: 70 },
        },
      },
      dismount: {
        section_id: '1724797765050x244604568865458100', multi: false,
        options: {
          yes_dismount: { id: '1724797767881x240367043608421540', price: 35 },
          no_dismount:  { id: '1751646857916x242648686812463100', price: 0  },
        },
      },
      extras: {
        section_id: '1724797765050x213192360935727360', multi: true,
        options: {
          frame_oneconnect: { id: '1741212168056x241358652217229300', price: 350 },
          soundbar:         { id: '1724797768116x299580540855954900', price: 45  },
          shelf:            { id: '1724797768116x917721356073396700', price: 45  },
          led:              { id: '1724797768116x423659180367796740', price: 45  },
          handyman_hour:    { id: '1724797768116x234539799179230620', price: 85  },
          other:            { id: '1724797768116x790768026842265000', price: 0   },
        },
      },
      terms: {
        section_id: '1724797765050x430508661186572740', multi: false,
        options: { agree: { id: '1724797768519x561520623913572350', price: 0 } },
      },
    },
  },
};

function resolveKey(stepId, val) {
  const v = String(val).toLowerCase();
  switch (stepId) {
    case 'size':
      if (v.includes('32'))                                      return 'size_33_59';
      if (v.includes('44') || v.includes('55'))                  return 'size_33_59';
      if (v.includes('56') || v.includes('65'))                  return 'size_60_69';
      if (v.includes('66') || v.includes('75'))                  return 'size_70_84';
      return 'size_85_97';
    case 'bracket':
      if (v.includes('own') || v.includes('already have'))       return 'own';
      if (v.includes('fixed') || v.includes('flush'))            return 'flat';
      if (v.includes('full-motion') || v.includes('articulating')) return 'full_motion';
      if (v.includes('tilt'))                                    return 'tilting';
      return 'own';
    case 'fireplace':
      return v.startsWith('yes') ? 'over_fp' : 'not_over_fp';
    case 'wires':
      if (v.includes('inside') || v.includes('behind'))          return 'behind_wall';
      if (v.includes('track') || v.includes('outside'))          return 'outside_wall';
      return 'hang_under';
    case 'surface':
      if (v.includes('brick') || v.includes('concrete') || v.includes('stone')) return 'brick_stone';
      if (v.includes('tile') || v.includes('backsplash'))        return 'tile';
      if (v.includes('metal'))                                   return 'drywall';
      return 'drywall';
    case 'lift':
      return 'under_70';
    case 'dismount':
      return v.startsWith('yes') ? 'yes_dismount' : 'no_dismount';
    case 'terms':
      return 'agree';
    default:
      return null;
  }
}

function resolveExtrasKeys(arr) {
  const keys = [];
  for (const val of arr) {
    const v = String(val).toLowerCase();
    if (v.includes('soundbar'))  keys.push('soundbar');
    else if (v.includes('led'))  keys.push('led');
  }
  return keys;
}

function buildSections(answers, svcMap) {
  const sections = [];
  for (const [stepId, def] of Object.entries(svcMap.sections)) {
    const answer = answers[stepId];
    if (answer == null) continue;
    let optionIds = [];
    if (stepId === 'extras') {
      const arr = Array.isArray(answer) ? answer : [answer];
      optionIds = resolveExtrasKeys(arr).map(k => def.options[k]?.id).filter(Boolean);
    } else {
      const key = resolveKey(stepId, answer);
      if (key && def.options[key]) optionIds = [def.options[key].id];
    }
    if (optionIds.length > 0) {
      sections.push({
        section_id: def.section_id,
        options: optionIds.map(id => ({ option_id: id, quantity: 1 })),
      });
    }
  }
  return sections;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const { territory_id, answers, selectedSlot, customer } = req.body || {};

  if (!territory_id) return res.status(400).json({ error: 'territory_id is required' });
  if (!selectedSlot) return res.status(400).json({ error: 'selectedSlot is required' });
  if (!customer?.email) return res.status(400).json({ error: 'customer.email is required' });

  const svcKey = SERVICE_BY_TERRITORY[territory_id];
  if (!svcKey || !ZENBOOKER_MAPS[svcKey]) {
    return res.status(400).json({ error: `No service map for territory ${territory_id}` });
  }

  const svcMap = ZENBOOKER_MAPS[svcKey];
  const sections = buildSections(answers || {}, svcMap);

  const payload = {
    service_id:  svcMap.service_id,
    timeslot_id: selectedSlot,
    territory_id,
    address:     customer.address || '',
    customer: {
      first_name: customer.first_name || '',
      last_name:  customer.last_name  || '',
      email:      customer.email,
      phone:      customer.phone      || '',
    },
    sections,
  };

  try {
    const r = await fetch('https://api.zenbooker.com/v1/jobs', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${ZBK_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('[book] Zenbooker error', r.status, JSON.stringify(data));
      return res.status(r.status).json({ error: data?.message || 'Booking failed', details: data });
    }

    return res.status(200).json({ success: true, job: data });
  } catch (err) {
    console.error('[book] Fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
