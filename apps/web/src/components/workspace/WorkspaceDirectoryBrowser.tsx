// FILE: WorkspaceDirectoryBrowser.tsx
// Purpose: Compact server-filesystem directory chooser for non-Electron workspace dialogs.
// Layer: Workspace dashboard UI
// Exports: WorkspaceDirectoryBrowser

import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { FolderClosed } from "~/components/FolderClosed";
import { ArrowUpIcon, LoaderCircleIcon } from "~/lib/icons";
import { expandLocalFolderPath } from "~/lib/localFolderMentions";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  normalizeProjectPathForDispatch,
} from "~/lib/projectPaths";
import { ensureNativeApi } from "~/nativeApi";

export function WorkspaceDirectoryBrowser({
  value,
  homeDir,
  onChange,
  onChoose,
}: {
  value: string;
  homeDir: string | null;
  onChange: (value: string) => void;
  onChoose: (value: string) => void;
}) {
  const browseDirectory = getBrowseDirectoryPath(value);
  const expandedDirectory = expandLocalFolderPath(browseDirectory, homeDir);
  const leaf = hasTrailingPathSeparator(value) ? "" : getBrowseLeafPathSegment(value);
  const browseQuery = useQuery({
    queryKey: ["workspace-directory-browser", expandedDirectory],
    queryFn: () => ensureNativeApi().filesystem.browse({ partialPath: expandedDirectory }),
    enabled: expandedDirectory.length > 0,
    staleTime: 5_000,
  });
  const entries = (browseQuery.data?.entries ?? []).filter(
    (entry) =>
      entry.name.toLocaleLowerCase().startsWith(leaf.toLocaleLowerCase()) &&
      (leaf.startsWith(".") || !entry.name.startsWith(".")),
  );
  const parent = getBrowseParentPath(value);
  const currentDirectory = normalizeProjectPathForDispatch(
    browseQuery.data?.parentPath ?? expandedDirectory,
  );

  return (
    <div
      className="mt-2 overflow-hidden rounded-lg border border-border bg-popover"
      aria-label="Browse server folders"
    >
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Go to parent folder"
          disabled={!canNavigateUp(value) || !parent}
          onClick={() => {
            if (parent) onChange(parent);
          }}
        >
          <ArrowUpIcon />
        </Button>
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={expandedDirectory}
        >
          {expandedDirectory}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={!currentDirectory || browseQuery.isPending}
          onClick={() => onChoose(currentDirectory)}
        >
          Use this folder
        </Button>
      </div>
      <div className="max-h-44 overflow-y-auto p-1" aria-live="polite">
        {browseQuery.isPending ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <LoaderCircleIcon className="animate-spin" /> Loading folders…
          </div>
        ) : browseQuery.isError ? (
          <div className="px-2 py-3 text-xs text-destructive">
            {browseQuery.error instanceof Error
              ? browseQuery.error.message
              : "Unable to load folders."}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">No matching folders.</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.fullPath}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-secondary focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onChange(appendBrowsePathSegment(value, entry.name))}
            >
              <FolderClosed className="size-3.5 text-muted-foreground" />
              <span className="truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
