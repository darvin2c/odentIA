import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  toast,
} from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  openSupportRequest,
  PageNotice,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, CreditCard, ReceiptText, Upload } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import { api } from "./lib/api"
import { listText } from "./lib/configuracion"
import { when } from "./lib/pedidos"
import {
  AGENT_STOP_WORDS,
  CHARGE_WORDS,
  NOTICE_LABELS,
  noticeText,
  noticeTone,
  owedOf,
  PAYMENT_WORDS,
  type PlanView,
  RECEIPT_WORDS,
  receiptHere,
  STATUS_WORDS,
  SUPPORT_STATUS_WORDS,
} from "./lib/plan"
import { money, moneyInput, readMoney } from "./lib/tienda"
import { shrinkPhoto } from "./piezas"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Plan y pagos» (lienzo B, paso B7; lienzo «gestorIA · Configuración, de nuevo», tablero 10): lo
 * que la administración dice de la tienda, de arriba abajo: lo que se debe y cuándo vence, el saldo
 * usado y el tope, cada pedido que cuenta (cuando el acuerdo lo mande), lo que se cobró y los
 * pagos. Nada se suma ni se calcula aquí: solo lo que falta de un cobro y lo que queda del saldo,
 * restando las dos cifras que manda la administración. Solo el
 * Dueño (el plan, decisión 7). Se pregunta desde la Ayuda de arriba, como en toda la tienda. Si
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
        subtitle="Cuánto te cobra gestorIA, qué tienes por pagar y lo que ya pagaste."
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
          <ToPay state={state} connected={view.connected} />
          <Balance state={state} receiptHere={receiptHere(state, view.connected)} />
          <Movements />
          <Charges state={state} />
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
      <Questions view={view} />
    </>
  )
}

type Known = NonNullable<PlanView["state"]>
type Charge = Known["charges"][number]

/**
 * El plan y su saldo (tablero 10), después de lo que se debe: el plan y su estado, cuánto del
 * saldo se usó y cuánto queda, y el tope, con lo que manda la administración (`plan` y `budget`
 * del acuerdo). No se dice «pagas X al mes» con el precio del plan: la cifra del mes la dirá la
 * administración cuando la mande; mientras, lo que se paga es lo de «Por pagar», arriba.
 */
function Balance({ state, receiptHere }: { state: Known; receiptHere: boolean }) {
  const { store } = useStoreContext()
  // Pedir otro tope es pedírselo a gestorIA: abre la Ayuda con el mensaje a soporte ya escrito,
  // para que la persona lo lea, lo complete y lo envíe ella. Soporte no escribe.
  const canAsk = store.permissions.includes("ayuda.pedir")
  const { plan, access, budget } = state
  // Lo que pasa del saldo lo dice la administración (`spentCents`); gestorIA no lo suma ni le
  // pone impuestos: cada cobro, con su total, sale en «Por pagar».
  const over = budget?.currency ? budget.spentCents : null
  const sentence = !plan
    ? "Te asignamos uno cuando tu cuenta esté lista. Mientras, tu tienda funciona igual."
    : over === null
      ? null
      : over > 0
        ? `Este mes, lo que usó Sofi pasó tu saldo en ${money(over, budget?.currency as string)}, sin impuestos: va en tu próximo cobro.`
        : "Hasta hoy, lo que usó Sofi este mes cabe en tu saldo."
  const credit = budget?.currency && budget.creditCents > 0 ? budget : null
  const currency = credit?.currency ?? ""
  const used = credit ? Math.min(credit.creditUsedCents, credit.creditCents) : 0
  const left = credit ? credit.creditCents - used : 0
  const methods = state.paymentMethods.map((one) => one.name)
  return (
    <section
      aria-labelledby="plan-saldo"
      className="elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="plan-saldo" className="text-lg font-bold">
            {plan ? `Plan ${plan.name}` : "Sin plan todavía"}
          </h2>
          {access ? (
            <Badge variant={access.status === "activa" ? "secondary" : "outline"}>
              {STATUS_WORDS[access.status]}
            </Badge>
          ) : null}
        </div>
        {sentence ? <p className="text-sm text-muted-foreground">{sentence}</p> : null}
      </div>
      {credit ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Usaste {money(used, currency)} de tu saldo de {money(credit.creditCents, currency)} ·{" "}
            <span className="font-semibold">te quedan {money(left, currency)}</span>
          </p>
          <div
            role="progressbar"
            aria-label="Saldo usado este mes"
            aria-valuemin={0}
            aria-valuemax={credit.creditCents}
            aria-valuenow={used}
            aria-valuetext={`${money(used, currency)} de ${money(credit.creditCents, currency)}`}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn("h-full rounded-full", left === 0 ? "bg-warning" : "bg-primary")}
              style={{ width: `${(used / credit.creditCents) * 100}%` }}
            />
          </div>
        </div>
      ) : null}
      <dl className="grid gap-4 border-t pt-4 text-sm sm:grid-cols-3">
        {budget?.currency ? (
          <Fact
            term="Tu tope del mes"
            value={budget.capCents !== null ? money(budget.capCents, budget.currency) : "Sin tope"}
            note={
              budget.capCents === null
                ? "Si quieres uno, pídelo."
                : budget.spentCents > 0
                  ? `Llevas ${money(budget.spentCents, budget.currency)} por encima de tu saldo. Si te acercas, te avisamos.`
                  : "Si te acercas, te avisamos."
            }
            action={
              canAsk ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto min-h-11 self-start p-0 sm:min-h-0"
                  onClick={() =>
                    openSupportRequest(
                      budget.capCents !== null
                        ? `Quiero cambiar mi tope del mes (hoy ${money(budget.capCents, budget.currency ?? "")}) a: `
                        : "Quiero poner un tope del mes de: ",
                    )
                  }
                >
                  {budget.capCents !== null ? "Pedir otro tope" : "Pedir un tope"}
                </Button>
              ) : null
            }
          />
        ) : null}
        {access?.readOnlyAt ? (
          <Fact
            term="Para seguir"
            value={`Paga antes del ${day(access.readOnlyAt)}`}
            note="Después tu tienda queda solo para mirar hasta que pagues."
          />
        ) : access?.trialEndsAt ? (
          <Fact term="Tu prueba" value={`Hasta el ${day(access.trialEndsAt)}`} />
        ) : budget ? (
          <Fact term="Tu mes cierra" value={day(budget.periodEnd)} note="Ese día sale tu cobro." />
        ) : null}
        {methods.length > 0 ? (
          <Fact
            term="Pagas con"
            value={listText(methods)}
            note={receiptHere ? "Y subes el comprobante arriba, en «Por pagar»." : undefined}
          />
        ) : null}
      </dl>
    </section>
  )
}

