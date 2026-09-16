import { Alert, AlertDescription, AlertTitle, Button, cn } from "@odentia/ui"
import { common } from "./common.js"

export interface ApiErrorShape {
  code?: string
  message?: string
  request_id?: string
  details?: unknown
}

export interface ErrorStateProps {
  title?: string
  message?: string
  code?: string
  requestId?: string
  details?: unknown
  error?: ApiErrorShape | Error | string | null
  onRetry?: () => void
  retryLabel?: string
  className?: string
}

function resolveErrorShape(err: ErrorStateProps["error"]): ApiErrorShape {
  if (!err) return {}
  if (typeof err === "string") return { message: err }
  if (err instanceof Error) return { message: err.message }
  return err as ApiErrorShape
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
  const normalized = resolveErrorShape(error)
  const displayMessage = message ?? normalized.message ?? common.errors.generic
  const displayCode = code ?? normalized.code
  const displayRequestId = requestId ?? normalized.request_id

  return (
    <Alert
      variant="destructive"
      className={cn("justify-items-center gap-2 border-destructive/20 py-8 text-center", className)}
    >
      <AlertTitle className="text-[16px] font-semibold text-foreground">{title}</AlertTitle>
      <AlertDescription className="flex max-w-sm flex-col items-center gap-1">
        <p>{displayMessage}</p>
        {displayCode ? (
          <p className="text-xs text-muted-foreground">{`${common.labels.code}: ${displayCode}`}</p>
        ) : null}
        {displayRequestId ? (
          <p className="text-xs text-muted-foreground">{`${common.labels.requestId}: ${displayRequestId}`}</p>
        ) : null}
      </AlertDescription>
      {onRetry ? (
        <Button type="button" variant="default" onClick={onRetry} className="mt-2">
          {retryLabel}
        </Button>
      ) : null}
    </Alert>
  )
}
