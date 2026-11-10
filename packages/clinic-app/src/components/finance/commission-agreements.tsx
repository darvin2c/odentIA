/**
 * La comisión de cada profesional, en Configuración › Comisiones por profesional: lo que se acordó con cada
 * persona que puede atender (su porcentaje de lo cobrado, los servicios con una comisión distinta
 * o que no cobra comisión). Es lo que se fija al contratar y cambia poco; el mes se liquida y se
 * paga en Finanzas › Comisiones, que solo la muestra.
 *
 * Siempre parte de lo que vale hoy: un cambio vale para lo que se atienda desde que se guarda y lo
 * atendido antes conserva lo que tenía. La primera comisión vale también para lo ya cobrado que aún
 * no se paga. Importes, vigencias y permisos los decide el servidor.
 */
import { currencyWord, formatMoney, formatMoneyInput } from "@odentia/clinical"
import { Button, cn, toast } from "@odentia/ui"
import { EmptyState, FormDrawer, PersonAvatar, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, Users } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import {
  agreementWords,
  type CommissionAgreement,
  type CommissionException,
  dayLabel,
  historyLines,
  percentInput,
  percentLabel,
  rateBpsFromPercent,
  setCommissionExceptionApi,
  setCommissionRateApi,
} from "../../lib/commissions"
import { financeFormMessage } from "../../lib/finance"
import { parseAmount } from "../../lib/finance-cash"
import { ChoiceButtons } from "../choice-buttons"
import { ServiceSelect } from "../service-select"

/** Todo lo de comisiones cuelga de esta clave: cambiar una comisión refresca también el mes. */
export const COMMISSIONS_KEY = ["commissions"] as const
export const AGREEMENTS_KEY = ["commissions", "agreements"] as const

/** «45 %» o «S/ 150.00 por cada uno», en la moneda del monto. */
export function exceptionWords(exception: CommissionException, locale: string, currency: string): string {
  return exception.fixedCents !== null
    ? `${formatMoney(exception.fixedCents, exception.fixedCurrency ?? currency, locale)} por cada uno`
    : percentLabel(exception.rateBps ?? 0, locale)
}

/** El monto quedó en otra moneda que el precio del servicio: no vale hasta escribirlo de nuevo. */
export function exceptionStale(exception: CommissionException): boolean {
  return (
    exception.fixedCents !== null &&
    Boolean(exception.fixedCurrency) &&
    Boolean(exception.serviceCurrency) &&
    exception.fixedCurrency !== exception.serviceCurrency
  )
}

/** Nadie decidió aún su comisión: lo cobrado de lo que atiende da 0 hasta fijarla. */
function undecided(agreement: CommissionAgreement): boolean {
  return !agreement.hasRate && agreement.exceptions.length === 0
}

/** Qué panel está abierto y para quién. */
type Editing =
  | { kind: "rate"; agreement: CommissionAgreement; start: "porcentaje" | "ninguno" }
  | { kind: "service"; agreement: CommissionAgreement; exception: CommissionException | null }

