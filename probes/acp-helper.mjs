/**
 * ACP probe helper — shared NDJSON JSON-RPC session manager.
 * Exported so each probe script can import it.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createAcpSession(opts = {}) {
  const {
    acpArgs = ['--trust-all-tools', '--agent-engine', 'v2'],
    cwd = process.cwd(),
    onMessage,
    onExit,
  } = opts;

  const child = spawn('kiro-cli', ['acp', ...acpArgs], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const traffic = [];
  let msgId = 0;

  function send(msg) {
    traffic.push({ direction: 'SEND', msg });
    process.stderr.write('[SEND] ' + JSON.stringify(msg) + '\n');
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  function request(method, params) {
    msgId++;
    const id = msgId;
    send({ jsonrpc: '2.0', id, method, params });
    return id;
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
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
    traffic.push({ direction: 'RECV', msg });
    if (onMessage) onMessage(msg, { send, request, notify, traffic, child });
  });

  child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
  child.on('exit', (code) => {
    process.stderr.write('[EXIT] ' + code + '\n');
    if (onExit) onExit(code, traffic);
  });

  return { send, request, notify, traffic, child, getId: () => msgId };
}

export function doHandshake(session, onReady) {
  let phase = 'init';
  const initId = session.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: 'pi-kiro-probe', version: '0.1.0' },
  });

  const origOnMessage = session._onMessage;
  session._handshakeReady = false;

  return new Promise((resolve) => {
    session.child.stdout.removeAllListeners('data'); // handled by rl already set up
    // We patch onMessage via closure; the session was created with onMessage that calls handle
    // So we replace the internal handler reference
    session._resolve = resolve;
    session._phase = phase;
    session._initId = initId;
    session._onReady = onReady;
    session._resolve = resolve;
  });
}
