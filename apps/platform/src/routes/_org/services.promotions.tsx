import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import {
  Badge,
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  FieldError,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Skeleton,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  addDays,
  DataTable,
  DatePickerButton,
  DetailDrawer,
  DetailField,
  DetailList,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
  zonedDateOf,
  zonedDayStart,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { BadgePercent, Plus } from "lucide-react"
import { type FormEvent, useId, useMemo, useRef, useState } from "react"
import { RadioChips } from "../../components/ui/radio-chips"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import {
  createPromotionApi,
  endPromotionApi,
  fetchPromotions,
  type PromotionItemBody,
  type PromotionMode,
  type PromotionServiceItem,
  type PromotionWithMetrics,
  type UpdatePromotionBody,
  updatePromotionApi,
} from "../../lib/promotions"
import {
  currencySymbol,
  fetchServices,
  formatAmount,
  type ServiceCatalogItem,
} from "../../lib/services"

export const Route = createFileRoute("/_org/services/promotions")({
  component: PromotionsPage,
})

/** Formato, moneda y zona de la clínica: con ellos se lee y escribe todo aquí. */
interface Regional {
  locale: string
  timeZone: string
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.shape.message) return error.shape.message
    if (error.shape.code) return `No se pudo guardar (${error.shape.code}). Inténtalo de nuevo.`
  }
  return error instanceof Error ? error.message : "No se pudo guardar. Inténtalo de nuevo."
}

/* ------------------------------ Fechas y textos ---------------------------- */

/** Fin del día elegido en la zona de la clínica: la promoción vale ese día entero. */
function endOfClinicDay(dateISO: string, timeZone: string): string {
  return new Date(zonedDayStart(addDays(dateISO, 1), timeZone).getTime() - 1000).toISOString()
}

function startOfClinicDay(dateISO: string, timeZone: string): string {
  return zonedDayStart(dateISO, timeZone).toISOString()
}

function dayParts(dateISO: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12))
}

