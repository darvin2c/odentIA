import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { usePermission } from "../lib/crm"
import type { PatientSectionId } from "../lib/patient-areas"

/**
 * El nombre de una persona que lleva a su página, la misma sea o no paciente
 * (ADR 0029). Con ficha manda la del paciente (el nombre que se muestra suele
 * ser el suyo, y quien escribe puede ser su tutor): su dirección redirige a su
 * persona. Sin ficha, la persona directamente: quien aún no es paciente solo
 * lo ven recepción y quien dirige (`crm.read`), así que para caja y odontología
 * queda como texto salvo que se sepa que es paciente (`isPatient`). Sin permiso
 * para ver a las personas queda como texto. Un solo sitio para ese enlace.
 */
/**
 * En tinta y no en el color de la marca: un nombre se repite fila a fila (ADR 0162). Solo,
 * en una lista o una fila, se subraya al pasar el mouse; dentro de una frase, siempre.
 */
const ON_ITS_OWN = "font-semibold text-foreground underline-offset-4 hover:underline"
const IN_TEXT =
  "font-semibold text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"

export function PersonLink({
  patientId,
  contactId,
  children,
  inText = false,
  className = inText ? IN_TEXT : ON_ITS_OWN,
  search,
  isPatient = false,
}: {
  patientId?: string | null
  contactId?: string | null
  /** La persona del contacto ya es paciente (su página la ve también quien solo ve pacientes). */
  isPatient?: boolean
  /** Va dentro de una frase («Habla por ella: Rosa»): lleva un subrayado tenue, porque el color ya no lo distingue. */
  inText?: boolean
  children: ReactNode
  className?: string
  /** Sección de la página que se abre (`?tab=`). */
  search?: { tab?: PatientSectionId }
}) {
  const canOpen = usePermission("patients.read")
  const seesNonPatients = usePermission("crm.read")
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
  if (canOpen && contactId && (seesNonPatients || isPatient)) {
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
  return <span className="font-semibold">{children}</span>
}
