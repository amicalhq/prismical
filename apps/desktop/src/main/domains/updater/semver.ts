// Keep these comparison rules aligned with the update service.
/**
 * Minimal semver comparison — no external dependencies.
 * Handles versions like "1.0.0", "1.0.0-beta.2".
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parse(version: string): ParsedVersion {
  const v = version.startsWith('v') ? version.slice(1) : version;

  const [core, pre] = v.split('-', 2);
  const [major, minor, patch] = (core ?? '').split('.').map(Number);

  return {
    major: major ?? 0,
    minor: minor ?? 0,
    patch: patch ?? 0,
    prerelease: pre ? pre.split('.') : [],
  };
}

/**
 * Compare two semver versions.
 * Returns: negative if a < b, positive if a > b, 0 if equal.
 */
export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);

  const coreDiff = pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
  if (coreDiff !== 0) return coreDiff;

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];

    if (ai === undefined) return -1;
    if (bi === undefined) return 1;

    const aNum = Number(ai);
    const bNum = Number(bi);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);

    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (aIsNum) {
      return -1;
    } else if (bIsNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }

  return 0;
}

/** Returns true if `a` is greater than `b`. */
export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}
