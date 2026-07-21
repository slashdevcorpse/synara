// FILE: localImageFiles.ts
// Purpose: Resolves legacy image/PDF previews and short-lived directory capabilities
//          without exposing arbitrary local files.
// Layer: Server HTTP utility
// Exports: route constants, grant creation/resolution, and allowlisted path resolvers
// Depends on: fs realpath/stat, trusted workspace roots, and safe preview extensions

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  LOCAL_IMAGE_ROUTE_PATH,
  LOCAL_PREVIEW_ROUTE_PREFIX,
  isSupportedLocalHtmlPath,
  isSupportedLocalImagePath,
  isSupportedLocalPreviewAssetPath,
  isSupportedLocalPreviewFilePath,
} from "@synara/shared/localPreviewFiles";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";

import { resolveCodexGeneratedImagesRoots } from "./codexGeneratedImages.ts";

export { LOCAL_IMAGE_ROUTE_PATH, LOCAL_PREVIEW_ROUTE_PREFIX };

interface LocalPreviewFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface LocalPreviewDirectoryIdentity extends LocalPreviewFileIdentity {
  readonly path: string;
}

export interface ResolvedLocalPreviewFile {
  readonly path: string;
  readonly fileName: string;
  /** From validation; verified-open callers replace this with the descriptor size. */
  readonly sizeBytes: number;
  /** Stable identity captured while validating the canonical path. */
  readonly fileIdentity: LocalPreviewFileIdentity;
  /** Canonical directory chain captured before opening a granted nested asset. */
  readonly ancestorDirectoryIdentities?: ReadonlyArray<LocalPreviewDirectoryIdentity>;
}

export interface LocalPreviewGrantResult {
  readonly grant: string;
  readonly expiresAt: string;
  readonly urlPath?: string;
}

export type LocalPreviewGrantPurpose = "preview" | "browser";

export interface ResolvedLocalPreviewGrantResource extends ResolvedLocalPreviewFile {
  readonly purpose: LocalPreviewGrantPurpose;
}

export type OpenedLocalPreviewFile<T extends ResolvedLocalPreviewFile = ResolvedLocalPreviewFile> =
  T & {
    readonly readable: Readable;
  };

export type LocalPreviewGrantErrorCode =
  | "invalid-path"
  | "cwd-required"
  | "purpose-required"
  | "network-path"
  | "workspace-not-found"
  | "untrusted-workspace"
  | "unsupported-entry"
  | "not-found"
  | "not-file"
  | "outside-root"
  | "symlink-escape";

export class LocalPreviewGrantError extends Error {
  readonly code: LocalPreviewGrantErrorCode;

  constructor(code: LocalPreviewGrantErrorCode, message: string) {
    super(message);
    this.name = "LocalPreviewGrantError";
    this.code = code;
  }
}

interface ExactFilePreviewGrant {
  readonly kind: "file";
  readonly ownerKey: string;
  readonly realFilePath: string;
  readonly expiresAtMs: number;
}

interface DirectoryPreviewGrant {
  readonly kind: "directory";
  readonly ownerKey: string;
  readonly realDirectoryPath: string;
  readonly directoryIdentity: LocalPreviewFileIdentity;
  readonly entryRealPath: string;
  readonly purpose: LocalPreviewGrantPurpose;
  readonly expiresAtMs: number;
}

type LocalPreviewGrant = ExactFilePreviewGrant | DirectoryPreviewGrant;

export const LOCAL_PREVIEW_GRANT_TTL_MS = 2 * 60 * 1000;
export const MAX_OUTSTANDING_LOCAL_PREVIEW_GRANTS = 100;
export const MAX_OUTSTANDING_LOCAL_PREVIEW_GRANTS_PER_OWNER = 20;
const DEFAULT_LOCAL_PREVIEW_GRANT_OWNER_KEY = "local-process";
const localPreviewGrantByToken = new Map<string, LocalPreviewGrant>();

