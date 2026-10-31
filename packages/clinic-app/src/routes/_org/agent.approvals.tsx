import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de «Aprobaciones», luego «Pendientes» y «Esperan su sí».
 * Hay enlaces y avisos guardados con esta dirección: lleva a la Bandeja, donde
 * vive lo que el agente propuso (ADR 0118).
 */
export const Route = createFileRoute("/_org/agent/approvals")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", search: { conversation: undefined }, replace: true })
  },
})
