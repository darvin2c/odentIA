import { UnsavedDialog, useDraftBlocker } from "@odentia/ui-patterns"
import { useEffect, useRef } from "react"

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
