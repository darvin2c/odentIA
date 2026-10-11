import { formatMoney, parseMoney } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import {
  DataTable,
  DatePickerButton,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
  formatDateLong,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import {
  createPromotionApi,
  endPromotionApi,
  fetchPromotionDetail,
  fetchPromotions,
  updatePromotionApi,
  type CreatePromotionBody,
  type Promotion,
  type PromotionItemBody,
  type PromotionWithMetrics,
} from "../../lib/promotions"
import { fetchServices, type ServiceCatalogItem } from "../../lib/services"
import { ChoiceSelect } from "../../components/ui/choice-select"
export const Route = createFileRoute("/_org/services/promotions")({
  component: PromotionsPage,
})

function toIsoDateInput(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString().slice(0, 10)
}

/** Fecha-sola (yyyy-MM-dd) de un instante en la zona de la clínica (no UTC). */
function instantToClinicDate(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value
      return acc
    }, {})
  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"]),
  )
  return asUtc - at.getTime()
}

/**
 * Fecha-sola a instante ISO: medianoche (inicio) o fin del día en la zona de
 * la clínica. Sin zona, medianoche local del navegador.
 */
function clinicDateToIso(dateOnly: string, timeZone: string | undefined, endOfDay: boolean): string {
  const [year, month, day] = dateOnly.split("-").map(Number)
  if (!year || !month || !day) return new Date(dateOnly).toISOString()
  if (!timeZone) {
    return new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).toISOString()
  }
  const guess = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0)
  return new Date(guess - tzOffsetMs(timeZone, new Date(guess))).toISOString()
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/**
 * Promociones (tablero 8c): nombre, fechas, precio por servicio (fijo o
 * «desde») y condiciones. Administración las configura; caja y presupuestos
 * las leen vigentes y la persona decide si corresponde. Al vencer dejan de
 * ofrecerse solas y lo cobrado con ellas no cambia.
 */
