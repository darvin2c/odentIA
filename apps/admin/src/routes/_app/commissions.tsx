/**
 * Comisiones de vendedores (admin): pendientes por liquidar, liquidación
 * mensual con resumen por correo y anulación trazable.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, Input, Label } from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  PageHeader,
  PageShell,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { requireAdminRole } from "../../lib/session"
import { Plus } from "lucide-react"
import { useState } from "react"
import {
  CommissionsPageSkeleton,
  PendingCommissionsSkeleton,
  SellersSkeleton,
  SettlementsSkeleton,
} from "../../components/skeletons/commissions"
import { ApiError, api } from "../../lib/api"

export const Route = createFileRoute("/_app/commissions")({
  beforeLoad: requireAdminRole,
  pendingComponent: CommissionsPageSkeleton,
  component: CommissionsPage,
})

const LOCALE = "es-PE"

interface Seller {
  id: string
  userId: string | null
  displayName: string
  rateBps: number
  windowDays: number
  isActive: boolean
}

interface PendingCommission {
  id: string
  organizationId: string
  organizationName: string | null
  baseCents: number
  commissionCents: number
  currency: string
  rateBps: number
  occurredAt: string
}

interface Settlement {
  id: string
  sellerId: string
  periodYear: number
  periodMonth: number
  currency: string
  grossCents: number
  adjustmentCents: number
  totalCents: number
  settledAt: string | null
  lineCount: number
}

function money(cents: number, currency: string): string {
  try {
    return formatMoney(cents, currency, LOCALE)
  } catch {
    return `${cents} ${currency}`
  }
}

function percent(rateBps: number): string {
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(rateBps / 100)} %`
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? `Error ${error.status}`
  return "Error inesperado"
}

function CommissionsPage() {
  const queryClient = useQueryClient()
  const [sellerDrawer, setSellerDrawer] = useState<null | { seller?: Seller }>(null)
  const [settleDrawer, setSettleDrawer] = useState<null | { seller: Seller }>(null)
  const [voidTarget, setVoidTarget] = useState<Settlement | null>(null)
  const [voidReason, setVoidReason] = useState("")

  const sellers = useQuery({
    queryKey: ["admin", "commissions", "sellers"],
    queryFn: () => api<Seller[]>("/api/admin/billing/sellers?includeInactive=1"),
  })
  const pending = useQuery({
    queryKey: ["admin", "commissions", "pending"],
    queryFn: () => api<PendingCommission[]>("/api/admin/billing/commissions/pending"),
  })
  const settlements = useQuery({
    queryKey: ["admin", "commissions", "settlements"],
    queryFn: () => api<Settlement[]>("/api/admin/billing/settlements?limit=50"),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "commissions"] })
  }

  const voidSettlement = useMutation({
    mutationFn: () => {
      if (!voidTarget) throw new Error("Sin liquidación")
      return api(`/api/admin/billing/settlements/${voidTarget.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason }),
      })
    },
    onSuccess: () => {
      setVoidTarget(null)
      setVoidReason("")
      refresh()
    },
  })

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Comisiones"
        subtitle="Vendedores, cobros confirmados por liquidar y liquidaciones"
        primary={{ label: "Nuevo vendedor", icon: <Plus aria-hidden />, onClick: () => setSellerDrawer({}) }}
      />

      <section aria-labelledby="vendedores" className="flex flex-col gap-2">
        <h2 id="vendedores" className="text-base font-semibold">
          Vendedores
        </h2>
        {sellers.isPending ? (
          <SkeletonRegion message="Cargando vendedores…">
            <SellersSkeleton />
          </SkeletonRegion>
        ) : sellers.isError ? (
          <ErrorState
            title="No se pudieron cargar los vendedores"
            message={errorMessage(sellers.error)}
            onRetry={() => void sellers.refetch()}
          />
        ) : sellers.data.length === 0 ? (
          <EmptyState
            title="Sin vendedores"
            description="Registra un vendedor con su porcentaje para comisionar cobros confirmados."
            actionLabel="Nuevo vendedor"
            onAction={() => setSellerDrawer({})}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {sellers.data.map((seller) => (
              <li
                key={seller.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">
                    {seller.displayName}{" "}
                    {!seller.isActive ? (
                      <span className="text-muted-foreground">(inactivo)</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {percent(seller.rateBps)} · ventana {seller.windowDays} días
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSellerDrawer({ seller })}>
                    Editar
                  </Button>
                  <Button size="sm" onClick={() => setSettleDrawer({ seller })}>
                    Liquidar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="por-liquidar" className="flex flex-col gap-2">
        <h2 id="por-liquidar" className="text-base font-semibold">
          Por liquidar
        </h2>
        {pending.isPending ? (
          <SkeletonRegion message="Cargando comisiones…">
            <PendingCommissionsSkeleton />
          </SkeletonRegion>
        ) : pending.isError ? (
          <ErrorState
            title="No se pudieron cargar las comisiones"
            message={errorMessage(pending.error)}
            onRetry={() => void pending.refetch()}
          />
        ) : pending.data.length === 0 ? (
          <EmptyState
            title="Nada por liquidar"
            description="Las comisiones nacen al confirmar un cobro (nunca de demos)."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.data.map((commission) => (
              <li
                key={commission.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">
                    {commission.organizationName ?? commission.organizationId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Base {money(commission.baseCents, commission.currency)} ·{" "}
                    {percent(commission.rateBps)} (congelado)
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {money(commission.commissionCents, commission.currency)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="liquidaciones" className="flex flex-col gap-2">
        <h2 id="liquidaciones" className="text-base font-semibold">
          Liquidaciones
        </h2>
        {settlements.isPending ? (
          <SkeletonRegion message="Cargando liquidaciones…">
            <SettlementsSkeleton />
          </SkeletonRegion>
        ) : settlements.isError ? (
          <ErrorState
            title="No se pudieron cargar las liquidaciones"
            message={errorMessage(settlements.error)}
            onRetry={() => void settlements.refetch()}
          />
        ) : settlements.data.length === 0 ? (
          <EmptyState title="Sin liquidaciones" description="Aún no se liquidó ningún mes." />
        ) : (
          <ul className="flex flex-col gap-2">
            {settlements.data.map((settlement) => (
              <li
                key={settlement.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">
                    {settlement.periodYear}-{String(settlement.periodMonth).padStart(2, "0")} ·{" "}
                    {settlement.lineCount} líneas
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Cobros {money(settlement.grossCents, settlement.currency)}
                    {settlement.adjustmentCents > 0
                      ? ` · ajustes −${money(settlement.adjustmentCents, settlement.currency)}`
                      : ""}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {money(settlement.totalCents, settlement.currency)}
                </p>
                <Button size="sm" variant="ghost" onClick={() => setVoidTarget(settlement)}>
                  Anular
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sellerDrawer ? (
        <SellerDrawer
          seller={sellerDrawer.seller}
          onClose={() => setSellerDrawer(null)}
          onSaved={refresh}
        />
      ) : null}
      {settleDrawer ? (
        <SettleDrawer
          seller={settleDrawer.seller}
          onClose={() => setSettleDrawer(null)}
          onSaved={refresh}
        />
      ) : null}
      <ConfirmDialog
        open={voidTarget !== null}
        title="Anular liquidación"
        description="Las comisiones vuelven a quedar por liquidar y los ajustes a quedar por aplicar. Las líneas originales se conservan (no se borran)."
        confirmLabel="Anular"
        onConfirm={() => voidSettlement.mutate()}
        onClose={() => {
          setVoidTarget(null)
          setVoidReason("")
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="void-reason">Motivo</Label>
          <Input
            id="void-reason"
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
            placeholder="Por qué se anula"
          />
        </div>
      </ConfirmDialog>
    </PageShell>
  )
}

function SellerDrawer({
  seller,
  onClose,
  onSaved,
}: {
  seller?: Seller
  onClose: () => void
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = useState(seller?.displayName ?? "")
  const [rate, setRate] = useState(seller ? String(seller.rateBps / 100) : "")
  const [windowDays, setWindowDays] = useState(seller ? String(seller.windowDays) : "90")
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const rateBps = Math.round(Number(rate) * 100)
      if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
        throw new Error("Porcentaje inválido (0–100)")
      }
      return api("/api/admin/billing/sellers", {
        method: "PUT",
        body: JSON.stringify({
          userId: seller?.userId ?? null,
          displayName: displayName.trim(),
          rateBps,
          windowDays: Number(windowDays),
        }),
      })
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar") : "No se pudo guardar",
      ),
  })

  return (
    <FormDrawer
      open
      title={seller ? "Editar vendedor" : "Nuevo vendedor"}
      submitLabel="Guardar"
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
    >
      <p className="text-sm text-muted-foreground">
        El porcentaje y la ventana se congelan por cobro al confirmar; cambiarlos no toca lo ya
        liquidado.
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="seller-name">Nombre</Label>
        <Input
          id="seller-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="seller-rate">Porcentaje (0–100)</Label>
          <Input
            id="seller-rate"
            inputMode="decimal"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="seller-window">Ventana (días)</Label>
          <Input
            id="seller-window"
            inputMode="numeric"
            value={windowDays}
            onChange={(event) => setWindowDays(event.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </FormDrawer>
  )
}

function SettleDrawer({
  seller,
  onClose,
  onSaved,
}: {
  seller: Seller
  onClose: () => void
  onSaved: () => void
}) {
  const now = new Date()
  const [year, setYear] = useState(String(now.getUTCFullYear()))
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1))
  const [currency, setCurrency] = useState("PEN")
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api("/api/admin/billing/settlements", {
        method: "POST",
        body: JSON.stringify({
          sellerId: seller.id,
          year: Number(year),
          month: Number(month),
          currency,
        }),
      }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo liquidar") : "No se pudo liquidar",
      ),
  })

  return (
    <FormDrawer
      open
      title={`Liquidar a ${seller.displayName}`}
      submitLabel="Liquidar y avisar por correo"
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
    >
      <p className="text-sm text-muted-foreground">
        Congela las comisiones pendientes del mes y los ajustes por reversos. Se envía un resumen
        por correo una sola vez.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="settle-year">Año</Label>
          <Input
            id="settle-year"
            inputMode="numeric"
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="settle-month">Mes</Label>
          <Input
            id="settle-month"
            inputMode="numeric"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="settle-currency">Moneda</Label>
          <Input
            id="settle-currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </FormDrawer>
  )
}
