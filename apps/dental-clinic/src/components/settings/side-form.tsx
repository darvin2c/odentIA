import { ConfirmDialog } from "@odentia/ui-patterns"
import { useCallback, useEffect, useRef, useState } from "react"

/** Lo que está abierto al lado: `null` es un registro nuevo. `opening` distingue una apertura de la siguiente. */
export interface SideFormState<T> {
  target: T | null
  opening: number
}

/**
 * El formulario de una lista de Configuración, que se abre al lado. La
 * superficie lateral no es modal —la lista sigue usable—, así que antes de
 * abrir otro registro sobre cambios sin guardar se pregunta
 * (`DiscardDraftDialog`). Cada apertura estrena formulario: se usa `opening`
 * como `key`.
 */
export function useSideForm<T>() {
  const [form, setForm] = useState<SideFormState<T> | null>(null)
  const [pending, setPending] = useState<{ target: T | null } | null>(null)
  const openings = useRef(0)
  const dirty = useRef(false)

  const show = useCallback((target: T | null) => {
    openings.current += 1
    dirty.current = false
    setForm({ target, opening: openings.current })
  }, [])

  const open = useCallback(
    (target: T | null) => {
      if (dirty.current) setPending({ target })
      else show(target)
    },
    [show],
  )

  const close = useCallback(() => {
    dirty.current = false
    setForm(null)
  }, [])

  /** El formulario abierto avisa si tiene cambios sin guardar (`useReportDirty`). */
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value
  }, [])

  return {
    form,
    open,
    close,
    setDirty,
    /** Hay una apertura esperando a que se decida qué hacer con lo escrito. */
    asking: pending !== null,
    keepEditing: useCallback(() => setPending(null), []),
    discard: useCallback(() => {
      if (pending) show(pending.target)
      setPending(null)
    }, [pending, show]),
  }
}

/** Dentro del formulario: mantiene al día si hay cambios sin guardar, y lo retira al cerrarse. */
export function useReportDirty(isDirty: boolean, report: (dirty: boolean) => void) {
  useEffect(() => {
    report(isDirty)
    return () => report(false)
  }, [isDirty, report])
}

/** La pregunta antes de reemplazar lo escrito: la misma en todas las listas. */
export function DiscardDraftDialog({
  form,
  what,
}: {
  form: { asking: boolean; keepEditing: () => void; discard: () => void }
  /** Lo que se iba a abrir, con su artículo: «otra etapa», «otro campo». */
  what: string
}) {
  return (
    <ConfirmDialog
      open={form.asking}
      onClose={form.keepEditing}
      onConfirm={form.discard}
      title="Hay cambios sin guardar"
      description={`Si abres ${what} se pierde lo que escribiste.`}
      confirmLabel="Descartar cambios"
      cancelLabel="Seguir editando"
      variant="destructive"
    />
  )
}
