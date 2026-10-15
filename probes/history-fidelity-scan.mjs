/**
 * How much of a tool call survives a FULL RESEND.
 *
 * serializeMessage (src/stream-adapter.ts) drops assistant toolCall blocks and
 * renders only `tool="<name>"` plus the result on the paired tool_result, so a
 * full resend shows kiro an answer with no record of the arguments. This scans
 * real pi transcripts to measure how often that loses something recoverable,
 * and what rendering the arguments back in would cost.
 *
 *   node probes/history-fidelity-scan.mjs [--sessions DIR] [--bridged a,b] [--json]
 *   node probes/history-fidelity-scan.mjs --selftest
 *
 * Reads only ~/.pi/agent/sessions (or --sessions); writes nothing.
 * Findings and the decision they drove: probes/history-fidelity-findings.md.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CAP = 200; // byte cap floated for a truncated args attribute

/**
 * The bridged tool set, parsed out of src/bridge.ts rather than copied here: a
 * second hand-written list would drift, and the scan's whole conclusion turns
 * on which tools kiro can re-issue as @pi/<name>.
 *
 * A PARTIAL parse is the failure to guard, not an empty one: the array
 * terminator is matched non-greedily, so a stray bracket would end the capture
 * early and yield a shorter list that still looks plausible. Anything but
 * quoted strings, commas and whitespace in the captured block is therefore an
 * error, not something to work around.
 */
export function parseBridgeToolList(src) {
  const block = src.match(/export const DEFAULT_BRIDGE_TOOLS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    throw new Error('could not find DEFAULT_BRIDGE_TOOLS in src/bridge.ts; fix the parse, do not hard-code the list');
  }
  const body = block[1];
  if (/[[\]]/.test(body) || body.replace(/"[^"]*"|,|\s/g, '') !== '') {
    throw new Error(`DEFAULT_BRIDGE_TOOLS did not parse cleanly, so the list may be truncated: ${JSON.stringify(body)}`);
  }
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error('DEFAULT_BRIDGE_TOOLS parsed empty; fix the parse, do not hard-code the list');
  }
  return names;
}

function defaultBridgedTools() {
  return parseBridgeToolList(readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8'));
}

/** Content blocks of a pi message, with the string shorthand normalized. */
function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === 'object');
  return [];
}

/** The transcript messages of one .jsonl session file, in order. */
function parseTranscript(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // a partially-flushed tail line
    }
    if (rec && rec.type === 'message' && rec.message && typeof rec.message === 'object') {
      out.push(rec.message);
    }
  }
  return out;
}

function emptyStats() {
  return {
    sessions: 0,
    sessionsWithCalls: 0,
    calls: 0,
    callsByTool: {},
    sameMessageText: 0,
    priorProseOnly: 0,
    noProse: 0,
    noProseByTool: {},
    noProseBridged: 0,
    noProseNonBridged: 0,
    results: 0,
    resultsJoinable: 0,
    resultsScoped: 0,
    resultBytes: 0,
    addAllBytes: 0,
    addScopedBytes: 0,
    addScopedCappedBytes: 0,
    argBytes: [],
  };
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Fold one session into `stats`.
 *
 * "Recoverable" means the replayed history still says what the call was about:
 * text in the SAME assistant message, or failing that, assistant prose earlier
 * in the same turn. A user message ends the turn and resets that fallback.
 */
export function scanSession(messages, bridged, stats) {
  stats.sessions += 1;
  const argsById = new Map();
  const nameById = new Map();
  const orphanIds = new Set();
  let callsHere = 0;
  let priorProse = '';

  for (const message of messages) {
    if (message.role === 'user') priorProse = '';
    if (message.role !== 'assistant') continue;
    const blocks = blocksOf(message.content);
    const sibling = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();

    for (const call of blocks.filter((b) => b.type === 'toolCall')) {
      const name = call.name ?? '?';
      const args = JSON.stringify(call.arguments ?? {});
      const id = call.toolCallId ?? call.id;
      callsHere += 1;
      stats.calls += 1;
      bump(stats.callsByTool, name);
      stats.argBytes.push(args.length);
      if (id !== undefined) {
        argsById.set(id, args);
        nameById.set(id, name);
      }
      if (sibling) {
        stats.sameMessageText += 1;
      } else if (priorProse) {
        stats.priorProseOnly += 1;
      } else {
        stats.noProse += 1;
        bump(stats.noProseByTool, name);
        if (bridged.has(name)) stats.noProseBridged += 1;
        else stats.noProseNonBridged += 1;
        if (id !== undefined) orphanIds.add(id);
      }
    }
    if (sibling) priorProse = sibling;
  }
  if (callsHere > 0) stats.sessionsWithCalls += 1;

  for (const message of messages) {
    if (message.role !== 'toolResult') continue;
    stats.results += 1;
    const name = message.toolName ?? '';
    const body = blocksOf(message.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    // What serializeMessage emits for this message today.
    stats.resultBytes += `<tool_result tool="${name}">\n${body}\n</tool_result>`.length;

    const id = message.toolCallId;
    const args = id === undefined ? undefined : argsById.get(id);
    if (args === undefined) continue;
    stats.resultsJoinable += 1;
    stats.addAllBytes += ` args="${args}"`.length;
    // The scoped rule: no prose to recover from, and not a tool kiro could
    // re-issue through the @pi/ bridge.
    if (orphanIds.has(id) && !bridged.has(nameById.get(id) ?? name)) {
      stats.resultsScoped += 1;
      stats.addScopedBytes += ` args="${args}"`.length;
      const capped = args.length <= CAP ? args : `${args.slice(0, CAP)}...(truncated)`;
      stats.addScopedCappedBytes += ` args="${capped}"`.length;
    }
  }
  return stats;
}

function sessionFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    let info;
    try {
      info = statSync(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) files.push(join(dir, name));
    }
  }
  return files.sort();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function pct(part, whole) {
  return whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1);
}

