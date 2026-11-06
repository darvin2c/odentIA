import { Button } from "@odentia/ui"
import { useNewVersion } from "../lib/new-version"

/**
 * El aviso fijo de una versión nueva: dice qué pasa, que lo guardado no se pierde
 * y cómo seguir. Recargar es decisión de la persona (puede estar escribiendo).
 */
export function NewVersionNotice() {
  const stale = useNewVersion()
  if (!stale) return null
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-xl flex-wrap items-center gap-3 rounded-xl border bg-background p-3 text-sm shadow-lg"
    >
      <p className="min-w-0 flex-1">
        Hay una versión nueva. Recarga la página para seguir: lo que ya guardaste no se pierde.
      </p>
      <Button type="button" size="sm" onClick={() => window.location.reload()}>
        Recargar
      </Button>
    </div>
  )
}
