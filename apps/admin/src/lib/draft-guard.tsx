import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@odentia/ui"
import { useBlocker } from "@tanstack/react-router"
import { useEffect, useRef } from "react"

export function DraftGuard({ dirty }: { dirty: boolean }) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const blocker = useBlocker({
    disabled: !dirty,
    enableBeforeUnload: false,
    withResolver: true,
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
    <AlertDialog
      open={blocked}
      onOpenChange={(open) => {
        if (!open && blocked) blocker.reset()
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Salir sin guardar los cambios</AlertDialogTitle>
          <AlertDialogDescription>
            Los cambios de este formulario no se han guardado. Si sales, se perderán.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Continuar editando</AlertDialogCancel>
          <Button
            onClick={() => {
              if (blocked) blocker.proceed()
            }}
          >
            Descartar y salir
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
