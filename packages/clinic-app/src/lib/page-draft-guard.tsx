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
import { useDraftBlocker } from "@odentia/ui-patterns"
import { useEffect, useRef, useState } from "react"

/** Compara valores de formulario, no metadatos de interacción ni orden de claves. */
export function sameDraft(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameDraft(a[key], b[key]))
}

/** El formulario conserva sus valores; el guard solo retiene el destino pendiente. */
export function usePageDraftGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const [leave, setLeave] = useState<(() => void) | null>(null)
  const editedField = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(false)
  const blocker = useDraftBlocker({
    disabled: !dirty,
    enableBeforeUnload: false,
    shouldBlockFn: () => dirtyRef.current,
  })

  useEffect(() => {
    const rememberField = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable=true], [role=combobox], [role=checkbox]")) {
        editedField.current = target
      }
    }
    document.addEventListener("focusin", rememberField)
    return () => document.removeEventListener("focusin", rememberField)
  }, [])

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [dirty])

  const cancel = () => {
    restoreFocus.current = true
    setLeave(null)
    if (blocker.status === "blocked") blocker.reset()
  }

  return {
    requestLeave(action: () => void) {
      if (dirtyRef.current) setLeave(() => action)
      else action()
    },
    dialog: (
      <AlertDialog open={blocker.status === "blocked" || leave !== null} onOpenChange={(open) => { if (!open) cancel() }}>
        <AlertDialogContent size="sm" finalFocus={() => {
          const target = restoreFocus.current && editedField.current?.isConnected ? editedField.current : false
          restoreFocus.current = false
          return target
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Salir sin guardar los cambios</AlertDialogTitle>
            <AlertDialogDescription>Los cambios de esta página no se han guardado. Si sales, se perderán.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuar editando</AlertDialogCancel>
            <Button type="button" onClick={() => {
              restoreFocus.current = false
              const action = leave
              setLeave(null)
              if (blocker.status === "blocked") blocker.proceed()
              else action?.()
            }}>Descartar y salir</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  }
}

export function PageDraftGuard({ dirty }: { dirty: boolean }) {
  return usePageDraftGuard(dirty).dialog
}
