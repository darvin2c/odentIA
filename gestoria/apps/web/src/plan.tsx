import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  toast,
} from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  KpiCard,
  LoadingState,
  PageNotice,
  RadioChips,
  SubmitButton,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, CreditCard, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import { api } from "./lib/api"
import { when } from "./lib/pedidos"
import {
  AGENT_STOP_WORDS,
  CHARGE_WORDS,
  NOTICE_LABELS,
  noticeText,
  noticeTone,
  PAYMENT_WORDS,
  type PlanView,
  RECEIPT_WORDS,
  STATUS_WORDS,
  SUPPORT_KIND_LABELS,
  SUPPORT_STATUS_WORDS,
  type SupportKind,
} from "./lib/plan"
import { money, moneyInput, readMoney } from "./lib/tienda"
import { shrinkPhoto } from "./piezas"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Plan y pagos» (lienzo B, paso B7): lo que la administración dice de la tienda (su plan, lo que
 * se le cobró, sus pagos y sus avisos) y pedirle ayuda. Solo el Dueño (el plan, decisión 7). Si
 * la administración no responde, se ve lo último que se supo y de cuándo es: la tienda sigue
 * funcionando igual.
 */

const PLAN_KEY = (storeId: string) => ["plan", storeId]

const day = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(iso),
  )

export function PlanPage() {
  const { store } = useStoreContext()
  const plan = useQuery({
    queryKey: PLAN_KEY(store.id),
    queryFn: () => api<PlanView>(`/api/tiendas/${store.id}/plan`),
  })
  return (
    <>
      <StoreHeader
        title="Plan y pagos"
        subtitle="Tu plan con gestorIA, lo que se te cobró y tus pagos."
      />
      {plan.isPending ? <LoadingState message="Cargando tu plan" /> : null}
      {plan.isError ? <ErrorState error={plan.error} onRetry={() => void plan.refetch()} /> : null}
      {plan.data ? <PlanBody view={plan.data} /> : null}
    </>
  )
}

function PlanBody({ view }: { view: PlanView }) {
  const state = view.state?.found ? view.state : null
  return (
    <>
      {view.stale && view.receivedAt ? (
        <PageNotice tone="aviso" label="Sin conexión">
          No pudimos consultar tu plan ahora. Esto es lo último que supimos ({when(view.receivedAt)}
          ). Tu tienda y Sofi siguen funcionando.
        </PageNotice>
      ) : null}
      {view.agentStop ? (
        <PageNotice tone="limite" label="Sofi en pausa">
          {AGENT_STOP_WORDS[view.agentStop]}
        </PageNotice>
      ) : null}
      {state?.notices
        // El límite que ya detuvo a Sofi lo dice el aviso de arriba: no se repite.
        .filter((notice) => !(view.agentStop && notice.level === "limite"))
        .map((notice) => {
          const tone = noticeTone(notice.level)
          return (
            <PageNotice key={notice.key} tone={tone} label={NOTICE_LABELS[tone]}>
              {noticeText(notice)}
            </PageNotice>
          )
        })}
      {state ? (
        <>
          <Summary state={state} />
          <Charges state={state} connected={view.connected} />
          <Payments state={state} view={view} />
        </>
      ) : (
        <EmptyState
          icon={CreditCard}
          title="Aún no hay datos de tu plan"
          description={
            view.stale || (view.connected && !view.receivedAt)
              ? "No pudimos consultarlo ahora. Tu tienda y Sofi funcionan igual; vuelve a mirar más tarde."
              : "Cuando tu cuenta esté lista, aquí verás tu plan, lo que se te cobra y tus pagos. Mientras, tu tienda funciona igual."
          }
        />
      )}
      <Support view={view} />
    </>
  )
}

type Known = NonNullable<PlanView["state"]>

