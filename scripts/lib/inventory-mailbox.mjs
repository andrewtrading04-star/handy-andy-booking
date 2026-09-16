import { parseWalmartEmails } from './walmart-parse.mjs';
import { WALMART_SEARCH_TERMS, gmailAuthenticationResults, walmartScanSince, searchMailboxUids } from './walmart-sync.mjs';
import { parseAmazonPlateEmail } from './amazon-parse.mjs';
import { parseGoogleReviewEmail } from './google-review-parse.mjs';
import { parseWebsiteLeadEmail } from './website-lead-parse.mjs';

const OTHER_SEARCH_TERMS = [
  {from:'auto-confirm@amazon.com'},{from:'ship-confirm@amazon.com'},{from:'order-update@amazon.com'},
  {body:'ANONION'},{body:'brush wall plate'},{body:'cable pass through'},
  {from:'businessprofile-noreply@google.com'},{body:'left a review for'},
  {from:'landingsite.ai'},{body:'New customer message from'},
];
const AMAZON_ORDER_SENDER_RE = /^(auto-confirm|ship-confirm|order-update)@amazon\.com$/i;

// Archive coverage applies only to Walmart. Other integrations retain their
// existing INBOX boundary; archived recommendations cannot become plate orders.
export async function scanInventoryMailbox({box,checkpoint,todayISO,lookbackDays=45,trustedForwarders=[],ImapFlow,simpleParser,now=new Date()}) {
  const client = new ImapFlow({host:'imap.gmail.com',port:993,secure:true,auth:{user:box.user,pass:box.pass},logger:false,socketTimeout:60000,greetingTimeout:15000,connectionTimeout:15000});
  client.on('error',()=>{});
  const result={walmart:[],amazon:[],reviews:[],leads:[]}, started=Date.now();
  const meta={candidates:0,search_terms_failed:0,parse_failures:0,unparsed_walmart:0,walmart_complete:true,walmart_archive_coverage:false,coverage_issues:[],walmart_scanned_through:now.toISOString()};
  let stage='connect';
  try { await client.connect(); } catch(error) { try{client.close();}catch(_){} error.stage=stage;throw error; }
  try {
    let archive=null;
    try { archive=(await client.list()).find(f => f.specialUse === '\\All' || f.specialUse?.includes?.('\\All'))?.path; }
    catch(_) { meta.coverage_issues.push('archive_listing_failed'); }
    if(!archive) {meta.walmart_complete=false;meta.coverage_issues.push('archive_folder_unavailable');}
    else meta.walmart_archive_coverage=true;
    const plans=[{path:archive || 'INBOX',walmart:true,terms:WALMART_SEARCH_TERMS,since:walmartScanSince(checkpoint,lookbackDays,now)},
      {path:'INBOX',walmart:false,terms:OTHER_SEARCH_TERMS,since:new Date(now.getTime()-lookbackDays*86400000)}];
    for(const plan of plans) {
      try {
        stage='open';await client.mailboxOpen(plan.path);
        stage='search';const found=await searchMailboxUids(client,plan.since,plan.terms);
        meta.candidates+=found.uids.length;meta.search_terms_failed+=found.failed_terms;
        if(found.failed_terms) {meta.coverage_issues.push(...found.failed_searches);if(plan.walmart)meta.walmart_complete=false;}
        if(!found.uids.length)continue;
        stage='fetch';let fetched=0;
        for await(const msg of client.fetch(found.uids,{source:true},{uid:true})) {
          fetched++;
          let parsed;
          try {parsed=await simpleParser(msg.source);}catch(_) {meta.parse_failures++;if(plan.walmart)meta.walmart_complete=false;continue;}
          const sourceDate=parsed.date && Number.isFinite(Date.parse(parsed.date)) ? new Date(parsed.date).toISOString() : null;
          const email={subject:parsed.subject || '',text:parsed.text || '',html:parsed.html || '',todayISO,emailDateISO:sourceDate};
          const from=(parsed.from?.value?.[0]?.address || '').toLowerCase();
          if(plan.walmart) {
            const events=parseWalmartEmails({...email,from,messageId:parsed.messageId || '',authenticationResults:gmailAuthenticationResults(parsed),trustedForwarders});
            if(!events.length && /\b(?:order|package|delivery)\b/i.test(email.subject) && /walmart/i.test(from+' '+email.text+' '+email.html)) {meta.unparsed_walmart++;meta.walmart_complete=false;}
            result.walmart.push(...events);continue;
          }
          const review=parseGoogleReviewEmail({...email,mailbox:box.user});if(review)result.reviews.push(review);
          const trustSender=box.idx===3 && AMAZON_ORDER_SENDER_RE.test(from);
          const plate=parseAmazonPlateEmail({...email,trustSender});if(plate)result.amazon.push(plate);
          const lead=parseWebsiteLeadEmail({from,subject:email.subject,text:email.text,html:email.html,messageId:parsed.messageId || '',receivedISO:sourceDate || ''});
          if(lead)result.leads.push(lead);
        }
        if(fetched!==found.uids.length) {meta.coverage_issues.push('message_fetch_incomplete');if(plan.walmart)meta.walmart_complete=false;}
      }catch(error) {
        meta.coverage_issues.push((plan.walmart?'walmart':'other')+'_'+stage+'_failed');
        if(plan.walmart)meta.walmart_complete=false;
      }
    }
  }finally {await client.logout().catch(()=>{try{client.close();}catch(_){}});}
  if(!meta.walmart_complete)meta.walmart_scanned_through=null;
  meta.ms=Date.now()-started;
  return {...result,meta};
}
