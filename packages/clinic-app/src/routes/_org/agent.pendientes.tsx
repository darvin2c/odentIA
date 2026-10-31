import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de «Esperan su sí». Lo que el agente propuso y espera el
 * sí de la persona se ve y se registra en la Bandeja, en su conversación, y en
 * el panel del agente (ADR 0117). Hay enlaces y avisos guardados con esta
 * dirección, así que lleva a la Bandeja.
 */
export const Route = createFileRoute("/_org/agent/pendientes")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", search: { conversation: undefined }, replace: true })
  },
})
