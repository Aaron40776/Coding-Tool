# Contributing

Thanks for helping make `smart` better.

## Setup
```sh
git clone https://github.com/Aaron40776/Smart.git
cd Smart
npm install
npm run check      # lint + typecheck + tests + build
npm run dev        # run from source (needs the `claude` CLI, logged in)
```
Node.js 22+ is required. smart supports **Windows 10 and 11** only, and CI runs on Windows. A few small non-Windows branches remain in the code
(process groups, symlinked paths) so the test suite also runs on Linux, which is where automated tooling usually runs; do not build features on them.

## Layout
```
src/core/     the engine, no UI imports: pipeline (orchestrator), classifier, planner, router, runner, verifier, review,
              effort, smalltalk, checkpoint (git undo), claude (the only place that spawns `claude`), config, events
src/core/store/   files under %USERPROFILE%\.smart: tracker (history), conversation, inputHistory, limits, atomicFile (lock + atomic write)
src/ui/       Ink components and the state reducer; src/cli.tsx and src/print.ts are the entry points
test/         mirrors src; test/fixtures/fake-claude.mjs stands in for the CLI
install.ps1   the Windows installer (CI parses it with Windows PowerShell 5.1 and runs it)
```

## Ground rules
- **`src/core` must not import UI code** (React/Ink). It emits events; frontends subscribe. ESLint enforces this.
- **`src/core/claude.ts` is the only place that spawns `claude`.** Everything else takes a `RunClaudeFn`, so tests mock Claude.
- Model names come from config, never from code.
- Add tests with every change. UI tests use `ink-testing-library`; core tests inject fakes.
- Do not skip or weaken tests to get green.

## Pull requests
- Branch from `main`, keep PRs focused, and fill in the PR template.
- `npm run check` must pass on Windows (CI runs Node 22 and 24).
- For anything that changes routing behavior, update `ROUTING.md`.

## Reporting problems
Use the issue templates. Include your OS/terminal, Node and Claude Code versions.
