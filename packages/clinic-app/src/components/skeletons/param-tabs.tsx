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
  ...props
}: ComponentProps<typeof Tabs> & {
  /** El parámetro de la dirección que elige la pestaña. */
  param: string
  /** La pestaña que abre sin parámetro: elegirla lo quita. */
  fallback?: string
}) {
  const navigate = useNavigate()
  return (
    <Tabs
      {...props}
      onValueChange={(value) => {
        const next = String(value)
        void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, [param]: next === fallback ? undefined : next }) } as never)
      }}
    />
  )
}