function PromotionsPage() {
  const canConfigure = usePermission("settings.write")
  const canView = canConfigure || usePermission("catalog.read")
  const queryClient = useQueryClient()
  const profile = useOrgProfile()
  const locale = profile.data?.locale
  const money = (cents: number | null, currency: string): string =>
    cents == null || !locale ? "…" : formatMoney(cents, currency, locale)

  const [showEnded, setShowEnded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Promotion | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ["promotions", showEnded ? "todas" : "vigentes"],
    queryFn: () => fetchPromotions({ scope: showEnded ? "todas" : "vigentes" }),
    enabled: canView,
  })
  const detailQuery = useQuery({
    queryKey: ["promotion", selectedId],
    queryFn: () => fetchPromotionDetail(selectedId as string),
    enabled: canView && selectedId != null,
  })
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["promotions"] })
    void queryClient.invalidateQueries({ queryKey: ["promotion"] })
  }
  const saveMutation = useMutation({
    mutationFn: (body: { id: string | null; payload: CreatePromotionBody }) =>
      body.id
        ? updatePromotionApi(body.id, body.payload)
        : createPromotionApi(body.payload),
    onSuccess: () => {
      setFormOpen(false)
      setEditing(null)
      setFormError(null)
      invalidate()
    },
    onError: (err) => setFormError(mutationMessage(err)),
  })
  const endMutation = useMutation({
    mutationFn: (id: string) => endPromotionApi(id),
    onSuccess: invalidate,
  })

  const rows = useMemo(() => listQuery.data?.data ?? [], [listQuery.data])
  const detail: PromotionWithMetrics | null = detailQuery.data?.data ?? null
  const columns = useMemo<ColumnDef<Promotion>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Promoción",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.conditions ?? "Sin condiciones"}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "endsAt",
        header: "Vigencia",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.endsAt
              ? `Hasta el ${new Date(row.original.endsAt).toLocaleDateString(locale, { day: "numeric", month: "long" })}`
              : "Sin fecha de fin"}
          </span>
        ),
      },
      {
        accessorKey: "items",
        header: "Precios",
        cell: ({ row }) => (
          <span className="flex flex-col gap-1 text-sm">
            {row.original.items.map((item) => (
              <span key={item.id}>
                {item.serviceName}:{" "}
                {item.mode === "fixed" ? (
                  <strong className="tabular-nums">{money(item.priceCents, item.currency)}</strong>
                ) : (
                  <span>
                    desde <strong className="tabular-nums">{money(item.priceCents, item.currency)}</strong>
                  </span>
                )}{" "}
                <span className="text-xs text-muted-foreground">
                  (tarifa {money(item.tariffCents, item.tariffCurrency)})
                </span>
              </span>
            ))}
          </span>
        ),
      },
    ],
    [locale],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  if (!canView) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <PageHeader title="Promociones" subtitle="Precios especiales por fecha" />
        <EmptyState
          title="Sin acceso"
          description="Necesitas permiso de configuración o de tarifario para ver promociones."
        />
      </div>
    )
  }
  if (listQuery.isPending) return <LoadingState />
  if (listQuery.isError || !listQuery.data) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <PageHeader title="Promociones" subtitle="Precios especiales por fecha" />
        <ErrorState
          error={listQuery.error instanceof ApiError ? listQuery.error.shape : null}
          onRetry={() => void listQuery.refetch()}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Promociones"
        subtitle="Un nombre, unas fechas y el precio de cada servicio. Caja y el agente las leen de aquí."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={showEnded ? "outline" : "default"}
          size="sm"
          onClick={() => setShowEnded(false)}
        >
          Vigentes
        </Button>
        <Button
          type="button"
          variant={showEnded ? "default" : "outline"}
          size="sm"
          onClick={() => setShowEnded(true)}
        >
          Todas
        </Button>
        {canConfigure ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditing(null)
              setFormError(null)
              setFormOpen(true)
            }}
          >
            Nueva promoción
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={showEnded ? "Sin promociones" : "Sin promociones vigentes"}
          description="Al llegar la fecha de fin dejan de ofrecerse solas. Lo ya cobrado con ellas no cambia."
        />
      ) : (
        <DataTable
          table={table}
          onRowClick={(row) => setSelectedId(row.id)}
        />
      )}
      {selectedId ? (
        <PromotionDetail
          detail={detail}
          loading={detailQuery.isPending}
          canConfigure={canConfigure}
          money={money}
          ending={endMutation.isPending}
          onClose={() => setSelectedId(null)}
          onEdit={(promotion) => {
            setEditing(promotion)
            setFormError(null)
            setFormOpen(true)
          }}
          onEnd={() => endMutation.mutate(selectedId)}
        />
      ) : null}
      {formOpen ? (
        <PromotionForm
          initial={editing}
          locale={locale}
          timeZone={profile.data?.timezone}
          error={formError}
          pending={saveMutation.isPending}
          onClose={() => {
            if (!saveMutation.isPending) {
              setFormOpen(false)
              setEditing(null)
            }
          }}
          onSubmit={(payload) => saveMutation.mutate({ id: editing?.id ?? null, payload })}
          onError={setFormError}
        />
      ) : null}
    </div>
  )
}

