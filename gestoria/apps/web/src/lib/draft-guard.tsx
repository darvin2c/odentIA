import { UnsavedDialog, useDraftBlocker } from "@odentia/ui-patterns"
import { useEffect, useRef } from "react"

/**
 * El aviso de borrador de la columna lateral (`SideDockProvider`): con algo escrito en el
 * formulario de la columna, salir por el menú o cerrar la pestaña pregunta lo mismo que × y
 * Escape (`UnsavedDialog`). Es el pegamento de la app con el router; el diálogo es el común.
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
