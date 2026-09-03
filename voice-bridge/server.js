// Standalone always-on bridge: Twilio ConversationRelay (WebSocket, plain
// JSON text messages — Twilio itself handles speech-to-text and
// text-to-speech, so no raw audio ever passes through this process) <->
// OpenAI Chat Completions with function calling, which drives the
// conversation using the tools in tools.js (all backed by the CRM's real
// /api/admin actions). Not a Vercel serverless function — this needs a
// persistent process (Fly.io/Render/Railway), since ConversationRelay holds
// one WebSocket open per call for the call's whole duration.
import http from 'http';
import { WebSocketServer } from 'ws';
import { verifyTwilioSignature } from './auth.js';
import { trackingNumberByPhone, businessBySlug, sessionUpsert, sessionSave } from './db.js';
import { adminApi } from './adminApi.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { buildSystemPrompt } from './prompt.js';

const PORT = process.env.PORT || 8080;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TOOL_HOPS = 6;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/relay')) { socket.destroy(); return; }
  // ConversationRelay signs the handshake the same way Twilio signs any
  // webhook — verify it before ever accepting the connection. See
  // twilioVoiceParams() in api/analytics.js for the HTTP-webhook equivalent;
  // this is the WS-handshake version of the same check.
  const signature = req.headers['x-twilio-signature'];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.url}`;
  if (!verifyTwilioSignature(url, {}, signature)) {
    console.error('[voice-bridge] rejected WS handshake: bad/missing Twilio signature');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const call = { ws, history: [], ctx: null, ended: false };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'setup') return handleSetup(call, msg).catch((e) => {
      console.error('[voice-bridge] setup failed:', e.message);
      speak(call, "Sorry, we're having trouble right now. Let me get you to someone who can help.");
      endCall(call);
    });

    if (msg.type === 'prompt' && msg.voicePrompt) {
      // ConversationRelay can send interim (partial) transcripts; only act
      // once the caller has actually finished speaking.
      if (msg.last === false) return;
      return handleTurn(call, msg.voicePrompt).catch((e) => {
        console.error('[voice-bridge] turn failed:', e.message);
        speak(call, "Sorry, I didn't catch that — could you say that again?");
      });
    }

    // 'interrupt', 'dtmf', 'error' etc: nothing special needed yet — the
    // model's next turn just continues from wherever the conversation is.
  });

  ws.on('close', () => { call.ended = true; });
  ws.on('error', (e) => console.error('[voice-bridge] ws error:', e.message));
});

async function handleSetup(call, msg) {
  const callSid = msg.callSid || (msg.customParameters && msg.customParameters.sid) || '';
  const toNumber = String(msg.to || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  const fromNumber = String(msg.from || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

  const line = await trackingNumberByPhone(toNumber);
  if (!line) throw new Error(`no tracking_numbers row for ${toNumber}`);
  const biz = await businessBySlug(line.business_slug);
  if (!biz) throw new Error(`no business for slug ${line.business_slug}`);

  const { services: svcs } = await adminApi('services', { params: { business: biz.slug } }).catch(() => ({ services: [] }));
  const tvService = (svcs || []).find((s) => /tv\s*mount|tv\s*install/i.test(s.category || s.name || ''));
  const handymanService = (svcs || []).find((s) => /handyman/i.test(s.category || s.name || ''));

  call.ctx = {
    callSid,
    businessSlug: biz.slug,
    businessName: biz.name,
    callerPhone: fromNumber,
    tvServiceId: tvService ? tvService.id : null,
    handymanServiceId: handymanService ? handymanService.id : null,
  };

  await sessionUpsert({
    call_sid: callSid, business_id: biz.id, business_slug: biz.slug,
    tracking_number: line.phone, caller_phone: fromNumber,
    step: 'in_progress', data: { engine: 'v2' }, retry_count: 0,
  }).catch((e) => console.error('[voice-bridge] session upsert failed:', e.message));

  const sys = buildSystemPrompt({ businessName: biz.name, hasTv: !!tvService, hasHandyman: !!handymanService });
  call.history.push({ role: 'system', content: sys });

  const greetName = biz.name || 'us';
  const greeting = (tvService && handymanService)
    ? `Thanks for calling ${greetName}! Are you looking to book TV mounting or handyman service today?`
    : `Thanks for calling ${greetName}! What can we help you get scheduled today?`;
  speak(call, greeting);
  call.history.push({ role: 'assistant', content: greeting });
}

async function handleTurn(call, callerText) {
  if (!call.ctx) return; // setup hasn't landed yet, ignore stray prompt
  call.history.push({ role: 'user', content: callerText });

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const resp = await callOpenAI(call.history);
    const choice = resp.choices && resp.choices[0];
    const message = choice && choice.message;
    if (!message) throw new Error('no message from OpenAI');

    if (message.tool_calls && message.tool_calls.length) {
      call.history.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
      for (const tc of message.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* bad args from model */ }
        let result;
        try { result = await runTool(tc.function.name, args, call.ctx); }
        catch (e) { result = { error: e.message }; }
        call.history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });

        if (tc.function.name === 'book_job' && result && result.booked) {
          await sessionSave(call.ctx.callSid, { step: 'done', data: { engine: 'v2', booked: true, total: result.total } }).catch(() => {});
        }
        if (tc.function.name === 'transfer_to_human') {
          speak(call, "Sure thing — one moment while I connect you.");
          return endCall(call);
        }
      }
      continue; // let the model see the tool results and respond
    }

    if (message.content) {
      call.history.push({ role: 'assistant', content: message.content });
      speak(call, message.content);
    }
    return;
  }
  // Hit the hop cap without a final answer — don't leave the caller hanging.
  speak(call, "Let me get you to someone who can finish this up.");
  endCall(call);
}

async function callOpenAI(history) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: history, tools: TOOL_SCHEMAS, tool_choice: 'auto', temperature: 0.4 }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

function speak(call, text) {
  if (call.ended || call.ws.readyState !== call.ws.OPEN) return;
  call.ws.send(JSON.stringify({ type: 'text', token: text, last: true }));
}

function endCall(call) {
  call.ended = true;
  try { call.ws.close(); } catch (_) { /* already closed */ }
}

server.listen(PORT, () => console.log(`[voice-bridge] listening on :${PORT}`));
