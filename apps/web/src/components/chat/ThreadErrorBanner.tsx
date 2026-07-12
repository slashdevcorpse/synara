// FILE: ThreadErrorBanner.tsx
// Purpose: Shows dismissible thread-level runtime errors above the transcript.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner

import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  actionLabel,
  onAction,
}: {
  error: string | null;
  onDismiss?: () => void;
  actionLabel?: string;
  onAction?: () => void;
}) {
  if (!error) return null;
  return (
    <ChatColumnBannerFrame>
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        {(onAction || onDismiss) && (
          <AlertAction>
            <div className="flex items-center gap-1.5">
              {onAction && actionLabel ? (
                <Button type="button" size="sm" variant="outline" onClick={onAction}>
                  {actionLabel}
                </Button>
              ) : null}
              {onDismiss ? (
                <IconButton
                  label="Dismiss error"
                  className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
                  onClick={onDismiss}
                >
                  <XIcon className="size-3.5" />
                </IconButton>
              ) : null}
            </div>
          </AlertAction>
        )}
      </Alert>
    </ChatColumnBannerFrame>
  );
});