function PromotionDetail({
  detail,
  loading,
  canConfigure,
  money,
  ending,
  onClose,
  onEdit,
  onEnd,
}: {
  detail: PromotionWithMetrics | null
  loading: boolean
  canConfigure: boolean
  money: (cents: number | null, currency: string) => string
  ending: boolean
  onClose: () => void
  onEdit: (promotion: Promotion) => void
  onEnd: () => void
}) {
  if (loading || !detail) {
    return (
      <div role="dialog" aria-label="Detalle de promoción" className="rounded-xl border p-4">
        <LoadingState />
      </div>
    )
  }
  const live = detail.isActive && (!detail.endsAt || new Date(detail.endsAt) >= new Date())
  return (
    <div
      role="dialog"
      aria-label={`Promoción ${detail.name}`}
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{detail.name}</h3>
        <Badge variant={live ? "success" : "secondary"}>{live ? "Vigente" : "Terminada"}</Badge>
        <span className="text-sm text-muted-foreground">usada {detail.metrics.uses} veces</span>
      </div>
      {detail.conditions ? <p className="text-sm">{detail.conditions}</p> : null}
      <ul className="flex flex-col gap-1 text-sm">
        {detail.items.map((item) => (
          <li key={item.id}>
            {item.serviceName}:{" "}
            {item.mode === "fixed" ? (
              <strong className="tabular-nums">{money(item.priceCents, item.currency)}</strong>
            ) : (
              <span>
                desde <strong className="tabular-nums">{money(item.priceCents, item.currency)}</strong>
              </span>
            )}{" "}
            <span className="text-xs text-muted-foreground">
              (tarifa {money(item.tariffCents, item.tariffCurrency)})
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Cobrado:{" "}
        {detail.metrics.chargedByCurrency.length === 0
          ? "—"
          : detail.metrics.chargedByCurrency
              .map((row) => money(row.cents, row.currency))
              .join(" · ")}
          {detail.metrics.uses > 0
            ? detail.metrics.chargedByCurrency.map((row) => (
                <span key={row.currency}>
                  {" "}· promedio {money(Math.round(row.cents / detail.metrics.uses), row.currency)}
                </span>
              ))
            : null}
      </p>
      <p className="text-xs text-muted-foreground">
        Los cambios valen desde ahora. Lo ya usado queda con el precio de ese momento.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cerrar
        </Button>
        {canConfigure ? (
          <Button type="button" variant="outline" onClick={() => onEdit(detail)}>
            Editar
          </Button>
        ) : null}
        {canConfigure && live ? (
          <Button type="button" variant="outline" disabled={ending} onClick={onEnd}>
            {ending ? "Terminando…" : "Terminar hoy"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

interface PromoRowState {
  serviceId: string
  serviceName: string
  currency: string
  tariffCents: number
  mode: "fixed" | "from"
  priceText: string
}

function PromotionForm({
  initial,
  locale,
  timeZone,
  error,
  pending,
  onClose,
  onSubmit,
  onError,
}: {
  initial: Promotion | null
  locale: string | undefined
  timeZone: string | undefined
  error: string | null
  pending: boolean
  onClose: () => void
  onSubmit: (payload: CreatePromotionBody) => void
  onError: (message: string | null) => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [startsAt, setStartsAt] = useState(
    initial
      ? instantToClinicDate(initial.startsAt, timeZone)
      : instantToClinicDate(new Date().toISOString(), timeZone),
  )
  const [endsAt, setEndsAt] = useState(
    initial?.endsAt ? instantToClinicDate(initial.endsAt, timeZone) : "",
  )
  const [conditions, setConditions] = useState(initial?.conditions ?? "")
  const [rows, setRows] = useState<PromoRowState[]>(
    initial?.items.map((item) => ({
      serviceId: item.serviceId,
      serviceName: item.serviceName,
      currency: item.currency,
      tariffCents: item.tariffCents,
      mode: item.mode,
      priceText: "",
    })) ?? [],
  )
  const [serviceSearch, setServiceSearch] = useState("")
  const servicesQuery = useQuery({
    queryKey: ["services", "promo-picker", serviceSearch],
    queryFn: () => fetchServices({ q: serviceSearch || undefined, state: "active", limit: 30 }),
    enabled: serviceSearch.trim() !== "",
  })
  const setRow = (serviceId: string, patch: Partial<PromoRowState>) =>
    setRows((current) => current.map((row) => (row.serviceId === serviceId ? { ...row, ...patch } : row)))
  // Snapshot al seleccionar: nombre, moneda y tarifa viajan en la fila para no
  // depender de resultados de búsqueda efímeros que cambian al limpiar.
  const addService = (service: ServiceCatalogItem) => {
    setRows((current) =>
      current.some((row) => row.serviceId === service.id)
        ? current
        : [
            ...current,
            {
              serviceId: service.id,
              serviceName: service.name,
              currency: service.currency,
              tariffCents: service.priceCents,
              mode: "fixed" as const,
              priceText: "",
            },
          ],
    )
    setServiceSearch("")
  }
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!locale) {
      onError("Sin formato de moneda de la clínica; inténtalo de nuevo.")
      return
    }
    if (!name.trim()) {
      onError("El nombre es obligatorio.")
      return
    }
    if (!startsAt) {
      onError("El inicio es obligatorio.")
      return
    }
    if (rows.length === 0) {
      onError("Agrega al menos un servicio con su precio.")
      return
    }
    const items: PromotionItemBody[] = []
    for (const row of rows) {
      let priceCents: number
      try {
        priceCents = parseMoney(row.priceText, row.currency, locale)
      } catch {
        onError(`Precio inválido para «${row.serviceName}».`)
        return
      }
      items.push({ serviceId: row.serviceId, mode: row.mode, priceCents })
    }
    onError(null)
    onSubmit({
      name: name.trim(),
      startsAt: clinicDateToIso(startsAt, timeZone, false),
      endsAt: endsAt ? clinicDateToIso(endsAt, timeZone, true) : null,
      conditions: conditions.trim() || null,
      items,
    })
  }
  return (
    <FormDrawer
      open
      title={initial ? `Editar ${initial.name}` : "Nueva promoción"}
      description="«Desde» anuncia un mínimo: el precio final lo pone quien hace el presupuesto."
      error={error}
      isSubmitting={pending}
      submitLabel={initial ? "Guardar cambios" : "Guardar promoción"}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field>
        <FieldLabel htmlFor="promo-name">Nombre, como sale en la publicación</FieldLabel>
        <Input
          id="promo-name"
          value={name}
          maxLength={120}
          onChange={(event) => {
            const value = event.currentTarget.value
            setName(value)
          }}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="promo-starts">Empieza</FieldLabel>
          <DatePickerButton id="promo-starts" value={startsAt} onChange={setStartsAt}>
            {startsAt ? formatDateLong(startsAt) : "Elige el inicio"}
          </DatePickerButton>
        </Field>
        <Field>
          <FieldLabel htmlFor="promo-ends">Termina (vacío = sin fin)</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <DatePickerButton
              id="promo-ends"
              value={endsAt || startsAt}
              min={startsAt || undefined}
              onChange={setEndsAt}
            >
              {endsAt ? formatDateLong(endsAt) : "Sin fecha de fin"}
            </DatePickerButton>
            {endsAt ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEndsAt("")}>
                Quitar fin
              </Button>
            ) : null}
          </div>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="promo-service-search">Agregar servicio del tarifario</FieldLabel>
        <Input
          id="promo-service-search"
          value={serviceSearch}
          placeholder="Buscar en el tarifario"
          onChange={(event) => {
            const value = event.currentTarget.value
            setServiceSearch(value)
          }}
        />
        {serviceSearch.trim() !== "" ? (
          <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-auto">
            {(servicesQuery.data?.data ?? []).map((service) => (
              <li key={service.id}>
                <Button type="button" variant="ghost" size="sm" onClick={() => addService(service)}>
                  {service.name} · {service.code ? `${service.code} · ` : ""}
                  {locale ? formatMoney(service.priceCents, service.currency, locale) : "…"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Field>
      {rows.map((row) => {
        const currentPrice = initial?.items.find((i) => i.serviceId === row.serviceId)
        return (
          <div key={row.serviceId} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {row.serviceName}{" "}
                <span className="font-normal text-muted-foreground">
                  (tarifa {locale ? formatMoney(row.tariffCents, row.currency, locale) : "…"})
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRows((current) => current.filter((r) => r.serviceId !== row.serviceId))}
              >
                Quitar
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`promo-mode-${row.serviceId}`}>Tipo de precio</FieldLabel>
                <ChoiceSelect
                  id={`promo-mode-${row.serviceId}`}
                  className="w-full"
                  value={row.mode}
                  onChange={(event) => {
                    const mode = event.target.value as "fixed" | "from"
                    setRow(row.serviceId, { mode })
                  }}
                >
                  <option value="fixed">Fijo</option>
                  <option value="from">Desde</option>
                </ChoiceSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`promo-price-${row.serviceId}`}>
                  {row.mode === "fixed" ? "Precio" : "Mínimo anunciado"}
                </FieldLabel>
                <Input
                  id={`promo-price-${row.serviceId}`}
                  value={row.priceText}
                  inputMode="decimal"
                  placeholder={
                    currentPrice && locale
                      ? formatMoney(currentPrice.priceCents, currentPrice.currency, locale)
                      : ""
                  }
                  onChange={(event) => {
                    const priceText = event.currentTarget.value
                    setRow(row.serviceId, { priceText })
                  }}
                />
              </Field>
            </div>
          </div>
        )
      })}
      <Field>
        <FieldLabel htmlFor="promo-conditions">Condiciones, en una frase</FieldLabel>
        <Textarea
          id="promo-conditions"
          value={conditions}
          rows={2}
          maxLength={500}
          onChange={(event) => {
            const value = event.currentTarget.value
            setConditions(value)
          }}
        />
      </Field>
    </FormDrawer>
  )
}
