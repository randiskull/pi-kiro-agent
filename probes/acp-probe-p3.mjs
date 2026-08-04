/**
 * P3 v2: tool-call events — fixed mcpServers to array format
 *
 * kiro log: "invalid type: map, expected a sequence"
 * mcpServers must be an ARRAY in session/new, not an object.
 *
 * This is different from the agent profile JSON (which uses object/map).
 * The ACP session/new mcpServers field is an array of server configs.
 *
 * kiro-cli 2.16.0 / NDJSON / protocolVersion: 1
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';

// Minimal MCP server that implements Streamable HTTP
async function startMinimalMcpServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try {
          const msg = JSON.parse(body);
          let result;
          if (msg.method === 'initialize') {
            result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe-mcp', version: '0.1' } };
          } else if (msg.method === 'notifications/initialized') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
            return;
          } else if (msg.method === 'tools/list') {
            result = { tools: [{ name: 'probe_echo', description: 'Echo probe tool', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }] };
          } else if (msg.method === 'tools/call') {
            result = { content: [{ type: 'text', text: 'ECHO: ' + JSON.stringify(msg.params?.arguments) }] };
          } else {
            result = {};
          }
          const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(resp) });
          res.end(resp);
        } catch {
          res.writeHead(400).end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, server });
    });
  });
}

const { port, server: mcpServer } = await startMinimalMcpServer();
process.stderr.write('[P3] MCP server on port ' + port + '\n');

const traffic = [];
let msgId = 0;
let phase = 'wait-init';
let sessionId = null;
let promptId = null;
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

// mcpServers as ARRAY — HTTP transport variant
// ACP spec: { type: "http", name: "...", url: "...", headers: [] }
// headers array is required to match the HTTP McpServer enum variant
const mcpServersArray = [
  {
    type: 'http',
    name: 'probeMcp',
    url: 'http://127.0.0.1:' + port + '/mcp',
    headers: [],
  },
];

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
    if (phase === 'wait-commands') sendPrompt();
    return;
  }
  if (msg.method === '_kiro.dev/mcp/server_initialized') {
    process.stderr.write('[P3] MCP server_initialized: ' + JSON.stringify(msg.params) + '\n');
    return;
  }

  if (phase === 'wait-init' && msg.id === 1) {
    phase = 'wait-session';
    send({
      jsonrpc: '2.0', id: nextId(), method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: mcpServersArray },
    });
    return;
  }
  if (phase === 'wait-session' && msg.id === 2) {
    if (msg.error) {
      process.stderr.write('[P3] session/new ERROR: ' + JSON.stringify(msg.error) + '\n');
      // Try with empty mcpServers to confirm the array format works
      phase = 'wait-session-empty';
      send({ jsonrpc: '2.0', id: nextId(), method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
      return;
    }
    sessionId = msg.result?.sessionId;
    process.stderr.write('[P3] sessionId=' + sessionId + '\n');
    phase = 'wait-commands';
    if (commandsAvailable) sendPrompt();
    return;
  }
  if (phase === 'wait-session-empty' && msg.id === 3) {
    sessionId = msg.result?.sessionId;
    process.stderr.write('[P3] fallback sessionId=' + sessionId + ' (no MCP)\n');
    phase = 'wait-commands';
    if (commandsAvailable) sendPrompt();
    return;
  }
  if (msg.method === 'session/update' && phase === 'wait-prompt-response') {
    const u = msg.params?.update ?? {};
    const type = u.sessionUpdate ?? u.type ?? 'unknown';
    process.stderr.write('[UPDATE] type=' + type + ' ' + JSON.stringify(u).slice(0, 300) + '\n');
    return;
  }
  if (phase === 'wait-prompt-response' && msg.id === promptId) {
    process.stderr.write('[P3] Prompt response! stopReason=' + JSON.stringify(msg.result?.stopReason) + '\n');
    phase = 'done';
    done = true;
    mcpServer.close();
    writeFileSync('probes/p3-tool-events.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    process.stderr.write('[P3 DONE] fixture=probes/p3-tool-events.json\n');
    child.stdin.end();
    setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 1500);
  }
});

function sendPrompt() {
  phase = 'wait-prompt-response';
  promptId = nextId();
  send({
    jsonrpc: '2.0', id: promptId, method: 'session/prompt',
    params: {
      sessionId,
      prompt: [{ type: 'text', text: 'Call the probe_echo tool with msg="hello from ACP probe" and report the exact response.' }],
    },
  });
}

child.stderr.on('data', (d) => process.stderr.write('[CLI] ' + d.toString()));
child.on('exit', (code) => {
  process.stderr.write('[EXIT] ' + code + '\n');
  if (!done) {
    mcpServer.close();
    writeFileSync('probes/p3-tool-events.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    process.stderr.write('[P3] partial fixture phase=' + phase + '\n');
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
    process.stderr.write('[P3] TIMEOUT phase=' + phase + '\n');
    mcpServer.close();
    writeFileSync('probes/p3-tool-events.json', JSON.stringify({ sessionId, traffic }, null, 2), 'utf8');
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 120000);
