import { UnsavedDialog, useDraftBlocker } from "@odentia/ui-patterns"
import { useEffect, useRef } from "react"

/**
 * Aviso de «salir sin guardar» para el formulario de la columna lateral: ahí
 * no es modal y se puede navegar con cambios pendientes. El mismo diálogo
 * (`UnsavedDialog`) que el de la app de la clínica.
 */
export function DraftGuard({ dirty }: { dirty: boolean }) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const blocker = useDraftBlocker({
    disabled: !dirty,
    enableBeforeUnload: false,
    shouldBlockFn: () => dirtyRef.current,
  })

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [dirty])

  const blocked = blocker.status === "blocked"
  // La misma pregunta que al cerrar el formulario con × o Escape.
  return (
    <UnsavedDialog
      open={blocked}
      onStay={() => {
        if (blocked) blocker.reset()
      }}
      onDiscard={() => {
        if (blocked) blocker.proceed()
      }}
    />
  )
}
