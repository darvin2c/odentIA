/**
 * Hoy › cobro (ADR 0031 y 0085, tablero O3): las pruebas por vencer o sin
 * saldo, con lo que hicieron los agentes como argumento de la llamada, y el
 * costo y margen de cada clínica con lo que hay que revisar. Solo la
 * administración las ve.
 */
import { Button } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api } from "../lib/api"
import { CostMarginOverviewSection } from "./cost-margin"
import { matchesProduct, type ProductChoice, ProductMark, useOrgProducts } from "./product"

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

const money = (cents: number, currency: string) => new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100)

function left(row: TrialRow): string {
  if (row.state === "en_pausa") return "En pausa: se le acabó el saldo"
  const parts: string[] = []
  if (row.creditLeftCents !== null && row.currency) parts.push(money(row.creditLeftCents, row.currency))
  if (row.daysLeft !== null) parts.push(`${Math.max(row.daysLeft, 0)} días`)
  return parts.join(" · ")
}

export function TodayBilling({ product = "todos" }: { product?: ProductChoice }) {
  const trials = useQuery({
    queryKey: ["admin", "billing", "trial-watch"],
    queryFn: () => api<TrialRow[]>("/api/admin/billing/trial-watch"),
    retry: false,
  })
  const products = useOrgProducts().data ?? {}
  const rows = (trials.data ?? []).filter((row) => matchesProduct(product, products[row.organizationId]))
  // Soporte no ve importes: sin acceso, la sección no aparece.
  return (
    <>
      {rows.length > 0 ? (
        <section aria-labelledby="pruebas" className="flex flex-col gap-2">
          <h2 id="pruebas" className="text-base font-semibold">
            Pruebas por vencer o sin saldo
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {rows.map((row) => (
              <li key={row.organizationId} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {row.organizationName}
                    {products[row.organizationId] ? <ProductMark product={products[row.organizationId]} /> : null}
                  </p>
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
      {/* Costo y margen de todas las clínicas, con la alarma y la Fundadora sin uso (ADR 0085, tablero O3). */}
      <CostMarginOverviewSection product={product} />
    </>
  )
}