function report(stats, bridged) {
  const calls = stats.calls;
  const args = [...stats.argBytes].sort((a, b) => a - b);
  const byCount = (a, b) => b[1] - a[1];
  const lines = [];
  lines.push(`corpus: ${stats.sessions} transcripts, ${stats.sessionsWithCalls} with tool use, ${calls} tool calls, ${stats.results} tool results`);
  lines.push(`bridged tools (re-issuable as @pi/<name>): ${[...bridged].join(', ')}`);
  lines.push('');
  lines.push('is the call recoverable from the replayed history?');
  lines.push(`  text in the same assistant message   ${stats.sameMessageText} (${pct(stats.sameMessageText, calls)}%)`);
  lines.push(`  only prose earlier in the turn        ${stats.priorProseOnly} (${pct(stats.priorProseOnly, calls)}%)`);
  lines.push(`  NO assistant prose anywhere           ${stats.noProse} (${pct(stats.noProse, calls)}%)`);
  lines.push('');
  lines.push('the unrecoverable calls, by tool:');
  for (const [name, n] of Object.entries(stats.noProseByTool).sort(byCount)) {
    lines.push(`  ${name.padEnd(24)} ${n}${bridged.has(name) ? '  (bridged)' : ''}`);
  }
  lines.push(`  bridged ${stats.noProseBridged}, not bridged ${stats.noProseNonBridged}`);
  lines.push('');
  lines.push(`results joinable to their call by toolCallId: ${stats.resultsJoinable} of ${stats.results}`);
  lines.push('');
  lines.push('argument JSON size in bytes:');
  lines.push(`  p50 ${percentile(args, 0.5)}  p90 ${percentile(args, 0.9)}  p99 ${percentile(args, 0.99)}  max ${args[args.length - 1] ?? 0}`);
  lines.push('');
  lines.push(`tool_result bytes as serialized today: ${stats.resultBytes}`);
  lines.push(`  args on every result:                +${stats.addAllBytes} (+${pct(stats.addAllBytes, stats.resultBytes)}%)`);
  lines.push(`  scoped: no prose and not bridged:    +${stats.addScopedBytes} (+${pct(stats.addScopedBytes, stats.resultBytes)}%) over ${stats.resultsScoped} results`);
  lines.push(`  scoped and capped at ${CAP} bytes:      +${stats.addScopedCappedBytes} (+${pct(stats.addScopedCappedBytes, stats.resultBytes)}%)`);
  lines.push('');
  lines.push('calls by tool:');
  for (const [name, n] of Object.entries(stats.callsByTool).sort(byCount)) {
    lines.push(`  ${name.padEnd(24)} ${n}`);
  }
  return lines.join('\n');
}

/**
 * Synthetic transcript with hand-derived expectations, so a counting bug shows
 * up without a live pi session. Expectations are written out here, NOT read
 * back from scanSession.
 */
