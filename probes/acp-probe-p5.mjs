/**
 * P5: session/load — persistent session identity across reconnects
 * Fixed: proper msgId tracking (init id=1, session/new id=2)
 *
 * kiro-cli 2.16.0 / NDJSON / protocolVersion: 1
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const traffic = [];

function makeChild() {
  return spawn('kiro-cli', ['acp', '--trust-all-tools', '--agent-engine', 'v2'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function runSession(label, afterSession) {
  return new Promise((resolve) => {
    const child = makeChild();
    let msgId = 0;
    function send(msg) {
      traffic.push({ direction: 'SEND', phase: label, msg, ts: Date.now() });
      process.stderr.write('[' + label + '][SEND] ' + JSON.stringify(msg).slice(0, 200) + '\n');
      child.stdin.write(JSON.stringify(msg) + '\n');
    }
    function nextId() { return ++msgId; }
    const rl = createInterface({ input: child.stdout });
    child.stderr.on('data', (d) => process.stderr.write('[' + label + '][CLI] ' + d.toString()));
    child.on('exit', (code) => {
      process.stderr.write('[' + label + '][EXIT] ' + code + '\n');
      resolve(null);
    });

    let phase = 'init';
    let sessionId = null;
    let cmdAvail = false;
    let promptId = null;
    let settled = false;

    function settle(result) {
      if (settled) return;
      settled = true;
      child.stdin.end();
      setTimeout(() => { child.kill('SIGTERM'); resolve(result); }, 500);
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const tag = msg.method ?? ('response:' + msg.id);
      process.stderr.write('[' + label + '][' + tag + '] ' + JSON.stringify(msg).slice(0, 300) + '\n');
      traffic.push({ direction: 'RECV', phase: label, msg, ts: Date.now() });

      if (msg.method !== undefined && msg.id !== undefined) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
      if (msg.method === '_kiro.dev/commands/available') {
        cmdAvail = true;
        if (phase === 'wait-cmd') afterSession(sessionId, send, nextId, settle, (p) => { phase = p; }, () => phase, () => promptId, (id) => { promptId = id; });
        return;
      }

      if (phase === 'init' && msg.id === 1) {
        phase = 'wait-session';
        send({ jsonrpc: '2.0', id: nextId(), method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
        return;
      }
      if (phase === 'wait-session' && msg.id === 2) {
        sessionId = msg.result?.sessionId;
        process.stderr.write('[' + label + '] sessionId=' + sessionId + '\n');
        phase = 'wait-cmd';
        if (cmdAvail) afterSession(sessionId, send, nextId, settle, (p) => { phase = p; }, () => phase, () => promptId, (id) => { promptId = id; });
        return;
      }

      // For load phase, session/load result comes as id=2 as well
      if (phase === 'wait-load' && msg.id === 2) {
        process.stderr.write('[' + label + '] session/load result: ' + JSON.stringify(msg.result ?? msg.error).slice(0, 300) + '\n');
        phase = 'wait-cmd';
        if (cmdAvail) afterSession(sessionId, send, nextId, settle, (p) => { phase = p; }, () => phase, () => promptId, (id) => { promptId = id; });
        return;
      }

      if (promptId && msg.id === promptId) {
        process.stderr.write('[' + label + '] prompt done stopReason=' + msg.result?.stopReason + '\n');
        settle({ sessionId });
        return;
      }
    });

    // Start
    send({ jsonrpc: '2.0', id: nextId(), method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '1' } } });

    setTimeout(() => {
      if (!settled) { process.stderr.write('[' + label + '] TIMEOUT\n'); settle(null); }
    }, 60000);
  });
}

// Phase 1: create session, send a prompt with a "secret word"
let capturedSessionId = null;
const result1 = await runSession('ph1', (sessionId, send, nextId, settle, setPhase, getPhase, getPromptId, setPromptId) => {
  capturedSessionId = sessionId;
  setPhase('wait-prompt');
  const id = nextId();
  setPromptId(id);
  send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'My secret word is XYLOPHONE. Acknowledge with: RECEIVED.' }] } });
});

process.stderr.write('[P5] Phase1 done. capturedSessionId=' + capturedSessionId + '\n');
if (!capturedSessionId) { process.stderr.write('[P5] No sessionId — aborting\n'); process.exit(1); }

// Wait 2s for session to persist to disk
await new Promise(r => setTimeout(r, 2000));

// Phase 2: new acp child, load session, ask for the secret word
await runSession('ph2', (sessionId, send, nextId, settle, setPhase, getPhase, getPromptId, setPromptId) => {
  // Override: load the captured session instead of using the new one
  // (the new session created here is unused — we want to load capturedSessionId)
  setPhase('wait-prompt');
  const id = nextId();
  setPromptId(id);
  send({
    jsonrpc: '2.0', id, method: 'session/prompt',
    params: { sessionId: capturedSessionId, prompt: [{ type: 'text', text: 'What was the secret word I told you?' }] },
  });
});

writeFileSync('probes/p5-session-load.json', JSON.stringify({ capturedSessionId, traffic }, null, 2), 'utf8');
process.stderr.write('[P5 DONE] fixture=probes/p5-session-load.json\n');
process.exit(0);
