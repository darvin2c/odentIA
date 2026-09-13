import { common } from "./common.js";
import { Button } from "@odentia/ui";

export interface ApiErrorShape {
  code?: string;
  message?: string;
  request_id?: string;
  details?: unknown;
}

export interface ErrorStateProps {
  title?: string;
  message?: string;
  code?: string;
  requestId?: string;
  details?: unknown;
  error?: ApiErrorShape | Error | string | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

function resolveErrorShape(err: ErrorStateProps["error"]): ApiErrorShape {
  if (!err) return {};
  if (typeof err === "string") return { message: err };
  if (err instanceof Error) return { message: err.message };
  return err as ApiErrorShape;
}

export function ErrorState({
  title = common.states.error,
  message,
  code,
  requestId,
  error,
  onRetry,
  retryLabel = common.actions.retry,
  className,
}: ErrorStateProps) {
  const normalized = resolveErrorShape(error);
  const displayMessage = message ?? normalized.message ?? common.errors.generic;
  const displayCode = code ?? normalized.code;
  const displayRequestId = requestId ?? normalized.request_id;

  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-danger/20 bg-danger-soft p-8 text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="alert"
    >
      <div
        className="flex size-10 items-center justify-center rounded-full bg-surface text-danger"
        aria-hidden
      >
        <span className="text-lg">!</span>
      </div>
      <h3 className="text-[16px] font-semibold text-foreground">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{displayMessage}</p>
      {displayCode ? (
        <p className="text-xs text-muted-foreground">{`${common.labels.code}: ${displayCode}`}</p>
      ) : null}
      {displayRequestId ? (
        <p className="text-xs text-muted-foreground">{`${common.labels.requestId}: ${displayRequestId}`}</p>
      ) : null}
      {onRetry ? (
        <Button type="button" variant="default" onClick={onRetry} className="mt-2">
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
