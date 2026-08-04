/**
 * P0: Raw transport sniffer — no framing assumptions.
 * Just spawns kiro-cli acp, sends the initialize message in both common formats,
 * and dumps everything received raw.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn('kiro-cli', ['acp', '--trust-all-tools'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const rawChunks = [];
const stderrChunks = [];

child.stdout.on('data', (d) => {
  rawChunks.push(d.toString('hex'));
  process.stderr.write('[STDOUT-HEX] ' + d.toString('hex') + '\n');
  process.stderr.write('[STDOUT-UTF8] ' + JSON.stringify(d.toString('utf8')) + '\n');
});
child.stderr.on('data', (d) => {
  stderrChunks.push(d.toString('utf8'));
  process.stderr.write('[STDERR] ' + d.toString('utf8'));
});

// Give the process 2s to emit anything unprompted (server-first protocol)
setTimeout(() => {
  process.stderr.write('\n[After 2s unprompted — sending LSP-framed initialize]\n');
  const msg = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'pi-kiro-probe', version: '0.1.0' },
    },
  });
  const frame = 'Content-Length: ' + Buffer.byteLength(msg, 'utf8') + '\r\n\r\n' + msg;
  process.stderr.write('[SEND-FRAME] ' + JSON.stringify(frame) + '\n');
  child.stdin.write(frame);
}, 2000);

// After another 5s dump and exit
setTimeout(() => {
  const result = {
    rawStdoutHexChunks: rawChunks,
    rawStdoutUtf8: rawChunks.map(h => Buffer.from(h, 'hex').toString('utf8')),
    stderr: stderrChunks,
  };
  writeFileSync('probes/p0-raw-sniff.json', JSON.stringify(result, null, 2), 'utf8');
  process.stderr.write('[P0] fixture written\n');
  child.kill('SIGTERM');
  process.exit(0);
}, 8000);

child.on('exit', (code) => process.stderr.write('[EXIT] ' + code + '\n'));
