import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/** One benchmark task: a prompt, optional starting files, and a check that decides pass or fail from the resulting directory. */
export interface BenchTask {
  id: string;
  title: string;
  prompt: string;
  files?: Record<string, string>;
  check: (dir: string) => boolean;
}

const node = (dir: string, args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? '') };
  }
};
const read = (dir: string, f: string): string => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');

export const TASKS: BenchTask[] = [
  {
    id: 'trivial-question',
    title: 'Answer a question, change nothing',
    prompt: 'What does the function in util.js do? Answer in one sentence and do not modify any file.',
    files: { 'util.js': 'exports.clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\n' },
    check: (d) => read(d, 'util.js') === 'exports.clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\n',
  },
  {
    id: 'fizzbuzz',
    title: 'Small new file',
    prompt: 'Create fizzbuzz.js that prints the numbers 1 to 15, one per line, replacing multiples of 3 with Fizz, of 5 with Buzz and of both with FizzBuzz.',
    check: (d) => {
      const r = node(d, ['fizzbuzz.js']);
      const want = Array.from({ length: 15 }, (_, i) => ((i + 1) % 15 === 0 ? 'FizzBuzz' : (i + 1) % 3 === 0 ? 'Fizz' : (i + 1) % 5 === 0 ? 'Buzz' : String(i + 1))).join('\n');
      return r.ok && r.out.trim() === want;
    },
  },
  {
    id: 'fix-bug',
    title: 'Fix a failing test',
    prompt: 'Running `node test.js` fails. Find the bug in the code and fix it, without changing test.js.',
    files: {
      'add.js': 'exports.add = (a, b) => a - b;\n',
      'test.js': "const assert = require('node:assert');\nconst { add } = require('./add.js');\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nconsole.log('ok');\n",
    },
    check: (d) => node(d, ['test.js']).out.includes('ok') && read(d, 'test.js').includes('add(-1, 1)'),
  },
  {
    id: 'rename',
    title: 'Rename across files',
    prompt: 'Rename the function `foo` to `computeTotal` everywhere in this project (definition and all uses). Keep the behaviour the same.',
    files: {
      'lib.js': 'exports.foo = (items) => items.reduce((a, b) => a + b, 0);\n',
      'main.js': "const { foo } = require('./lib.js');\nconsole.log(foo([1, 2, 3]));\n",
    },
    check: (d) => !/\bfoo\b/.test(read(d, 'lib.js') + read(d, 'main.js')) && node(d, ['main.js']).out.trim() === '6',
  },
  {
    id: 'slugify-tests',
    title: 'Function plus tests',
    prompt: 'Write slugify(str) in slugify.js (CommonJS, exported as `slugify`): lowercase, trim, replace runs of non-alphanumerics with a single "-", no leading or trailing "-". Add slugify.test.js using node:test that covers it.',
    check: (d) => {
      const probe = node(d, ['-e', "const {slugify}=require('./slugify.js');console.log(slugify('  Hello, World!! '));"]);
      return probe.ok && probe.out.trim() === 'hello-world' && node(d, ['--test']).ok;
    },
  },
  {
    id: 'todo-cli',
    title: 'Multi-file feature (planning candidate)',
    prompt: 'Build a tiny todo CLI in Node with no dependencies. `node todo.js add "text"` adds an item, `node todo.js list` prints one item per line as "<id>. [ ] text" or "<id>. [x] text", `node todo.js done <id>` marks it done. Persist to todos.json in the current directory. Put the storage code in store.js.',
    check: (d) => {
      const run = (...a: string[]) => node(d, ['todo.js', ...a]);
      // Start from an empty store so the check does not depend on leftovers from the run.
      rmSync(path.join(d, 'todos.json'), { force: true });
      run('add', 'buy milk');
      run('add', 'walk dog');
      run('done', '1');
      const list = run('list').out;
      return existsSync(path.join(d, 'store.js')) && /1\.\s*\[x\]\s*buy milk/.test(list) && /2\.\s*\[ \]\s*walk dog/.test(list);
    },
  },
];

export const VARIANTS = ['sonnet', 'opus', 'smart'] as const;
export type Variant = (typeof VARIANTS)[number];