export function CommissionAgreementsList({
  agreements,
  locale,
  timeZone,
  currency,
  focusId,
  openRate = false,
  onSaved,
}: {
  agreements: CommissionAgreement[]
  locale: string
  timeZone: string
  currency: string
  /** La persona que se viene a ver (desde Finanzas): su tarjeta se lleva a la vista. */
  focusId: string | null
  /** Se vino a ponerle su porcentaje (desde su fila en Finanzas): el panel se abre solo, una vez. */
  openRate?: boolean
  /** Después de guardar su porcentaje, lo que hace la página (volver a donde estaba). */
  onSaved?: () => void
}) {
  // El último panel pedido sigue con su persona mientras se cierra: no se vacía en la animación.
  const [editing, setEditing] = useState<Editing | null>(null)
  const [open, setOpen] = useState(false)
  const edit = (next: Editing) => {
    setEditing(next)
    setOpen(true)
  }
  const focusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!focusId) return
    focusRef.current?.scrollIntoView({ block: "center" })
    focusRef.current?.focus({ preventScroll: true })
  }, [focusId])
  // Desde Finanzas, «Poner su porcentaje» abre su panel: un solo paso, no dos.
  const opened = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: se abre una sola vez, al llegar.
  useEffect(() => {
    if (!openRate || opened.current) return
    const agreement = agreements.find((item) => item.professionalUserId === focusId)
    if (!agreement?.attends) return
    opened.current = true
    edit({ kind: "rate", agreement, start: "porcentaje" })
  }, [openRate, focusId, agreements])

  if (agreements.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Aún no hay quien atienda"
        description="Aquí aparece cada persona del equipo que puede atender pacientes, para fijar lo que se lleva de lo cobrado."
      />
    )
  }

  return (
    <>
      <ul className="flex min-w-0 flex-col gap-3">
        {/* Primero quien aún no tiene comisión decidida: es lo único que pide hacer algo. */}
        {[...agreements.filter(undecided), ...agreements.filter((agreement) => !undecided(agreement))].map((agreement) => (
          <li key={agreement.professionalUserId} className="min-w-0">
            <AgreementCard
              agreement={agreement}
              locale={locale}
              timeZone={timeZone}
              currency={currency}
              focused={agreement.professionalUserId === focusId}
              cardRef={
                agreement.professionalUserId === focusId
                  ? (node) => {
                      focusRef.current = node
                    }
                  : undefined
              }
              onEdit={edit}
            />
          </li>
        ))}
      </ul>
      <RateDrawer
        editing={editing?.kind === "rate" ? editing : null}
        open={open && editing?.kind === "rate"}
        onClose={() => setOpen(false)}
        onSaved={onSaved}
        locale={locale}
      />
      <ServiceCommissionDrawer
        editing={editing?.kind === "service" ? editing : null}
        open={open && editing?.kind === "service"}
        onClose={() => setOpen(false)}
        currency={currency}
        locale={locale}
      />
    </>
  )
}