/** «31 de octubre»; con el año si no es el que corre en la clínica. */
function dayInWords(dateISO: string, regional: Regional): string {
  const thisYear = zonedDateOf(new Date().toISOString(), regional.timeZone).slice(0, 4)
  return new Intl.DateTimeFormat(regional.locale, {
    day: "numeric",
    month: "long",
    ...(dateISO.slice(0, 4) === thisYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(dayParts(dateISO))
}

/** «1 nov 2026», para el botón que abre el calendario. */
function dayShort(dateISO: string, regional: Regional): string {
  return new Intl.DateTimeFormat(regional.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(dayParts(dateISO))
}

/** Vigencia con palabras, siempre en el día de la clínica y no en el del navegador. */
function validityText(promotion: PromotionWithMetrics, regional: Regional): string {
  const end = promotion.endsAt ? zonedDateOf(promotion.endsAt, regional.timeZone) : null
  if (promotion.state === "terminada") {
    return end ? `Terminó el ${dayInWords(end, regional)}` : "Terminada"
  }
  if (promotion.state === "programada") {
    const start = zonedDateOf(promotion.startsAt, regional.timeZone)
    return `Empieza el ${dayInWords(start, regional)}`
  }
  return end ? `Vigente hasta el ${dayInWords(end, regional)}` : "Vigente, sin fecha de fin"
}

/**
 * Precio de un servicio en la promoción. Estos importes acompañan al nombre y
 * van sin símbolo, como en el tablero; «Cobrado» y «Precio promedio» sí lo llevan.
 */
function itemText(item: PromotionServiceItem, locale: string): string {
  const price = formatAmount(item.priceCents, item.currency, locale)
  if (item.mode === "from") {
    return `${item.serviceName} desde ${price} · el precio final se pone en el presupuesto`
  }
  if (item.priceCents === 0) return `${item.serviceName} sin costo`
  if (item.priceCents === item.tariffCents && item.currency === item.tariffCurrency) {
    return `${item.serviceName} a ${price}`
  }
  return `${item.serviceName} a ${price} en vez de ${formatAmount(item.tariffCents, item.tariffCurrency, locale)}`
}

function usesText(uses: number): string {
  if (uses === 0) return "Aún no se usó"
  return uses === 1 ? "Usada 1 vez" : `Usada ${uses} veces`
}

/** «Cobrado …» o, si anuncia un mínimo, «Precio promedio …». `null` si no hay nada que decir. */
function moneyText(promotion: PromotionWithMetrics, locale: string): string | null {
  const metrics = promotion.metrics
  if (!metrics || metrics.uses === 0) return null
  const hasFrom = promotion.items.some((item) => item.mode === "from")
  const amounts = (hasFrom ? metrics.averageByCurrency : metrics.chargedByCurrency).filter(
    (row) => row.cents > 0,
  )
  if (amounts.length === 0) return null
  const text = amounts.map((row) => formatMoney(row.cents, row.currency, locale)).join(" · ")
  return hasFrom ? `Precio promedio ${text}` : `Cobrado ${text}`
}

/* --------------------------------- Página --------------------------------- */

/**
 * Promociones (tableros 8c y 27): un nombre, unas fechas y el precio de cada
 * servicio. Administración las crea, edita y termina; los demás las leen, y
 * solo quien ve dinero recibe cuánto se usaron y cobraron.
 */
function PromotionsPage() {
  const canConfigure = usePermission("settings.write")
  const canView = canConfigure || usePermission("catalog.read")
  const navigate = useNavigate()
  const profileQuery = useOrgProfile()
  const locale = profileQuery.data?.locale
  const timeZone = profileQuery.data?.timezone
  const regional = useMemo<Regional | null>(
    () => (locale && timeZone ? { locale, timeZone } : null),
    [locale, timeZone],
  )

  /** Lo abierto al lado: alta, edición o lectura. `session` remonta el formulario. */
  const [surface, setSurface] = useState<{ id: string | null; session: number } | null>(null)
  const [surfaceOpen, setSurfaceOpen] = useState(false)
  const sequence = useRef(0)
  const open = (id: string | null) => {
    sequence.current += 1
    setSurface({ id, session: sequence.current })
    setSurfaceOpen(true)
  }

  const listQuery = useQuery({
    queryKey: ["promotions", "todas"],
    queryFn: () => fetchPromotions({ scope: "todas" }),
    enabled: canView,
  })
  const promotions = useMemo(() => listQuery.data?.data ?? [], [listQuery.data])
  const current = useMemo(
    () => promotions.filter((promotion) => promotion.state !== "terminada"),
    [promotions],
  )
  const ended = useMemo(
    () =>
      promotions
        .filter((promotion) => promotion.state === "terminada")
        .sort((a, b) => (b.endsAt ?? b.startsAt).localeCompare(a.endsAt ?? a.startsAt)),
    [promotions],
  )
  const selected = surface?.id
    ? (promotions.find((promotion) => promotion.id === surface.id) ?? null)
    : null

  const columns = useMemo<ColumnDef<PromotionWithMetrics>[]>(() => {
    if (!regional) return []
    return [
      {
        id: "promocion",
        header: "Promoción",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 max-w-xl flex-col gap-1 whitespace-normal">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-words">{row.original.name}</span>
              {row.original.items.some((item) => item.mode === "from") ? (
                <Badge variant="outline">Precio «desde»</Badge>
              ) : null}
            </span>
            <span className="text-xs font-normal break-words text-muted-foreground">
              {row.original.items.length === 0
                ? "Sin servicios"
                : row.original.items.map((item) => itemText(item, regional.locale)).join(" · ")}
            </span>
          </span>
        ),
      },
      {
        id: "vigencia",
        header: "Vigencia",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="whitespace-normal">{validityText(row.original, regional)}</span>
        ),
      },
      {
        id: "uso",
        header: "Uso",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const metrics = row.original.metrics
          // Sin permiso para ver dinero no llega el uso: no se inventa un cero.
          if (!metrics) return <span className="text-muted-foreground">—</span>
          const money = moneyText(row.original, regional.locale)
          return (
            <span className="flex flex-col whitespace-normal">
              <span>{usesText(metrics.uses)}</span>
              {money ? <span className="text-xs text-muted-foreground">{money}</span> : null}
            </span>
          )
        },
      },
    ]
  }, [regional])

  const header = (
    <PageHeader
      title="Promociones"
      subtitle="Un nombre, unas fechas y el precio de cada servicio. Caja y el agente las leen de aquí."
      actions={
        canConfigure && regional ? (
          <Button type="button" className="min-h-11" onClick={() => open(null)}>
            <Plus aria-hidden />
            Nueva promoción
          </Button>
        ) : undefined
      }
    />
  )

  if (!canView) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Promociones" />
        <EmptyState
          title="Sin acceso"
          description="Necesitas permiso de tarifario o de configuración para ver las promociones."
        />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {profileQuery.isPending || listQuery.isPending ? (
        <LoadingState />
      ) : profileQuery.isError ? (
        <ErrorState
          message="No se pudo cargar el formato de la clínica"
          onRetry={() => void profileQuery.refetch()}
        />
      ) : !regional ? (
        <EmptyState
          title="Falta la región de la clínica"
          description={
            canConfigure
              ? "Las promociones usan la moneda y la zona horaria de la clínica. Configúralas para crear la primera."
              : "Quien administra la clínica debe configurar el país y la moneda."
          }
          actionLabel={canConfigure ? "Configurar la clínica" : undefined}
          onAction={canConfigure ? () => void navigate({ to: "/settings" }) : undefined}
        />
      ) : listQuery.isError ? (
        <ErrorState
          error={listQuery.error instanceof ApiError ? listQuery.error.shape : null}
          onRetry={() => void listQuery.refetch()}
        />
      ) : promotions.length === 0 ? (
        <EmptyState
          icon={BadgePercent}
          title="Aún no hay promociones"
          description={
            canConfigure
              ? "Crea una con su nombre, sus fechas y el precio de cada servicio. Al llegar la fecha de fin deja de ofrecerse sola."
              : "Cuando la clínica tenga una promoción, aparecerá aquí con sus precios."
          }
          actionLabel={canConfigure ? "Nueva promoción" : undefined}
          onAction={canConfigure ? () => open(null) : undefined}
        />
      ) : (
        <>
          <section aria-labelledby="promos-vigentes" className="flex min-w-0 flex-col gap-2">
            <h2 id="promos-vigentes" className="text-sm font-semibold">
              Vigentes
            </h2>
            {current.length === 0 ? (
              <EmptyState
                icon={BadgePercent}
                title="Ninguna promoción vigente"
                description="Las terminadas quedan abajo, con lo que se usó de cada una."
                actionLabel={canConfigure ? "Nueva promoción" : undefined}
                onAction={canConfigure ? () => open(null) : undefined}
              />
            ) : (
              <PromotionTable
                rows={current}
                columns={columns}
                onSelect={(row) => open(row.id)}
                activeId={surfaceOpen ? (surface?.id ?? null) : null}
                isFetching={listQuery.isFetching}
              />
            )}
          </section>
          {ended.length > 0 ? (
            <section aria-labelledby="promos-terminadas" className="flex min-w-0 flex-col gap-2">
              <h2 id="promos-terminadas" className="text-sm font-semibold">
                Terminadas
              </h2>
              <PromotionTable
                rows={ended}
                columns={columns}
                onSelect={(row) => open(row.id)}
                activeId={surfaceOpen ? (surface?.id ?? null) : null}
                isFetching={false}
              />
            </section>
          ) : null}
        </>
      )}
      {regional && surface ? (
        canConfigure ? (
          <PromotionForm
            key={surface.session}
            open={surfaceOpen}
            initial={surface.id ? selected : null}
            regional={regional}
            onClose={() => setSurfaceOpen(false)}
          />
        ) : selected ? (
          <PromotionReadOnly
            open={surfaceOpen}
            promotion={selected}
            regional={regional}
            onClose={() => setSurfaceOpen(false)}
          />
        ) : null
      ) : null}
    </div>
  )
}