interface LocalPreviewGrantRecord {
  readonly ownerKey: string;
  readonly realFilePath: string;
  readonly expiresAtMs: number;
}

export class LocalPreviewGrantCapacityError extends Error {
  readonly code = "LOCAL_PREVIEW_GRANT_CAPACITY_EXCEEDED";

  constructor(readonly retryAfterMs: number) {
    super("Local preview grant capacity exceeded.");
    this.name = "LocalPreviewGrantCapacityError";
  }
}

function pruneExpiredGrants<T extends { readonly expiresAtMs: number }>(
  grants: Map<string, T>,
  nowMs: number,
): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAtMs <= nowMs) grants.delete(token);
  }
}

function assertLocalPreviewGrantCapacity<
  T extends { readonly expiresAtMs: number; readonly ownerKey: string },
>(input: {
  readonly grants: Map<string, T>;
  readonly nowMs: number;
  readonly maxOutstanding: number;
  readonly maxOutstandingPerOwner: number;
  readonly ownerKey: string;
}): void {
  pruneExpiredGrants(input.grants, input.nowMs);
  const ownerGrants = Array.from(input.grants.values()).filter(
    (grant) => grant.ownerKey === input.ownerKey,
  );
  if (ownerGrants.length >= input.maxOutstandingPerOwner) {
    const earliestOwnerExpiryMs = Math.min(...ownerGrants.map((grant) => grant.expiresAtMs));
    throw new LocalPreviewGrantCapacityError(Math.max(1, earliestOwnerExpiryMs - input.nowMs));
  }
  if (input.grants.size < input.maxOutstanding) return;

  const earliestExpiryMs = Math.min(
    ...Array.from(input.grants.values(), (grant) => grant.expiresAtMs),
  );
  throw new LocalPreviewGrantCapacityError(Math.max(1, earliestExpiryMs - input.nowMs));
}

function pruneExpiredPreviewGrants(nowMs = Date.now()): void {
  pruneExpiredGrants(localPreviewGrantByToken, nowMs);
}

type NewLocalPreviewGrant =
  | Omit<ExactFilePreviewGrant, "expiresAtMs">
  | Omit<DirectoryPreviewGrant, "expiresAtMs">;

function grantsSameResource(left: NewLocalPreviewGrant, right: LocalPreviewGrant): boolean {
  if (left.ownerKey !== right.ownerKey) return false;
  if (left.kind === "file") {
    return right.kind === "file" && isSameCanonicalPath(left.realFilePath, right.realFilePath);
  }
  return (
    right.kind === "directory" &&
    left.purpose === right.purpose &&
    isSameCanonicalPath(left.realDirectoryPath, right.realDirectoryPath) &&
    isSameCanonicalPath(left.entryRealPath, right.entryRealPath) &&
    hasSameIdentity(left.directoryIdentity, right.directoryIdentity)
  );
}