function Summary({ state }: { state: Known }) {
  const { plan, access, budget } = state
  const statusNote = access?.trialEndsAt
    ? `Hasta el ${day(access.trialEndsAt)}`
    : access?.readOnlyAt
      ? `Paga antes del ${day(access.readOnlyAt)} para seguir`
      : undefined
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <KpiCard
        title="Tu plan"
        value={plan ? plan.name : "Sin plan"}
        description={
          plan
            ? `${money(plan.priceCents, plan.currency)} al mes${plan.creditCents ? ` · incluye ${money(plan.creditCents, plan.currency)} de uso` : ""}`
            : "Te asignamos uno cuando tu cuenta esté lista"
        }
      />
      <KpiCard
        title="Estado"
        value={access ? STATUS_WORDS[access.status] : "—"}
        description={statusNote}
      />
      {budget?.currency ? (
        <KpiCard
          title="Gasto de este periodo"
          value={money(budget.spentCents, budget.currency)}
          description={
            budget.capCents !== null
              ? `De un tope de ${money(budget.capCents, budget.currency)} · hasta el ${day(budget.periodEnd)}`
              : `Hasta el ${day(budget.periodEnd)}`
          }
          meter={
            budget.capCents
              ? {
                  value: Math.min(budget.spentCents, budget.capCents),
                  total: budget.capCents,
                  tone: budget.spentCents >= budget.capCents ? "danger" : "primary",
                }
              : undefined
          }
        />
      ) : (
        <KpiCard title="Gasto de este periodo" value="—" description="Sin consumo todavía" />
      )}
    </div>
  )
}