function selftest() {
  const msgs = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [
      { type: 'text', text: 'reading the file' },
      { type: 'toolCall', toolCallId: 'c1', name: 'read', arguments: { path: 'a.ts' } },
    ] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'contents' },
    // no sibling text, but "reading the file" is still in this turn
    { role: 'assistant', content: [
      { type: 'toolCall', toolCallId: 'c2', name: 'bash', arguments: { command: 'ls' } },
    ] },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: 'a.ts' },
    { role: 'user', content: 'next' },
    // new turn, so no prose to fall back on: unrecoverable, and not bridged
    { role: 'assistant', content: [
      { type: 'toolCall', toolCallId: 'c3', name: 'read', arguments: { path: 'b.ts' } },
    ] },
    { role: 'toolResult', toolCallId: 'c3', toolName: 'read', content: 'more' },
    // unrecoverable too, but bridged, so the scoped rule must leave it alone
    { role: 'assistant', content: [
      { type: 'toolCall', toolCallId: 'c4', name: 'ask_user_question', arguments: { question: 'which?' } },
    ] },
    { role: 'toolResult', toolCallId: 'c4', toolName: 'ask_user_question', content: 'the second' },
  ];
  const jsonl = msgs.map((m, i) => JSON.stringify({ type: 'message', id: `m${i}`, message: m })).join('\n');
  const parsed = parseTranscript(`${jsonl}\n{"type":"session"}\nnot json\n`);
  const bridged = new Set(['ask_user_question', 'todo', 'Agent']);
  const s = scanSession(parsed, bridged, emptyStats());

  const expected = {
    parsed: 10,
    calls: 4,
    sameMessageText: 1,
    priorProseOnly: 1,
    noProse: 2,
    noProseBridged: 1,
    noProseNonBridged: 1,
    results: 4,
    resultsJoinable: 4,
    resultsScoped: 1,
    // ' args="' + '{"path":"b.ts"}' + '"' = 7 + 15 + 1
    addScopedBytes: 23,
    // the same for all four: 23 + 24 + 23 + 29
    addAllBytes: 99,
  };
  const actual = {
    parsed: parsed.length,
    calls: s.calls,
    sameMessageText: s.sameMessageText,
    priorProseOnly: s.priorProseOnly,
    noProse: s.noProse,
    noProseBridged: s.noProseBridged,
    noProseNonBridged: s.noProseNonBridged,
    results: s.results,
    resultsJoinable: s.resultsJoinable,
    resultsScoped: s.resultsScoped,
    addScopedBytes: s.addScopedBytes,
    addAllBytes: s.addAllBytes,
  };
  const failures = Object.entries(expected)
    .filter(([k, v]) => actual[k] !== v)
    .map(([k, v]) => `  ${k}: expected ${v}, got ${actual[k]}`);
  if (s.noProseByTool.read !== 1 || s.noProseByTool.ask_user_question !== 1) {
    failures.push(`  noProseByTool: expected read 1 and ask_user_question 1, got ${JSON.stringify(s.noProseByTool)}`);
  }
  // The live default must still parse out of src/bridge.ts.
  const live = defaultBridgedTools();
  if (!live.includes('ask_user_question')) {
    failures.push(`  DEFAULT_BRIDGE_TOOLS parse: expected ask_user_question among ${JSON.stringify(live)}`);
  }
  // And a source shape that would truncate the list must throw, not return a
  // short list: a silently shortened set would move every bridged/not-bridged
  // number in the report.
  const rejects = [
    ['nested array', 'export const DEFAULT_BRIDGE_TOOLS = [\n\t"a",\n\t["b"],\n];'],
    ['missing declaration', 'export const SOMETHING_ELSE = ["a"];'],
    ['unquoted entry', 'export const DEFAULT_BRIDGE_TOOLS = [\n\tNAME,\n];'],
  ];
  for (const [label, source] of rejects) {
    let threw = false;
    try {
      parseBridgeToolList(source);
    } catch {
      threw = true;
    }
    if (!threw) failures.push(`  parseBridgeToolList accepted a ${label} source instead of throwing`);
  }
  if (failures.length > 0) {
    console.error('selftest FAILED');
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`selftest ok (${live.length} bridged tools parsed from src/bridge.ts)`);
}

function main(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  if (argv.includes('--selftest')) return selftest();

  const root = flag('--sessions', join(homedir(), '.pi', 'agent', 'sessions'));
  const bridgedArg = flag('--bridged', undefined);
  const bridged = new Set(
    bridgedArg === undefined ? defaultBridgedTools() : bridgedArg.split(',').map((s) => s.trim()).filter(Boolean),
  );

  let files;
  try {
    files = sessionFiles(root);
  } catch (err) {
    console.error(`cannot read ${root}: ${err.message}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`no .jsonl transcripts under ${root}`);
    process.exit(1);
  }

  const stats = emptyStats();
  for (const file of files) {
    scanSession(parseTranscript(readFileSync(file, 'utf8')), bridged, stats);
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...stats, argBytes: undefined, bridged: [...bridged] }, null, 2));
  } else {
    console.log(report(stats, bridged));
  }
}

main(process.argv.slice(2));
