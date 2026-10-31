import { FISCAL_DISCLAIMER } from "@odentia/clinical"
import { Badge, Button, cn, FieldGroup, FieldLegend, FieldSet, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  common,
  EmptyState,
  ErrorState,
  FormDrawer,
  PageHeader,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, Wallet } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { useReceptionName } from "../../lib/agent-names"
import { usePermission, useCan } from "../../lib/crm"
import { type OrgProfile, saveOrgPrinting, useOrgProfile } from "../../lib/org"
import {
  createPaymentMethodApi,
  fetchPaymentMethods,
  isCashMethod,
  movePaymentMethodApi,
  PAYMENT_TYPE_CODES,
  type PaymentMethod,
  type PaymentTypeCode,
  paymentTypeLabel,
  updatePaymentMethodApi,
} from "../../lib/payment-methods"
import { PaymentMethodRowsSkeleton, PaymentMethodsPageSkeleton, TicketRowsSkeleton } from "../../components/skeletons/settings"
import { settingsPrimary } from "../../lib/screen-rules"

export const Route = createFileRoute("/_org/settings/payment-methods")({
  pendingComponent: PaymentMethodsPageSkeleton,
  component: PaymentMethodsPage,
})

const SUBTITLE = "Con qué se cobra en caja y cómo salen el ticket y el presupuesto."

/** La tarjeta de página, la misma en toda Configuración. */
const CARD = "elevated flex min-w-0 flex-col rounded-xl border bg-card"

const RECEIPT_WIDTHS = { "80": "Térmica de 80 mm", "58": "Térmica de 58 mm" } as const
const SHEET_SIZES = { A4: "A4 · 210 × 297 mm", Letter: "Carta · 216 × 279 mm" } as const

/** Clave de la lista completa (también los apagados), la que edita esta pantalla. */
const METHODS_KEY = ["payment-methods", false] as const

/** Qué hace el tipo del medio en caja, dicho con palabras. */
function typeBehavior(typeCode: string): string {
  return isCashMethod(typeCode) ? "se cuenta al cerrar caja" : "pide número de operación"
}

/**
 * Medios de pago y ticket: la lista de medios con los que se cobra —caja ofrece
 * los encendidos, en este orden, y el agente responde con la misma lista— y lo
 * que se imprime. Un medio se añade y se edita en la superficie lateral; su
 * interruptor guarda al momento, y el orden se cambia subiendo y bajando.
 * Apagar un medio no altera los cobros anteriores: el ticket conserva lo suyo.
 */
