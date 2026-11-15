import type { HealthAtSigning } from "@odentia/clinical"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { declaredMarkWords } from "../../lib/declared-health"
import type { PatientFull } from "../../lib/patients"

/**
 * «Lo que dijo de su salud al firmar» (auditor, 15 nov, A2): lo que seguía sin revisar cuando se
 * firmó la atención, como lo guardó el servidor. Una marca por declaración, con las palabras de la
 * franja («Lo dijo ella el 14 nov, sin revisar»), y lo que dijo, dato por dato.
 */
export function healthAtSigningLines(
  groups: readonly HealthAtSigning[],
  sex: string | null | undefined,
): Array<{ mark: string; items: string[] }> {
  return groups.map((group) => ({
    mark: declaredMarkWords(group.by, group.at, sex),
    items: group.rows.map((row) => `${row.label}: ${row.value}`),
  }))
}

/** La lista, igual en la atención firmada y en la Historia. El sexo, de la ficha ya cargada. */
export function HealthAtSigningList({ patientId, groups }: { patientId: string; groups: readonly HealthAtSigning[] }) {
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })
  return (
    <div className="flex flex-col gap-2 text-sm">
      {healthAtSigningLines(groups, patient.data?.data.patient.sex).map((group, index) => (
        <div key={`${index}-${group.mark}`} className="flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">{group.mark}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