function Charges({ state, connected }: { state: Known; connected: boolean }) {
  const [paying, setPaying] = useState<Known["charges"][number] | null>(null)
  // Se sube un comprobante de lo que falta pagar, si hay cómo pagar y gestorIA está conectada.
  const canSend = connected && state.paymentMethods.length > 0
  return (
    <section aria-labelledby="plan-cobros" className="flex flex-col gap-3">
      <h2 id="plan-cobros" className="text-lg font-bold">
        Lo que se te cobró
      </h2>
      {state.charges.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay cobros.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.charges.map((charge) => (
            <li key={charge.id} className="rounded-xl border bg-card">
              <Collapsible>
                <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-4 text-left">
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block font-medium">
                      {day(charge.periodStart)} al {day(charge.periodEnd)}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {charge.paidCents > 0 && charge.paidCents < charge.amountCents
                        ? `Pagaste ${money(charge.paidCents, charge.currency)}`
                        : charge.dueAt && charge.status === "pendiente"
                          ? `Vence el ${day(charge.dueAt)}`
                          : null}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">
                    {money(charge.amountCents, charge.currency)}
                  </span>
                  <Badge variant={charge.status === "pagada" ? "secondary" : "outline"}>
                    {CHARGE_WORDS[charge.status] ?? charge.status}
                  </Badge>
                  <ChevronDown aria-hidden className="size-4 text-muted-foreground" />
                  <span className="sr-only">Ver el detalle</span>
                </CollapsibleTrigger>
                {canSend && charge.paidCents < charge.amountCents && charge.status !== "anulada" ? (
                  <div className="px-4 pb-3">
                    <Button size="sm" variant="outline" onClick={() => setPaying(charge)}>
                      <Upload aria-hidden />
                      Subir comprobante
                    </Button>
                  </div>
                ) : null}
                <CollapsibleContent>
                  <ul className="flex flex-col gap-1 border-t px-4 py-3 text-sm">
                    {charge.lines.map((line) => (
                      <li
                        key={`${line.kind}-${line.description}`}
                        className="flex justify-between gap-3"
                      >
                        <span className="min-w-0">
                          {line.description}
                          {line.quantity > 1 ? ` · ${line.quantity}` : ""}
                        </span>
                        <span className="tabular-nums">
                          {money(line.amountCents, charge.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            </li>
          ))}
        </ul>
      )}
      {paying ? (
        <ReceiptSheet charge={paying} state={state} onClose={() => setPaying(null)} />
      ) : null}
    </section>
  )
}

/**
 * Subir el comprobante de un cobro: sale a la administración, que lo revisa y confirma el pago.
 * Una foto (se achica antes de subirla) o un PDF, hasta 1,5 MB.
 */
function ReceiptSheet({
  charge,
  state,
  onClose,
}: {
  charge: Known["charges"][number]
  state: Known
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const owed = charge.amountCents - charge.paidCents
  const fileInput = useRef<HTMLInputElement>(null)
  const schema = z.object({
    methodCode: z.string().min(1, "Elige cómo pagaste"),
    amountCents: z
      .string()
      .refine((text) => Boolean(readMoney(text, charge.currency)), "Escribe cuánto pagaste"),
    file: z
      .instanceof(File, { message: "Elige la foto o el PDF del comprobante" })
      .nullable()
      .refine((file) => file !== null, "Elige la foto o el PDF del comprobante"),
  })
  const form = useAppForm({
    defaultValues: {
      methodCode: state.paymentMethods[0]?.code ?? "",
      amountCents: moneyInput(owed, charge.currency),
      file: null as File | null,
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const body = new FormData()
      body.set("chargeId", charge.id)
      body.set("amountCents", String(readMoney(value.amountCents, charge.currency)))
      body.set("methodCode", value.methodCode)
      if (value.file)
        body.set(
          "archivo",
          value.file.type === "application/pdf" ? value.file : await shrinkPhoto(value.file),
          "comprobante",
        )
      await api(`/api/tiendas/${store.id}/plan/comprobante`, { method: "POST", form: body })
      await queryClient.invalidateQueries({ queryKey: PLAN_KEY(store.id) })
      toast.success("Comprobante subido: lo revisamos y confirmamos tu pago.")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Subir comprobante"
      description={`Del cobro del ${day(charge.periodStart)} al ${day(charge.periodEnd)}. Lo revisamos y confirmamos tu pago.`}
      onClose={onClose}
      submitLabel="Subir comprobante"
    >
      <form.AppField name="methodCode">
        {(field) => {
          const instructions = state.paymentMethods.find(
            (one) => one.code === field.state.value,
          )?.instructions
          return (
            <field.SelectField
              label="Cómo pagaste"
              options={state.paymentMethods.map((one) => ({ value: one.code, label: one.name }))}
              description={
                instructions ? (
                  <span className="whitespace-pre-wrap">{instructions}</span>
                ) : undefined
              }
            />
          )
        }}
      </form.AppField>
      <form.AppField name="amountCents">
        {(field) => (
          <field.Control
            label="Cuánto pagaste"
            description={`Falta pagar ${money(owed, charge.currency)}.`}
          >
            {(control) => (
              <MoneyInput
                control={control}
                currency={charge.currency}
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      <form.AppField name="file">
        {(field) => (
          <field.Control
            label="Foto o PDF del comprobante"
            description="JPG, PNG, WebP o PDF, hasta 1,5 MB."
          >
            {(control) => (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(e) => {
                    field.handleChange(e.target.files?.[0] ?? null)
                    field.handleBlur()
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    id={control.id}
                    variant="outline"
                    type="button"
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onClick={() => fileInput.current?.click()}
                  >
                    {field.state.value ? "Elegir otro" : "Elegir el archivo"}
                  </Button>
                  {field.state.value ? (
                    <span className="min-w-0 truncate text-sm">{field.state.value.name}</span>
                  ) : null}
                </div>
              </>
            )}
          </field.Control>
        )}
      </form.AppField>
    </FormDrawer>
  )
}

function Payments({ state, view }: { state: Known; view: PlanView }) {
  return (
    <section aria-labelledby="plan-pagos" className="flex flex-col gap-3">
      <h2 id="plan-pagos" className="text-lg font-bold">
        Tus pagos
      </h2>
      {view.pendingReceipts.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {view.pendingReceipts.map((receipt) => (
            <li key={receipt.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4">
              <span className="min-w-0 flex-1 basis-40 text-sm">
                {when(receipt.createdAt)}
                {receipt.reason ? (
                  <span className="block text-muted-foreground">{receipt.reason}</span>
                ) : null}
              </span>
              <span className="font-semibold tabular-nums">
                {money(
                  receipt.amountCents,
                  state.charges.find((one) => one.id === receipt.chargeId)?.currency ??
                    state.plan?.currency ??
                    "USD",
                )}
              </span>
              <Badge variant={receipt.status === "rechazado" ? "destructive" : "outline"}>
                {RECEIPT_WORDS[receipt.status]}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {state.payments.length === 0 && view.pendingReceipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay pagos.</p>
      ) : state.payments.length === 0 ? null : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {state.payments.map((payment) => (
            <li key={payment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4">
              <span className="min-w-0 flex-1 basis-40 text-sm">{when(payment.at)}</span>
              <span className="font-semibold tabular-nums">
                {money(payment.amountCents, payment.currency)}
              </span>
              <Badge variant={payment.status === "confirmado" ? "secondary" : "outline"}>
                {PAYMENT_WORDS[payment.status] ?? payment.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const askSchema = z.object({
  kind: z.enum(["pregunta", "problema", "cobro"]),
  question: z.string().trim().min(1, "Escribe tu pregunta").max(500, "Máximo 500 caracteres"),
  detail: z.string().max(4000, "Máximo 4000 caracteres"),
})

/**
 * Pedir ayuda al equipo de gestorIA sobre el plan o un cobro, y ver las respuestas de la tienda.
 * Lo de cada tarea está en la Ayuda de la cabecera, que también escribe a soporte para todo el equipo.
 */
function Support({ view }: { view: PlanView }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const form = useAppForm({
    defaultValues: { kind: "pregunta" as SupportKind, question: "", detail: "" },
    validators: { onSubmit: askSchema },
    onSubmit: async ({ value, formApi }) => {
      await api(`/api/tiendas/${store.id}/plan/ayuda`, {
        method: "POST",
        body: {
          kind: value.kind,
          question: value.question.trim(),
          detail: value.detail.trim() || undefined,
        },
      })
      formApi.reset({ kind: value.kind, question: "", detail: "" })
      await queryClient.invalidateQueries({ queryKey: PLAN_KEY(store.id) })
      toast.success("Tu pregunta quedó anotada. Te respondemos aquí.")
    },
  })
  const surface = useFormSurface(form)
  const cases = view.state?.found ? view.state.support : []
  return (
    <section
      aria-labelledby="plan-ayuda"
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="plan-ayuda" className="text-lg font-bold">
          Pedir ayuda
        </h2>
        <p className="text-sm text-muted-foreground">
          {view.connected
            ? "Escríbenos sobre tu plan, un cobro o algo que no funciona. Te respondemos aquí."
            : "Todavía no podemos recibir preguntas desde aquí."}
        </p>
      </div>
      {view.connected ? (
        <form noValidate onSubmit={surface.onSubmit} className="flex flex-col gap-4">
          <form.AppField name="kind">
            {(field) => (
              <field.Group legend="Sobre qué">
                {(control) => (
                  <RadioChips
                    id={control.id}
                    value={field.state.value}
                    options={Object.entries(SUPPORT_KIND_LABELS).map(([value, label]) => ({
                      value: value as SupportKind,
                      label,
                    }))}
                    onChange={(next) => field.handleChange(next)}
                    onBlur={control.onBlur}
                    aria-label="Sobre qué"
                    aria-describedby={control.describedBy}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
          <form.AppField name="question">
            {(field) => (
              <field.TextField
                label="Tu pregunta"
                maxLength={500}
                placeholder="Por ejemplo, ¿cómo subo el tope de gasto?"
              />
            )}
          </form.AppField>
          <form.AppField name="detail">
            {(field) => (
              <field.TextareaField label="Detalle (opcional)" maxLength={4000} rows={3} />
            )}
          </form.AppField>
          {surface.error ? (
            <p role="alert" className="text-sm text-danger">
              {surface.error}
            </p>
          ) : null}
          <SubmitButton type="submit" pending={surface.isSubmitting} className="self-start">
            Enviar
          </SubmitButton>
        </form>
      ) : null}
      {view.pendingSupport.length > 0 || cases.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {view.pendingSupport.map((pending) => (
            <li key={pending.createdAt} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium">{pending.question}</span>
                <Badge variant="outline">{pending.sent ? "Enviada" : "Por enviar"}</Badge>
              </div>
            </li>
          ))}
          {cases.map((kase) => (
            <li key={kase.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium">{kase.question}</span>
                <Badge variant="outline">{SUPPORT_STATUS_WORDS[kase.status] ?? kase.status}</Badge>
              </div>
              {kase.replies.map((reply) => (
                <div key={reply.at} className="rounded-md bg-muted/50 p-2">
                  <p className="whitespace-pre-wrap">{reply.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Equipo de gestorIA · {when(reply.at)}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
