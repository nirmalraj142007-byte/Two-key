/**
 * npm run mcp:release — builds the twokey-mcp release asset into release/ (git-ignored).
 *
 * Packs @twokey/mcp (prepack bundles dist/twokey-mcp.js) and checks the tarball against the pinned
 * record in apps/mcp/release.json: same file name and same sha256. npm pack is deterministic, so a
 * mismatch means the server code or its package.json changed; then bump the version, rerun with
 * --record, and publish a new release. The developers page and docs link to release.json's url.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RECORD = join(ROOT, 'apps', 'mcp', 'release.json');
const OUT = join(ROOT, 'release');

interface Release {
  tag: string;
  asset: string;
  url: string;
  sha256: string;
}

const release = JSON.parse(readFileSync(RECORD, 'utf8')) as Release;
const { version } = JSON.parse(readFileSync(join(ROOT, 'apps', 'mcp', 'package.json'), 'utf8')) as {
  version: string;
};
if (release.tag !== `v${version}` || release.asset !== `twokey-mcp-${version}.tgz`) {
  console.error(
    `apps/mcp/release.json names ${release.tag}/${release.asset}, package is ${version}`,
  );
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execSync(`npm pack -w @twokey/mcp --pack-destination "${OUT}"`, { cwd: ROOT, stdio: 'ignore' });
const file = join(OUT, release.asset);
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');

if (process.argv.includes('--record')) {
  writeFileSync(RECORD, `${JSON.stringify({ ...release, sha256 }, null, 2)}\n`);
  console.log(`recorded sha256 ${sha256} in apps/mcp/release.json`);
} else if (sha256 !== release.sha256) {
  console.error(
    `release/${release.asset} sha256 ${sha256} does not match apps/mcp/release.json (${release.sha256}). Bump the version and rerun with --record.`,
  );
  process.exit(1);
}

console.log(`release/${release.asset}
sha256 ${sha256}

Upload it as a GitHub release:
  1. https://github.com/nirmalraj142007-byte/Two-key/releases/new
  2. Tag: ${release.tag} (target: main). Title: twokey-mcp ${release.tag}
  3. Attach release/${release.asset} and publish.
  4. npm run mcp:pack-smoke -- --remote   (installs from ${release.url})`);