function PaymentMethodsPage() {
  const receptionName = useReceptionName()
  const can = useCan()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const queryClient = useQueryClient()
  const methodsQuery = useQuery({
    queryKey: METHODS_KEY,
    queryFn: () => fetchPaymentMethods(false),
    enabled: canRead,
  })
  const profileQuery = useOrgProfile()
  /** `"new"` añade un medio; un medio, lo edita. El formulario es el mismo. */
  const [methodForm, setMethodForm] = useState<"new" | PaymentMethod | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  /** Lo último que se movió: se dice y el foco vuelve a su botón. */
  const [moved, setMoved] = useState<{ id: string; direction: "up" | "down"; said: string } | null>(
    null,
  )
  const listRef = useRef<HTMLUListElement | null>(null)

  // La lista que edita esta pantalla y la que ofrece caja al cobrar.
  const refreshMethods = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["payment-methods"] }),
      queryClient.invalidateQueries({ queryKey: ["org-payment-methods"] }),
    ])

  const toggleMutation = useMutation({
    mutationFn: (row: PaymentMethod) => updatePaymentMethodApi(row.id, { isActive: !row.isActive }),
    onSuccess: async ({ data }) => {
      toast.success(
        data.isActive
          ? `${data.name} vuelve a ofrecerse al cobrar`
          : `${data.name} ya no se ofrece al cobrar. Los cobros anteriores se conservan.`,
      )
      await refreshMethods()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  const moveMutation = useMutation({
    mutationFn: ({ row, direction }: { row: PaymentMethod; direction: "up" | "down" }) =>
      movePaymentMethodApi(row.id, direction),
    onSuccess: async ({ data }, { row, direction }) => {
      // El servidor devuelve la lista como quedó: se pinta sin esperar otra consulta.
      queryClient.setQueryData(METHODS_KEY, { data })
      const position = data.findIndex((item) => item.id === row.id) + 1
      setMoved({
        id: row.id,
        direction,
        said: `${row.name} quedó en el puesto ${position} de ${data.length}.`,
      })
      await queryClient.invalidateQueries({ queryKey: ["org-payment-methods"] })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  // Al reordenar, la fila cambia de sitio: el foco vuelve al botón que se usó o,
  // si quedó en un extremo y ese botón ya no sirve, al contrario.
  useEffect(() => {
    if (!moved) return
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
      `[data-move-of="${moved.id}"]`,
    )
    const same = [...(buttons ?? [])].find((button) => button.dataset.move === moved.direction)
    const other = [...(buttons ?? [])].find((button) => button.dataset.move !== moved.direction)
    const target = same && !same.disabled ? same : other
    target?.focus()
  }, [moved])

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Medios de pago y ticket" subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const methods = methodsQuery.data
    ? [...methodsQuery.data.data].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      )
    : undefined
  // Lo que nunca llegó se dice; un fallo al actualizar no retira la lista que ya estaba.
  const neverLoaded = methodsQuery.isError && methods === undefined
  const noneActive =
    methods !== undefined && methods.length > 0 && methods.every((row) => !row.isActive)
  const busy = moveMutation.isPending || toggleMutation.isPending

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Medios de pago y ticket"
        subtitle={SUBTITLE}
        primary={methods && methods.length > 0 ? settingsPrimary("paymentMethods", can, () => setMethodForm("new")) : undefined}
      />

      <section aria-labelledby="payment-methods-title" className={CARD}>
        <div className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
          <h2 id="payment-methods-title" className="font-heading text-base font-medium">
            Medios de pago
          </h2>
          <p className="text-sm text-muted-foreground">
            Caja ofrece los encendidos, en este orden, y {receptionName} responde con esta misma
            lista.
          </p>
        </div>
        {neverLoaded ? (
          <div className="px-4 pb-4">
            <ErrorState
              title="No pudimos cargar los medios de pago"
              message="Comprueba tu conexión y vuelve a intentarlo."
              onRetry={() => void methodsQuery.refetch()}
            />
          </div>
        ) : methods === undefined ? (
          <SkeletonRegion message="Cargando los medios de pago…">
            <PaymentMethodRowsSkeleton />
          </SkeletonRegion>
        ) : methods.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              icon={Wallet}
              title="Aún no hay medios de pago"
              description="Sin al menos uno, caja no puede cobrar."
              actionLabel={canWrite ? "Agrega el primer medio de pago" : undefined}
              onAction={canWrite ? () => setMethodForm("new") : undefined}
            />
          </div>
        ) : (
          <>
            <ul ref={listRef} className="flex flex-col">
              {methods.map((row, index) => (
                <li
                  key={row.id}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-3",
                    methodForm !== "new" && methodForm?.id === row.id && "bg-primary-soft/40",
                  )}
                >
                  <div className="flex min-w-48 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={cn("font-medium", !row.isActive && "text-muted-foreground")}>
                        {row.name}
                      </span>
                      {row.isActive ? null : <Badge variant="secondary">Apagado</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {paymentTypeLabel(row.typeCode)} · {typeBehavior(row.typeCode)}
                    </span>
                  </div>
                  {canWrite ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        aria-label={`Subir ${row.name}`}
                        data-move="up"
                        data-move-of={row.id}
                        disabled={index === 0 || busy}
                        onClick={() => moveMutation.mutate({ row, direction: "up" })}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        aria-label={`Bajar ${row.name}`}
                        data-move="down"
                        data-move-of={row.id}
                        disabled={index === methods.length - 1 || busy}
                        onClick={() => moveMutation.mutate({ row, direction: "down" })}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                      <Switch
                        className="mx-2"
                        checked={row.isActive}
                        disabled={busy}
                        aria-label={`${row.isActive ? "Apagar" : "Encender"} ${row.name}`}
                        onCheckedChange={() => toggleMutation.mutate(row)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setMethodForm(row)}
                      >
                        Editar
                        <span className="sr-only"> {row.name}</span>
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {/* Lo que se movió se anuncia: la lista cambia de orden sin otro aviso. */}
            <p role="status" className="sr-only">
              {moved?.said ?? ""}
            </p>
            <p className="border-t px-4 pt-2.5 pb-3.5 text-sm text-muted-foreground">
              {noneActive ? (
                <span className="font-medium text-warning">
                  Ningún medio está encendido: caja no puede cobrar.{" "}
                </span>
              ) : null}
              El interruptor guarda al momento. Apagar un medio no cambia los cobros que ya se
              hicieron con él.
            </p>
          </>
        )}
      </section>

      <TicketCard
        profile={profileQuery.data}
        failed={profileQuery.isError && profileQuery.data === undefined}
        onRetry={() => void profileQuery.refetch()}
        onEdit={canWrite ? () => setTicketOpen(true) : undefined}
      />

      {methodForm ? (
        <PaymentMethodForm
          key={methodForm === "new" ? "new" : methodForm.id}
          method={methodForm === "new" ? null : methodForm}
          onClose={() => setMethodForm(null)}
          onSaved={async () => {
            setMethodForm(null)
            await refreshMethods()
          }}
        />
      ) : null}
      {ticketOpen && profileQuery.data ? (
        <TicketForm
          profile={profileQuery.data}
          onClose={() => setTicketOpen(false)}
          onSaved={async () => {
            setTicketOpen(false)
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["org-profile"] }),
              // Caja lee el ticket de su propia consulta del perfil.
              queryClient.invalidateQueries({ queryKey: ["org-finance-profile"] }),
            ])
          }}
        />
      ) : null}
    </div>
  )
}

function TicketRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-56 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words">{children}</dd>
    </div>
  )
}

/**
 * Lo que se imprime: ancho del ticket, tamaño de hoja y frase al pie. Se lee
 * aquí y se edita en la superficie lateral, como la lista de arriba.
 */
function TicketCard({
  profile,
  failed,
  onRetry,
  onEdit,
}: {
  /** `undefined` mientras carga; `null` si la clínica aún no tiene sus datos. */
  profile: OrgProfile | null | undefined
  failed: boolean
  onRetry: () => void
  onEdit?: () => void
}) {
  return (
    <section aria-labelledby="ticket-title" className={CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-3">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <h2 id="ticket-title" className="font-heading text-base font-medium">
            Ticket e impresión
          </h2>
          <p className="text-sm text-muted-foreground">
            El ticket y la hoja de cierre salen en térmica; el presupuesto, en hoja, con sus
            condiciones.
          </p>
        </div>
        {profile && onEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            Editar
            <span className="sr-only"> el ticket y la impresión</span>
          </Button>
        ) : null}
      </div>
      {failed ? (
        <div className="px-4 pb-4">
          <ErrorState
            title="No pudimos cargar el ticket"
            message="Comprueba tu conexión y vuelve a intentarlo."
            onRetry={onRetry}
          />
        </div>
      ) : profile === undefined ? (
        <SkeletonRegion message="Cargando el ticket…">
          <TicketRowsSkeleton />
        </SkeletonRegion>
      ) : profile === null ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          Faltan los datos de la clínica: con ellos se sabe la moneda y el papel.{" "}
          <Link
            to="/settings"
            className="font-bold text-primary underline-offset-4 hover:underline"
          >
            Completar Datos de la clínica
          </Link>
        </p>
      ) : (
        <dl className="flex flex-col">
          <TicketRow label="Ancho del ticket">
            {RECEIPT_WIDTHS[profile.receiptWidth === "58" ? "58" : "80"]}
          </TicketRow>
          <TicketRow label="Tamaño de hoja">
            {SHEET_SIZES[profile.sheetSize === "Letter" ? "Letter" : "A4"]}
          </TicketRow>
          <TicketRow label="Frase al pie del ticket">{profile.ticketFooter}</TicketRow>
          <TicketRow label="Días de vigencia del presupuesto">
            {profile.budgetValidDays ?? 30}
          </TicketRow>
          <TicketRow label="Cómo se paga">
            {profile.budgetPaymentTerms || "Sin texto: no sale en el presupuesto"}
          </TicketRow>
          <TicketRow label="Si el importe cambia">
            {profile.budgetChangeTerms || "Sin texto: no sale en el presupuesto"}
          </TicketRow>
        </dl>
      )}
    </section>
  )
}

const methodSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del medio de pago")
    .max(120, "El nombre admite hasta 120 caracteres"),
  typeCode: z.enum(PAYMENT_TYPE_CODES, "Elige el tipo del medio de pago de la lista"),
})

/** Alta y edición de un medio de pago, en la superficie lateral. */
function PaymentMethodForm({
  method,
  onClose,
  onSaved,
}: {
  /** El medio que se edita; `null` crea uno nuevo, que va al final de la lista. */
  method: PaymentMethod | null
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const initialType = (PAYMENT_TYPE_CODES as readonly string[]).includes(method?.typeCode ?? "")
    ? (method?.typeCode as PaymentTypeCode)
    : "1"
  const save = useMutation({
    mutationFn: (values: { name: string; typeCode: PaymentTypeCode }) =>
      method ? updatePaymentMethodApi(method.id, values) : createPaymentMethodApi(values),
  })
  const form = useAppForm({
    defaultValues: { name: method?.name ?? "", typeCode: initialType as PaymentTypeCode },
    validators: { onSubmit: methodSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({ name: value.name.trim(), typeCode: value.typeCode })
      toast.success(method ? "Medio de pago guardado" : "Medio de pago agregado")
      await onSaved()
    },
  })
  const surface = useFormSurface(form)
  const typeCode = useStore(form.store, (state) => state.values.typeCode)

  return (
    <FormDrawer
      {...surface}
      open
      title={method ? `Editar ${method.name}` : "Nuevo medio de pago"}
      description={
        method
          ? "Los cobros que ya se hicieron con él no cambian."
          : "Se añade al final de la lista; después puedes subirlo."
      }
      onClose={onClose}
      submitLabel={common.actions.save}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label="Nombre"
              maxLength={120}
              description="Como lo dice caja y como saldrá en el ticket."
            />
          )}
        </form.AppField>
        <form.AppField name="typeCode">
          {(field) => (
            <field.Control
              label="Tipo"
              description={
                isCashMethod(typeCode)
                  ? "El efectivo se cuenta al cerrar caja."
                  : "Al cobrar con él se pide el número de operación, y no entra en el conteo de caja."
              }
            >
              {(control) => (
                <ChoiceSelect
                  id={control.id}
                  name={control.name}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  value={field.state.value}
                  onBlur={control.onBlur}
                  onChange={(event) => field.handleChange(event.target.value as PaymentTypeCode)}
                >
                  {PAYMENT_TYPE_CODES.map((code) => (
                    <option key={code} value={code}>
                      {paymentTypeLabel(code)}
                    </option>
                  ))}
                </ChoiceSelect>
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

const ticketSchema = z.object({
  receiptWidth: z.enum(["58", "80"], "Elige el ancho del ticket: 58 u 80 mm"),
  sheetSize: z.enum(["A4", "Letter"], "Elige el tamaño de hoja: A4 o Carta"),
  ticketFooter: z
    .string()
    .trim()
    .min(1, "Escribe la frase al pie del ticket")
    .max(280, "La frase al pie admite hasta 280 caracteres"),
  budgetValidDays: z
    .string()
    .refine(
      (value) => /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 365,
      "Escribe un número de 1 a 365.",
    ),
  budgetPaymentTerms: z.string().max(2000, "Escribe como mucho 2000 caracteres."),
  budgetChangeTerms: z.string().max(2000, "Escribe como mucho 2000 caracteres."),
})

/** Ancho del ticket, tamaño de hoja y frase al pie, en la superficie lateral. */
function TicketForm({
  profile,
  onClose,
  onSaved,
}: {
  profile: OrgProfile
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const save = useMutation({ mutationFn: saveOrgPrinting })
  const form = useAppForm({
    defaultValues: {
      receiptWidth: profile.receiptWidth === "58" ? ("58" as const) : ("80" as const),
      sheetSize: profile.sheetSize === "Letter" ? ("Letter" as const) : ("A4" as const),
      ticketFooter: profile.ticketFooter,
      budgetValidDays: String(profile.budgetValidDays ?? 30),
      budgetPaymentTerms: profile.budgetPaymentTerms ?? "",
      budgetChangeTerms: profile.budgetChangeTerms ?? "",
    } as {
      receiptWidth: "58" | "80"
      sheetSize: "A4" | "Letter"
      ticketFooter: string
      budgetValidDays: string
      budgetPaymentTerms: string
      budgetChangeTerms: string
    },
    validators: { onSubmit: ticketSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        receiptWidth: value.receiptWidth,
        sheetSize: value.sheetSize,
        ticketFooter: value.ticketFooter.trim(),
        budgetValidDays: Number(value.budgetValidDays),
        budgetPaymentTerms: value.budgetPaymentTerms.trim() || null,
        budgetChangeTerms: value.budgetChangeTerms.trim() || null,
      })
      toast.success("Ticket guardado")
      await onSaved()
    },
  })
  const surface = useFormSurface(form)

  return (
    <FormDrawer
      {...surface}
      open
      title="Ticket e impresión"
      description="Vale para los tickets y presupuestos que se impriman desde ahora. Lo ya entregado no cambia."
      onClose={onClose}
      submitLabel={common.actions.save}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(36rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="receiptWidth">
          {(field) => (
            <field.Control
              label="Ancho del ticket"
              description="El de la impresora térmica: en él salen el ticket y la hoja de cierre de caja."
            >
              {(control) => (
                <ChoiceSelect
                  id={control.id}
                  name={control.name}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  value={field.state.value}
                  onBlur={control.onBlur}
                  onChange={(event) =>
                    field.handleChange(event.target.value === "58" ? "58" : "80")
                  }
                >
                  <option value="80">{RECEIPT_WIDTHS["80"]}</option>
                  <option value="58">{RECEIPT_WIDTHS["58"]}</option>
                </ChoiceSelect>
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="sheetSize">
          {(field) => (
            <field.Control label="Tamaño de hoja" description="En ella sale el presupuesto.">
              {(control) => (
                <ChoiceSelect
                  id={control.id}
                  name={control.name}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  value={field.state.value}
                  onBlur={control.onBlur}
                  onChange={(event) =>
                    field.handleChange(event.target.value === "Letter" ? "Letter" : "A4")
                  }
                >
                  <option value="A4">{SHEET_SIZES.A4}</option>
                  <option value="Letter">{SHEET_SIZES.Letter}</option>
                </ChoiceSelect>
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="ticketFooter">
          {(field) => (
            <field.TextField
              label="Frase al pie del ticket"
              maxLength={280}
              description={`Va antes de «${FISCAL_DISCLAIMER}», que todo ticket lleva siempre. Los tickets ya emitidos conservan la frase con la que salieron.`}
            />
          )}
        </form.AppField>
        <FieldSet>
          <FieldLegend>Condiciones del presupuesto</FieldLegend>
          <FieldGroup>
            <form.AppField name="budgetValidDays">
              {(field) => (
                <field.TextField
                  label="Días de vigencia del presupuesto"
                  inputMode="numeric"
                  inputClassName="max-w-32"
                  description="Con esto se propone su fecha; se puede cambiar en cada uno."
                />
              )}
            </form.AppField>
            <form.AppField name="budgetPaymentTerms">
              {(field) => (
                <field.TextareaField
                  label="Cómo se paga"
                  rows={3}
                  maxLength={2000}
                  description="Vacío, esa parte no sale en el presupuesto."
                />
              )}
            </form.AppField>
            <form.AppField name="budgetChangeTerms">
              {(field) => (
                <field.TextareaField
                  label="Si el importe cambia"
                  rows={3}
                  maxLength={2000}
                  description="Vacío, esa parte no sale en el presupuesto."
                />
              )}
            </form.AppField>
          </FieldGroup>
        </FieldSet>
      </div>
    </FormDrawer>
  )
}
