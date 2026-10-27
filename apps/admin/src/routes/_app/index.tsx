import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { matchesProduct, type ProductChoice, ProductFilter, ProductMark, useOrgProducts } from "../../components/product"
import { TodayBilling } from "../../components/today-billing"

export const Route = createFileRoute("/_app/")({ component: AdminHome })
const overviewSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      description: z.string(),
      path: z.enum(["/support", "/billing", "/commissions", "/organizations", "/users", "/complaints", "/waitlist"]),
    }),
  ),
  expiring: z
    .array(
      z.object({
        organizationId: z.string(),
        organizationName: z.string(),
        kind: z.enum(["precio_especial", "condiciones"]),
        endsAt: z.string(),
        discountBps: z.number().nullable(),
      }),
    )
    .default([]),
})

const endFormat = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" })

/** «10 % negociado vence el sáb 24 oct · faltan 6 días». */
function expiringText(item: z.infer<typeof overviewSchema>["expiring"][number], now: Date): { title: string; tail: string; soon: boolean } {
  const end = new Date(item.endsAt)
  const days = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000))
  const day = endFormat.format(end).replaceAll(".", "").replace(",", "")
  const tail = days === 0 ? "vence hoy" : `faltan ${days} ${days === 1 ? "día" : "días"}`
  return item.kind === "precio_especial"
    ? { title: `Su precio negociado (${(item.discountBps ?? 0) / 100} % menos) vence el ${day}`, tail, soon: days <= 7 }
    : { title: `Sus condiciones de Fundador terminan el ${day}; después pasa al plan de lista`, tail, soon: days <= 7 }
}

function AdminHome() {
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: async () => overviewSchema.parse(await api<unknown>("/api/admin/overview")),
  })
  const pending = overview.data?.items.filter((item) => item.count > 0) ?? []
  // El filtro alcanza a lo que es de una clínica (vencimientos, pruebas, costo y margen); las colas
  // de arriba suman los dos productos.
  const [product, setProduct] = useState<ProductChoice>("todos")
  const products = useOrgProducts().data ?? {}
  const expiring = (overview.data?.expiring ?? []).filter((item) => matchesProduct(product, products[item.organizationId]))
  return (
    <PageShell className="space-y-6">
      <PageHeader title="Hoy" subtitle="Lo que necesita atención del equipo, en los dos productos." />
      <ProductFilter value={product} onChange={setProduct} />
      {overview.isPending ? (
        <LoadingState message="Consultando pendientes…" />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : pending.length === 0 ? (
        <EmptyState
          title="No hay pendientes en estas colas"
          description="Puedes consultar organizaciones y casos de soporte desde el menú."
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {pending.map((item) => (
            <li key={item.key}>
              <Link
                to={item.path}
                className="flex items-center gap-4 p-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.label}</span>
                  <span className="block text-sm text-muted-foreground">{item.description}</span>
                </span>
                <span className="text-lg font-semibold tabular-nums">{item.count}</span>
                <ArrowRight className="size-4 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {expiring.length > 0 ? (
        <section aria-labelledby="vencen-pronto" className="space-y-3">
          <h2 id="vencen-pronto" className="text-base font-semibold">
            Precios especiales que vencen pronto
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {expiring.map((item) => {
              const text = expiringText(item, new Date())
              return (
                <li key={`${item.kind}-${item.organizationId}`} className="flex flex-wrap items-center gap-3 p-4">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {item.organizationName}
                      {products[item.organizationId] ? <ProductMark product={products[item.organizationId]} /> : null}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {text.title} · <span className={text.soon ? "font-medium text-destructive" : undefined}>{text.tail}</span>
                    </span>
                  </span>
                  <Link
                    to="/organizations/$organizationId"
                    params={{ organizationId: item.organizationId }}
                    search={item.kind === "precio_especial" ? { tab: "precio" } : {}}
                    className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {item.kind === "precio_especial" ? "Renovar…" : "Ver la clínica"}
                  </Link>
                </li>
              )
            })}
          </ul>
          <p className="text-sm text-muted-foreground">
            Si no haces nada, vence: desde el día siguiente se cuenta al precio de lista y la clínica ya recibió su aviso.
          </p>
        </section>
      ) : null}
      <TodayBilling product={product} />
    </PageShell>
  )
}
