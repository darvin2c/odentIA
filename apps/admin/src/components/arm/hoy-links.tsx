import { Button, cn } from "@odentia/ui"
import type { QueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { ClientTab } from "../../lib/list-search"
import { invalidateClient } from "./client-model"

/**
 * Cómo Hoy, Kairós, Reportes y Demos abren la ficha de un cliente: su página
 * (`/clients/<id>`) en la pestaña que toca, con la pestaña en la dirección
 * (`?tab=`; las de `CLIENT_TABS`). «pagos» es solo de Administración (la ficha
 * y la API se la niegan a Soporte). El Resumen no se escribe en la dirección.
 */
export type { ClientTab }

/** La búsqueda de la ficha para abrirla en una pestaña. */
const tabSearch = (tab: ClientTab) => ({ tab: tab === "resumen" ? undefined : tab })

const linkClass =
  "font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"

/** El nombre del cliente como enlace a su ficha. */
export function ClientName({
  clientId,
  tab = "resumen",
  children,
  className,
}: {
  clientId: string
  tab?: ClientTab
  children: ReactNode
  className?: string
}) {
  return (
    <Link
      to="/clients/$clientId"
      params={{ clientId }}
      search={tabSearch(tab)}
      className={cn(linkClass, className)}
    >
      {children}
    </Link>
  )
}

/** El botón de una fila que abre la ficha en su pestaña: lleno si es urgente. */
export function OpenClientButton({
  clientId,
  tab,
  label = "Abrir ficha",
  urgent = false,
}: {
  clientId: string
  tab: ClientTab
  label?: string
  urgent?: boolean
}) {
  return (
    <Button
      size="sm"
      variant={urgent ? "default" : "outline"}
      render={<Link to="/clients/$clientId" params={{ clientId }} search={tabSearch(tab)} />}
    >
      {label}
    </Button>
  )
}

/**
 * Después de cambiar algo de un cliente (decidir lo de Kairós, dar por hecha
 * o mover una tarea, deshacer): la ficha, la lista, Kairós (Hoy y el número
 * del menú van debajo de esa clave) e Inicio de antes.
 */
export function invalidateArm(queryClient: QueryClient, clientId?: string | null): void {
  if (clientId) {
    invalidateClient(queryClient, clientId)
    return
  }
  void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] })
  void queryClient.invalidateQueries({ queryKey: ["admin", "kairos"] })
  void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
}
