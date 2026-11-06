import { cn } from "@odentia/ui"
import type { Prescription } from "../../lib/clinical-journey"

/**
 * Lo que vio quien recetó (ADR 0143): la receta lo guarda sola, con su
 * nombre, sin pedirle nada; y el motivo, si lo dejó. Las recetas de antes solo tienen el motivo.
 */
export function PrescriptionAlertsSeen({
  prescription,
  className,
}: {
  prescription: Pick<Prescription, "alertsSeen" | "allergyOverrideReason" | "prescriberName">
  className?: string
}) {
  const alerts = prescription.alertsSeen ?? []
  if (alerts.length === 0 && !prescription.allergyOverrideReason) return null
  const who = prescription.prescriberName ?? "quien la emitió"
  return (
    <div className={cn("flex flex-col gap-0.5 text-sm text-muted-foreground", className)}>
      {alerts.length > 0 ? (
        <>
          <p>{alerts.length === 1 ? `Emitida con este aviso, visto por ${who}:` : `Emitida con estos avisos, vistos por ${who}:`}</p>
          <ul className="list-disc pl-5">
            {alerts.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}
      {prescription.allergyOverrideReason ? (
        <p>
          {alerts.length > 0 ? "Motivo" : "Recetada pese al aviso"}: {prescription.allergyOverrideReason}
        </p>
      ) : null}
    </div>
  )
}
