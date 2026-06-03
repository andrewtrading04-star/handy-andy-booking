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
          outside_wall:  { id: '16873954
