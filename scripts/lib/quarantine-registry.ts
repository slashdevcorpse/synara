import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

type UnknownRecord = Record<string, unknown>;

export const QUARANTINE_PLATFORMS = ["linux", "windows"] as const;
export type QuarantinePlatform = (typeof QUARANTINE_PLATFORMS)[number];

export interface QuarantineEntry {
  readonly id: string;
  readonly path: string;
  readonly marker: string;
  readonly suite: "browser-geometry";
  readonly platform: readonly QuarantinePlatform[];
  readonly reason: string;
  readonly owner: string;
  readonly lastFlaked: string;
  readonly cases: number;
}

export interface QuarantineRegistry {
  readonly schemaVersion: 1;
  readonly entries: readonly QuarantineEntry[];
}

export interface QuarantineValidationResult {
  readonly registry: QuarantineRegistry | null;
  readonly errors: readonly string[];
}

export interface QuarantineSummaryBaseline {
  readonly ref: string;
  readonly registry: QuarantineRegistry;
}

const ENTRY_KEYS = new Set([
  "id",
  "path",
  "marker",
  "suite",
  "platform",
  "reason",
  "owner",
  "lastFlaked",
  "cases",
]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKER_PATTERN = /\[quarantine:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;
const TEST_SOURCE_PATTERN = /\.(?:browser|test|spec)\.[cm]?[jt]sx?$/;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const PLATFORM_ORDER = new Map(
  QUARANTINE_PLATFORMS.map((platform, index) => [platform, index] as const),
);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlatform(value: unknown): value is QuarantinePlatform {
  return typeof value === "string" && QUARANTINE_PLATFORMS.includes(value as QuarantinePlatform);
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function isWithinRepository(repositoryRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(repositoryRoot, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function sourceFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name))
        files.push(...sourceFiles(resolve(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && TEST_SOURCE_PATTERN.test(entry.name))
      files.push(resolve(directory, entry.name));
  }
  return files;
}

function readMarkers(path: string): readonly string[] {
  return [...readFileSync(path, "utf8").matchAll(MARKER_PATTERN)].map((match) => match[0]);
}

export function validateQuarantineRegistry(
  source: string,
  options: {
    readonly repositoryRoot: string;
    readonly today?: string;
    readonly validateSources?: boolean;
  },
): QuarantineValidationResult {
  const errors: string[] = [];
  let document: unknown;
  try {
    document = parseYaml(source, { strict: true, uniqueKeys: true });
  } catch (error) {
    return {
      registry: null,
      errors: [`Quarantine registry is not valid YAML: ${String(error)}`],
    };
  }

  if (!isRecord(document)) {
    return { registry: null, errors: ["Quarantine registry must be a mapping."] };
  }
  const rootKeys = Object.keys(document);
  for (const key of rootKeys) {
    if (key !== "schemaVersion" && key !== "entries") {
      errors.push(`Quarantine registry has unsupported key \`${key}\`.`);
    }
  }
  if (document.schemaVersion !== 1) errors.push("Quarantine registry schemaVersion must be 1.");
  if (!Array.isArray(document.entries)) {
    errors.push("Quarantine registry entries must be an array.");
    return { registry: null, errors };
  }

  const repositoryRoot = resolve(options.repositoryRoot);
  const todayText = options.today ?? new Date().toISOString().slice(0, 10);
  const today = parseIsoDate(todayText);
  if (!today) throw new Error(`Invalid validator date: ${todayText}`);
  const entries: QuarantineEntry[] = [];
  const ids = new Set<string>();

  for (const [index, value] of document.entries.entries()) {
    const label = `Quarantine entry ${index + 1}`;
    if (!isRecord(value)) {
      errors.push(`${label} must be a mapping.`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!ENTRY_KEYS.has(key)) errors.push(`${label} has unsupported key \`${key}\`.`);
    }

    const id = value.id;
    const path = value.path;
    const marker = value.marker;
    const suite = value.suite;
    const platforms = value.platform;
    const reason = value.reason;
    const owner = value.owner;
    const lastFlaked = value.lastFlaked;
    const cases = value.cases;

    if (typeof id !== "string" || !ID_PATTERN.test(id)) errors.push(`${label} id is invalid.`);
    if (typeof id === "string") {
      if (ids.has(id)) errors.push(`${label} duplicates id \`${id}\`.`);
      ids.add(id);
    }
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\\") ||
      path.startsWith("/")
    ) {
      errors.push(`${label} path must be a repository-relative POSIX path.`);
    }
    if (typeof marker !== "string" || typeof id !== "string" || marker !== `[quarantine:${id}]`) {
      errors.push(`${label} marker must exactly match its id.`);
    }
    if (suite !== "browser-geometry") errors.push(`${label} suite is unsupported.`);
    if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every(isPlatform)) {
      errors.push(`${label} platform must contain supported platforms.`);
    } else {
      if (new Set(platforms).size !== platforms.length) errors.push(`${label} repeats a platform.`);
      const sorted = [...platforms].sort(
        (left, right) => PLATFORM_ORDER.get(left)! - PLATFORM_ORDER.get(right)!,
      );
      if (sorted.some((platform, platformIndex) => platform !== platforms[platformIndex])) {
        errors.push(`${label} platforms must use linux, windows order.`);
      }
    }
    if (typeof reason !== "string" || reason.trim().length < 12) {
      errors.push(`${label} reason must explain the quarantine.`);
    }
    if (typeof owner !== "string" || owner.trim().length === 0) {
      errors.push(`${label} owner must be non-empty.`);
    }
    const lastFlakedDate = typeof lastFlaked === "string" ? parseIsoDate(lastFlaked) : null;
    if (!lastFlakedDate) errors.push(`${label} lastFlaked must be a real YYYY-MM-DD date.`);
    else if (lastFlakedDate > today) errors.push(`${label} lastFlaked cannot be in the future.`);
    if (!Number.isInteger(cases) || (cases as number) < 1) {
      errors.push(`${label} cases must be a positive integer.`);
    }

    if (
      typeof id === "string" &&
      ID_PATTERN.test(id) &&
      typeof path === "string" &&
      path.length > 0 &&
      !path.includes("\\") &&
      !path.startsWith("/") &&
      typeof marker === "string" &&
      marker === `[quarantine:${id}]` &&
      suite === "browser-geometry" &&
      Array.isArray(platforms) &&
      platforms.length > 0 &&
      platforms.every(isPlatform) &&
      typeof reason === "string" &&
      reason.trim().length >= 12 &&
      typeof owner === "string" &&
      owner.trim().length > 0 &&
      typeof lastFlaked === "string" &&
      lastFlakedDate &&
      Number.isInteger(cases) &&
      (cases as number) > 0
    ) {
      entries.push({
        id,
        path,
        marker,
        suite,
        platform: platforms,
        reason,
        owner,
        lastFlaked,
        cases: cases as number,
      });
    }
  }

  const sortedIds = [...entries].map((entry) => entry.id).sort();
  if (entries.some((entry, index) => entry.id !== sortedIds[index])) {
    errors.push("Quarantine entries must be sorted by id.");
  }

  if (options.validateSources !== false) {
    const registeredMarkers = new Map(entries.map((entry) => [entry.marker, entry] as const));
    for (const entry of entries) {
      const absolutePath = resolve(repositoryRoot, entry.path);
      if (!isWithinRepository(repositoryRoot, absolutePath)) {
        errors.push(`Quarantine entry \`${entry.id}\` escapes the repository root.`);
      } else if (!existsSync(absolutePath)) {
        errors.push(`Quarantine entry \`${entry.id}\` path does not exist: ${entry.path}.`);
      } else if (!statSync(absolutePath).isFile()) {
        errors.push(`Quarantine entry \`${entry.id}\` path is not a file: ${entry.path}.`);
      } else if (!readFileSync(absolutePath, "utf8").includes(entry.marker)) {
        errors.push(`Quarantine entry \`${entry.id}\` marker is missing from ${entry.path}.`);
      }
    }

    for (const rootName of ["apps", "packages", "scripts"]) {
      for (const absolutePath of sourceFiles(resolve(repositoryRoot, rootName))) {
        const path = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
        for (const marker of readMarkers(absolutePath)) {
          const entry = registeredMarkers.get(marker);
          if (!entry) errors.push(`Unregistered quarantine marker ${marker} found in ${path}.`);
          else if (entry.path !== path) {
            errors.push(
              `Quarantine marker ${marker} is registered for ${entry.path}, not ${path}.`,
            );
          }
        }
      }
    }
  }

  return {
    registry: errors.length === 0 ? { schemaVersion: 1, entries } : null,
    errors,
  };
}

export function quarantineSuitesForPlatform(
  registry: QuarantineRegistry,
  platform: QuarantinePlatform,
): readonly QuarantineEntry["suite"][] {
  return [
    ...new Set(
      registry.entries
        .filter((entry) => entry.platform.includes(platform))
        .map((entry) => entry.suite),
    ),
  ].sort();
}

export function quarantineMarkersForPlatform(
  registry: QuarantineRegistry,
  platform: QuarantinePlatform,
): readonly string[] {
  return [
    ...new Set(
      registry.entries
        .filter((entry) => entry.platform.includes(platform))
        .map((entry) => entry.marker),
    ),
  ].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function quarantineTestNamePattern(
  registry: QuarantineRegistry,
  platform: QuarantinePlatform,
  mode: "stable" | "quarantine",
): RegExp {
  const markers = quarantineMarkersForPlatform(registry, platform).map(escapeRegExp);
  if (markers.length === 0) return mode === "stable" ? /.*/ : /$a/;
  const markerPattern = `(?:${markers.join("|")})`;
  return mode === "stable" ? new RegExp(`^(?!.*${markerPattern}).*$`) : new RegExp(markerPattern);
}

export function formatQuarantineSummary(
  registry: QuarantineRegistry,
  options: {
    readonly today?: string;
    readonly platform?: QuarantinePlatform;
    readonly baseline?: QuarantineSummaryBaseline;
  } = {},
): string {
  const todayText = options.today ?? new Date().toISOString().slice(0, 10);
  const today = parseIsoDate(todayText);
  if (!today) throw new Error(`Invalid summary date: ${todayText}`);
  const entries = options.platform
    ? registry.entries.filter((entry) => entry.platform.includes(options.platform!))
    : registry.entries;
  const age = (entry: QuarantineEntry) => {
    const date = parseIsoDate(entry.lastFlaked)!;
    return Math.floor((today.valueOf() - date.valueOf()) / 86_400_000);
  };
  const cases = entries.reduce((total, entry) => total + entry.cases, 0);
  const oldest = entries.length === 0 ? 0 : Math.max(...entries.map(age));
  const scope = options.platform ? ` for ${options.platform}` : "";
  const lines = [
    `## Test quarantine${scope}`,
    "",
    `- Registered groups: **${entries.length}**`,
    `- Registered test cases: **${cases}**`,
    `- Oldest active quarantine: **${oldest} day${oldest === 1 ? "" : "s"}**`,
  ];
  if (options.baseline) {
    const baselineEntries = options.platform
      ? options.baseline.registry.entries.filter((entry) =>
          entry.platform.includes(options.platform!),
        )
      : options.baseline.registry.entries;
    const baselineCases = baselineEntries.reduce((total, entry) => total + entry.cases, 0);
    const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));
    lines.push(
      `- Baseline ref: \`${options.baseline.ref}\``,
      `- Change from baseline: **${signed(entries.length - baselineEntries.length)} groups**, **${signed(cases - baselineCases)} cases**`,
    );
  }
  lines.push(
    "",
    "| ID | Suite | Platforms | Cases | Last flaked | Age | Owner | Reason |",
    "| --- | --- | --- | ---: | --- | ---: | --- | --- |",
  );
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const entry of entries) {
    lines.push(
      `| ${entry.id} | ${entry.suite} | ${entry.platform.join(", ")} | ${entry.cases} | ${entry.lastFlaked} | ${age(entry)} days | ${escape(entry.owner)} | ${escape(entry.reason)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