function storeLocalPreviewGrant(
  previewGrant: NewLocalPreviewGrant,
  nowMs: number,
): LocalPreviewGrantResult {
  pruneExpiredPreviewGrants(nowMs);
  for (const [grant, existing] of localPreviewGrantByToken) {
    const issuedAtMs = existing.expiresAtMs - LOCAL_PREVIEW_GRANT_TTL_MS;
    if (issuedAtMs <= nowMs && grantsSameResource(previewGrant, existing)) {
      return { grant, expiresAt: new Date(existing.expiresAtMs).toISOString() };
    }
  }
  assertLocalPreviewGrantCapacity({
    grants: localPreviewGrantByToken,
    nowMs,
    maxOutstanding: MAX_OUTSTANDING_LOCAL_PREVIEW_GRANTS,
    maxOutstandingPerOwner: MAX_OUTSTANDING_LOCAL_PREVIEW_GRANTS_PER_OWNER,
    ownerKey: previewGrant.ownerKey,
  });
  const grant = crypto.randomUUID();
  const expiresAtMs = nowMs + LOCAL_PREVIEW_GRANT_TTL_MS;
  if (previewGrant.kind === "file") {
    localPreviewGrantByToken.set(grant, {
      kind: "file",
      ownerKey: previewGrant.ownerKey,
      realFilePath: previewGrant.realFilePath,
      expiresAtMs,
    });
  } else {
    localPreviewGrantByToken.set(grant, {
      kind: "directory",
      ownerKey: previewGrant.ownerKey,
      realDirectoryPath: previewGrant.realDirectoryPath,
      directoryIdentity: previewGrant.directoryIdentity,
      entryRealPath: previewGrant.entryRealPath,
      purpose: previewGrant.purpose,
      expiresAtMs,
    });
  }
  return { grant, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function makeLocalPreviewGrantRegistry(
  options: {
    readonly now?: () => number;
    readonly createToken?: () => string;
    readonly maxOutstanding?: number;
    readonly maxOutstandingPerOwner?: number;
    readonly ttlMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const createToken = options.createToken ?? crypto.randomUUID;
  const maxOutstanding = options.maxOutstanding ?? MAX_OUTSTANDING_LOCAL_PREVIEW_GRANTS;
  const maxOutstandingPerOwner =
    options.maxOutstandingPerOwner ?? MAX_OUTSTANDING_LOCAL_PREVIEW_GRANTS_PER_OWNER;
  const ttlMs = options.ttlMs ?? LOCAL_PREVIEW_GRANT_TTL_MS;
  const grants = new Map<string, LocalPreviewGrantRecord>();

  const pruneExpired = (nowMs = now()): void => pruneExpiredGrants(grants, nowMs);

  const resolve = (token: string | null | undefined): string | null => {
    const normalizedToken = token?.trim();
    if (!normalizedToken) return null;
    const nowMs = now();
    pruneExpired(nowMs);
    const grant = grants.get(normalizedToken);
    return grant !== undefined && grant.expiresAtMs > nowMs ? grant.realFilePath : null;
  };

  const create = (
    realFilePath: string,
    ownerKey = DEFAULT_LOCAL_PREVIEW_GRANT_OWNER_KEY,
  ): LocalPreviewGrantResult => {
    const nowMs = now();
    pruneExpired(nowMs);
    for (const [grant, existing] of grants) {
      const issuedAtMs = existing.expiresAtMs - ttlMs;
      if (
        issuedAtMs <= nowMs &&
        existing.ownerKey === ownerKey &&
        isSameCanonicalPath(existing.realFilePath, realFilePath)
      ) {
        return { grant, expiresAt: new Date(existing.expiresAtMs).toISOString() };
      }
    }
    assertLocalPreviewGrantCapacity({
      grants,
      nowMs,
      maxOutstanding,
      maxOutstandingPerOwner,
      ownerKey,
    });

    const grant = createToken();
    const expiresAtMs = nowMs + ttlMs;
    grants.set(grant, { ownerKey, realFilePath, expiresAtMs });
    return { grant, expiresAt: new Date(expiresAtMs).toISOString() };
  };

  const snapshot = () => {
    pruneExpired();
    return { outstanding: grants.size } as const;
  };

  return { create, resolve, snapshot } as const;
}

function hasValidPreviewGrant(input: {
  readonly token: string | null | undefined;
  readonly realFilePath: string;
}): boolean {
  return resolveLocalPreviewGrantRealPath({ token: input.token }) === input.realFilePath;
}

export function resolveLocalPreviewGrantRealPath(input: {
  readonly token: string | null | undefined;
  readonly nowMs?: number;
}): string | null {
  const token = input.token?.trim();
  if (!token) {
    return null;
  }
  const nowMs = input.nowMs ?? Date.now();
  pruneExpiredPreviewGrants(nowMs);
  const grant = localPreviewGrantByToken.get(token);
  if (grant === undefined || grant.expiresAtMs <= nowMs) {
    return null;
  }
  return grant.kind === "file" ? grant.realFilePath : grant.entryRealPath;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isNetworkPath(candidate: string): boolean {
  const trimmed = candidate.trim();
  return /^[\\/]{2}/.test(trimmed);
}

function isSameCanonicalPath(left: string, right: string): boolean {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

function hasSameIdentity(left: LocalPreviewFileIdentity, right: LocalPreviewFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function readDirectoryIdentity(
  directoryPath: string,
): Promise<LocalPreviewDirectoryIdentity | null> {
  const linkState = await fs
    .readlink(directoryPath)
    .then(() => "link" as const)
    .catch((cause: unknown) =>
      (cause as NodeJS.ErrnoException).code === "EINVAL" ? ("not-link" as const) : null,
    );
  if (linkState !== "not-link") {
    return null;
  }

  const stat = await fs.lstat(directoryPath, { bigint: true }).catch(() => null);
  return stat?.isDirectory() && !stat.isSymbolicLink()
    ? { path: directoryPath, device: stat.dev, inode: stat.ino }
    : null;
}

async function captureAncestorDirectoryIdentities(input: {
  readonly rootPath: string;
  readonly filePath: string;
  readonly expectedRootIdentity: LocalPreviewFileIdentity;
}): Promise<ReadonlyArray<LocalPreviewDirectoryIdentity> | null> {
  const parentPath = path.dirname(input.filePath);
  if (!isPathInside(parentPath, input.rootPath)) {
    return null;
  }

  const relativeParentPath = path.relative(input.rootPath, parentPath);
  const directoryPaths = [input.rootPath];
  if (relativeParentPath) {
    let currentPath = input.rootPath;
    for (const segment of relativeParentPath.split(path.sep)) {
      currentPath = path.join(currentPath, segment);
      directoryPaths.push(currentPath);
    }
  }

  const identities: LocalPreviewDirectoryIdentity[] = [];
  for (const directoryPath of directoryPaths) {
    const identity = await readDirectoryIdentity(directoryPath);
    if (!identity) {
      return null;
    }
    identities.push(identity);
  }
  return hasSameIdentity(identities[0] as LocalPreviewDirectoryIdentity, input.expectedRootIdentity)
    ? identities
    : null;
}

function hasSameDirectoryIdentityChain(
  left: ReadonlyArray<LocalPreviewDirectoryIdentity>,
  right: ReadonlyArray<LocalPreviewDirectoryIdentity>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (identity, index) =>
        isSameCanonicalPath(identity.path, (right[index] as LocalPreviewDirectoryIdentity).path) &&
        hasSameIdentity(identity, right[index] as LocalPreviewDirectoryIdentity),
    )
  );
}

function encodeUrlPathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function decodeGrantedRelativePath(encodedRelativePath: string): string[] | null {
  if (
    !encodedRelativePath ||
    encodedRelativePath.includes("\0") ||
    encodedRelativePath.includes("\\") ||
    encodedRelativePath.startsWith("/")
  ) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedRelativePath);
  } catch {
    return null;
  }

  if (
    !decoded ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    path.posix.isAbsolute(decoded) ||
    path.win32.isAbsolute(decoded) ||
    /^[A-Za-z]:/.test(decoded)
  ) {
    return null;
  }

  const segments = decoded.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : segments;
}

async function realpathOrNull(candidate: string | undefined): Promise<string | null> {
  if (!candidate) {
    return null;
  }
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(path.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Keep walking until we hit the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function temporaryDirectoryRoots(): Promise<string[]> {
  const candidates = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.platform === "darwin" ? "/tmp" : undefined,
  ];
  const roots = await Promise.all(Array.from(new Set(candidates)).map(realpathOrNull));
  return Array.from(new Set(roots.filter((root): root is string => root !== null)));
}

async function realDirectoryPathOrNull(candidate: string | undefined): Promise<string | null> {
  const realPath = await realpathOrNull(candidate);
  if (!realPath) {
    return null;
  }
  const stat = await fs.stat(realPath).catch(() => null);
  return stat?.isDirectory() ? realPath : null;
}

async function canonicalAllowedWorkspaceRoots(
  candidates: ReadonlyArray<string>,
): Promise<string[]> {
  const roots = await Promise.all(
    candidates.map((candidate) => {
      const trimmed = candidate.trim();
      return !trimmed || isNetworkPath(trimmed) || !path.isAbsolute(trimmed)
        ? Promise.resolve(null)
        : realDirectoryPathOrNull(trimmed);
    }),
  );
  return Array.from(new Set(roots.filter((root): root is string => root !== null)));
}

async function scratchWorkspaceRoots(): Promise<string[]> {
  return (await temporaryDirectoryRoots()).map((root) =>
    path.join(root, SCRATCH_WORKSPACES_DIRNAME),
  );
}

async function resolveWorkspaceRoot(cwd: string | null): Promise<string | null> {
  if (!cwd) {
    return null;
  }
  const realCwd = await realpathOrNull(cwd);
  if (!realCwd) {
    return null;
  }
  const cwdStat = await fs.stat(realCwd).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    return null;
  }
  const gitRoot = await findGitRoot(realCwd);
  return (gitRoot ? await realpathOrNull(gitRoot) : realCwd) ?? null;
}

export async function resolveAllowedLocalPreviewFile(input: {
  readonly requestedPath: string | null;
  readonly cwd: string | null;
  readonly codexHomePath?: string;
  readonly allowAbsoluteLocalPreviewFile?: boolean;
  readonly previewGrant?: string | null;
}): Promise<ResolvedLocalPreviewFile | null> {
  const requestedPath = input.requestedPath?.trim();
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    !isSupportedLocalPreviewFilePath(requestedPath)
  ) {
    return null;
  }

  const resolvedRequestedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(input.cwd ?? process.cwd(), requestedPath);
  const realFilePath = await realpathOrNull(resolvedRequestedPath);
  if (!realFilePath || !isSupportedLocalPreviewFilePath(realFilePath)) {
    return null;
  }

  const stat = await fs.lstat(realFilePath, { bigint: true }).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }
  const resolved: ResolvedLocalPreviewFile = {
    path: realFilePath,
    fileName: path.basename(realFilePath),
    sizeBytes: Number(stat.size),
    fileIdentity: {
      device: stat.dev,
      inode: stat.ino,
    },
  };

  // The workspace check covers the common case (file previews), so resolve it
  // first and skip the broader root lookups entirely when it passes.
  const workspaceRoot = await resolveWorkspaceRoot(input.cwd);
  if (workspaceRoot !== null && isPathInside(realFilePath, workspaceRoot)) {
    return resolved;
  }

  // Sessions that start before a project workspace exists run in per-thread
  // scratch directories under the OS temp dir. Files agents create there are
  // workspace-equivalent, so every preview type is servable from that root.
  const tempRoots = await temporaryDirectoryRoots();
  const scratchWorkspaceRoots = tempRoots.map((root) =>
    path.join(root, SCRATCH_WORKSPACES_DIRNAME),
  );
  if (scratchWorkspaceRoots.some((root) => isPathInside(realFilePath, root))) {
    return resolved;
  }

  // The in-app file panel may intentionally preview an absolute local path
  // supplied by the agent (for example a file in Downloads). Keep this opt-in
  // so other callers retain the narrower workspace/generated-image allowlist.
  if (
    input.allowAbsoluteLocalPreviewFile === true &&
    path.isAbsolute(requestedPath) &&
    hasValidPreviewGrant({ token: input.previewGrant, realFilePath })
  ) {
    return resolved;
  }

  // The generated-image and temp-dir roots exist for agent-produced images in
  // chat markdown; keep them image-only so they never serve documents.
  if (!isSupportedLocalImagePath(realFilePath)) {
    return null;
  }
  const generatedImagesRoots = await Promise.all(
    resolveCodexGeneratedImagesRoots(input.codexHomePath).map(realpathOrNull),
  ).then((roots) => roots.filter((root): root is string => root !== null));
  const allowed =
    generatedImagesRoots.some((root) => isPathInside(realFilePath, root)) ||
    tempRoots.some((root) => isPathInside(realFilePath, root));
  return allowed ? resolved : null;
}