function PromotionTable({
  rows,
  columns,
  onSelect,
  activeId,
  isFetching,
}: {
  rows: PromotionWithMetrics[]
  columns: ColumnDef<PromotionWithMetrics>[]
  onSelect: (row: PromotionWithMetrics) => void
  activeId: string | null
  isFetching: boolean
}) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  })
  return (
    <DataTable
      table={table}
      onRowClick={onSelect}
      isRowActive={(row) => row.id === activeId}
      isFetching={isFetching}
    />
  )
}

/** Estado y uso, en la cabecera de la promoción abierta. */
function PromotionStatus({ promotion, locale }: { promotion: PromotionWithMetrics; locale: string }) {
  const label =
    promotion.state === "vigente"
      ? "Vigente"
      : promotion.state === "programada"
        ? "Aún no empieza"
        : "Terminada"
  const money = moneyText(promotion, locale)
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Badge variant={promotion.state === "vigente" ? "success" : "secondary"}>{label}</Badge>
      {promotion.metrics ? <span>{usesText(promotion.metrics.uses).toLowerCase()}</span> : null}
      {money ? <span>· {money.toLowerCase()}</span> : null}
    </div>
  )
}

/** Lectura para quien no administra: la promoción y sus precios, sin controles que no puede usar. */
function PromotionReadOnly({
  open,
  promotion,
  regional,
  onClose,
}: {
  open: boolean
  promotion: PromotionWithMetrics
  regional: Regional
  onClose: () => void
}) {
  return (
    <DetailDrawer
      open={open}
      title={promotion.name}
      headerContent={<PromotionStatus promotion={promotion} locale={regional.locale} />}
      onClose={onClose}
    >
      <DetailList columns={1}>
        <DetailField label="Vigencia">{validityText(promotion, regional)}</DetailField>
        <DetailField label="Servicios y su precio">
          <ul className="flex flex-col gap-1">
            {promotion.items.map((item) => (
              <li key={item.id}>{itemText(item, regional.locale)}</li>
            ))}
          </ul>
        </DetailField>
        <DetailField label="Condiciones">{promotion.conditions}</DetailField>
      </DetailList>
    </DetailDrawer>
  )
}

