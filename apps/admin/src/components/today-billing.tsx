/**
 * Hoy › cobro (ADR 0030, tablero O3): las pruebas por vencer o sin saldo, con
 * lo que hicieron los agentes como argumento de la llamada, y las clínicas
 * con margen bajo dos meses seguidos. Solo la administración las ve.
 */
import { Button } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api } from "../lib/api"

interface TrialRow {
  organizationId: string
  organizationName: string
  state: "en_pausa" | "sin_saldo" | "por_vencer"
  creditLeftCents: number | null
  currency: string | null
  daysLeft: number | null
  did: { conversacion: number; consulta: number; cita: number }
  sellerName: string | null
}

interface MarginRow {
  organizationId: string
  organizationName: string
  currency: string
  months: Array<{ label: string; revenueCents: number; costCents: number; marginPct: number }>
}

const money = (cents: number, currency: string) => new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100)

function left(row: TrialRow): string {
  if (row.state === "en_pausa") return "En pausa: se le acabó el saldo"
  const parts: string[] = []
  if (row.creditLeftCents !== null && row.currency) parts.push(money(row.creditLeftCents, row.currency))
  if (row.daysLeft !== null) parts.push(`${Math.max(row.daysLeft, 0)} días`)
  return parts.join(" · ")
}

export function TodayBilling() {
  const trials = useQuery({
    queryKey: ["admin", "billing", "trial-watch"],
    queryFn: () => api<TrialRow[]>("/api/admin/billing/trial-watch"),
    retry: false,
  })
  const margin = useQuery({
    queryKey: ["admin", "billing", "low-margin"],
    queryFn: () => api<MarginRow[]>("/api/admin/billing/low-margin"),
    retry: false,
  })
  // Soporte no ve importes: sin acceso, la sección no aparece.
  return (
    <>
      {trials.data && trials.data.length > 0 ? (
        <section aria-labelledby="pruebas" className="flex flex-col gap-2">
          <h2 id="pruebas" className="text-base font-semibold">
            Pruebas por vencer o sin saldo
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {trials.data.map((row) => (
              <li key={row.organizationId} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium">{row.organizationName}</p>
                  <p className="text-muted-foreground">
                    Le queda: {left(row)} · {row.did.conversacion} conversaciones, {row.did.consulta} consultas
                    {row.did.cita ? `, ${row.did.cita} citas` : ""}
                    {row.sellerName ? ` · ${row.sellerName}` : ""}
                  </p>
                </div>
                <Button size="sm" variant={row.state === "en_pausa" ? "default" : "outline"} render={<Link to="/organizations" search={{ org: row.organizationId }} />}>
                  Llamar
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {margin.data && margin.data.length > 0 ? (
        <section aria-labelledby="margen" className="flex flex-col gap-2">
          <h2 id="margen" className="text-base font-semibold">
            Margen bajo dos meses seguidos
          </h2>
          <p className="text-sm text-muted-foreground">Menos de 50 %: revisa el plan, un uso fuera de lo normal o el precio negociado.</p>
          <ul className="divide-y rounded-xl border bg-card">
            {margin.data.map((row) => (
              <li key={row.organizationId} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium">{row.organizationName}</p>
                  <p className="text-muted-foreground">
                    {row.months
                      .map((month) => `${month.label}: cobrado ${money(month.revenueCents, row.currency)}, costo real ${money(month.costCents, row.currency)}, ${month.marginPct} %`)
                      .join(" · ")}
                  </p>
                </div>
                <Button size="sm" variant="outline" render={<Link to="/organizations" search={{ org: row.organizationId }} />}>
                  Ver ficha
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
