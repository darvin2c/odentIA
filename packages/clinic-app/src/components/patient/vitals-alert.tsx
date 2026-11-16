import { bloodPressureAlert, type Vitals } from "@odentia/clinical"

/**
 * La presión que pide pensar antes de lo electivo (QA del 16 nov, E5a): bajo los signos vitales,
 * en el diálogo de firmar y en la atención firmada, con el patrón de aviso de la receta. Avisa y
 * no frena: el profesional decide. Desde los 13 años (`bloodPressureAlert`, `@odentia/clinical`).
 */
export function VitalsPressureAlert({
  vitals,
  ageYears,
  id,
  className,
}: {
  vitals: Vitals | null | undefined
  ageYears: number | null | undefined
  id?: string
  className?: string
}): React.JSX.Element | null {
  const alert = bloodPressureAlert(vitals, ageYears)
  if (!alert) return null
  const [word, ...rest] = alert.split(": ")
  return (
    <p
      id={id}
      role="note"
      className={`rounded-md border border-warning/40 bg-warning/5 p-3 text-sm ${className ?? ""}`}
    >
      <span className="font-medium">{word}:</span> {rest.join(": ")}
    </p>
  )
}