export async function resolveLocalPreviewGrantResource(input: {
  readonly token: string | null | undefined;
  /** Raw URL-path suffix. This function performs the single decode operation. */
  readonly encodedRelativePath: string;
  readonly nowMs?: number;
}): Promise<ResolvedLocalPreviewGrantResource | null> {
  const token = input.token?.trim();
  if (!token) {
    return null;
  }

  const nowMs = input.nowMs ?? Date.now();
  pruneExpiredPreviewGrants(nowMs);
  const grant = localPreviewGrantByToken.get(token);
  if (grant?.kind !== "directory" || grant.expiresAtMs <= nowMs) {
    return null;
  }

  const relativeSegments = decodeGrantedRelativePath(input.encodedRelativePath);
  if (!relativeSegments) {
    return null;
  }
  const relativePath = relativeSegments.join("/");
  if (!isSupportedLocalPreviewAssetPath(relativePath)) {
    return null;
  }

  const candidatePath = path.resolve(grant.realDirectoryPath, ...relativeSegments);
  if (!isPathInside(candidatePath, grant.realDirectoryPath)) {
    return null;
  }

  const initialAncestorDirectoryIdentities = await captureAncestorDirectoryIdentities({
    rootPath: grant.realDirectoryPath,
    filePath: candidatePath,
    expectedRootIdentity: grant.directoryIdentity,
  });
  if (!initialAncestorDirectoryIdentities) {
    return null;
  }

  const realFilePath = await realpathOrNull(candidatePath);
  if (
    !realFilePath ||
    !isPathInside(realFilePath, grant.realDirectoryPath) ||
    !isSupportedLocalPreviewAssetPath(realFilePath)
  ) {
    return null;
  }

  const ancestorDirectoryIdentities = await captureAncestorDirectoryIdentities({
    rootPath: grant.realDirectoryPath,
    filePath: realFilePath,
    expectedRootIdentity: grant.directoryIdentity,
  });
  if (
    !ancestorDirectoryIdentities ||
    !hasSameDirectoryIdentityChain(initialAncestorDirectoryIdentities, ancestorDirectoryIdentities)
  ) {
    return null;
  }

  const confirmedRealFilePath = await realpathOrNull(candidatePath);
  if (!confirmedRealFilePath || !isSameCanonicalPath(confirmedRealFilePath, realFilePath)) {
    return null;
  }

  const stat = await fs.lstat(confirmedRealFilePath, { bigint: true }).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }
  return {
    path: realFilePath,
    fileName: path.basename(realFilePath),
    sizeBytes: Number(stat.size),
    fileIdentity: {
      device: stat.dev,
      inode: stat.ino,
    },
    ancestorDirectoryIdentities,
    purpose: grant.purpose,
  };
}

