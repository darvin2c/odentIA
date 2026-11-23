import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldGroup,
  FieldLabel,
  toast,
} from "@odentia/ui"
import { Textarea } from "@odentia/ui/components/textarea"
import { EmptyState, KpiCard, PageNotice, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, CreditCard } from "lucide-react"
import { type FormEvent, useId, useState } from "react"
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
  STATUS_WORDS,
  SUPPORT_KINDS,
  SUPPORT_STATUS_WORDS,
  type SupportKind,
} from "./lib/plan"
import { money } from "./lib/tienda"
import { FormAlert, fieldErrors, SELECT_CLASSES, TextField } from "./piezas"
import { ErrorBlock, useStoreContext } from "./tiendas"

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
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold">Plan y pagos</h2>
        <p className="text-sm text-muted-foreground">
          Tu plan con gestorIA, lo que se te cobró y tus pagos.
        </p>
      </div>
      {plan.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      {plan.isError ? (
        <ErrorBlock error={plan.error} onRetry={() => void plan.refetch()} />
      ) : null}
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
          No pudimos consultar tu plan ahora. Esto es lo último que supimos, del{" "}
          {when(view.receivedAt)}. Tu tienda y Sofi siguen funcionando.
        </PageNotice>
      ) : null}
      {view.agentStop ? (
        <PageNotice tone="limite" label="Sofi en pausa">
          {AGENT_STOP_WORDS[view.agentStop]}
        </PageNotice>
      ) : null}
      {state?.notices.map((notice) => (
        <PageNotice
          key={notice.key}
          tone={noticeTone(notice.level)}
          label={NOTICE_LABELS[noticeTone(notice.level)]}
        >
          {noticeText(notice)}
        </PageNotice>
      ))}
      {state ? (
        <>
          <Summary state={state} />
          <Charges state={state} />
          <Payments state={state} />
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

function Charges({ state }: { state: Known }) {
  return (
    <section aria-labelledby="plan-cobros" className="flex flex-col gap-3">
      <h3 id="plan-cobros" className="text-lg font-bold">
        Lo que se te cobró
      </h3>
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
    </section>
  )
}

function Payments({ state }: { state: Known }) {
  return (
    <section aria-labelledby="plan-pagos" className="flex flex-col gap-3">
      <h3 id="plan-pagos" className="text-lg font-bold">
        Tus pagos
      </h3>
      {state.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay pagos.</p>
      ) : (
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

/** Pedir ayuda al equipo de gestorIA y ver sus respuestas. */
function Support({ view }: { view: PlanView }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<SupportKind>("pregunta")
  const [question, setQuestion] = useState("")
  const [detail, setDetail] = useState("")
  const kindId = useId()
  const detailId = useId()
  const ask = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/plan/ayuda`, {
        method: "POST",
        body: { kind, question, detail: detail.trim() || undefined },
      }),
    onSuccess: async () => {
      setQuestion("")
      setDetail("")
      await queryClient.invalidateQueries({ queryKey: PLAN_KEY(store.id) })
      toast.success("Tu pregunta quedó anotada. Te respondemos aquí.")
    },
  })
  const errors = fieldErrors(ask.error)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    ask.mutate()
  }
  const cases = view.state?.found ? view.state.support : []
  return (
    <section
      aria-labelledby="plan-ayuda"
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h3 id="plan-ayuda" className="text-lg font-bold">
          Pedir ayuda
        </h3>
        <p className="text-sm text-muted-foreground">
          Escríbenos sobre tu plan, un cobro o algo que no funciona. Te respondemos aquí.
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={kindId}>Sobre qué</FieldLabel>
            <select
              id={kindId}
              value={kind}
              onChange={(e) => setKind(e.target.value as SupportKind)}
              className={SELECT_CLASSES}
            >
              {SUPPORT_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <TextField
            label="Tu pregunta"
            value={question}
            onChange={setQuestion}
            maxLength={500}
            error={errors.question}
            placeholder="Por ejemplo, ¿cómo subo el tope de gasto?"
          />
          <Field>
            <FieldLabel htmlFor={detailId}>Detalle (opcional)</FieldLabel>
            <Textarea
              id={detailId}
              value={detail}
              maxLength={4000}
              rows={3}
              onChange={(e) => setDetail(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <FormAlert error={ask.error} />
        <SubmitButton type="submit" pending={ask.isPending} className="self-start">
          Enviar
        </SubmitButton>
      </form>
      {view.pendingSupport.length > 0 || cases.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {view.pendingSupport.map((pending) => (
            <li key={pending.createdAt} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium">{pending.question}</span>
                <Badge variant="outline">Por enviar</Badge>
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
