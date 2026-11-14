import { type KeptInPage, UnsavedDialog, useDraftBlocker } from "@odentia/ui-patterns"
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

/**
 * El formulario conserva sus valores; el guard solo retiene el destino pendiente.
 * Con `keptInPage` solo pregunta al ir a otra ruta (`useDraftBlocker`).
 */
export function usePageDraftGuard(
  dirty: boolean,
  options: {
    keptInPage?: KeptInPage | null
    /** Qué se pierde de verdad, si quien avisa lo sabe (el panel lateral con lo que se guarda solo). */
    lost?: string | null
    /** Antes de salir con «Descartar y salir»: lo descartado ya no se guarda al cerrarse. */
    onDiscard?: () => void
  } = {},
) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const [leave, setLeave] = useState<(() => void) | null>(null)
  const editedField = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(false)
  const blocker = useDraftBlocker({
    disabled: !dirty,
    enableBeforeUnload: false,
    shouldBlockFn: () => dirtyRef.current,
    keptInPage: options.keptInPage,
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
      // La misma pregunta que al cerrar el panel con × o Escape (`UnsavedDialog`): dice lo que se pierde.
      <UnsavedDialog
        open={blocker.status === "blocked" || leave !== null}
        lost={options.lost}
        onStay={cancel}
        finalFocus={() => {
          const target = restoreFocus.current && editedField.current?.isConnected ? editedField.current : false
          restoreFocus.current = false
          return target
        }}
        onDiscard={() => {
          restoreFocus.current = false
          const action = leave
          setLeave(null)
          options.onDiscard?.()
          if (blocker.status === "blocked") blocker.proceed()
          else action?.()
        }}
      />
    ),
  }
}

export function PageDraftGuard({
  dirty,
  keptInPage,
  lost,
  onDiscard,
}: {
  dirty: boolean
  keptInPage?: KeptInPage | null
  lost?: string | null
  onDiscard?: () => void
}) {
  return usePageDraftGuard(dirty, { keptInPage, lost, onDiscard }).dialog
}
