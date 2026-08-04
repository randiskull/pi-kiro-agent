/**
 * P2: session/prompt round-trip — capture all update event shapes
 *
 * Key fix: session/prompt uses `prompt` field (not `content`)
 * Confirmed by kiro-cli log: "missing field `prompt`"
 *
 * Protocol summary so far (kiro-cli 2.16.0):
 *  - NDJSON transport (newline-delimited JSON, NOT LSP framing)
 *  - protocolVersion: 1 (integer)
 *  - session/new: { cwd, mcpServers: [] }
 *  - session/prompt: { sessionId, prompt: [{ type: 'text', text: '...' }] }
 *  - 'initialized' notification: -32601 (not supported — skip it)
 *  - Notifications arrive via session/notification (updateType field)
 *  - _kiro.dev/commands/available arrives after session/new
 *  - _kiro.dev/metadata arrives after session/prompt (contextUsagePercentage)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const traffic = [];
let msgId = 0;
let phase = 'wait-init';
let sessionId = null;
let promptId = null;
let done = false;
let commandsAvailableReceived = false;

const child = spawn('kiro-cli', ['acp', '--trust-all-tools', '--agent-engine', 'v2'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

function send(msg) {
  traffic.push({ direction: 'SEND', msg, ts: Date.now() });
  process.stderr.write('[SEND] ' + JSON.stringify(msg).slice(0, 200) + '\n');
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function nextId() { return ++msgId; }

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    process.stderr.write('[PARSE-ERR] ' + line + '\n');
    return;
  }
  const tag = msg.method ?? ('response:' + msg.id);
  process.stderr.write('[RECV] [' + tag + '] ' + JSON.stringify(msg).slice(0, 400) + '\n');
  traffic.push({ direction: 'RECV', msg, ts: Date.now() });

  // Server-initiated requests: auto-respond
  if (msg.method !== undefined && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === '_kiro.dev/commands/available') {
    commandsAvailableReceived = true;
    if (phase === 'wait-commands') sendPrompt();
    return;
  }

  if (phase === 'wait-init' && msg.id === 1) {
    phase = 'wait-session';
    send({
      jsonrpc: '2.0', id: nextId(), method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] },
    });
    return;
  }

  if (phase === 'wait-session' && msg.id === 2) {
    sessionId = msg.result?.sessionId;
    process.stderr.write('[P2] sessionId=' + sessionId + '\n');
    phase = 'wait-commands';
    if (commandsAvailableReceived) sendPrompt();
    return;
  }

  // session/notification: streaming updates — capture type shapes
  if (msg.method === 'session/notification' && phase === 'wait-prompt-response') {
    const p = msg.params ?? {};
    const type = p.type ?? p.updateType ?? p.update_type ?? JSON.stringify(Object.keys(p));
    process.stderr.write('[NOTIF] type=' + type + '\n');
    // Detect TurnEnd
    if (type === 'TurnEnd' || type === 'turn_end') {
      process.stderr.write('[P2] TurnEnd received\n');
    }
    return;
  }

  if (phase === 'wait-prompt-response' && msg.id === promptId) {
    process.stderr.write('[P2] Prompt response received! stopReason=' + JSON.stringify(msg.result?.stopReason ?? msg.result?.stop_reason) + '\n');
    phase = 'done';
    done = true;
    finish();
    return;
  }
});

function sendPrompt() {
  phase = 'wait-prompt-response';
  promptId = nextId();
  process.stderr.write('[P2] Sending session/prompt id=' + promptId + '\n');
  send({
    jsonrpc: '2.0', id: promptId, method: 'session/prompt',
    params: {
      sessionId,
      // CORRECT field name is 'prompt', not 'content' (confirmed by kiro log)
      prompt: [{ type: 'text', text: 'Reply with exactly the word: PONG' }],
    },
  });
}

function finish() {
  const out = JSON.stringify({ sessionId, traffic }, null, 2);
  writeFileSync('probes/p2-prompt-events.json', out, 'utf8');
  process.stderr.write('\n[P2 DONE] fixture=probes/p2-prompt-events.json\n');
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 1500);
}

child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
child.on('exit', (code) => {
  process.stderr.write('[EXIT] ' + code + '\n');
  if (!done) {
    writeFileSync('probes/p2-prompt-events.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    process.stderr.write('[P2] partial fixture phase=' + phase + '\n');
  }
});

msgId = 1;
send({
  jsonrpc: '2.0', id: msgId, method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'pi-kiro-probe', version: '0.1.0' },
  },
});

setTimeout(() => {
  if (!done) {
    process.stderr.write('[P2] TIMEOUT phase=' + phase + '\n');
    writeFileSync('probes/p2-prompt-events.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 120000);
