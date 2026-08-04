/**
 * P4: session/cancel — cancel semantics
 *
 * Sends a prompt, then immediately sends session/cancel.
 * Captures what the server returns: does it send a cancellation response?
 * Does the prompt response still arrive with stopReason 'cancelled'?
 *
 * kiro-cli 2.16.0 / NDJSON / protocolVersion: 1
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const traffic = [];
let msgId = 0;
let phase = 'wait-init';
let sessionId = null;
let promptId = null;
let cancelId = null;
let done = false;
let commandsAvailable = false;

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
  try { msg = JSON.parse(line); } catch { return; }
  const tag = msg.method ?? ('response:' + msg.id);
  process.stderr.write('[RECV] [' + tag + '] ' + JSON.stringify(msg).slice(0, 400) + '\n');
  traffic.push({ direction: 'RECV', msg, ts: Date.now() });

  if (msg.method !== undefined && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === '_kiro.dev/commands/available') {
    commandsAvailable = true;
    if (phase === 'wait-commands') sendPromptThenCancel();
    return;
  }

  if (phase === 'wait-init' && msg.id === 1) {
    phase = 'wait-session';
    send({ jsonrpc: '2.0', id: nextId(), method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    return;
  }
  if (phase === 'wait-session' && msg.id === 2) {
    sessionId = msg.result?.sessionId;
    process.stderr.write('[P4] sessionId=' + sessionId + '\n');
    phase = 'wait-commands';
    if (commandsAvailable) sendPromptThenCancel();
    return;
  }

  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {};
    process.stderr.write('[UPDATE] ' + (u.sessionUpdate ?? u.type) + ' ' + JSON.stringify(u).slice(0, 200) + '\n');
    return;
  }

  // Got prompt response (cancelled or completed)
  if (msg.id === promptId) {
    process.stderr.write('[P4] prompt response stopReason=' + JSON.stringify(msg.result?.stopReason ?? msg.error) + '\n');
    if (!done) { phase = 'done'; done = true; finish(); }
    return;
  }
  if (msg.id === cancelId) {
    process.stderr.write('[P4] cancel response: ' + JSON.stringify(msg.result ?? msg.error) + '\n');
    return;
  }
});

function sendPromptThenCancel() {
  phase = 'wait-cancel-response';
  promptId = nextId();
  send({
    jsonrpc: '2.0', id: promptId, method: 'session/prompt',
    params: {
      sessionId,
      prompt: [{ type: 'text', text: 'Count from 1 to 100 slowly, one number per line.' }],
    },
  });
  // Send cancel 200ms after the prompt
  setTimeout(() => {
    cancelId = nextId();
    process.stderr.write('[P4] Sending session/cancel\n');
    send({ jsonrpc: '2.0', id: cancelId, method: 'session/cancel', params: { sessionId } });
    phase = 'wait-prompt-response';
    // Wait up to 10s for the prompt response after cancel
    setTimeout(() => {
      if (!done) {
        process.stderr.write('[P4] No prompt response after cancel — recording as fixture\n');
        done = true;
        finish();
      }
    }, 10000);
  }, 200);
}

function finish() {
  writeFileSync('probes/p4-cancel.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
  process.stderr.write('[P4 DONE] fixture=probes/p4-cancel.json\n');
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 1500);
}

child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
child.on('exit', (code) => {
  process.stderr.write('[EXIT] ' + code + '\n');
  if (!done) {
    writeFileSync('probes/p4-cancel.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    process.stderr.write('[P4] partial fixture phase=' + phase + '\n');
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
    process.stderr.write('[P4] TIMEOUT phase=' + phase + '\n');
    writeFileSync('probes/p4-cancel.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 60000);
