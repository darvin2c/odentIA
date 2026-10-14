import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@odentia/ui"
import { Link } from "@tanstack/react-router"

/**
 * Camino de vuelta de una pantalla que se abre desde Integraciones (WhatsApp,
 * Chat web, Modelo del agente): en la lista de Configuración sigue marcada
 * «Integraciones», y este enlace devuelve a ella.
 */
export function IntegrationsCrumb({ current }: { current: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link to="/settings/integrations" />}>Integraciones</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
