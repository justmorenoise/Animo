/**
 * The version a build reports, from `package.json` and git.
 *
 * `package.json` holds MAJOR.MINOR (and a patch that is only a floor); the
 * patch of a build is the tag's patch plus the commits since it, read from
 * `git describe --tags --long --match "v[0-9]*" --dirty`. So every commit has
 * its own number without any file being rewritten, and a number leads back to
 * its commit. Pure: vite.config.ts runs git and passes the output here.
 */

export interface BuildVersion {
  version: string;
  /** Short hash of the commit built; null outside a git checkout. */
  commit: string | null;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/;
const DESCRIBE = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/;

export function versionFrom(packageVersion: string, describe: string | null): BuildVersion {
  const pkg = SEMVER.exec(packageVersion);
  const d = describe ? DESCRIBE.exec(describe.trim()) : null;
  if (!pkg || !d) return { version: packageVersion, commit: null };
  const [, major, minor, patch] = pkg.map(Number) as [number, number, number, number];
  const [, tMajor, tMinor, tPatch, since, hash, dirty] = d;
  // A package.json already raised past the last tag (1.1.0 before `v1.1.0`
  // exists) counts from its own number: the tag's would go backwards.
  const sameLine = Number(tMajor) === major && Number(tMinor) === minor;
  const base = sameLine ? Math.max(Number(tPatch), patch) : patch;
  const next = sameLine ? base + Number(since) : patch;
  return {
    // Uncommitted changes are marked as build metadata, which semver ignores in ordering.
    version: `${major}.${minor}.${next}${dirty ? "+dirty" : ""}`,
    commit: hash!,
  };
}
