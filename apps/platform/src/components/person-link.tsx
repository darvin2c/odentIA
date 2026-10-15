import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { usePermission } from "../lib/crm"
import type { PatientSectionId } from "../lib/patient-areas"

/**
 * El nombre de una persona que lleva a su página, la misma sea o no paciente
 * (ADR 0029). Con ficha manda la del paciente (el nombre que se muestra suele
 * ser el suyo, y quien escribe puede ser su tutor): su dirección redirige a su
 * persona. Sin ficha, la persona directamente. Sin permiso para ver a las
 * personas queda como texto. Un solo sitio para ese enlace.
 */
export function PersonLink({
  patientId,
  contactId,
  children,
  className = "font-medium text-primary hover:underline",
  search,
}: {
  patientId?: string | null
  contactId?: string | null
  children: ReactNode
  className?: string
  /** Sección de la página que se abre (`?tab=`). */
  search?: { tab?: PatientSectionId }
}) {
  const canOpen = usePermission("patients.read")
  if (canOpen && patientId) {
    return (
      <Link
        to="/patients/$patientId"
        params={{ patientId }}
        search={search ?? {}}
        className={className}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </Link>
    )
  }
  if (canOpen && contactId) {
    return (
      <Link
        to="/people/$personId"
        params={{ personId: contactId }}
        search={search ?? {}}
        className={className}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </Link>
    )
  }
  return <span className="font-medium">{children}</span>
}
