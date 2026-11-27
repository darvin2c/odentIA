import { UnsavedDialog, useDraftBlocker } from "@odentia/ui-patterns"
import { useEffect, useRef } from "react"

/**
 * «¿Salir sin guardar?» para lo que se abre en la columna lateral del armazón (un formulario de
 * la cuenta, la Ayuda): ahí no es modal y se puede navegar con algo escrito. El mismo diálogo
 * (`UnsavedDialog`) que en las clínicas y en el panel de la cuenta.
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