/* -------------------------------- Formulario ------------------------------- */

interface PriceRow {
  serviceId: string
  serviceName: string
  currency: string
  tariffCents: number
  mode: PromotionMode
  priceText: string
}

const MODE_OPTIONS: ReadonlyArray<{ value: PromotionMode; label: string }> = [
  { value: "fixed", label: "Fijo" },
  { value: "from", label: "Desde" },
]

function parsePrice(row: PriceRow, locale: string): number | null {
  if (row.priceText.trim() === "") return null
  try {
    return parseMoney(row.priceText, row.currency, locale)
  } catch {
    return null
  }
}

/**
 * Alta y edición (tableros 8c y 27). Al editar solo viaja lo que cambió: así
 * una promoción terminada no vuelve a ofrecerse por corregirle el nombre, y sus
 * fechas ya no se tocan.
 */
function PromotionForm({
  open,
  initial,
  regional,
  onClose,
}: {
  open: boolean
  initial: PromotionWithMetrics | null
  regional: Regional
  onClose: () => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const { locale, timeZone } = regional
  const today = zonedDateOf(new Date().toISOString(), timeZone)
  const initialStart = initial ? zonedDateOf(initial.startsAt, timeZone) : today
  const initialEnd = initial?.endsAt ? zonedDateOf(initial.endsAt, timeZone) : ""
  const initialRows = useMemo<PriceRow[]>(
    () =>
      (initial?.items ?? []).map((item) => ({
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        currency: item.currency,
        tariffCents: item.tariffCents,
        mode: item.mode,
        priceText: formatMoneyInput(item.priceCents, item.currency, locale),
      })),
    [initial, locale],
  )
  const ended = initial?.state === "terminada"
  /** Lo que ya empezó conserva su inicio: el histórico se cuenta desde ahí. */
  const started = initial !== null && initial.state !== "programada"

  const [name, setName] = useState(initial?.name ?? "")
  const [startsOn, setStartsOn] = useState(initialStart)
  const [endsOn, setEndsOn] = useState(initialEnd)
  const [conditions, setConditions] = useState(initial?.conditions ?? "")
  const [rows, setRows] = useState<PriceRow[]>(initialRows)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["promotions"] })
    await queryClient.invalidateQueries({ queryKey: ["promotion"] })
  }

  const itemsChanged =
    rows.length !== initialRows.length ||
    rows.some((row, index) => {
      const before = initialRows[index]
      return (
        !before ||
        before.serviceId !== row.serviceId ||
        before.mode !== row.mode ||
        before.priceText !== row.priceText
      )
    })
  const isDirty =
    name !== (initial?.name ?? "") ||
    startsOn !== initialStart ||
    endsOn !== initialEnd ||
    conditions !== (initial?.conditions ?? "") ||
    itemsChanged

  const nameIssue = name.trim() ? null : "Ponle un nombre"
  const rowsIssue = rows.length === 0 ? "Agrega al menos un servicio con su precio" : null
  const datesIssue = endsOn && endsOn < startsOn ? "No puede terminar antes de empezar" : null
  const priceIssues = rows.map((row) => {
    if (row.priceText.trim() === "") return "Falta el precio (usa 0 si es sin costo)"
    return parsePrice(row, locale) === null ? "Precio inválido" : null
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const items: PromotionItemBody[] = rows.map((row) => ({
        serviceId: row.serviceId,
        mode: row.mode,
        priceCents: parsePrice(row, locale) ?? 0,
      }))
      if (!initial) {
        return createPromotionApi({
          name: name.trim(),
          startsAt: startOfClinicDay(startsOn, timeZone),
          endsAt: endsOn ? endOfClinicDay(endsOn, timeZone) : null,
          conditions: conditions.trim() || null,
          items,
        })
      }
      const patch: UpdatePromotionBody = {}
      if (name.trim() !== initial.name) patch.name = name.trim()
      if ((conditions.trim() || null) !== (initial.conditions ?? null)) {
        patch.conditions = conditions.trim() || null
      }
      if (itemsChanged) patch.items = items
      // Las fechas de lo terminado no viajan: editarla no la revive.
      if (!ended) {
        if (!started && startsOn !== initialStart) patch.startsAt = startOfClinicDay(startsOn, timeZone)
        if (endsOn !== initialEnd) patch.endsAt = endsOn ? endOfClinicDay(endsOn, timeZone) : null
      }
      if (Object.keys(patch).length === 0) return null
      return updatePromotionApi(initial.id, patch)
    },
    onSuccess: async () => {
      setError(null)
      await invalidate()
      toast.success(initial ? "Promoción actualizada" : "Promoción guardada")
      onClose()
    },
    onError: (failure) => setError(errorMessage(failure)),
  })

  const endMutation = useMutation({
    mutationFn: () => endPromotionApi(initial?.id ?? ""),
    onSuccess: async () => {
      await invalidate()
      toast.success("La promoción terminó hoy")
      setConfirmEnd(false)
      onClose()
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (nameIssue || rowsIssue || datesIssue || priceIssues.some(Boolean)) {
      setError("Revisa lo marcado antes de guardar.")
      return
    }
    setError(null)
    saveMutation.mutate()
  }

  const setRow = (serviceId: string, patch: Partial<PriceRow>) =>
    setRows((list) => list.map((row) => (row.serviceId === serviceId ? { ...row, ...patch } : row)))

  const uses = initial?.metrics?.uses ?? null
  const usedNote =
    uses === null || uses === 0
      ? "Los cambios valen desde ahora."
      : uses === 1
        ? "Los cambios valen desde ahora. La vez que ya se usó queda con el precio de ese momento."
        : `Los cambios valen desde ahora. Las ${uses} veces que ya se usó quedan con el precio de ese momento.`

  return (
    <>
      <FormDrawer
        open={open}
        title={initial ? initial.name : "Nueva promoción"}
        headerContent={initial ? <PromotionStatus promotion={initial} locale={locale} /> : undefined}
        error={error}
        isDirty={isDirty}
        isSubmitting={saveMutation.isPending}
        submitLabel={initial ? "Guardar cambios" : "Guardar promoción"}
        onClose={onClose}
        onSubmit={submit}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-nombre`}>
            {initial ? "Nombre" : "Nombre, como sale en la publicación"}
          </FieldLabel>
          <Input
            id={`${id}-nombre`}
            value={name}
            maxLength={120}
            aria-invalid={(submitted && nameIssue !== null) || undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {submitted && nameIssue ? <FieldError>{nameIssue}</FieldError> : null}
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <span id={`${id}-empieza`} className="text-sm font-medium">
              {started ? "Empezó" : "Empieza"}
            </span>
            {started ? (
              <p className="text-sm" aria-labelledby={`${id}-empieza`}>
                {dayShort(startsOn, regional)}
              </p>
            ) : (
              <DatePickerButton
                aria-labelledby={`${id}-empieza`}
                className="w-full justify-start"
                value={startsOn}
                min={today}
                onChange={setStartsOn}
              >
                {dayShort(startsOn, regional)}
              </DatePickerButton>
            )}
          </Field>
          <Field>
            <span id={`${id}-termina`} className="text-sm font-medium">
              {ended ? "Terminó" : "Termina"}
            </span>
            {ended ? (
              <p className="text-sm" aria-labelledby={`${id}-termina`}>
                {endsOn ? dayShort(endsOn, regional) : "Se desactivó"}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <DatePickerButton
                  aria-labelledby={`${id}-termina`}
                  className="min-w-0 flex-1 justify-start"
                  value={endsOn || startsOn}
                  min={startsOn > today ? startsOn : today}
                  onChange={setEndsOn}
                >
                  {endsOn ? dayShort(endsOn, regional) : "Sin fecha de fin"}
                </DatePickerButton>
                {endsOn ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEndsOn("")}>
                    Quitar fin
                  </Button>
                ) : null}
              </div>
            )}
            {datesIssue ? <FieldError>{datesIssue}</FieldError> : null}
          </Field>
        </div>
        {ended ? (
          <p className="text-xs text-muted-foreground">
            Una promoción terminada no vuelve a ofrecerse. Para repetirla, crea una nueva.
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">
            {initial ? "Servicios y su precio" : "Servicios y su precio en la promoción"}
          </span>
          {rows.map((row, index) => {
            const price = parsePrice(row, locale)
            const issue = submitted ? priceIssues[index] : null
            const above = price !== null && price > row.tariffCents
            return (
              <div key={row.serviceId} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium break-words">{row.serviceName}</span>
                    <span className="text-xs text-muted-foreground">
                      Normal {formatAmount(row.tariffCents, row.currency, locale)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Quitar ${row.serviceName} de la promoción`}
                    onClick={() =>
                      setRows((list) => list.filter((item) => item.serviceId !== row.serviceId))
                    }
                  >
                    Quitar
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RadioChips
                    aria-label={`Tipo de precio de ${row.serviceName}`}
                    className="w-auto"
                    value={row.mode}
                    options={MODE_OPTIONS}
                    onChange={(mode) => setRow(row.serviceId, { mode })}
                  />
                  <InputGroup className="w-40">
                    <InputGroupAddon align="inline-start">
                      <InputGroupText>{currencySymbol(row.currency, locale)}</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      inputMode="decimal"
                      placeholder={formatMoneyInput(0, row.currency, locale)}
                      aria-label={
                        row.mode === "from"
                          ? `Precio desde de ${row.serviceName} en la promoción`
                          : `Precio de ${row.serviceName} en la promoción`
                      }
                      aria-invalid={Boolean(issue) || undefined}
                      value={row.priceText}
                      onChange={(event) => setRow(row.serviceId, { priceText: event.target.value })}
                    />
                  </InputGroup>
                </div>
                {issue ? <FieldError>{issue}</FieldError> : null}
                {above ? (
                  <p className="text-xs text-warning" role="status">
                    Es más que el precio normal ({formatMoney(row.tariffCents, row.currency, locale)}
                    ). Revisa que sea lo que quieres.
                  </p>
                ) : null}
              </div>
            )
          })}
          {rows.some((row) => row.mode === "from") ? (
            <p className="text-xs text-muted-foreground">
              «Desde» anuncia un mínimo. El precio final lo pone quien hace el presupuesto.
            </p>
          ) : null}
          <ServiceAdder
            id={`${id}-servicio`}
            label={rows.length === 0 ? "Agregar un servicio" : "Agregar otro servicio"}
            locale={locale}
            taken={rows.map((row) => row.serviceId)}
            onAdd={(service) =>
              setRows((list) => [
                ...list,
                {
                  serviceId: service.id,
                  serviceName: service.name,
                  currency: service.currency,
                  tariffCents: service.priceCents,
                  mode: "fixed",
                  priceText: "",
                },
              ])
            }
          />
          {submitted && rowsIssue ? <FieldError>{rowsIssue}</FieldError> : null}
        </div>

        <Field>
          <FieldLabel htmlFor={`${id}-condiciones`}>
            {initial ? "Condiciones" : "Condiciones, en una frase"}
          </FieldLabel>
          <Textarea
            id={`${id}-condiciones`}
            value={conditions}
            rows={2}
            maxLength={500}
            onChange={(event) => setConditions(event.target.value)}
          />
        </Field>

        <p className="text-xs text-muted-foreground" role="status">
          {initial
            ? usedNote
            : "Al llegar la fecha de fin deja de ofrecerse sola. Lo ya cobrado con ella no cambia."}
        </p>
        {initial?.state === "vigente" ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            disabled={saveMutation.isPending}
            onClick={() => {
              endMutation.reset()
              setConfirmEnd(true)
            }}
          >
            Terminar la promoción hoy
          </Button>
        ) : null}
      </FormDrawer>

      {initial ? (
        <FormDrawer
          dock={false}
          open={confirmEnd}
          title="Terminar la promoción hoy"
          description={`«${initial.name}» deja de ofrecerse desde ahora. Lo ya presupuestado o cobrado con ella no cambia, y no se puede volver a activar.`}
          error={endMutation.isError ? errorMessage(endMutation.error) : null}
          isSubmitting={endMutation.isPending}
          submitLabel="Terminar hoy"
          cancelLabel="Dejarla vigente"
          onClose={() => setConfirmEnd(false)}
          onSubmit={(event) => {
            event.preventDefault()
            endMutation.mutate()
          }}
        >
          <p className="text-sm">{usesText(uses ?? 0)}.</p>
        </FormDrawer>
      ) : null}
    </>
  )
}

