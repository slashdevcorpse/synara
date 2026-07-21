// FILE: WorkspaceProjectDialogs.tsx
// Purpose: Accessible add-existing and clone-repository flows for the workspace dashboard.
// Layer: Workspace dashboard UI
// Exports: AddExistingProjectDialog and CloneRepositoryDialog

import type {
  ProjectId,
  WorkspaceCloneId,
  WorkspaceCloneProgressEvent,
  WorkspaceCloneRepositoryResult,
} from "@synara/contracts";
import { useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { createOrRecoverProjectFromPath } from "~/lib/projectCreation";
import { cn, randomUUID } from "~/lib/utils";
import {
  cloneWorkspaceRepository,
  getWorkspaceCloneStatus,
  retryWorkspaceCloneProjectCreation,
  subscribeWorkspaceCloneProgress,
} from "~/lib/workspaceReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { FolderOpenIcon, LoaderCircleIcon } from "~/lib/icons";
import { isElectron } from "~/env";
import { getBrowseDirectoryPath, getInitialBrowseQuery } from "~/lib/projectPaths";
import {
  defaultCloneTarget,
  githubRepositoryFromUrl,
  validateCloneInput,
} from "./workspaceDashboard.logic";
import { WorkspaceDirectoryBrowser } from "./WorkspaceDirectoryBrowser";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function pickFolder(): Promise<string | null> {
  if (!isElectron) return null;
  return ensureNativeApi().dialogs.pickFolder();
}

export function AddExistingProjectDialog({
  open,
  homeDir,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  homeDir: string | null;
  onOpenChange: (open: boolean) => void;
  onAdded: (projectId: ProjectId) => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const pathId = useId();
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);

  useEffect(() => {
    if (!open) return;
    setPath("");
    setError(null);
    setSubmitting(false);
    setBrowseOpen(false);
  }, [open]);

  const handleSubmit = async () => {
    const workspaceRoot = path.trim();
    if (!workspaceRoot) {
      setError("Enter or choose a project folder.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const result = await createOrRecoverProjectFromPath({
        api,
        workspaceRoot,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
      });
      if (result.snapshot) syncServerShellSnapshot(result.snapshot);
      if (result.restored) {
        toastManager.add({
          type: "success",
          title: "Project restored",
          description: "The original project, repository files, and chats are available again.",
        });
      }
      onOpenChange(false);
      onAdded(result.projectId);
    } catch (cause) {
      setError(errorMessage(cause, "The project could not be added."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup surface="solid">
        <DialogHeader>
          <DialogTitle>Add existing project</DialogTitle>
          <DialogDescription>
            Link a folder that already exists on the Synara server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="mb-1.5 block text-xs font-medium" htmlFor={pathId}>
            Project folder
          </label>
          <div className="flex gap-2">
            <Input
              id={pathId}
              autoFocus
              aria-describedby={error ? `${pathId}-error` : undefined}
              aria-invalid={Boolean(error)}
              placeholder="C:\\path\\to\\project"
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSubmit();
              }}
            />
            <Button
              variant="outline"
              aria-expanded={!isElectron ? browseOpen : undefined}
              onClick={() => {
                if (isElectron) {
                  void pickFolder().then((pickedPath) => {
                    if (pickedPath) setPath(pickedPath);
                  });
                  return;
                }
                if (!path.trim()) setPath(getInitialBrowseQuery(homeDir));
                setBrowseOpen((current) => !current);
              }}
            >
              <FolderOpenIcon />
              Browse
            </Button>
          </div>
          {!isElectron && browseOpen ? (
            <WorkspaceDirectoryBrowser
              value={path}
              homeDir={homeDir}
              onChange={setPath}
              onChoose={(selectedPath) => {
                setPath(selectedPath);
                setBrowseOpen(false);
              }}
            />
          ) : null}
          {error ? (
            <p className="mt-2 text-xs text-destructive" id={`${pathId}-error`} role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="px-0">
            <Button variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={submitting} onClick={() => void handleSubmit()}>
              {submitting ? <LoaderCircleIcon className="animate-spin" /> : null}
              Add project
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

type CloneDialogState =
  | { kind: "editing" }
  | {
      kind: "cloning";
      cloneId: WorkspaceCloneId;
      snapshot: WorkspaceCloneProgressEvent["snapshot"] | null;
      recoveryMessage?: string;
    }
  | {
      kind: "error";
      cloneId: WorkspaceCloneId;
      result: WorkspaceCloneRepositoryResult;
      message: string;
    }
  | { kind: "success"; result: WorkspaceCloneRepositoryResult };

const ACTIVE_CLONE_STORAGE_KEY = "synara:workspace-active-clone";
const CLONE_STATUS_POLL_INTERVAL_MS = 1_000;
const CLONE_STATUS_NOT_FOUND_MAX_ATTEMPTS = 3;

function readActiveCloneId(): WorkspaceCloneId | null {
  try {
    const value = sessionStorage.getItem(ACTIVE_CLONE_STORAGE_KEY)?.trim();
    return value ? (value as WorkspaceCloneId) : null;
  } catch {
    return null;
  }
}

function writeActiveCloneId(cloneId: WorkspaceCloneId | null): void {
  try {
    if (cloneId) sessionStorage.setItem(ACTIVE_CLONE_STORAGE_KEY, cloneId);
    else sessionStorage.removeItem(ACTIVE_CLONE_STORAGE_KEY);
  } catch {
    // Session storage can be disabled; the live clone still continues normally.
  }
}

export function hasRestorableWorkspaceClone(): boolean {
  return readActiveCloneId() !== null;
}

function terminalCloneState(
  cloneId: WorkspaceCloneId,
  result: WorkspaceCloneRepositoryResult,
): CloneDialogState {
  if (result.failure) {
    return { kind: "error", cloneId, result, message: result.failure.message };
  }
  if (result.projectId) return { kind: "success", result };
  return {
    kind: "error",
    cloneId,
    result,
    message: "The repository was cloned, but no Synara project was created.",
  };
}

export function CloneRepositoryDialog({
  open,
  homeDir,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  homeDir: string | null;
  onOpenChange: (open: boolean) => void;
  onComplete: (projectId: ProjectId) => void;
}) {
  const [url, setUrl] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [validation, setValidation] = useState<{ url: string | null; targetPath: string | null }>({
    url: null,
    targetPath: null,
  });
  const [state, setState] = useState<CloneDialogState>({ kind: "editing" });
  const [browseOpen, setBrowseOpen] = useState(false);
  const [cloneBrowsePath, setCloneBrowsePath] = useState("");
  const urlId = useId();
  const targetId = useId();
  const activeCloneId = state.kind === "cloning" ? state.cloneId : null;

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setTargetPath("");
    setValidation({ url: null, targetPath: null });
    setState({ kind: "editing" });
    setBrowseOpen(false);
    setCloneBrowsePath("");
    const cloneId = readActiveCloneId();
    if (!cloneId) return;
    setState({ kind: "cloning", cloneId, snapshot: null });
  }, [open]);

  useEffect(() => {
    if (!open || !activeCloneId) return;
    let cancelled = false;
    let terminal = false;
    let missingStatusAttempts = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: WorkspaceCloneRepositoryResult) => {
      terminal = true;
      if (pollTimer) clearTimeout(pollTimer);
      setState(terminalCloneState(activeCloneId, result));
    };
    const unsubscribe = subscribeWorkspaceCloneProgress(activeCloneId, (event) => {
      if (cancelled || terminal) return;
      if (event._tag === "clone_finished") {
        finish(event.result);
      } else {
        setState({ kind: "cloning", cloneId: activeCloneId, snapshot: event.snapshot });
      }
    });

    const poll = async (): Promise<void> => {
      try {
        const snapshot = await getWorkspaceCloneStatus(activeCloneId);
        if (cancelled || terminal) return;
        if (snapshot?.result) {
          finish(snapshot.result);
          return;
        }
        if (snapshot && (snapshot.status === "pending" || snapshot.status === "running")) {
          missingStatusAttempts = 0;
          setState({ kind: "cloning", cloneId: activeCloneId, snapshot });
        } else if (!snapshot) {
          missingStatusAttempts += 1;
          if (missingStatusAttempts >= CLONE_STATUS_NOT_FOUND_MAX_ATTEMPTS) {
            finish({
              cloneId: activeCloneId,
              clonedPath: null,
              projectId: null,
              failure: {
                stage: "clone",
                code: "WORKSPACE_CLONE_STATUS_NOT_FOUND",
                message:
                  "The clone request was not found on the server. Review the destination and try again.",
                retryable: true,
              },
            });
            return;
          }
        }
      } catch {
        // Push events may still arrive; keep polling while this clone is visible.
      }
      if (!cancelled && !terminal) {
        pollTimer = setTimeout(() => void poll(), CLONE_STATUS_POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      unsubscribe();
    };
  }, [activeCloneId, open]);

  const runClone = async () => {
    const nextValidation = validateCloneInput({ url, targetPath });
    setValidation(nextValidation);
    if (nextValidation.url || nextValidation.targetPath) return;

    const cloneId = randomUUID() as WorkspaceCloneId;
    writeActiveCloneId(cloneId);
    setState({ kind: "cloning", cloneId, snapshot: null });
    try {
      const result = await cloneWorkspaceRepository({
        cloneId,
        url: url.trim(),
        targetPath: targetPath.trim(),
        onProgress: (event) => setState({ kind: "cloning", cloneId, snapshot: event.snapshot }),
      });
      setState(terminalCloneState(cloneId, result));
    } catch (cause) {
      setState((current) =>
        current.kind === "cloning" && current.cloneId === cloneId
          ? {
              kind: "cloning",
              cloneId,
              snapshot: current.snapshot,
              recoveryMessage: `${errorMessage(
                cause,
                "The connection was interrupted.",
              )} Checking whether the clone is still running on the server…`,
            }
          : current,
      );
    }
  };

  const retry = async () => {
    if (state.kind !== "error") return;
    if (state.result.failure?.stage !== "project" || !state.result.clonedPath) {
      const nextValidation = validateCloneInput({ url, targetPath });
      if (nextValidation.url || nextValidation.targetPath) {
        setValidation(nextValidation);
        setState({ kind: "editing" });
        return;
      }
      await runClone();
      return;
    }
    const cloneId = state.cloneId;
    setState({ kind: "cloning", cloneId, snapshot: null });
    try {
      const result = await retryWorkspaceCloneProjectCreation(cloneId);
      if (result.failure || !result.projectId) {
        setState({
          kind: "error",
          cloneId,
          result,
          message: result.failure?.message ?? "The Synara project could not be created.",
        });
      } else {
        setState({ kind: "success", result });
      }
    } catch (cause) {
      setState((current) =>
        current.kind === "cloning" && current.cloneId === cloneId
          ? {
              ...current,
              recoveryMessage: `${errorMessage(
                cause,
                "The connection was interrupted.",
              )} Checking whether project setup is still running on the server…`,
            }
          : current,
      );
    }
  };

  const cloningSnapshot = state.kind === "cloning" ? state.snapshot : null;
  const progress = cloningSnapshot?.percent ?? null;
  const cloningMessage =
    cloningSnapshot?.message ??
    (state.kind === "cloning" ? state.recoveryMessage : undefined) ??
    "Starting clone…";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (state.kind !== "cloning") {
          if (!nextOpen) writeActiveCloneId(null);
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup surface="solid">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>
            Clone a GitHub repository into a new folder and add it to Synara as a project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.kind === "editing" ? (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium" htmlFor={urlId}>
                  GitHub URL
                </label>
                <Input
                  id={urlId}
                  autoFocus
                  aria-describedby={validation.url ? `${urlId}-error` : undefined}
                  aria-invalid={Boolean(validation.url)}
                  placeholder="https://github.com/owner/repository.git"
                  value={url}
                  onBlur={() => {
                    if (!targetPath.trim()) {
                      const nextTarget = defaultCloneTarget(homeDir, url);
                      if (nextTarget) {
                        setTargetPath(nextTarget);
                        setValidation((current) => ({ ...current, targetPath: null }));
                      }
                    }
                  }}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setValidation((current) => ({ ...current, url: null }));
                  }}
                />
                {validation.url ? (
                  <p className="mt-1.5 text-xs text-destructive" id={`${urlId}-error`}>
                    {validation.url}
                  </p>
                ) : null}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium" htmlFor={targetId}>
                  New destination folder
                </label>
                <div className="flex gap-2">
                  <Input
                    id={targetId}
                    aria-describedby={validation.targetPath ? `${targetId}-error` : undefined}
                    aria-invalid={Boolean(validation.targetPath)}
                    placeholder="C:\\path\\to\\repository"
                    value={targetPath}
                    onChange={(event) => {
                      setTargetPath(event.target.value);
                      setValidation((current) => ({ ...current, targetPath: null }));
                    }}
                  />
                  <Button
                    variant="outline"
                    aria-expanded={!isElectron ? browseOpen : undefined}
                    onClick={() => {
                      if (!githubRepositoryFromUrl(url)) {
                        setValidation((current) => ({
                          ...current,
                          url: "Enter a valid credential-free HTTPS or SSH GitHub repository URL.",
                        }));
                        return;
                      }
                      if (isElectron) {
                        void pickFolder().then((parentPath) => {
                          const nextTarget = parentPath ? defaultCloneTarget(parentPath, url) : "";
                          if (nextTarget) {
                            setTargetPath(nextTarget);
                            setValidation((current) => ({ ...current, targetPath: null }));
                          }
                        });
                        return;
                      }
                      setCloneBrowsePath(
                        targetPath.trim()
                          ? getBrowseDirectoryPath(targetPath.trim())
                          : getInitialBrowseQuery(homeDir),
                      );
                      setBrowseOpen((current) => !current);
                    }}
                  >
                    <FolderOpenIcon />
                    Browse
                  </Button>
                </div>
                {!isElectron && browseOpen ? (
                  <WorkspaceDirectoryBrowser
                    value={cloneBrowsePath}
                    homeDir={homeDir}
                    onChange={setCloneBrowsePath}
                    onChoose={(parentPath) => {
                      const nextTarget = defaultCloneTarget(parentPath, url);
                      if (nextTarget) {
                        setTargetPath(nextTarget);
                        setValidation((current) => ({ ...current, targetPath: null }));
                      }
                      setBrowseOpen(false);
                    }}
                  />
                ) : null}
                {validation.targetPath ? (
                  <p className="mt-1.5 text-xs text-destructive" id={`${targetId}-error`}>
                    {validation.targetPath}
                  </p>
                ) : null}
              </div>
            </div>
          ) : state.kind === "cloning" ? (
            <div className="space-y-3 py-3" aria-live="polite">
              <div className="flex items-center gap-2 text-sm font-medium">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {cloningMessage}
              </div>
              <div
                aria-label="Clone progress"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progress ?? undefined}
                className="h-2 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-primary transition-[width] duration-200",
                    progress === null && "w-1/3 animate-pulse",
                  )}
                  style={progress === null ? undefined : { width: `${progress}%` }}
                />
              </div>
            </div>
          ) : state.kind === "error" ? (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
              role="alert"
            >
              <p className="text-sm font-medium text-destructive">Clone could not finish</p>
              <p className="mt-1 text-xs text-muted-foreground">{state.message}</p>
              {state.result.clonedPath ? (
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  Files remain at {state.result.clonedPath}.
                </p>
              ) : null}
            </div>
          ) : (
            <div
              className="rounded-lg border border-success/30 bg-success/5 p-3"
              aria-live="polite"
            >
              <p className="text-sm font-medium text-success">Repository cloned</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {state.result.clonedPath}
              </p>
            </div>
          )}
          <DialogFooter className="px-0">
            {state.kind === "success" ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    writeActiveCloneId(null);
                    onOpenChange(false);
                  }}
                >
                  Stay here
                </Button>
                <Button
                  onClick={() => {
                    if (state.result.projectId) {
                      writeActiveCloneId(null);
                      onComplete(state.result.projectId);
                    }
                  }}
                >
                  Open project
                </Button>
              </>
            ) : state.kind === "error" ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    writeActiveCloneId(null);
                    onOpenChange(false);
                  }}
                >
                  Close
                </Button>
                <Button onClick={() => void retry()}>Retry</Button>
              </>
            ) : state.kind === "editing" ? (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={() => void runClone()}>Clone repository</Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
