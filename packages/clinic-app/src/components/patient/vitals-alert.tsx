import { bloodPressureAlert, type Vitals, weightForAgeAlert } from "@odentia/clinical"

/**
 * La presión que pide pensar antes de lo electivo, y el peso imposible para su edad (QA del 16 nov, E5a): bajo los signos vitales,
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
  // Un peso imposible para su edad («230 kg» a los 7 años): avisa antes de que la anestesia lo use
  // (mesa del 25 nov, entrega 3).
  const weight = weightForAgeAlert(vitals?.peso, ageYears)
  if (!alert && !weight) return null
  const [word, ...rest] = (alert ?? "").split(": ")
  return (
    <div id={id} role="note" className={`flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm ${className ?? ""}`}>
      {alert ? (
        <p>
          <span className="font-medium">{word}:</span> {rest.join(": ")}
        </p>
      ) : null}
      {weight ? (
        <p>
          <span className="font-medium">Peso:</span> {weight}
        </p>
      ) : null}
    </div>
  )
}
