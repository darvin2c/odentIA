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

/** El camino de vuelta y el texto de contexto, en la fila de contexto del encabezado. */
export function IntegrationsCrumbWithText({ current, text }: { current: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <IntegrationsCrumb current={current} />
      <p className="min-w-0">{text}</p>
    </div>
  )
}
