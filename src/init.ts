import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write a starter `smart.config.json` into `cwd`. Returns a message for the user; never overwrites without `force`. */
export function initConfig(cwd: string, examplePath: string, force = false): { ok: boolean; message: string } {
  const target = join(cwd, 'smart.config.json');
  if (existsSync(target) && !force) return { ok: false, message: `${target} already exists. Use \`smart init --force\` to overwrite it.` };
  let body: string;
  try {
    body = readFileSync(examplePath, 'utf8');
  } catch {
    return { ok: false, message: `Could not read the example config at ${examplePath}.` };
  }
  try {
    writeFileSync(target, body);
  } catch (e) {
    return { ok: false, message: `Could not write ${target}: ${(e as Error).message}` };
  }
  return { ok: true, message: `Created ${target}. Edit it to change models, routing rules, review, budgets and more (see ROUTING.md).` };
}
