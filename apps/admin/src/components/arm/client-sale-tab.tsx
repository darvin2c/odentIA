import { type ClinicalProduct, productWords, upperFirst } from "@odentia/clinical"
import { Badge, Button, Skeleton, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DatePickerButton,
  ErrorState,
  FormDrawer,
  SkeletonRegion,
  SubmitButton,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { CalendarPlus, ExternalLink, FileText } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { money } from "../../lib/cost-format"
import { fichaDecisionArea, focusInsideLater } from "../../lib/focus"
import { invitationDueWords } from "../../lib/invitation-words"
import { supportDay, supportDayTime } from "../../lib/support-words"
import { useDemos, useOpenDemo } from "../demos"
import { DecideDrawer, type SaleDecision } from "./decide-drawer"
import { PresentationDrawer } from "./presentation-drawer"
import { ProposalDrawer } from "./proposal-drawer"
import {
  type ClientSale,
  postJson,
  type RequestDetail,
  type SaleProposal,
  type SaleTimelineEntry,
  useClientProposals,
  useClientSale,
  useClientTasks,
  useInvalidateClient,
  useRequestDetail,
  useSaleTimeline,
  useSellers,
} from "./sale-api"
import {
  dayWords,
  dueWords,
  limaDay,
  PROFESSIONALS_WORDS,
  PROPOSAL_STATUS_WORDS,
  percentWords,
  STAGE_FACT,
  STAGE_WORDS,
  TASK_WORDS,
  type TaskKind,
  TOOL_WORDS,
  WAITLIST_STAGE_WORDS,
} from "./sale-words"

/**
 * Ficha del cliente › Venta (plan §6, lienzo de la ficha y del Embudo): la
 * etapa con el hecho que la puso ahí, quién vende y para cuándo (solo
 * Administración), las presentaciones con su demo, las propuestas, la
 * solicitud de la web con su seguimiento, la invitación con su etapa y las
 * ventas anteriores. La etapa la calcula el servidor: ningún botón la mueve,
 * cada uno hace el hecho (agendar, proponer, invitar, dar de alta, decidir).
 * Soporte ve la venta y agenda presentaciones; lo demás es de Administración
 * y el servidor también se lo niega.
 */
export interface ClientSaleTabProps {
  clientId: string
  organizationId: string | null
  organizationName: string
  product: ClinicalProduct
  isAdmin: boolean
}

type Open =
  | { kind: "presentation"; taskId: string | null }
  | { kind: "proposal"; proposalId: string | null }
  | { kind: "decide"; decision: SaleDecision }
  | { kind: "opportunity" }
  | null

const DECIDED = new Set(["no_por_ahora", "perdido"])

export function ClientSaleTab({ clientId, organizationId, product, isAdmin }: ClientSaleTabProps) {
  const client = useClientSale(clientId)
  const [open, setOpen] = useState<Open>(null)
  if (client.isPending) return <ClientSaleTabSkeleton isAdmin={isAdmin} />
  if (client.isError || !client.data)
    return (
      <ErrorState
        title="No pude cargar la venta"
        error={client.error instanceof Error ? client.error : null}
        onRetry={() => void client.refetch()}
        retryLabel={common.actions.retry}
      />
    )
  const data = client.data
  const hasAccount = Boolean(organizationId ?? data.organization)
  const selling = !hasAccount && !DECIDED.has(data.stage)

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <StageCard
          client={data}
          isAdmin={isAdmin}
          selling={selling}
          hasAccount={hasAccount}
          onOpen={setOpen}
        />
        <PresentationsCard
          clientId={clientId}
          product={product}
          selling={selling}
          onOpen={setOpen}
        />
        {isAdmin ? (
          <ProposalsCard clientId={clientId} selling={!hasAccount} onOpen={setOpen} />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {data.waitlistRequest ? <RequestCard clientId={clientId} client={data} /> : null}
        {!hasAccount || data.waitlistRequest ? (
          <InvitationCard client={data} isAdmin={isAdmin} selling={selling} onOpen={setOpen} />
        ) : null}
        <PastSalesCard clientId={clientId} />
      </div>

      <PresentationDrawer
        clientId={clientId}
        open={open?.kind === "presentation"}
        taskId={open?.kind === "presentation" ? open.taskId : null}
        onClose={() => setOpen(null)}
      />
      <ProposalDrawer
        clientId={clientId}
        open={open?.kind === "proposal"}
        proposalId={open?.kind === "proposal" ? open.proposalId : null}
        onClose={() => setOpen(null)}
      />
      {open?.kind === "decide" ? (
        <DecideDrawer
          clientId={clientId}
          open
          decision={open.decision}
          onClose={() => {
            setOpen(null)
            focusInsideLater(fichaDecisionArea)
          }}
        />
      ) : null}
      {open?.kind === "opportunity" ? (
        <OpportunityDrawer clientId={clientId} client={data} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  )
}

/* ---------- Piezas ---------- */

function Card({
  title,
  id,
  action,
  children,
}: {
  title: string
  id: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 text-sm sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** Lo que dice el historial de la venta: las decisiones y las ventas anteriores salen de ahí, sin otra lista. */
const isDecision = (entry: SaleTimelineEntry) =>
  entry.id.startsWith("venta:") && entry.id.endsWith(":decision")
const isReopen = (entry: SaleTimelineEntry) =>
  entry.id.startsWith("venta:") && entry.id.endsWith(":abierta")

/* ---------- La etapa ---------- */

function StageCard({
  client,
  isAdmin,
  selling,
  hasAccount,
  onOpen,
}: {
  client: ClientSale
  isAdmin: boolean
  selling: boolean
  hasAccount: boolean
  onOpen: (open: Open) => void
}) {
  const timeline = useSaleTimeline(client.id)
  const invalidate = useInvalidateClient(client.id)
  const reopen = useMutation({
    mutationFn: () => postJson(`/api/admin/clients/${encodeURIComponent(client.id)}/reopen`),
    onSuccess: () => {
      invalidate()
      toast.success("Venta abierta otra vez: la anterior queda en su historial")
    },
  })
  const latest = timeline.data?.items[0] ?? null
  const decision = DECIDED.has(client.stage)
    ? (timeline.data?.items.find(isDecision) ?? null)
    : null
  const today = limaDay()
  const step = client.nextStep

  return (
    <Card title="La venta" id="venta-etapa">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{STAGE_WORDS[client.stage]}</Badge>
          <span className="text-sm text-muted-foreground">{STAGE_FACT[client.stage]}</span>
        </p>
        {decision ? (
          <p className="text-sm">
            {decision.title}
            {decision.detail ? ` · ${decision.detail}` : ""}
          </p>
        ) : null}
      </div>
      <dl className="flex flex-col gap-2">
        <Line label="Último hecho">
          {timeline.isPending ? (
            <Skeleton className="my-0.5 h-4 w-48" />
          ) : latest ? (
            `${latest.title} · ${supportDayTime(latest.at)}${latest.who.kind === "persona" ? ` · ${latest.who.name}` : latest.who.kind === "kairos" ? " · Kairós" : ""}`
          ) : (
            "Todavía nada"
          )}
        </Line>
        <Line label="Próximo paso">
          {step ? (
            <span className={step.overdue ? "font-medium text-destructive" : undefined}>
              {/* «Presentación · Presentación»: el tipo solo cuando el título dice otra cosa. */}
              {[TASK_WORDS[step.kind as TaskKind] ?? "Tarea", step.title]
                .filter((part, index, parts) => index === 0 || part !== parts[0])
                .join(" · ")}{" "}
              · {dueWords(step.dueOn, step.dueAt, today)}
              {step.overdue ? " · vencido" : ""}
            </span>
          ) : selling ? (
            "Sin próximo paso"
          ) : (
            "—"
          )}
        </Line>
        <Line label="Responsable">{client.owner?.name ?? "Sin responsable"}</Line>
        {isAdmin && client.opportunity ? (
          <>
            <Line label="Quién vende">{client.opportunity.seller?.name ?? "Sin vendedor"}</Line>
            <Line label="Fecha esperada">
              {client.opportunity.expectedOn
                ? dayWords(client.opportunity.expectedOn)
                : "Sin fecha"}
            </Line>
          </>
        ) : null}
      </dl>
      {isAdmin && client.opportunity ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => onOpen({ kind: "opportunity" })}
          >
            Cambiar quién vende o la fecha
          </Button>
        </div>
      ) : null}
      {selling ? (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button
            type="button"
            size="sm"
            onClick={() => onOpen({ kind: "presentation", taskId: null })}
          >
            <CalendarPlus aria-hidden />
            Agendar presentación
          </Button>
          {isAdmin ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onOpen({ kind: "proposal", proposalId: null })}
              >
                Nueva propuesta
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onOpen({ kind: "decide", decision: "invitar" })}
              >
                Invitar
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onOpen({ kind: "decide", decision: "alta" })}
              >
                Dar de alta
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onOpen({ kind: "decide", decision: "no_por_ahora" })}
              >
                No por ahora
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => onOpen({ kind: "decide", decision: "perdido" })}
              >
                Perdido
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {!selling && !hasAccount && isAdmin ? (
        <div className="flex flex-col gap-1 border-t pt-3">
          <div>
            <SubmitButton
              type="button"
              size="sm"
              variant="outline"
              pending={reopen.isPending}
              onClick={() => reopen.mutate()}
            >
              Abrir otra venta
            </SubmitButton>
          </div>
          <p className="text-xs text-muted-foreground">
            Si la clínica vuelve: esta decisión queda en su historial.
          </p>
          {reopen.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(reopen.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {!isAdmin && selling ? (
        <p className="text-xs text-muted-foreground">
          Proponer, invitar, dar de alta y decidir la venta es del rol Administración.
        </p>
      ) : null}
    </Card>
  )
}

/* ---------- Quién vende y para cuándo (solo Administración) ---------- */

const opportunitySchema = z.object({ sellerId: z.string(), expectedOn: z.string() })

function OpportunityDrawer({
  clientId,
  client,
  onClose,
}: {
  clientId: string
  client: ClientSale
  onClose: () => void
}) {
  const sellers = useSellers(true)
  const invalidate = useInvalidateClient(clientId)
  const form = useAppForm({
    defaultValues: {
      sellerId: client.opportunity?.seller?.id ?? "",
      expectedOn: client.opportunity?.expectedOn ?? "",
    },
    validators: { onSubmit: opportunitySchema },
    onSubmit: async ({ value }) => {
      await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/opportunity`, {
        sellerId: value.sellerId || null,
        expectedOn: value.expectedOn || null,
      })
      invalidate()
      toast.success("Venta actualizada")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Quién vende y para cuándo"
      description={client.name}
      submitLabel={common.actions.save}
      cancelLabel={common.actions.cancel}
      isLoading={sellers.isPending}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="sellerId">
          {(field) => (
            <field.SelectField
              id="venta-vendedora"
              label="Quién vende"
              description="Su comisión se cuenta cuando la clínica entra."
              options={[
                { value: "", label: "Sin vendedor" },
                ...(sellers.data ?? []).map((seller) => ({
                  value: seller.id,
                  label: seller.displayName,
                })),
              ]}
            />
          )}
        </form.AppField>
        <form.AppField name="expectedOn">
          {(field) => (
            <field.Control id="venta-fecha" label="Fecha esperada (opcional)">
              {(control) => (
                <DatePickerButton
                  {...control.props}
                  value={field.state.value}
                  onChange={(next) => {
                    field.handleChange(next)
                    field.handleBlur()
                  }}
                  min={limaDay()}
                  emptyLabel="Sin fecha"
                  className="w-full justify-start"
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

/* ---------- Presentaciones ---------- */

function PresentationsCard({
  clientId,
  product,
  selling,
  onOpen,
}: {
  clientId: string
  product: ClinicalProduct
  selling: boolean
  onOpen: (open: Open) => void
}) {
  const open = useClientTasks(clientId, "abierta")
  const done = useClientTasks(clientId, "hecha")
  const demos = useDemos()
  const openDemo = useOpenDemo()
  const today = limaDay()
  const coming = (open.data ?? []).filter((task) => task.kind === "presentacion")
  const made = (done.data ?? []).filter((task) => task.kind === "presentacion")
  const demoOf = (id: string | null) =>
    id ? ((demos.data ?? []).find((demo) => demo.id === id) ?? null) : null

  return (
    <Card
      title="Presentaciones"
      id="venta-presentaciones"
      action={
        selling ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpen({ kind: "presentation", taskId: null })}
          >
            Agendar
          </Button>
        ) : undefined
      }
    >
      {open.isPending || done.isPending ? (
        <SkeletonRegion message="Cargando las presentaciones…" className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
        </SkeletonRegion>
      ) : open.isError || done.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pude cargar las presentaciones.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void Promise.all([open.refetch(), done.refetch()])}
          >
            Reintentar
          </button>
        </p>
      ) : coming.length === 0 && made.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no hay presentaciones. Se agendan con la demo de {productWords(product).name} que
          se usará.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {coming.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Por venir</h3>
              <ul className="divide-y rounded-lg border">
                {coming.map((task) => {
                  const demo = demoOf(task.demoId)
                  return (
                    <li
                      key={task.id}
                      className="flex flex-wrap items-center justify-between gap-2 p-3"
                    >
                      <div className="min-w-0">
                        <p
                          className={
                            task.overdue
                              ? "text-sm font-medium text-destructive"
                              : "text-sm font-medium"
                          }
                        >
                          {upperFirst(dueWords(task.dueOn, task.dueAt, today))}
                          {task.overdue ? " · ya pasó, falta anotar cómo fue" : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {[
                            demo ? demo.name : task.demoId ? "Una demo que ya no está" : "Sin demo",
                            task.assignee?.name,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {demo && demo.status === "lista" && demo.organizationId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              openDemo.mutate({
                                id: demo.id,
                                slug: demo.slug,
                                product: demo.product,
                              })
                            }
                          >
                            <ExternalLink aria-hidden />
                            Abrir demo
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onOpen({ kind: "presentation", taskId: task.id })}
                        >
                          Anotar cómo fue
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
          {made.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Hechas</h3>
              <ul className="flex flex-col gap-1.5">
                {made.map((task) => {
                  const demo = demoOf(task.demoId)
                  return (
                    <li key={task.id} className="text-sm">
                      Se hizo el {task.doneAt ? supportDay(task.doneAt) : dayWords(task.dueOn)}
                      <span className="text-muted-foreground">
                        {" "}
                        · {demo ? demo.name : "sin demo"}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  )
}

/* ---------- Propuestas (solo Administración) ---------- */

const decideNoteSchema = z.object({
  note: z.string().trim().max(1000, "Usa como máximo 1000 caracteres"),
})

function ProposalsCard({
  clientId,
  selling,
  onOpen,
}: {
  clientId: string
  selling: boolean
  onOpen: (open: Open) => void
}) {
  const proposals = useClientProposals(clientId, true)
  const invalidate = useInvalidateClient(clientId)
  const [deciding, setDeciding] = useState<{ proposal: SaleProposal; accepted: boolean } | null>(
    null,
  )
  const approve = useMutation({
    mutationFn: (id: string) =>
      postJson(`/api/admin/clients/proposals/${encodeURIComponent(id)}/approve`),
    onSuccess: () => {
      invalidate()
      toast.success("Propuesta aprobada: ya se puede enviar")
    },
  })
  const decide = useMutation({
    mutationFn: (input: { id: string; accepted: boolean; note: string | null }) =>
      postJson(`/api/admin/clients/proposals/${encodeURIComponent(input.id)}/decide`, {
        accepted: input.accepted,
        note: input.note,
      }),
  })
  const noteForm = useAppForm({
    defaultValues: { note: "" },
    validators: { onSubmit: decideNoteSchema },
    onSubmit: async ({ value, formApi }) => {
      if (!deciding) return
      await decide.mutateAsync({
        id: deciding.proposal.id,
        accepted: deciding.accepted,
        note: value.note.trim() || null,
      })
      invalidate()
      toast.success(
        deciding.accepted
          ? `Propuesta v${deciding.proposal.version} aceptada`
          : `Propuesta v${deciding.proposal.version}: no la aceptó`,
      )
      formApi.reset()
      const decidedId = deciding.proposal.id
      setDeciding(null)
      focusInsideLater(() => document.querySelector(`[data-proposal-id="${decidedId}"]`))
    },
  })
  const noteError = useFormSubmitError(noteForm)
  const noting = useStore(noteForm.store, (state) => state.isSubmitting)

  return (
    <Card
      title="Propuestas"
      id="venta-propuestas"
      action={
        selling ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpen({ kind: "proposal", proposalId: null })}
          >
            Nueva propuesta
          </Button>
        ) : undefined
      }
    >
      {proposals.isPending ? (
        <SkeletonRegion message="Cargando las propuestas…">
          <Skeleton className="h-14 w-full" />
        </SkeletonRegion>
      ) : proposals.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pude cargar las propuestas.{" "}
          <button type="button" className="underline" onClick={() => void proposals.refetch()}>
            Reintentar
          </button>
        </p>
      ) : proposals.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin propuestas. Se arman con un plan, su precio de lista, el descuento, la prueba y la
          vigencia.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {proposals.data.map((proposal) => {
            const expired = proposal.displayStatus === "vencida"
            return (
              <li
                key={proposal.id}
                data-proposal-id={proposal.id}
                className="flex flex-col gap-2 p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-sm font-medium">
                    v{proposal.version} · {proposal.plan.name} ·{" "}
                    {money(proposal.listPriceCents, proposal.currency)}
                    {proposal.discountBps > 0
                      ? ` · ${percentWords(proposal.discountBps)} de descuento`
                      : ""}
                  </p>
                  <Badge
                    variant={
                      proposal.status === "aceptada"
                        ? "success"
                        : expired || proposal.status === "no_aceptada"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {PROPOSAL_STATUS_WORDS[proposal.displayStatus]}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {proposal.status === "aceptada" || proposal.status === "no_aceptada"
                    ? `${proposal.status === "aceptada" ? "La aceptó" : "No la aceptó"}${proposal.decidedAt ? ` el ${supportDay(proposal.decidedAt)}` : ""}${proposal.acceptedNote ? `: ${proposal.acceptedNote}` : ""}`
                    : expired
                      ? `Venció el ${dayWords(proposal.validUntil)}`
                      : `${proposal.sentAt ? `Enviada el ${supportDay(proposal.sentAt)} · ` : ""}Vale hasta el ${dayWords(proposal.validUntil)}`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2"
                    onClick={() => onOpen({ kind: "proposal", proposalId: proposal.id })}
                  >
                    <FileText aria-hidden />
                    {proposal.status === "borrador" ? "Ver y enviar" : "Ver PDF"}
                  </Button>
                  {proposal.status === "por_aprobar" ? (
                    <SubmitButton
                      type="button"
                      size="sm"
                      pending={approve.isPending && approve.variables === proposal.id}
                      onClick={() => approve.mutate(proposal.id)}
                    >
                      Aprobar
                    </SubmitButton>
                  ) : null}
                  {proposal.status === "enviada" ? (
                    <>
                      {!expired ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setDeciding({ proposal, accepted: true })}
                        >
                          La aceptó
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDeciding({ proposal, accepted: false })}
                      >
                        No la aceptó
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {approve.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(approve.error)}
        </p>
      ) : null}
      <ConfirmDialog
        open={deciding !== null}
        title={
          deciding
            ? deciding.accepted
              ? `¿Aceptó la propuesta v${deciding.proposal.version}?`
              : `¿No aceptó la propuesta v${deciding.proposal.version}?`
            : ""
        }
        description={
          deciding?.accepted
            ? "Queda aceptada en su historial. Al invitarla o darla de alta, sus condiciones se ponen solas."
            : "Queda en su historial. Para otras condiciones, arma una versión nueva."
        }
        confirmLabel={deciding?.accepted ? "Sí, la aceptó" : "No la aceptó"}
        cancelLabel="Volver"
        variant="default"
        pending={noting}
        error={noteError}
        onConfirm={() => void submitForm(noteForm)}
        onClose={() => {
          noteForm.reset()
          decide.reset()
          setDeciding(null)
        }}
      >
        <noteForm.AppField name="note">
          {(field) => (
            <field.TextareaField
              id="propuesta-nota"
              label="Cómo lo dijo (opcional)"
              placeholder="Ej.: Respondió «empecemos» por correo."
              rows={3}
              maxLength={1000}
            />
          )}
        </noteForm.AppField>
      </ConfirmDialog>
    </Card>
  )
}

/* ---------- La solicitud de la web ---------- */

function answerWords(request: RequestDetail["request"]): string | null {
  const answer = request.answer
  if (!answer) return null
  if (answer.kind === "por_responder")
    return answer.due === "vencida"
      ? `Respuesta vencida el ${dayWords(answer.day)}`
      : answer.due === "hoy"
        ? "Responder hoy"
        : `Responder hasta el ${dayWords(answer.day)}`
  if (answer.kind === "volver") return `Volver a contactar: ${dayWords(answer.day)}`
  return `Contactada el ${dayWords(answer.day)}`
}

function RequestCard({ clientId, client }: { clientId: string; client: ClientSale }) {
  const summary = client.waitlistRequest
  const detail = useRequestDetail(clientId, summary?.id ?? null)
  if (!summary) return null
  const request = detail.data?.request ?? null
  const entries = detail.data?.entries ?? []
  const fromWeb = summary.source !== "administracion"

  return (
    <Card title={fromWeb ? "La solicitud de la web" : "La solicitud"} id="venta-solicitud">
      <p className="text-sm">
        {fromWeb
          ? `Pidió en la web de ${productWords(client.product).name} el ${supportDay(summary.createdAt)}.`
          : `Se armó desde la administración el ${supportDay(summary.createdAt)} para invitarla.`}{" "}
        <span className="text-muted-foreground">
          {WAITLIST_STAGE_WORDS[summary.stage] ?? summary.stage}
        </span>
      </p>
      {detail.isPending ? (
        <SkeletonRegion message="Cargando la solicitud…">
          <Skeleton className="h-20 w-full" />
        </SkeletonRegion>
      ) : detail.isError || !request ? (
        <p role="alert" className="text-sm text-destructive">
          No pude cargar la solicitud.{" "}
          <button type="button" className="underline" onClick={() => void detail.refetch()}>
            Reintentar
          </button>
        </p>
      ) : (
        <>
          <dl className="flex flex-col gap-2">
            <Line label="Quién pidió">{`${request.firstName} ${request.lastName}`.trim()}</Line>
            <Line label="Correo">{request.email}</Line>
            <Line label="Celular">
              <a
                className="underline"
                href={`https://wa.me/${request.phone.replace(/^\+/, "")}`}
                target="_blank"
                rel="noreferrer"
              >
                {request.phone}
              </a>
            </Line>
            <Line label="Dónde">{request.city}</Line>
            <Line label="Atienden">
              {PROFESSIONALS_WORDS[request.professionals as keyof typeof PROFESSIONALS_WORDS] ??
                request.professionals}
            </Line>
            <Line label="Usan hoy">
              {TOOL_WORDS[request.currentTool as keyof typeof TOOL_WORDS] ?? request.currentTool}
            </Line>
            {answerWords(request) ? <Line label="Plazo">{answerWords(request)}</Line> : null}
            {request.discardReason ? <Line label="Descartada">{request.discardReason}</Line> : null}
          </dl>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Seguimiento</h3>
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin entradas.</p>
            ) : (
              <ol aria-label="Entradas del seguimiento" className="flex flex-col gap-2">
                {entries.map((entry) =>
                  entry.body === null ? (
                    <li
                      key={entry.id}
                      className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground"
                    >
                      Entrada solo para Administración · {supportDayTime(entry.createdAt)}
                      {entry.followUpOn ? ` · volver el ${dayWords(entry.followUpOn)}` : ""}
                    </li>
                  ) : (
                    <li
                      key={entry.id}
                      className="flex flex-col gap-0.5 rounded-lg border px-3 py-2"
                    >
                      <p className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {entry.authorName ?? "Nota anterior, sin autor registrado"}
                        </span>
                        <span>{supportDayTime(entry.createdAt)}</span>
                      </p>
                      <p className="text-sm whitespace-pre-wrap">{entry.body}</p>
                      {entry.followUpOn ? (
                        <p className="text-xs text-muted-foreground">
                          Volver a contactar: {dayWords(entry.followUpOn)}
                        </p>
                      ) : null}
                      {entry.adminOnly ? (
                        <p className="text-xs text-muted-foreground">Solo Administración</p>
                      ) : null}
                    </li>
                  ),
                )}
              </ol>
            )}
            <p className="text-xs text-muted-foreground">
              Lo que anotes con «Anotar» en la ficha queda también aquí. Las entradas no se editan
              ni se borran.
            </p>
          </div>
        </>
      )}
    </Card>
  )
}

/* ---------- La invitación ---------- */

function InvitationCard({
  client,
  isAdmin,
  selling,
  onOpen,
}: {
  client: ClientSale
  isAdmin: boolean
  selling: boolean
  onOpen: (open: Open) => void
}) {
  const request = client.waitlistRequest
  const invited = request && (request.status === "invitada" || request.invitedAt)
  const due =
    request?.status === "invitada" && request.inviteExpiresAt
      ? invitationDueWords(request.inviteExpiresAt)
      : null
  return (
    <Card
      title="La invitación"
      id="venta-invitacion"
      action={
        isAdmin && selling ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpen({ kind: "decide", decision: "invitar" })}
          >
            {request?.status === "invitada" ? "Invitar otra vez" : "Invitar"}
          </Button>
        ) : undefined
      }
    >
      {request?.enteredAt ? (
        <p className="text-sm">
          Entró el {supportDay(request.enteredAt)}
          {client.organization ? ` con su cuenta ${client.organization.slug}` : ""}.{" "}
          <span className="text-muted-foreground">{WAITLIST_STAGE_WORDS[request.stage] ?? ""}</span>
        </p>
      ) : invited && request ? (
        <p className={due?.urgent ? "text-sm font-medium text-destructive" : "text-sm"}>
          {WAITLIST_STAGE_WORDS[request.stage] ?? "Invitada"}
          {request.invitedAt ? ` el ${supportDay(request.invitedAt)}` : ""} a {request.email}
          {due ? `: ${due.text}` : ""}.
        </p>
      ) : client.organization ? (
        <p className="text-sm text-muted-foreground">Entró con el alta asistida, sin invitación.</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Todavía no se invitó. La invitación vale 14 días para un solo correo.
        </p>
      )}
      {request?.stage === "invitacion_vencida" ? (
        <p className="text-xs text-muted-foreground">
          Su enlace ya venció y no entró: invitar otra vez da uno nuevo.
        </p>
      ) : null}
    </Card>
  )
}

/* ---------- Ventas anteriores ---------- */

function PastSalesCard({ clientId }: { clientId: string }) {
  const timeline = useSaleTimeline(clientId)
  const past = (timeline.data?.items ?? []).filter((entry) => isDecision(entry) || isReopen(entry))
  if (timeline.isPending || timeline.isError || past.length === 0) return null
  return (
    <Card title="Ventas anteriores" id="venta-anteriores">
      <ol className="flex flex-col gap-2">
        {past.map((entry) => (
          <li key={entry.id} className="text-sm">
            <span className="font-medium">{entry.title}</span>
            {entry.detail ? <span> · {entry.detail}</span> : null}
            <span className="block text-xs text-muted-foreground">
              {supportDay(entry.at)}
              {entry.who.kind === "persona" ? ` · ${entry.who.name}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  )
}

/* ---------- Esqueleto de la pestaña ---------- */

/** La pestaña mientras llega: las mismas tarjetas y rejilla, sin pedir nada. */
export function ClientSaleTabSkeleton({ isAdmin }: { isAdmin: boolean }) {
  const card = (title: string, lines: number) => (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <span className="text-base font-semibold">{title}</span>
      {Array.from({ length: lines }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: líneas de relleno, siempre las mismas.
        <Skeleton key={index} className="h-4 w-full max-w-80" />
      ))}
    </div>
  )
  return (
    <SkeletonRegion message="Cargando la venta…" className="grid min-w-0 gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        {card("La venta", 4)}
        {card("Presentaciones", 2)}
        {isAdmin ? card("Propuestas", 2) : null}
      </div>
      <div className="flex flex-col gap-4">{card("La invitación", 1)}</div>
    </SkeletonRegion>
  )
}
