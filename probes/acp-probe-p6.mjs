/**
 * P6: Auth-expiry + error shapes
 *
 * Key findings from initialize:
 *   - authMethods: [] (empty — no auth callback surface advertised)
 *   - agentCapabilities.auth: {} (empty)
 *
 * This probe:
 *   1. Confirms auth is live (send a minimal "Say OK" prompt)
 *   2. Sends an unknown method to capture error shape
 *   3. Records all findings
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
let badMethodId = null;
let done = false;
let cmdAvail = false;

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
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const tag = msg.method ?? ('response:' + msg.id);
  process.stderr.write('[RECV] [' + tag + '] ' + JSON.stringify(msg).slice(0, 400) + '\n');
  traffic.push({ direction: 'RECV', msg, ts: Date.now() });

  if (msg.method !== undefined && msg.id !== undefined) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === '_kiro.dev/commands/available') {
    cmdAvail = true;
    if (phase === 'wait-cmd') doProbes();
    return;
  }

  if (phase === 'wait-init' && msg.id === 1) {
    const authMethods = msg.result?.authMethods ?? [];
    const authCaps = msg.result?.agentCapabilities?.auth ?? {};
    process.stderr.write('[P6] authMethods=' + JSON.stringify(authMethods) + '\n');
    process.stderr.write('[P6] authCaps=' + JSON.stringify(authCaps) + '\n');
    phase = 'wait-session';
    send({ jsonrpc: '2.0', id: nextId(), method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    return;
  }
  if (phase === 'wait-session' && msg.id === 2) {
    sessionId = msg.result?.sessionId;
    process.stderr.write('[P6] sessionId=' + sessionId + '\n');
    phase = 'wait-cmd';
    if (cmdAvail) doProbes();
    return;
  }

  if (msg.id === promptId) {
    process.stderr.write('[P6] prompt resp stopReason=' + msg.result?.stopReason + ' err=' + JSON.stringify(msg.error ?? null) + '\n');
    // Now send an invalid method to capture error shape
    badMethodId = nextId();
    send({ jsonrpc: '2.0', id: badMethodId, method: 'session/nonexistent_method', params: {} });
    return;
  }
  if (msg.id === badMethodId) {
    process.stderr.write('[P6] bad-method error: ' + JSON.stringify(msg.error ?? msg.result) + '\n');
    done = true;
    finish();
    return;
  }
});

function doProbes() {
  phase = 'probing';
  promptId = nextId();
  send({ jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Say OK' }] } });
}

function finish() {
  writeFileSync('probes/p6-auth-error.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
  process.stderr.write('[P6 DONE] fixture=probes/p6-auth-error.json\n');
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 1500);
}

child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
child.on('exit', (code) => {
  process.stderr.write('[EXIT] ' + code + '\n');
  if (!done) {
    writeFileSync('probes/p6-auth-error.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    process.stderr.write('[P6] partial fixture phase=' + phase + '\n');
  }
});

msgId = 1;
send({
  jsonrpc: '2.0', id: msgId, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: 'pi-kiro-probe', version: '0.1.0' } },
});

setTimeout(() => {
  if (!done) {
    process.stderr.write('[P6] TIMEOUT phase=' + phase + '\n');
    writeFileSync('probes/p6-auth-error.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 90000);