/** Buscador del tarifario para sumar un servicio a la promoción. */
function ServiceAdder({
  id,
  label,
  locale,
  taken,
  onAdd,
}: {
  id: string
  label: string
  locale: string
  /** Servicios ya en la promoción: cada uno aparece una sola vez. */
  taken: string[]
  onAdd: (service: ServiceCatalogItem) => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const servicesQuery = useQuery({
    queryKey: ["services", "promo-picker", query.trim()],
    queryFn: () => fetchServices({ q: query.trim() || undefined, state: "active", limit: 30 }),
    staleTime: 30_000,
  })
  const items = useMemo(
    () => (servicesQuery.data?.data ?? []).filter((service) => !taken.includes(service.id)),
    [servicesQuery.data, taken],
  )
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={items}
        filter={null}
        open={open}
        onOpenChange={setOpen}
        value={null}
        itemToStringValue={(item: ServiceCatalogItem) => item.id}
        inputValue={query}
        onInputValueChange={(next, details) => {
          if (details.reason === "input-change") {
            setQuery(next)
            setOpen(true)
          } else if (details.reason === "input-clear" || details.reason === "clear-press") {
            setQuery("")
          }
        }}
        onValueChange={(item: ServiceCatalogItem | null) => {
          if (!item) return
          onAdd(item)
          setQuery("")
          setOpen(false)
        }}
      >
        <ComboboxInput id={id} placeholder="Buscar en el tarifario" showTrigger={false} />
        <ComboboxContent>
          {servicesQuery.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : servicesQuery.isError ? (
            <div role="alert" className="flex flex-col gap-2 p-2">
              <p className="text-sm text-destructive">No se pudo buscar en el tarifario.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void servicesQuery.refetch()}
              >
                Reintentar
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              Ningún servicio activo del tarifario coincide.
            </p>
          ) : (
            <>
              <ComboboxList aria-label="Servicios del tarifario">
                {items.map((item) => (
                  <ComboboxItem key={item.id} value={item} className="flex-col items-start gap-0 py-2">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-muted-foreground">
                      Normal {formatAmount(item.priceCents, item.currency, locale)}
                    </span>
                  </ComboboxItem>
                ))}
              </ComboboxList>
              <ComboboxEmpty>Sin resultados.</ComboboxEmpty>
            </>
          )}
        </ComboboxContent>
      </Combobox>
    </Field>
  )
}
