/**
 * Comisiones de vendedores (admin): pendientes por liquidar, liquidación
 * mensual con resumen por correo y anulación trazable.
 */
import { formatMoney } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  PageHeader,
  PageShell,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { requireAdminRole } from "../../lib/session"
import { Plus } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { CurrencySelect } from "../../components/billing-fields"
import { ReasonDialog } from "../../components/reason-dialog"
import { CommissionsPageSkeleton, PendingCommissionsSkeleton, SellersSkeleton, SettlementsSkeleton } from "../../components/skeletons/commissions"

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

function CommissionsPage() {
  const queryClient = useQueryClient()
  const [sellerDrawer, setSellerDrawer] = useState<null | { seller?: Seller }>(null)
  const [settleDrawer, setSettleDrawer] = useState<null | { seller: Seller }>(null)
  const [voidTarget, setVoidTarget] = useState<Settlement | null>(null)

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
    mutationFn: ({ target, reason }: { target: Settlement; reason: string }) =>
      api(`/api/admin/billing/settlements/${target.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: refresh,
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
            message={submitErrorMessage(sellers.error)}
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
            message={submitErrorMessage(pending.error)}
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
            message={submitErrorMessage(settlements.error)}
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
      <ReasonDialog
        open={voidTarget !== null}
        id="void-reason"
        title="Anular liquidación"
        description="Las comisiones vuelven a quedar por liquidar y los ajustes a quedar por aplicar. Las líneas originales se conservan (no se borran)."
        confirmLabel="Anular"
        placeholder="Por qué se anula"
        onConfirm={(reason) =>
          voidTarget ? voidSettlement.mutateAsync({ target: voidTarget, reason }) : Promise.resolve()
        }
        onClose={() => setVoidTarget(null)}
      />
    </PageShell>
  )
}

const sellerSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del vendedor")
    .max(120, "Escribe el nombre en 120 caracteres como mucho"),
  rate: z
    .string()
    .trim()
    .min(1, "Escribe el porcentaje")
    .regex(/^\d{1,3}([.,]\d{1,2})?$/, "Escribe el porcentaje con hasta dos decimales, como 10 o 12,5")
    .refine((value) => Number(value.replace(",", ".")) <= 100, "El porcentaje debe estar entre 0 y 100 %"),
  windowDays: z
    .string()
    .trim()
    .min(1, "Escribe la ventana en días")
    .regex(/^\d+$/, "Escribe la ventana en días enteros")
    .refine((value) => Number(value) <= 730, "La ventana debe estar entre 0 y 730 días"),
})

function SellerDrawer({
  seller,
  onClose,
  onSaved,
}: {
  seller?: Seller
  onClose: () => void
  onSaved: () => void
}) {
  const save = useMutation({
    mutationFn: (body: { userId: string | null; displayName: string; rateBps: number; windowDays: number }) =>
      api("/api/admin/billing/sellers", { method: "PUT", body: JSON.stringify(body) }),
  })
  const form = useAppForm({
    defaultValues: {
      displayName: seller?.displayName ?? "",
      rate: seller ? String(seller.rateBps / 100) : "",
      windowDays: seller ? String(seller.windowDays) : "90",
    },
    validators: { onSubmit: sellerSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        userId: seller?.userId ?? null,
        displayName: value.displayName.trim(),
        rateBps: Math.round(Number(value.rate.trim().replace(",", ".")) * 100),
        windowDays: Number(value.windowDays.trim()),
      })
      onSaved()
      onClose()
    },
  })

  return (
    <FormDrawer
      {...useFormSurface(form, { fieldMap: { rateBps: "rate" } })}
      open
      title={seller ? "Editar vendedor" : "Nuevo vendedor"}
      submitLabel="Guardar"
      onClose={onClose}
    >
      <p className="text-sm text-muted-foreground">
        El porcentaje y la ventana se congelan por cobro al confirmar; cambiarlos no toca lo ya
        liquidado.
      </p>
      <form.AppField name="displayName">
        {(field) => <field.TextField id="seller-name" label="Nombre" maxLength={120} />}
      </form.AppField>
      <div className="grid grid-cols-2 gap-3">
        <form.AppField name="rate">
          {(field) => <field.TextField id="seller-rate" label="Porcentaje (0–100)" inputMode="decimal" />}
        </form.AppField>
        <form.AppField name="windowDays">
          {(field) => <field.TextField id="seller-window" label="Ventana (días)" inputMode="numeric" />}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

const settleSchema = z.object({
  year: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Escribe el año con cuatro cifras")
    .refine((value) => Number(value) >= 2000 && Number(value) <= 2100, "El año debe estar entre 2000 y 2100"),
  month: z
    .string()
    .trim()
    .regex(/^\d{1,2}$/, "Escribe el mes con un número del 1 al 12")
    .refine((value) => Number(value) >= 1 && Number(value) <= 12, "El mes debe estar entre 1 y 12"),
  currency: z.string().min(1, "Elige la moneda"),
})

function SettleDrawer({
  seller,
  onClose,
  onSaved,
}: {
  seller: Seller
  onClose: () => void
  onSaved: () => void
}) {
  const save = useMutation({
    mutationFn: (body: { sellerId: string; year: number; month: number; currency: string }) =>
      api("/api/admin/billing/settlements", { method: "POST", body: JSON.stringify(body) }),
  })
  const now = new Date()
  const form = useAppForm({
    defaultValues: { year: String(now.getUTCFullYear()), month: String(now.getUTCMonth() + 1), currency: "PEN" },
    validators: { onSubmit: settleSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        sellerId: seller.id,
        year: Number(value.year.trim()),
        month: Number(value.month.trim()),
        currency: value.currency,
      })
      onSaved()
      onClose()
    },
  })

  return (
    <FormDrawer
      {...useFormSurface(form)}
      open
      title={`Liquidar a ${seller.displayName}`}
      submitLabel="Liquidar y avisar por correo"
      onClose={onClose}
    >
      <p className="text-sm text-muted-foreground">
        Congela las comisiones pendientes del mes y los ajustes por reversos. Se envía un resumen
        por correo una sola vez.
      </p>
      <div className="grid grid-cols-3 gap-3">
        <form.AppField name="year">
          {(field) => <field.TextField id="settle-year" label="Año" inputMode="numeric" maxLength={4} />}
        </form.AppField>
        <form.AppField name="month">
          {(field) => <field.TextField id="settle-month" label="Mes" inputMode="numeric" maxLength={2} />}
        </form.AppField>
        <form.AppField name="currency">
          {(field) => (
            <field.Control id="settle-currency" label="Moneda">
              {(control) => (
                <CurrencySelect
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={(code) => field.handleChange(code)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
