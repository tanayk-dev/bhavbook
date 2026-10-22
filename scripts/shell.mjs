// Shell command lines for the packaging scripts. pnpm, npm and npx are .cmd shims on Windows, so they run through
// the shell (cmd.exe or sh); arguments are quoted, and anything either shell would interpret is refused, not escaped.
import { execSync } from 'node:child_process';

const PLAIN = /^[\w .:\\/@+=,~-]+$/;

/** One argument, quoted: plain paths and words only (no `$`, `%`, backticks, quotes, `!`, `^`, `&`, `|`, `<`, `>`). */
export function shellArg(arg) {
  if (!PLAIN.test(arg)) throw new Error(`refusing an unsafe shell argument: ${arg}`);
  return `"${arg}"`;
}

/** Runs `command` with `args` quoted; returns its standard output (stderr passes through). */
export function run(command, args, { cwd, env = process.env, inherit = false } = {}) {
  const line = [command, ...args.map(shellArg)].join(' ');
  return execSync(line, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', inherit ? 'inherit' : 'pipe', 'inherit'],
  });
}
