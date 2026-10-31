/**
 * Las pestañas de un esqueleto que viven en la dirección: se ven y responden
 * aunque la pantalla no haya llegado. Un control a la vista nunca es un control
 * muerto; lo que no pueda responder todavía va deshabilitado.
 */
import { Tabs } from "@odentia/ui"
import { useNavigate } from "@tanstack/react-router"
import type { ComponentProps } from "react"

export function ParamTabs({
  param,
  fallback,
  clear = [],
  to = ".",
  ...props
}: ComponentProps<typeof Tabs> & {
  /** El parámetro de la dirección que elige la pestaña. */
  param: string
  /** La pestaña que abre sin parámetro: elegirla lo quita. */
  fallback?: string
  /** Lo que la pantalla limpia al cambiar de pestaña: los filtros son de cada una. */
  clear?: readonly string[]
  /** Cuando la dirección de ahora no es la de estas pestañas (Comisiones dentro de Finanzas). */
  to?: string
}) {
  const navigate = useNavigate()
  return (
    <Tabs
      {...props}
      onValueChange={(value) => {
        const next = String(value)
        const cleared = Object.fromEntries(clear.map((key) => [key, undefined]))
        void navigate({ to, search: (prev: Record<string, unknown>) => ({ ...prev, ...cleared, [param]: next === fallback ? undefined : next }) } as never)
      }}
    />
  )
}