/**
 * Opens a previously validated preview path and binds all response reads to that
 * descriptor. The identity check rejects a final-path replacement between
 * validation and open; streaming the same handle prevents a later replacement
 * from changing the bytes served.
 *
 * Directory capabilities additionally bind their canonical ancestor identities
 * before open, then revalidate the chain, canonical path, and final file identity
 * against the open descriptor. This catches a one-way ancestor replacement while
 * keeping the bytes bound to the descriptor selected by these checks.
 *
 * Portable Node does not expose descriptor-relative traversal (`openat`) or a
 * Windows final-path-by-handle API. A coordinated same-user process that can
 * toggle filesystem entries between every check is therefore outside this
 * boundary; sandboxed preview content itself has no filesystem mutation ability.
 */
export async function openResolvedLocalPreviewFile<T extends ResolvedLocalPreviewFile>(
  resolved: T,
): Promise<OpenedLocalPreviewFile<T> | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const noFollowFlag = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    handle = await fs.open(resolved.path, fsConstants.O_RDONLY | noFollowFlag);
    const descriptorStat = await handle.stat({ bigint: true });
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== resolved.fileIdentity.device ||
      descriptorStat.ino !== resolved.fileIdentity.inode
    ) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      return null;
    }

    if (resolved.ancestorDirectoryIdentities) {
      const expectedRoot = resolved.ancestorDirectoryIdentities[0];
      if (!expectedRoot) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        return null;
      }
      const confirmedAncestors = await captureAncestorDirectoryIdentities({
        rootPath: expectedRoot.path,
        filePath: resolved.path,
        expectedRootIdentity: expectedRoot,
      });
      const confirmedRealPath = await realpathOrNull(resolved.path);
      const confirmedPathStat = confirmedRealPath
        ? await fs.lstat(confirmedRealPath, { bigint: true }).catch(() => null)
        : null;
      if (
        !confirmedAncestors ||
        !hasSameDirectoryIdentityChain(resolved.ancestorDirectoryIdentities, confirmedAncestors) ||
        !confirmedRealPath ||
        !isSameCanonicalPath(confirmedRealPath, resolved.path) ||
        !confirmedPathStat?.isFile() ||
        confirmedPathStat.dev !== descriptorStat.dev ||
        confirmedPathStat.ino !== descriptorStat.ino
      ) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        return null;
      }
    }

    const readable = handle.createReadStream({ autoClose: true });
    handle = undefined;
    return {
      ...resolved,
      sizeBytes: Number(descriptorStat.size),
      readable,
    };
  } catch {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    return null;
  }
}

