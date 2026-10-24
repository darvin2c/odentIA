import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { lastPatientSection } from "../../lib/people"

/**
 * Miga `Pacientes > {paciente} > Atención`, debajo del nombre en la cabecera de la
 * atención (fila de contexto, como en Recepción del agente). El enlace a su página
 * vuelve a la pestaña donde estaba quien abrió la atención; si no se sabe (llegó
 * desde la Agenda o Inicio), a la que su página abre por su rol.
 */
export function EncounterBreadcrumb({ patientId, patientName }: { patientId: string; patientName?: string }) {
  const back = lastPatientSection(patientId)
  return (
    <div className="min-w-0 basis-full">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/people" />}>Pacientes</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink
              render={<Link to="/patients/$patientId" params={{ patientId }} search={back ? { tab: back } : {}} />}
            >
              {patientName ?? "…"}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Atención</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  )
}
