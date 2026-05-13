const NPM_REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;
const NPM_REGISTRY_TIMEOUT_MS = 3_000;

type NpmPackageVersions = {
  latest: string | null;
  stableVersions: string[];
};

type CachedPackageVersions = {
  expiresAt: number;
  value: NpmPackageVersions;
};

const cache = new Map<string, CachedPackageVersions>();

export type NpmEtargetFailure = {
  packageName: string;
  requestedVersion: string;
};

export function detectNpmEtargetError(
  output: string,
): NpmEtargetFailure | null {
  if (!/npm\s+(?:ERR!|error)\s+code\s+ETARGET/i.test(output)) {
    return null;
  }

  const match = output.match(/No matching version found for\s+([^\s]+)/i);
  const specifier = match?.[1]?.replace(/[.,;:]+$/, "");
  if (!specifier) return null;

  const versionSeparator = specifier.lastIndexOf("@");
  if (versionSeparator <= 0) return null;

  const packageName = specifier.slice(0, versionSeparator);
  const requestedVersion = specifier.slice(versionSeparator + 1);
  if (!packageName || !requestedVersion) return null;

  return { packageName, requestedVersion };
}

export async function getNpmPackageVersions(
  packageName: string,
): Promise<NpmPackageVersions> {
  const cached = cache.get(packageName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NPM_REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      return { latest: null, stableVersions: [] };
    }
    const payload = (await response.json()) as {
      "dist-tags"?: { latest?: unknown };
      versions?: Record<string, unknown>;
    };
    const latest =
      typeof payload["dist-tags"]?.latest === "string"
        ? payload["dist-tags"].latest
        : null;
    const stableVersions = Object.keys(payload.versions ?? {})
      .filter(isStableVersion)
      .sort(compareVersions);
    const value = { latest, stableVersions };
    cache.set(packageName, {
      expiresAt: Date.now() + NPM_REGISTRY_CACHE_TTL_MS,
      value,
    });
    return value;
  } catch {
    return { latest: null, stableVersions: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export function selectNpmReplacementVersion(input: {
  requestedVersion: string;
  latest: string | null;
  stableVersions: string[];
}): string | null {
  const requested = parseVersion(input.requestedVersion);
  const stable = input.stableVersions.filter(
    (version) => parseVersion(version) !== null,
  );

  if (requested) {
    const sameMinor = stable
      .filter((version) => {
        const parsed = parseVersion(version);
        return (
          parsed &&
          parsed.major === requested.major &&
          parsed.minor === requested.minor &&
          compareVersions(version, input.requestedVersion) <= 0
        );
      })
      .at(-1);
    if (sameMinor) return sameMinor;

    const sameMajor = stable
      .filter((version) => {
        const parsed = parseVersion(version);
        return (
          parsed &&
          parsed.major === requested.major &&
          compareVersions(version, input.requestedVersion) <= 0
        );
      })
      .at(-1);
    if (sameMajor) return sameMajor;
  }

  return input.latest ?? stable.at(-1) ?? null;
}

export function buildNpmEtargetRecoveryMessage(input: {
  packageName: string;
  requestedVersion: string;
  replacementVersion: string;
  distTagLatest?: string | null;
}) {
  const distTagNote =
    input.distTagLatest && input.distTagLatest !== input.replacementVersion
      ? ` npm dist-tag latest is ${input.distTagLatest}.`
      : "";
  return `Install failed because ${input.packageName}@${input.requestedVersion} doesn't exist. Latest valid version is ${input.replacementVersion}.${distTagNote} Update package.json and rerun. Don't retry the same version.`;
}

function isStableVersion(version: string) {
  return !version.includes("-") && parseVersion(version) !== null;
}

function parseVersion(version: string) {
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || 0;
}