function AgreementCard({
  agreement,
  locale,
  timeZone,
  currency,
  focused,
  cardRef,
  onEdit,
}: {
  agreement: CommissionAgreement
  locale: string
  timeZone: string
  currency: string
  focused: boolean
  cardRef?: (node: HTMLElement | null) => void
  onEdit: (editing: Editing) => void
}) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState<string | null>(null)
  const name = agreement.professionalName
  const titleId = `comision-${agreement.professionalUserId}`
  const day = (iso: string) => dayLabel(iso, locale, timeZone)
  const none = undecided(agreement)
  const summary = agreementWords(
    { hasRate: agreement.hasRate, rateBps: agreement.rateBps, exceptionCount: agreement.exceptions.length },
    locale,
  )
  const noCommission = agreement.hasRate && agreement.rateBps === 0 && agreement.exceptions.length === 0
  // Desde cuándo vale lo de hoy; lo que tenía antes, con quién lo cambió, va en su historial.
  const since = [
    !agreement.attends ? "Ya no atiende pacientes" : null,
    agreement.rateSince ? `desde el ${day(agreement.rateSince)}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  // Con un solo cambio, el historial repetiría la tarjeta: aparece cuando hubo cambios.
  const history = (agreement.history ?? []).length > 1 ? historyLines(agreement.history ?? [], locale, timeZone, currency) : []

  const remove = async (exception: CommissionException) => {
    setRemoving(exception.serviceId)
    try {
      await setCommissionExceptionApi({ professionalUserId: agreement.professionalUserId, serviceId: exception.serviceId })
      void queryClient.invalidateQueries({ queryKey: COMMISSIONS_KEY })
      toast.success(
        agreement.rateBps > 0
          ? `${exception.serviceName}: desde ahora vuelve a su ${percentLabel(agreement.rateBps, locale)}`
          : `${exception.serviceName}: desde ahora ya no comisiona`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo quitar")
    } finally {
      setRemoving(null)
    }
  }

  return (
    <section
      ref={cardRef}
      tabIndex={focused ? -1 : undefined}
      aria-labelledby={titleId}
      className={cn(
        "elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card px-4 py-4 outline-none sm:px-5",
        focused && "ring-2 ring-ring",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <PersonAvatar name={name} fallbackClassName="text-xs" decorative />
        {/* El nombre tiene su espacio: si no cabe junto al porcentaje, el porcentaje baja de línea. */}
        <div className="flex min-w-40 flex-1 flex-col">
          <h2 id={titleId} className="truncate font-medium">
            {name}
          </h2>
          {none ? (
            <p className="text-sm">Sin comisión decidida</p>
          ) : since ? (
            <p className="text-sm text-muted-foreground">{since}</p>
          ) : null}
        </div>
        {none ? null : (
          <div className="ml-auto flex items-center gap-3">
            {agreement.rateBps > 0 ? (
              <p className="text-lg font-semibold whitespace-nowrap tabular-nums">
                {percentLabel(agreement.rateBps, locale)}{" "}
                <span className="text-sm font-normal text-muted-foreground">de lo cobrado</span>
              </p>
            ) : (
              <p className="text-sm font-medium">{summary}</p>
            )}
            {agreement.attends || !noCommission ? (
              <Button
                type="button"
                variant="outline"
                aria-label={`Cambiar la comisión de ${name}`}
                onClick={() => onEdit({ kind: "rate", agreement, start: agreement.rateBps > 0 ? "porcentaje" : "ninguno" })}
              >
                Cambiar
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {none ? (
        // Las dos decisiones, debajo y a lo ancho: con el panel abierto o en el teléfono el nombre no se aprieta.
        <>
          <p className="text-sm text-muted-foreground">
            Mientras no se decida, lo cobrado de lo que atiende no comisiona. La primera comisión que pongas vale
            también para lo ya cobrado que aún no se paga.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => onEdit({ kind: "rate", agreement, start: "porcentaje" })}>
              Poner su porcentaje
            </Button>
            <Button type="button" variant="outline" onClick={() => onEdit({ kind: "rate", agreement, start: "ninguno" })}>
              No cobra comisión
            </Button>
          </div>
        </>
      ) : null}

      {agreement.exceptions.length > 0 ? (
        <div className="flex min-w-0 flex-col border-t pt-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            {agreement.rateBps > 0 ? "Servicios con comisión distinta" : "Comisiona solo por estos servicios"}
          </h3>
          <ul className="mt-1 flex min-w-0 flex-col">
            {agreement.exceptions.map((exception) => (
              <li key={exception.serviceId} className="flex min-w-0 items-start gap-2 py-1.5 text-sm">
                {/* El servicio arriba y la comisión debajo: en el teléfono el nombre no se aplasta. */}
                <span className="min-w-0 flex-1">
                  <span className="block break-words">{exception.serviceName}</span>
                  <span className="block text-xs text-muted-foreground">
                    <span className="font-medium text-foreground tabular-nums">
                      {exceptionWords(exception, locale, currency)}
                    </span>
                    {exception.effectiveFrom ? ` · desde el ${day(exception.effectiveFrom)}` : ""}
                  </span>
                  {exceptionStale(exception) ? (
                    // Nunca se convierte: lo atendido desde el cambio queda sin comisión hasta escribirlo.
                    <span className="block text-xs text-destructive">
                      El servicio ahora tiene su precio en {currencyWord(exception.serviceCurrency ?? "", locale)}: vuelve a
                      escribir el monto para que valga.
                    </span>
                  ) : null}
                </span>
                <RowActions
                  label={`Más acciones de ${exception.serviceName}`}
                  items={[
                    // A quien ya no atiende solo se le quita: una comisión nueva es de quien atiende.
                    ...(agreement.attends
                      ? [{ key: "cambiar", label: "Cambiar", onSelect: () => onEdit({ kind: "service", agreement, exception }) }]
                      : []),
                    {
                      key: "quitar",
                      label: removing === exception.serviceId ? "Quitando…" : "Quitar",
                      disabled: removing !== null,
                      onSelect: () => void remove(exception),
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {agreement.attends ? (
        <div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => onEdit({ kind: "service", agreement, exception: null })}
          >
            <Plus aria-hidden />
            {/* Quien no cobra comisión, si se le agrega un servicio, pasa a cobrar solo por ese servicio. */}
            {noCommission
              ? "Cobrar solo por un servicio"
              : agreement.rateBps > 0
                ? "Comisión distinta para un servicio"
                : agreement.exceptions.length > 0
                  ? "Comisión por otro servicio"
                  : "Comisión por un servicio"}
          </Button>
        </div>
      ) : null}

      {history.length > 0 ? (
        // Plegado, como lo demás que se consulta poco: quién cambió su comisión, cuándo y qué había antes.
        <details className="border-t pt-1 text-sm">
          <summary className="min-h-11 cursor-pointer content-center font-medium text-primary-soft-foreground sm:min-h-8">
            Ver historial<span className="sr-only"> de {name}</span> ({history.length})
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            Cada cambio vale para lo que se atienda desde el momento en que se guardó; lo atendido antes conserva lo
            que tenía. «La primera» fue su primera comisión: valió también para lo que ya había atendido y no se le
            había pagado.
          </p>
          <ol className="mt-1 flex min-w-0 flex-col">
            {history.map((line) => (
              <li key={line.key} className="py-1.5">
                <span className="block break-words font-medium">{line.what}</span>
                <span className="block text-xs text-muted-foreground">{line.detail}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  )
}

// --- Su porcentaje de lo cobrado ---------------------------------------------------------

/** A quien ya no atiende solo se le deja sin comisión: un porcentaje nuevo es de quien atiende. */
const RATE_KINDS = (hasServices: boolean, attends: boolean) =>
  [
    ...(attends ? [{ value: "porcentaje" as const, label: "Un porcentaje de lo cobrado" }] : []),
    { value: "ninguno" as const, label: hasServices ? "Solo por sus servicios" : "No cobra comisión" },
  ]

function RateDrawer({
  editing,
  open,
  onClose,
  onSaved,
  locale,
}: {
  editing: Extract<Editing, { kind: "rate" }> | null
  open: boolean
  onClose: () => void
  onSaved?: () => void
  locale: string
}) {
  const queryClient = useQueryClient()
  const agreement = editing?.agreement ?? null
  const name = agreement?.professionalName ?? ""
  const current = agreement?.rateBps ?? 0
  const hasServices = (agreement?.exceptions.length ?? 0) > 0
  const initial = {
    kind: (editing?.start ?? "porcentaje") as "porcentaje" | "ninguno",
    percent: current > 0 ? percentInput(current, locale) : "",
  }
  const form = useAppForm({
    defaultValues: initial,
    validators: {
      onSubmit: ({ value }) => {
        if (value.kind === "ninguno") return undefined
        const rate = rateBpsFromPercent(value.percent)
        if (rate === null || rate === 0)
          return { fields: { percent: "Escribe un porcentaje mayor que 0 y hasta 100, con dos decimales como máximo." } }
        return undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!agreement) return
      const rateBps = value.kind === "ninguno" ? 0 : (rateBpsFromPercent(value.percent) ?? 0)
      await setCommissionRateApi({ professionalUserId: agreement.professionalUserId, rateBps })
      void queryClient.invalidateQueries({ queryKey: COMMISSIONS_KEY })
      toast.success(
        rateBps > 0
          ? `${name}: ${percentLabel(rateBps, locale)} de lo cobrado`
          : hasServices
            ? `${name}: comisiona solo por sus servicios`
            : `${name}: no cobra comisión`,
        onSaved ? { action: { label: "Volver a Finanzas", onClick: onSaved } } : undefined,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, { formMessage: financeFormMessage, fieldMap: { rateBps: "percent" } })
  const kind = useStore(form.store, (state) => state.values.kind)
  const key = `${agreement?.professionalUserId ?? ""}:${editing?.start ?? ""}:${current}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: cada apertura parte de lo que vale hoy para esa persona, sin pisar lo que se escribe.
  useEffect(() => {
    if (open) form.reset(initial)
  }, [key, form, open])

  const first = agreement !== null && !agreement.hasRate
  const percentHelp = first
    ? "Es su primer porcentaje: vale también para lo ya cobrado de lo que atendió que aún no se paga."
    : current > 0
      ? `Hoy tiene ${percentLabel(current, locale)}. El nuevo vale para lo que se atienda desde ahora; lo atendido antes conserva lo que tenía, aunque se cobre después. Se le avisa del cambio.`
      : "Vale para lo que se atienda desde ahora; lo atendido antes conserva lo que tenía. Se le avisa del cambio."
  const keeps =
    current > 0
      ? " Lo que atendió hasta ahora conserva lo que tenía y se le paga en Finanzas › Comisiones."
      : ""
  const noneHelp = hasServices
    ? `Desde ahora comisiona solo por sus servicios con comisión; lo demás que atienda no comisiona.${keeps}`
    : `${current > 0 ? "Desde ahora no" : "No"} comisiona por lo que atiende, y deja de aparecer en el mes cuando no tenga nada por pagar.${keeps} Si tiene un sueldo, se paga en Gastos.`

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title={agreement?.hasRate ? "Cambiar su comisión" : "Su comisión"}
      description={`Lo que se lleva ${name} de lo cobrado por lo que atiende.`}
      submitLabel="Guardar"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="kind">
          {(field) => (
            <field.Group legend="Cómo comisiona" className="gap-3">
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  tone="primary"
                  columns={(agreement?.attends ?? true) ? 2 : undefined}
                  value={field.state.value}
                  options={RATE_KINDS(hasServices, agreement?.attends ?? true)}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {kind === "porcentaje" ? (
          <form.AppField name="percent">
            {(field) => (
              <field.TextField
                label="Porcentaje de lo cobrado (%)"
                description={percentHelp}
                inputMode="decimal"
                autoComplete="off"
                inputClassName="w-32"
              />
            )}
          </form.AppField>
        ) : (
          <p className="text-sm text-muted-foreground">{noneHelp}</p>
        )}
        {hasServices && kind === "porcentaje" ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            Sus servicios con comisión distinta no cambian.
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

// --- Comisión distinta para un servicio ------------------------------------------------------

/** Con un porcentaje general, «otro»; sin él, no hay otro respecto de qué. */
const SERVICE_KINDS = (hasGeneral: boolean) => [
  { value: "percent", label: hasGeneral ? "Otro porcentaje" : "Un porcentaje" },
  { value: "fixed", label: "Monto fijo por cada uno" },
]

function ServiceCommissionDrawer({
  editing,
  open,
  onClose,
  currency,
  locale,
}: {
  editing: Extract<Editing, { kind: "service" }> | null
  open: boolean
  onClose: () => void
  currency: string
  locale: string
}) {
  const queryClient = useQueryClient()
  const agreement = editing?.agreement ?? null
  const exception = editing?.exception ?? null
  const name = agreement?.professionalName ?? ""
  // El monto va en la moneda del precio del servicio: la comisión va en la moneda de lo cobrado.
  const [picked, setPicked] = useState<{ id: string; priceCents: number; currency: string; billingMode: string } | null>(null)
  const service =
    picked ??
    (exception?.serviceCurrency
      ? {
          id: exception.serviceId,
          priceCents: exception.servicePriceCents ?? 0,
          currency: exception.serviceCurrency,
          billingMode: exception.billingMode ?? "treatment",
        }
      : null)
  const amountCurrency = service?.currency ?? currency
  const initial = {
    serviceId: exception?.serviceId ?? "",
    kind: exception?.fixedCents !== null && exception?.fixedCents !== undefined ? "fixed" : "percent",
    percent: exception?.rateBps !== null && exception?.rateBps !== undefined ? percentInput(exception.rateBps, locale) : "",
    // Un monto que quedó en otra moneda se escribe de nuevo: nunca se convierte.
    amount:
      exception?.fixedCents && !exceptionStale(exception)
        ? formatMoneyInput(exception.fixedCents, exception.fixedCurrency ?? currency, locale)
        : "",
  }
  const form = useAppForm({
    defaultValues: initial,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.serviceId) fields.serviceId = "Elige el servicio."
        if (value.kind === "percent" && rateBpsFromPercent(value.percent) === null)
          fields.percent = "Escribe un porcentaje entre 0 y 100, con dos decimales como máximo."
        const amount = parseAmount(value.amount, amountCurrency, locale)
        if (value.kind === "fixed" && (amount === null || amount <= 0)) fields.amount = "Escribe un monto mayor que cero."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!agreement) return
      await setCommissionExceptionApi({
        professionalUserId: agreement.professionalUserId,
        serviceId: value.serviceId,
        ...(value.kind === "fixed"
          ? { fixedCents: parseAmount(value.amount, amountCurrency, locale) ?? 0 }
          : { rateBps: rateBpsFromPercent(value.percent) ?? 0 }),
      })
      void queryClient.invalidateQueries({ queryKey: COMMISSIONS_KEY })
      toast.success(firstForService ? "Guardado: vale también para lo ya cobrado de ese servicio que aún no se paga" : "Guardado: vale para lo que se atienda desde ahora")
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    formMessage: financeFormMessage,
    fieldMap: { rateBps: "percent", fixedCents: "amount" },
  })
  const kind = useStore(form.store, (state) => state.values.kind)
  const amountText = useStore(form.store, (state) => state.values.amount)
  const serviceId = useStore(form.store, (state) => state.values.serviceId)
  const typed = parseAmount(amountText, amountCurrency, locale)
  const overPrice = service !== null && service.priceCents > 0 && typed !== null && typed > service.priceCents
  // Sin porcentaje general, lo ya cobrado del servicio no tenía comisión: la primera vale también para eso.
  const firstForService =
    agreement !== null &&
    !agreement.hasRate &&
    serviceId !== "" &&
    !agreement.exceptions.some((item) => item.serviceId === serviceId)
  const key = `${agreement?.professionalUserId ?? ""}:${exception?.serviceId ?? ""}:${exception?.rateBps ?? ""}:${exception?.fixedCents ?? ""}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: cada apertura parte del servicio elegido (o de nada), sin pisar lo que se escribe.
  useEffect(() => {
    if (!open) return
    setPicked(null)
    form.reset(initial)
  }, [key, form, open])

  const instead = agreement && agreement.rateBps > 0 ? `, en vez de su ${percentLabel(agreement.rateBps, locale)}` : ""
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title={
        exception
          ? `Cambiar · ${exception.serviceName}`
          : (agreement?.rateBps ?? 0) > 0
            ? "Comisión distinta para un servicio"
            : "Comisión por un servicio"
      }
      description={`Para ${name}${instead}. ${
        firstForService
          ? "Es la primera para este servicio: vale también para lo ya cobrado de él que aún no se paga. Lo demás que atiende no comisiona; si además se lleva un porcentaje de todo, ponlo primero con «Poner su porcentaje»."
          : "Vale para lo que se atienda desde ahora: lo atendido antes conserva lo que tenía, aunque se cobre después."
      }`}
      submitLabel="Guardar"
    >
      <div className="flex flex-col gap-4">
        {exception ? null : (
          <form.AppField name="serviceId">
            {(field) => (
              <field.Control label="Servicio">
                {(control) => (
                  <ServiceSelect
                    id={control.id}
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(chosen) => {
                      field.handleChange(chosen?.id ?? "")
                      setPicked(
                        chosen
                          ? { id: chosen.id, priceCents: chosen.priceCents, currency: chosen.currency, billingMode: chosen.billingMode }
                          : null,
                      )
                    }}
                    placeholder="Busca el servicio"
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        )}
        <form.AppField name="kind">
          {(field) => (
            <field.Group legend="Cómo se le paga" className="gap-3">
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  tone="primary"
                  value={field.state.value}
                  options={SERVICE_KINDS((agreement?.rateBps ?? 0) > 0)}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {kind === "fixed" ? (
          <form.AppField name="amount">
            {(field) => (
              <field.TextField
                label={`Monto en ${currencyWord(amountCurrency, locale)}`}
                description={
                  service === null ? (
                    "Elige primero el servicio: el monto va en la moneda de su precio."
                  ) : overPrice ? (
                    <span className="font-medium text-foreground">
                      Es más que el precio del servicio ({formatMoney(service.priceCents, service.currency, locale)}). Nunca se
                      paga más de lo cobrado, así que no llegará a pagarse entero.
                    </span>
                  ) : service.billingMode === "session" ? (
                    "Se gana en cada sesión que se cobre, nunca más de lo cobrado."
                  ) : (
                    "Lo mismo por cada uno, aunque se cobre con descuento; si se paga en partes, en proporción a lo pagado. Nunca más de lo cobrado."
                  )
                }
                disabled={service === null}
                inputMode="decimal"
                inputClassName="w-40"
              />
            )}
          </form.AppField>
        ) : (
          <form.AppField name="percent">
            {(field) => (
              <field.TextField
                label="Porcentaje de lo cobrado (%)"
                description={
                  agreement && agreement.rateBps > 0
                    ? `De lo cobrado de ese servicio, en vez de su ${percentLabel(agreement.rateBps, locale)}.`
                    : "De lo cobrado de ese servicio."
                }
                inputMode="decimal"
                inputClassName="w-28"
              />
            )}
          </form.AppField>
        )}
      </div>
    </FormDrawer>
  )
}

/** El enlace a la comisión de una persona en Configuración (desde Finanzas o su liquidación). */
export function AgreementLink({
  professionalUserId,
  children,
  className,
  openRate = false,
  label,
}: {
  professionalUserId: string
  children: ReactNode
  className?: string
  /** Abre allí su panel del porcentaje (quien atendió sin comisión decidida). */
  openRate?: boolean
  /** Nombre accesible, si el texto a la vista no dice de quién es. */
  label?: string
}) {
  return (
    <Link
      to="/settings/commissions"
      search={{ profesional: professionalUserId, ...(openRate ? { editar: "porcentaje" as const } : {}) }}
      aria-label={label}
      className={cn("font-medium text-primary-soft-foreground underline-offset-2 hover:underline", className)}
    >
      {children}
    </Link>
  )
}
