/**
 * P3-gate v2: verify tool CALLS work via session/new.mcpServers (both server types)
 *
 * Fix from v1: only send session/prompt once; wait for all MCP servers to initialize
 * before sending the prompt.
 *
 * kiro-cli 2.16.0 / NDJSON / protocolVersion: 1
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';

async function startHttpMcpServer() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        process.stderr.write('[HTTP-MCP] ' + msg.method + '\n');
        let result;
        if (msg.method === 'initialize') {
          result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pi-bridge-probe', version: '0.1' } };
        } else if (msg.method === 'notifications/initialized') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return;
        } else if (msg.method === 'tools/list') {
          result = { tools: [{ name: 'ask_user_question', description: 'Ask a question (probe HTTP tool)', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }] };
        } else if (msg.method === 'tools/call') {
          const call = { name: msg.params?.name, args: msg.params?.arguments };
          calls.push(call);
          process.stderr.write('[HTTP-MCP] TOOL CALL: ' + JSON.stringify(call) + '\n');
          result = { content: [{ type: 'text', text: 'HTTP_RESULT: ' + JSON.stringify(call.args) }] };
        } else { result = {}; }
        const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(resp) }).end(resp);
      } catch { res.writeHead(400).end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, server, calls };
}

const STDIO_MCP_SCRIPT = `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'notifications/initialized') return;
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gsdworkflow-probe', version: '0.1' } };
  else if (msg.method === 'tools/list') result = { tools: [{ name: 'gsd_milestone_status', description: 'GSD milestone status (probe)', inputSchema: { type: 'object', properties: { milestone: { type: 'string' } }, required: ['milestone'] } }] };
  else if (msg.method === 'tools/call') { process.stderr.write('[STDIO-MCP] TOOL CALL: ' + msg.params?.name + '\\n'); result = { content: [{ type: 'text', text: 'STDIO_RESULT: milestone_status for ' + JSON.stringify(msg.params?.arguments) }] }; }
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
process.stdin.resume();
`;
writeFileSync('/tmp/probe-stdio-mcp.mjs', STDIO_MCP_SCRIPT, 'utf8');

const { port, server: httpServer, calls: httpCalls } = await startHttpMcpServer();
process.stderr.write('[P3-GATE] HTTP MCP port=' + port + '\n');

const traffic = [];
let msgId = 0;
let sessionId = null;
let promptSent = false;
let done = false;
let allServersReady = false;
const readyServers = new Set();
const EXPECTED_SERVERS = new Set(['pi', 'gsdworkflow']);

const child = spawn('kiro-cli', ['acp', '--trust-all-tools', '--agent-engine', 'v2'], {
  cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
});

function send(msg) {
  traffic.push({ direction: 'SEND', msg, ts: Date.now() });
  process.stderr.write('[SEND] ' + JSON.stringify(msg).slice(0, 250) + '\n');
  child.stdin.write(JSON.stringify(msg) + '\n');
}
function nextId() { return ++msgId; }

function maybeSendPrompt() {
  if (promptSent || !allServersReady || !sessionId) return;
  promptSent = true;
  const pid = nextId();
  send({
    jsonrpc: '2.0', id: pid, method: 'session/prompt',
    params: {
      sessionId,
      prompt: [{ type: 'text', text: 'Call the gsd_milestone_status tool with milestone="M001". Then call ask_user_question with q="hello". Report the EXACT text returned by each tool.' }],
    },
  });
  // Wait for response
  const checkDone = (msg) => {
    if (msg.id === pid) {
      process.stderr.write('[P3-GATE] prompt resp stopReason=' + msg.result?.stopReason + ' err=' + JSON.stringify(msg.error ?? null) + '\n');
      done = true;
      finish();
    }
  };
  promptHandlers.push(checkDone);
}

const promptHandlers = [];

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const tag = msg.method ?? ('response:' + msg.id);
  process.stderr.write('[RECV] [' + tag + '] ' + JSON.stringify(msg).slice(0, 400) + '\n');
  traffic.push({ direction: 'RECV', msg, ts: Date.now() });

  for (const h of promptHandlers) h(msg);

  if (msg.method !== undefined && msg.id !== undefined) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === '_kiro.dev/mcp/server_initialized') {
    const sn = msg.params?.serverName;
    readyServers.add(sn);
    process.stderr.write('[P3-GATE] server_initialized: ' + sn + ' readyServers=' + JSON.stringify([...readyServers]) + '\n');
    if (EXPECTED_SERVERS.size === readyServers.size && [...EXPECTED_SERVERS].every(s => readyServers.has(s))) {
      if (!allServersReady) { allServersReady = true; maybeSendPrompt(); }
    }
    return;
  }
  if (msg.method === '_kiro.dev/commands/available') {
    const tools = msg.params?.tools ?? [];
    const ourTools = tools.filter(t => ['ask_user_question', 'gsd_milestone_status'].includes(t.name)).map(t => t.name);
    process.stderr.write('[P3-GATE] commands/available ourTools=' + JSON.stringify(ourTools) + '\n');
    return;
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {};
    process.stderr.write('[UPDATE] ' + (u.sessionUpdate ?? '?') + ' ' + JSON.stringify(u).slice(0, 200) + '\n');
    return;
  }
  if (msg.id === 1) {
    // initialize response — send session/new
    send({ jsonrpc: '2.0', id: nextId(), method: 'session/new', params: {
      cwd: process.cwd(),
      mcpServers: [
        { type: 'http', name: 'pi', url: 'http://127.0.0.1:' + port + '/mcp', headers: [] },
        { name: 'gsdworkflow', command: 'node', args: ['/tmp/probe-stdio-mcp.mjs'], env: [] },
      ],
    }});
    return;
  }
  if (msg.id === 2) {
    sessionId = msg.result?.sessionId;
    process.stderr.write('[P3-GATE] sessionId=' + sessionId + '\n');
    // session/new response may arrive before or after server_initialized events
    // If both servers already ready, send prompt; otherwise wait for server_initialized
    if (allServersReady) maybeSendPrompt();
    return;
  }
});

function finish() {
  const result = { sessionId, allServersReady, readyServers: [...readyServers], httpCalls, traffic };
  writeFileSync('probes/p3-gate-option-b.json', JSON.stringify(result, null, 2), 'utf8');
  process.stderr.write('\n[P3-GATE DONE] allServersReady=' + allServersReady + ' httpCalls=' + httpCalls.length + '\n');
  httpServer.close();
  child.stdin.end();
  setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 1500);
}

child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
child.on('exit', (code) => {
  process.stderr.write('[EXIT] ' + code + '\n');
  if (!done) {
    writeFileSync('probes/p3-gate-option-b.json', JSON.stringify({ sessionId, allServersReady, readyServers: [...readyServers], httpCalls, traffic }, null, 2), 'utf8');
    httpServer.close();
  }
});

msgId = 1;
send({
  jsonrpc: '2.0', id: msgId, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: 'pi-kiro-probe', version: '0.1.0' } },
});

setTimeout(() => {
  if (!done) {
    process.stderr.write('[P3-GATE] TIMEOUT\n');
    writeFileSync('probes/p3-gate-option-b.json', JSON.stringify({ sessionId, allServersReady, readyServers: [...readyServers], httpCalls, traffic }, null, 2), 'utf8');
    httpServer.close();
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 120000);
