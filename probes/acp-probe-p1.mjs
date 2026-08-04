/**
 * P1: initialize / session/new handshake
 *
 * Protocol confirmed by raw sniff + kiro.dev/docs/cli/acp/:
 *  - NDJSON (one JSON object per line), NOT LSP Content-Length framing
 *  - protocolVersion: 1 (integer, not string)
 *  - session/new requires { cwd, mcpServers: [] }
 *  - session/notification carries updates (not session/update)
 *  - TurnEnd update type signals turn completion
 *
 * kiro-cli version: 2.16.0
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const traffic = [];
let phase = 'wait-init';
let msgId = 0;
let sessionId = null;
let done = false;

const child = spawn('kiro-cli', ['acp', '--trust-all-tools', '--agent-engine', 'v2'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

function send(msg) {
  traffic.push({ direction: 'SEND', msg, ts: Date.now() });
  process.stderr.write('[SEND] ' + JSON.stringify(msg) + '\n');
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    process.stderr.write('[PARSE-ERR] ' + line + '\n');
    return;
  }
  process.stderr.write('[RECV] ' + JSON.stringify(msg) + '\n');
  traffic.push({ direction: 'RECV', msg, ts: Date.now() });

  // Server-initiated requests: respond with empty result
  if (msg.method !== undefined && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (phase === 'wait-init' && msg.id === 1) {
    phase = 'wait-session';
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    msgId = 2;
    send({
      jsonrpc: '2.0', id: msgId, method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] },
    });
    return;
  }

  if (phase === 'wait-session' && msg.id === 2) {
    sessionId = msg.result?.sessionId ?? msg.result?.session_id ?? null;
    phase = 'done';
    done = true;
    writeFixture();
    child.stdin.end();
    setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 800);
    return;
  }
});

function writeFixture() {
  const out = JSON.stringify({ sessionId, traffic }, null, 2);
  writeFileSync('probes/p1-init-session.json', out, 'utf8');
  process.stderr.write('\n[P1 DONE] sessionId=' + sessionId + ' fixture=probes/p1-init-session.json\n');
}

child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
child.on('exit', (code) => {
  process.stderr.write('[EXIT] ' + code + '\n');
  if (!done) {
    writeFileSync('probes/p1-init-session.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    process.stderr.write('[P1] partial fixture written phase=' + phase + '\n');
  }
});

// Send initialize with correct protocolVersion (integer 1)
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
    process.stderr.write('[P1] TIMEOUT phase=' + phase + '\n');
    writeFileSync('probes/p1-init-session.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 30000);
