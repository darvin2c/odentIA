import { common } from "./common.js";
import { Skeleton, Spinner, cn } from "@odentia/ui";
import { Marker, MarkerContent } from "./marker.js";

export interface LoadingStateProps {
  message?: string;
  className?: string;
}

export interface DataRefreshMarkerProps {
  message?: string;
  className?: string;
}

export function LoadingState({ message = common.states.loading, className }: LoadingStateProps) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-surface p-8 text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Spinner className="size-4" />
      <span className="text-sm text-muted-foreground">{message}</span>
      <div className="w-full max-w-sm space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

export function DataRefreshMarker({
  message = common.states.refreshing,
  className,
}: DataRefreshMarkerProps) {
  return (
    <Marker
      role="status"
      className={cn(
        "pointer-events-none w-fit select-none rounded-full border border-border bg-surface px-3 py-1.5",
        className,
      )}
    >
      <MarkerContent className="shimmer shimmer-color-accent/60 motion-reduce:shimmer-none text-xs font-medium text-muted-foreground">
        {message}
      </MarkerContent>
    </Marker>
  );
}