async function createExactFilePreviewGrant(input: {
  readonly requestedPath: string;
  readonly ownerKey: string;
  readonly nowMs: number;
}): Promise<LocalPreviewGrantResult> {
  const requestedPath = input.requestedPath.trim();
  if (!requestedPath || requestedPath.includes("\0") || !path.isAbsolute(requestedPath)) {
    throw new Error("Only absolute local files can be granted.");
  }

  const realFilePath = await realpathOrNull(path.resolve(requestedPath));
  if (!realFilePath) {
    throw new Error("Preview file not found.");
  }
  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("Preview path is not a file.");
  }

  return storeLocalPreviewGrant(
    { kind: "file", ownerKey: input.ownerKey, realFilePath },
    input.nowMs,
  );
}

async function createDirectoryPreviewGrant(input: {
  readonly requestedPath: string;
  readonly ownerKey: string;
  readonly cwd?: string;
  readonly allowedWorkspaceRoots: ReadonlyArray<string>;
  readonly purpose?: LocalPreviewGrantPurpose;
  readonly nowMs: number;
}): Promise<LocalPreviewGrantResult> {
  if (!input.purpose) {
    throw new LocalPreviewGrantError(
      "purpose-required",
      "Directory preview grants require an explicit purpose.",
    );
  }

  const requestedPath = input.requestedPath.trim();
  const cwd = input.cwd?.trim();
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new LocalPreviewGrantError("invalid-path", "Preview entry path is invalid.");
  }
  if (isNetworkPath(requestedPath) || (cwd !== undefined && isNetworkPath(cwd))) {
    throw new LocalPreviewGrantError(
      "network-path",
      "Network paths cannot be granted for local previews.",
    );
  }
  if (!isSupportedLocalHtmlPath(requestedPath)) {
    throw new LocalPreviewGrantError(
      "unsupported-entry",
      "Directory preview entries must be HTML or HTM files.",
    );
  }
  if (!path.isAbsolute(requestedPath) && !cwd) {
    throw new LocalPreviewGrantError(
      "cwd-required",
      "Relative preview entry paths require an active workspace directory.",
    );
  }

  const scratchRoots = await scratchWorkspaceRoots();
  const allowedRoots = await canonicalAllowedWorkspaceRoots(input.allowedWorkspaceRoots);
  let canonicalCwd: string | null = null;
  if (cwd !== undefined) {
    if (!path.isAbsolute(cwd)) {
      throw new LocalPreviewGrantError(
        "workspace-not-found",
        "Active workspace directory was not found.",
      );
    }
    canonicalCwd = await realDirectoryPathOrNull(cwd);
    if (!canonicalCwd) {
      throw new LocalPreviewGrantError(
        "workspace-not-found",
        "Active workspace directory was not found.",
      );
    }
    const isKnownWorkspace = allowedRoots.some((root) =>
      isPathInside(canonicalCwd as string, root),
    );
    const isScratchWorkspace = scratchRoots.some((root) =>
      isPathInside(canonicalCwd as string, root),
    );
    if (!isKnownWorkspace && !isScratchWorkspace) {
      throw new LocalPreviewGrantError(
        "untrusted-workspace",
        "Active workspace directory is not a known project, worktree, or scratch root.",
      );
    }
  }

  const resolvedRequestedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(canonicalCwd as string, requestedPath);
  const realFilePath = await realpathOrNull(resolvedRequestedPath);
  if (!realFilePath) {
    throw new LocalPreviewGrantError("not-found", "Preview entry file was not found.");
  }

  const realRequestedParent = await realpathOrNull(path.dirname(resolvedRequestedPath));
  const lexicalFilePath = realRequestedParent
    ? path.join(realRequestedParent, path.basename(resolvedRequestedPath))
    : resolvedRequestedPath;
  const eligibleRoots = canonicalCwd === null ? [...allowedRoots, ...scratchRoots] : [canonicalCwd];
  const lexicalRoot = eligibleRoots.find((root) => isPathInside(lexicalFilePath, root));
  if (!lexicalRoot) {
    throw new LocalPreviewGrantError(
      "outside-root",
      "Preview entry is outside the active workspace and approved scratch roots.",
    );
  }
  if (!isPathInside(realFilePath, lexicalRoot)) {
    throw new LocalPreviewGrantError(
      "symlink-escape",
      "Preview entry symlink resolves outside its allowed root.",
    );
  }
  if (!isSupportedLocalHtmlPath(realFilePath)) {
    throw new LocalPreviewGrantError(
      "unsupported-entry",
      "Directory preview entries must resolve to HTML or HTM files.",
    );
  }

  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new LocalPreviewGrantError("not-file", "Preview entry path is not a regular file.");
  }

  const realDirectoryPath = path.dirname(realFilePath);
  const directoryIdentity = await readDirectoryIdentity(realDirectoryPath);
  if (!directoryIdentity) {
    throw new LocalPreviewGrantError(
      "symlink-escape",
      "Preview directory identity changed while the grant was being created.",
    );
  }
  const result = storeLocalPreviewGrant(
    {
      kind: "directory",
      ownerKey: input.ownerKey,
      realDirectoryPath,
      directoryIdentity,
      entryRealPath: realFilePath,
      purpose: input.purpose,
    },
    input.nowMs,
  );
  const encodedEntryPath = encodeUrlPathSegment(path.basename(realFilePath));
  return {
    ...result,
    urlPath: `${LOCAL_PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(result.grant)}/${encodedEntryPath}`,
  };
}

export async function createLocalPreviewGrant(input: {
  readonly requestedPath: string;
  /** Server-derived admission bucket only; the random grant remains the bearer capability. */
  readonly ownerKey?: string;
  readonly cwd?: string;
  readonly allowedWorkspaceRoots?: ReadonlyArray<string>;
  readonly scope?: "file" | "directory";
  readonly purpose?: LocalPreviewGrantPurpose;
  readonly nowMs?: number;
}): Promise<LocalPreviewGrantResult> {
  const nowMs = input.nowMs ?? Date.now();
  const ownerKey = input.ownerKey?.trim() || DEFAULT_LOCAL_PREVIEW_GRANT_OWNER_KEY;
  if (input.scope !== "directory") {
    return createExactFilePreviewGrant({ requestedPath: input.requestedPath, ownerKey, nowMs });
  }
  return createDirectoryPreviewGrant({
    requestedPath: input.requestedPath,
    ownerKey,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    allowedWorkspaceRoots: input.allowedWorkspaceRoots ?? [],
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    nowMs,
  });
}
