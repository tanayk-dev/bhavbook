// Fails if git tracks anything under docs/broker-exports other than notes (*.md) and .gitkeep.
// Real broker exports contain personal data and must never be committed (plans/bhavbook-v1.md, invariant 3).
import { execFileSync } from 'node:child_process';

const ALLOWED = /(\.md|\.gitkeep)$/;

const tracked = execFileSync('git', ['ls-files', '-z', '--', 'docs/broker-exports'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const leaks = tracked.filter((path) => !ALLOWED.test(path));

if (leaks.length > 0) {
  console.error('Broker export files are tracked by git (personal data risk):');
  for (const path of leaks) console.error(`  ${path}`);
  process.exit(1);
}

console.log(`check:leaks OK (${tracked.length} allowed files tracked under docs/broker-exports)`);
