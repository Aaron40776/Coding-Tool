#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks the same stream-json protocol, for free, deterministic
// UI testing and demos:  SMART_CLAUDE_BIN=test/fixtures/fake-claude.mjs smart
// Env: FAKE_STEPS (plan length, default 5), FAKE_DELAY_MS (per event, default 120), FAKE_COMPLEXITY (default large_build),
//      FAKE_LONG=1 (verbose plan text), FAKE_FAIL_REVIEW / FAKE_ERROR (simulate problems).
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
if (args.includes('--version')) { process.stdout.write('0.0.0-fake (Claude Code)\n'); process.exit(0); }
const model = flag('--model') ?? 'sonnet';
const schemaRaw = flag('--json-schema');
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
const delay = Number(process.env.FAKE_DELAY_MS ?? 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) prompt += c;

const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 24000, cache_creation_input_tokens: 0 });
const price = { haiku: 1, sonnet: 3, opus: 5 };
const cost = (i, o) => ((i * price[model.replace(/.*(haiku|sonnet|opus).*/, '$1')] + o * 5 * price[model.replace(/.*(haiku|sonnet|opus).*/, '$1')]) / 1e6) + 0.004;
const result = (text, extra = {}, i = 900, o = 300) => out({
  type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, num_turns: 1, total_cost_usd: cost(i, o),
  usage: usage(i, o), modelUsage: { [model]: { inputTokens: i, outputTokens: o, cacheReadInputTokens: 24000, cacheCreationInputTokens: 0, costUSD: cost(i, o) } }, ...extra,
});
out({ type: 'system', subtype: 'init', model, session_id: sessionId, cwd: process.cwd() });

if (process.env.FAKE_5H) out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: Number(process.env.FAKE_5H), resetsAt: Math.floor(Date.now() / 1000) + 8040 }, seven_day: { utilization: Number(process.env.FAKE_7D ?? 0.18), resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 } } } });

if (process.env.FAKE_ERROR === 'auth') { process.stderr.write('Not logged in. Please run /login\n'); process.exit(1); }

if (schemaRaw) {
  const props = JSON.parse(schemaRaw).properties ?? {};
  await sleep(delay * 2);
  if ('complexity' in props) {
    const c = process.env.FAKE_COMPLEXITY ?? (/snake|build|app/i.test(prompt) ? 'large_build' : 'small_edit');
    result('', { structured_output: { complexity: c, needsPlan: c === 'large_build', reason: `Fake classifier: looks like ${c}, so it is routed accordingly.` } }, 400, 60);
  } else if ('pass' in props) {
    const fail = process.env.FAKE_FAIL_REVIEW === '1' && !/Review found/.test(prompt);
    result('', { structured_output: fail ? { pass: false, issues: ['Fake review: the game loop never calls step().'] } : { pass: true, issues: [] } }, 500, 40);
  } else {
    const n = Number(process.env.FAKE_STEPS ?? 5);
    const long = process.env.FAKE_LONG === '1';
    const steps = Array.from({ length: n }, (_, i) => ({
      title: `Step ${i + 1}: ${['Scaffold the project', 'Implement game logic', 'Render the canvas', 'Wire up keyboard input', 'Add scoring and game over', 'Write unit tests', 'Polish styling', 'Document usage'][i % 8]}`,
      instructions: (long
        ? 'Create the module and export the public API. Keep functions small and pure where possible, inject randomness so it can be tested, and avoid global state. Handle edge cases explicitly: empty input, boundaries, and repeated calls. Use clear names, add brief comments only where the intent is not obvious, and keep the file under 150 lines. '
        : 'Create the module and export the public API. ').repeat(long ? 2 : 1) + `(step ${i + 1})`,
      files: i === 0 ? [] : ['src/game.js', 'index.html'],
      acceptance: ['Opening the page shows no console errors', 'The behaviour described in this step works as expected', ...(long ? ['Existing behaviour from earlier steps is unchanged and covered by a test'] : [])],
    }));
    result('', { structured_output: { summary: 'A browser snake game with a pure, testable game-logic module and a canvas front end, built in small verifiable steps.', features: ['Snake movement', 'Food and growth', 'Collision and game over'], fileStructure: ['index.html', 'src/game.js'], steps } }, 1200, 900);
  }
  process.exit(0);
}

// executor
const id = () => 'msg_' + Math.random().toString(36).slice(2, 10);
const say = async (text) => { out({ type: 'assistant', message: { id: id(), model, content: [{ type: 'text', text }], usage: usage(800, 40) }, session_id: sessionId }); await sleep(delay); };
const tool = async (name, input) => { out({ type: 'assistant', message: { id: id(), model, content: [{ type: 'tool_use', name, input }], usage: usage(800, 60) }, session_id: sessionId }); await sleep(delay); };
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
mkdirSync('src', { recursive: true });
const gamePath = 'src/game.js';
const before = existsSync(gamePath) ? readFileSync(gamePath, 'utf8') : '';
writeFileSync(gamePath, before + `// change ${new Date().toISOString().slice(11, 19)} ${Math.random().toString(36).slice(2, 6)}\nfunction step() { return 1; }\n`);
await say('On it. I will read the current files and then make the change.');
await tool('Read', { file_path: process.cwd() + '/index.html' });
await tool('Write', { file_path: process.cwd() + '/src/game.js' });
await tool('Edit', { file_path: process.cwd() + '/index.html' });
await tool('Bash', { command: 'node --check src/game.js' });
const finalText = process.env.FAKE_BIG ? 'x'.repeat(Number(process.env.FAKE_BIG)) + '\nEND' : 'Done: implemented this step and checked that it runs. ' + (prompt.slice(0, 60).replace(/\s+/g, ' '));
await say(finalText);
result(finalText, {}, 1500, 700);
