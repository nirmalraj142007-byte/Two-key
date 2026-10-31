// npm audit --omit=dev --audit-level=high, with documented exceptions.
// Each exception is an advisory we can't fix without a breaking upgrade; docs/SECURITY.md
// gives the reason. An exception stops applying on its review date, so it can't go stale.
import { execFileSync } from 'node:child_process';

const EXCEPTIONS = {
  // drizzle-orm < 0.45.2: SQL injection through escaped *identifiers*. Every identifier we pass
  // comes from our own schema code, never from input. The fix (0.45.x) is semver-breaking and
  // would change the ORM under the running evaluation; upgrade after the test split (Nov 7).
  'GHSA-gpj5-g38j-94v9': { pkg: 'drizzle-orm', until: '2026-11-15' },
};

let out;
try {
  out = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  out = err.stdout; // npm audit exits 1 when it finds anything
}
const report = JSON.parse(out);
const today = new Date().toISOString().slice(0, 10);
const failures = [];
const excepted = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via === 'string') continue; // reported under the package it comes from
    if (via.severity !== 'high' && via.severity !== 'critical') continue;
    const id = String(via.url ?? '')
      .split('/')
      .pop();
    const ex = EXCEPTIONS[id];
    const line = `${via.severity} ${name} ${id} ${via.title}`;
    if (ex && ex.pkg === name && today <= ex.until)
      excepted.push(`${line} (exception until ${ex.until})`);
    else failures.push(line);
  }
}
for (const l of excepted) console.log(`excepted: ${l}`);
const m = report.metadata?.vulnerabilities ?? {};
console.log(
  `npm audit --omit=dev: ${m.critical ?? 0} critical, ${m.high ?? 0} high, ${m.moderate ?? 0} moderate, ${m.low ?? 0} low`,
);
if (failures.length) {
  for (const l of failures) console.error(`not allowed: ${l}`);
  process.exit(1);
}
console.log('audit gate OK');
