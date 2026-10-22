import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * La dirección vieja del chat, con el id de la conexión: un solo chat por
 * clínica (decisión 7 del pulido de la Bandeja), así que lleva a `/embed`.
 */
export const Route = createFileRoute("/embed/$connectionId")({
  beforeLoad: () => {
    throw redirect({ to: "/embed", search: {} })
  },
})
