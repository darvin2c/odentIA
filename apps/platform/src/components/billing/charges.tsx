/**
 * Tus cargos (ADR 0031, fase 4): cada cargo con sus líneas, la cuota, lo que
 * pasó del crédito por agente, lo que cubrió el crédito y el impuesto. La
 * suma es exactamente lo que se vio en «Ver cada acción».
 */
import { EmptyState } from "@odentia/ui-patterns"
import { formatMicros, formatPlanMoney } from "./money"

export interface ChargeLine {
  id: string
  /** `revision`: lo que odentIA devolvió al revisar un cobro ya facturado (resta, ADR 0054). */
  kind: "cuota" | "conversacion" | "consulta" | "cita" | "devolucion" | "revision" | "credito" | "impuesto"
  description: string
  quantity: number
  unitBaseMicros: number | null
  unitPriceMicros: number | null
  amountCents: number
}

export interface ChargeWithLines {
  id: string
  planName: string
  periodStart: string
  periodEnd: string
  amountCents: number
  paidCents: number
  currency: string
  status: string
  dueAt: string | null
  lines?: ChargeLine[]
}

const STATUS_WORDS: Record<string, string> = {
  pendiente: "Por pagar",
  parcial: "Pago parcial",
  pagada: "Pagado",
  reversada: "Reversado",
  anulada: "Anulado",
}

function day(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso))
}

export function ChargesList({ charges }: { charges: ChargeWithLines[] }) {
  if (charges.length === 0) {
    return <EmptyState title="Aún no hay cargos" description="El primero sale al cerrar tu primer mes de plan, con lo que hicieron tus agentes." />
  }
  return (
    <ul className="flex flex-col gap-3">
      {charges.map((charge) => {
        const money = (cents: number) => formatPlanMoney(cents, charge.currency)
        return (
          <li key={charge.id} className="rounded-lg border">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  Del {day(charge.periodStart)} al {day(charge.periodEnd)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {STATUS_WORDS[charge.status] ?? charge.status}
                  {charge.dueAt && (charge.status === "pendiente" || charge.status === "parcial") ? ` · vence el ${day(charge.dueAt)}` : ""}
                  {charge.paidCents > 0 && charge.status !== "pagada" ? ` · pagado ${money(charge.paidCents)}` : ""}
                </p>
              </div>
              <p className="text-base font-semibold tabular-nums">{money(charge.amountCents)}</p>
            </div>
            {charge.lines?.length ? (
              <ul className="divide-y border-t text-sm">
                {charge.lines.map((line) => (
                  <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2">
                    <span className={line.kind === "credito" ? "min-w-0 flex-1 basis-60 text-muted-foreground" : "min-w-0 flex-1 basis-60"}>
                      {line.description}
                      {line.unitPriceMicros !== null && line.quantity > 1 ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {line.quantity} × {formatMicros(line.unitPriceMicros, charge.currency)}
                          {line.unitBaseMicros !== null && line.unitBaseMicros !== line.unitPriceMicros ? (
                            <>
                              {" "}
                              (base <s>{formatMicros(line.unitBaseMicros, charge.currency)}</s>)
                            </>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">{line.kind === "credito" ? "Sin cargo" : money(line.amountCents)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
