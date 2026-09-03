// Standalone always-on bridge: Twilio ConversationRelay (WebSocket, plain
// JSON text messages — Twilio itself handles speech-to-text and
// text-to-speech, so no raw audio ever passes through this process) <->
// Claude (Anthropic Messages API with tool use), which drives the
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
// Haiku: fastest/cheapest Claude, and latency is what matters most on a live
// call. Bump to a Sonnet model via env if reasoning quality ever needs it.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
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
  const call = { ws, system: '', history: [], ctx: null, ended: false };

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

  const greetName = biz.name || 'us';
  const greeting = (tvService && handymanService)
    ? `Thanks for calling ${greetName}! Are you looking to book TV mounting or handyman service today?`
    : `Thanks for calling ${greetName}! What can we help you get scheduled today?`;

  // Claude's Messages API requires the transcript to open with a user turn,
  // so the greeting we speak first lives in the system prompt as context
  // rather than as a leading assistant message.
  call.system = buildSystemPrompt({ businessName: biz.name, hasTv: !!tvService, hasHandyman: !!handymanService })
    + `\n\nYou have ALREADY greeted the caller with: "${greeting}" — do not greet them again; pick up from their reply.`;
  speak(call, greeting);
}

async function handleTurn(call, callerText) {
  if (!call.ctx) return; // setup hasn't landed yet, ignore stray prompt
  call.history.push({ role: 'user', content: callerText });

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const resp = await callClaude(call.system, call.history);
    const blocks = resp.content || [];
    if (!blocks.length) throw new Error('empty response from Claude');

    // Claude returns text and tool_use blocks together in one assistant
    // turn; the whole block list goes back into history verbatim so the
    // tool_result turn that follows can reference each tool_use id.
    call.history.push({ role: 'assistant', content: blocks });
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();

    if (toolUses.length) {
      const results = [];
      for (const tu of toolUses) {
        let result;
        try { result = await runTool(tu.name, tu.input || {}, call.ctx); }
        catch (e) { result = { error: e.message }; }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });

        if (tu.name === 'book_job' && result && result.booked) {
          await sessionSave(call.ctx.callSid, { step: 'done', data: { engine: 'v2', booked: true, total: result.total } }).catch(() => {});
        }
        if (tu.name === 'transfer_to_human') {
          speak(call, "Sure thing — one moment while I connect you.");
          return endCall(call);
        }
      }
      call.history.push({ role: 'user', content: results });
      continue; // let the model see the tool results and respond
    }

    if (text) speak(call, text);
    return;
  }
  // Hit the hop cap without a final answer — don't leave the caller hanging.
  speak(call, "Let me get you to someone who can finish this up.");
  endCall(call);
}

async function callClaude(system, history) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 400, system, messages: history, tools: TOOL_SCHEMAS, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text().catch(() => '')}`);
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