function Fact({
  term,
  value,
  note,
  action,
}: {
  term: string
  value: string
  note?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-muted-foreground">{note}</dd> : null}
      {action ? <dd>{action}</dd> : null}
    </div>
  )
}

/**
 * Lo que se debe, lo primero de la página (tablero 10, paso 4): cada cobro por pagar con su cifra,
 * su vencimiento, cómo se paga y «Subir comprobante». Las cifras son las del cobro que manda la
 * administración. Sin nada por pagar, se dice en una línea. Lo pagado va abajo.
 */
function ToPay({ state, connected }: { state: Known; connected: boolean }) {
  const [paying, setPaying] = useState<Charge | null>(null)
  const due = state.charges.filter((charge) => owedOf(charge) > 0)
  const canSend = receiptHere(state, connected)
  if (due.length === 0)
    return (
      <section
        aria-labelledby="plan-por-pagar"
        className="elevated flex flex-col gap-1 rounded-xl border bg-card p-5 sm:p-6"
      >
        <h2 id="plan-por-pagar" className="text-2xl font-bold tracking-tight">
          Nada por pagar
        </h2>
        <p className="text-sm text-muted-foreground">
          {state.charges.length === 0
            ? "Todavía no tienes cobros."
            : "Tus cobros anteriores los ves más abajo, en «Lo que se te cobró»."}
        </p>
      </section>
    )
  return (
    <section aria-label="Por pagar" className="flex flex-col gap-3">
      {due.map((charge) => (
        <article
          key={charge.id}
          aria-labelledby={`por-pagar-${charge.id}`}
          className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6"
        >
          <div className="flex flex-col gap-1">
            <h2
              id={`por-pagar-${charge.id}`}
              className="text-2xl font-bold tracking-tight tabular-nums"
            >
              Por pagar {money(owedOf(charge), charge.currency)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {charge.dueAt ? (
                <span className="font-medium text-foreground">Vence el {day(charge.dueAt)}</span>
              ) : null}
              {charge.dueAt ? " · " : ""}
              Cobro del {day(charge.periodStart)} al {day(charge.periodEnd)}
              {charge.paidCents > 0
                ? ` · ya pagaste ${money(charge.paidCents, charge.currency)}`
                : ""}
            </p>
          </div>
          <ChargeLines charge={charge} />
          {state.paymentMethods.length > 0 ? (
            <ul className="flex flex-col gap-2 text-sm">
              {state.paymentMethods.map((method) => (
                <li key={method.code} className="rounded-lg bg-muted/60 px-3 py-2">
                  <span className="font-medium">{method.name}</span>
                  {method.instructions ? (
                    <span className="block whitespace-pre-wrap text-muted-foreground">
                      {method.instructions}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {canSend ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button className="max-sm:min-h-11" onClick={() => setPaying(charge)}>
                <Upload aria-hidden />
                Subir comprobante
              </Button>
              <span className="text-sm text-muted-foreground">
                Queda «Comprobante enviado» hasta que gestorIA confirma tu pago.
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Cuando pagues, avísanos escribiendo a soporte desde la «Ayuda», arriba.
            </p>
          )}
        </article>
      ))}
      {paying ? (
        <ReceiptSheet charge={paying} state={state} onClose={() => setPaying(null)} />
      ) : null}
    </section>
  )
}

/** El detalle de un cobro, plegado: lo que manda la administración, línea por línea. */
function ChargeLines({ charge }: { charge: Charge }) {
  if (charge.lines.length === 0) return null
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-11 items-center gap-1 text-sm font-medium text-primary sm:min-h-0">
        Qué incluye
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[panel-open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {charge.lines.map((line) => (
            <li key={`${line.kind}-${line.description}`} className="flex justify-between gap-3">
              <span className="min-w-0">
                {line.description}
                {line.quantity > 1 ? ` · ${line.quantity}` : ""}
              </span>
              <span className="tabular-nums">{money(line.amountCents, charge.currency)}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Cada pedido que cuenta para el cobro (tablero 10, paso 3). Los manda la administración por el
 * acuerdo cuando empiece a cobrar por pedido (tablero 18 del lienzo principal); hoy no los manda:
 * aquí se dice qué se verá y cuándo, sin inventar filas.
 */
function Movements() {
  return (
    <section aria-labelledby="plan-movimientos" className="flex flex-col gap-3">
      <h2 id="plan-movimientos" className="text-lg font-bold">
        Cada pedido
      </h2>
      <div className="rounded-xl border bg-card">
        <EmptyState
          icon={ReceiptText}
          title="Aquí verás cada pedido que cuenta para tu cobro"
          description="Si tu plan cobra por pedido, cada pedido de Sofi o de tu catálogo tendrá aquí su fila, con la venta, lo que se cobró y tu saldo; los anulados y las devoluciones, también. Aparecen cuando gestorIA los reciba con tu plan. Mientras, cada cobro se ve completo en «Por pagar» y en «Lo que se te cobró»."
        />
      </div>
    </section>
  )
}

/** Lo que se cobró antes, ya pagado o anulado, con su detalle. */
function Charges({ state }: { state: Known }) {
  const past = state.charges.filter((charge) => owedOf(charge) === 0)
  return (
    <section aria-labelledby="plan-cobros" className="flex flex-col gap-3">
      <h2 id="plan-cobros" className="text-lg font-bold">
        Lo que se te cobró
      </h2>
      {past.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {state.charges.length === 0 ? "Todavía no hay cobros." : "Lo de antes aparece aquí."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {past.map((charge) => (
            <li key={charge.id} className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="min-w-0 flex-1 basis-48 font-medium">
                  {day(charge.periodStart)} al {day(charge.periodEnd)}
                </span>
                <span className="font-semibold tabular-nums">
                  {money(charge.amountCents, charge.currency)}
                </span>
                <Badge variant={charge.status === "pagada" ? "secondary" : "outline"}>
                  {CHARGE_WORDS[charge.status] ?? charge.status}
                </Badge>
              </div>
              <ChargeLines charge={charge} />
            </li>
          ))}
        </ul>
      )}
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
  charge: Charge
  state: Known
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const owed = owedOf(charge)
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

/**
 * Las preguntas de la tienda sobre el plan y sus respuestas. Se pregunta desde la «Ayuda» de
 * arriba, escribiendo a soporte; aquí el Dueño ve las de toda la tienda.
 */
function Questions({ view }: { view: PlanView }) {
  const cases = view.state?.found ? view.state.support : []
  if (view.pendingSupport.length === 0 && cases.length === 0) return null
  return (
    <section aria-labelledby="plan-ayuda" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="plan-ayuda" className="text-lg font-bold">
          Preguntas de la tienda
        </h2>
        <p className="text-sm text-muted-foreground">
          Para preguntar algo más, abre «Ayuda» arriba y escribe a soporte. Te respondemos aquí y en
          la Ayuda.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {view.pendingSupport.map((pending) => (
          <li key={pending.createdAt} className="rounded-xl border bg-card p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 font-medium">{pending.question}</span>
              <Badge variant="outline">{pending.sent ? "Enviada" : "Por enviar"}</Badge>
            </div>
          </li>
        ))}
        {cases.map((kase) => (
          <li key={kase.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
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
    </section>
  )
}
