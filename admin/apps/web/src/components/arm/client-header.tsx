/**
 * La cabecera de la ficha del cliente (tablero 3 del lienzo, ADR 0196): quién es (el producto,
 * su fase o la etapa de su venta, si está en riesgo), sus datos en una línea, «Abrir en <slug>»
 * si tiene cuenta y la barra de las tres fases (por vender, en alta con sus pasos, activo desde su
 * primer pago). Debajo, el próximo paso, en orden: una conversación que espera respuesta, lo que
 * falta del alta y la tarea más próxima con «Hecho» y «Cambiar fecha». Al lado, lo que decide
 * Administración: Invitar, Dar de alta, No por ahora o Perdido mientras la venta está abierta, o
 * reabrirla. La etapa y la fase no se mueven a mano: las dice el servidor.
 */
import { Badge, Button, cn } from "@odentia/ui"
import { Check, ChevronRight, CircleAlert, CircleDot } from "lucide-react"
import { domainOf, platformUrl } from "../../lib/host"
import { invitationDueWords } from "../../lib/invitation-words"
import { ProductMark } from "../product"
import {
  CLIENT_PHASE_WORDS,
  type ClientDetail,
  countryWords,
  dayWords,
  limaDayOf,
  type NextStep,
  nextStepWords,
  ORIGIN_WORDS,
  PLAN_STATUS_WORDS,
  PROFESSIONALS_WORDS,
  planStatusVariant,
  STAGE_WORDS,
  stageWords,
  TOOL_WORDS,
  wordOf,
} from "./client-model"
import type { ConversationTarget } from "./conversation-drawer"
import type { SaleDecision } from "./decide-drawer"
import { INBOX_CHANNEL_WORDS, useInbox } from "./inbox-api"

export interface ClientHeaderActions {
  onDone: (step: NextStep) => void
  onMove: (step: NextStep) => void
  onTask: () => void
  onDecide: (decision: SaleDecision) => void
  onReopen: () => void
  /** Abre la conversación que espera respuesta, en su cajón. */
  onConversation: (target: ConversationTarget) => void
  /** Lleva a la pestaña Alta. */
  onAlta: () => void
  donePending?: boolean
  reopenPending?: boolean
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** Los estados del plan que se dicen junto a la fase: lo de siempre (prueba, activa) no. */
const NOTABLE_PLAN: ReadonlySet<string> = new Set(["gracia", "restringida", "pausada", "cancelada"])

/** Lo que sigue debajo del título: producto, fase o etapa, la línea de datos y las tres fases. */
export function ClientHeaderFacts({ client }: { client: ClientDetail }) {
  const invited =
    !client.organization &&
    client.waitlistRequest?.status === "invitada" &&
    client.waitlistRequest.inviteExpiresAt
      ? invitationDueWords(client.waitlistRequest.inviteExpiresAt)
      : null
  const planStatus = client.organization?.planStatus ?? null
  const facts = [
    [client.city, countryWords(client.countryCode)].filter(Boolean).join(", "),
    client.professionals ? wordOf(PROFESSIONALS_WORDS, client.professionals) : null,
    // Solo la inicial: «cuaderno o Excel», no «cuaderno o excel».
    client.currentTool ? lowerFirst(wordOf(TOOL_WORDS, client.currentTool)) : null,
    `Responsable: ${client.owner?.name || "sin responsable"}`,
    `Origen: ${wordOf(ORIGIN_WORDS, client.origin, "Otro")}${client.referredBy ? ` (la refirió ${client.referredBy.name})` : ""}`,
    `primer contacto el ${dayWords(limaDayOf(new Date(client.createdAt)))}`,
    client.organization ? `con cuenta: ${client.organization.slug}` : "sin cuenta todavía",
  ].filter(Boolean)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProductMark product={client.product} kind className="text-sm" />
        <Badge variant={client.phase === "activo" ? "success" : "outline"}>
          {stageWords(client)}
        </Badge>
        {planStatus && NOTABLE_PLAN.has(planStatus) ? (
          <Badge variant={planStatusVariant(planStatus)}>
            Cuenta {wordOf(PLAN_STATUS_WORDS, planStatus, planStatus).toLowerCase()}
          </Badge>
        ) : null}
        {invited ? (
          <Badge variant={invited.urgent ? "destructive" : "outline"}>
            La invitación {invited.text}
          </Badge>
        ) : null}
        {client.riskSignals.length ? (
          <Badge variant="destructive">
            <CircleAlert aria-hidden />
            En riesgo
          </Badge>
        ) : null}
        {client.archivedAt ? <Badge variant="secondary">Archivada</Badge> : null}
        {client.organization ? (
          <a
            className="text-sm text-foreground underline underline-offset-2 sm:ml-auto [overflow-wrap:anywhere]"
            href={platformUrl(client.organization.slug, "/home", client.product)}
            target="_blank"
            rel="noreferrer"
          >
            Abrir en {client.organization.slug}.{domainOf(client.product)} ↗
          </a>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{facts.join(" · ")}</p>
      <PhaseBar client={client} />
    </div>
  )
}

type PhaseState = "hecho" | "actual" | "despues"

const PHASE_STATE_WORDS: Record<PhaseState, string> = {
  hecho: ": ya pasó",
  actual: ": está aquí",
  despues: ": todavía no",
}

/**
 * Las tres fases (ADR 0196): por vender (o lo que se decidió), en alta con sus pasos y activo
 * desde su primer pago. Cada una dice con texto si ya pasó, si está ahí o si falta: no solo con
 * el color.
 */
export function PhaseBar({ client }: { client: ClientDetail }) {
  const account = client.organization !== null
  const decided = client.phase === "no_por_ahora" || client.phase === "perdido"
  const alta = client.alta
  const steps: Array<{ key: string; label: string; state: PhaseState; detail: string | null }> = [
    {
      key: "venta",
      label: decided ? CLIENT_PHASE_WORDS[client.phase] : CLIENT_PHASE_WORDS.por_vender,
      state: account ? "hecho" : "actual",
      detail: null,
    },
    {
      key: "alta",
      label: CLIENT_PHASE_WORDS.en_alta,
      state:
        client.phase === "activo" ? "hecho" : client.phase === "en_alta" ? "actual" : "despues",
      detail:
        client.phase === "en_alta" && alta
          ? `${alta.done} de ${alta.total} pasos${alta.missing.length ? ` · faltan ${alta.missing.length}` : ""}`
          : null,
    },
    {
      key: "activo",
      label: CLIENT_PHASE_WORDS.activo,
      state: client.phase === "activo" ? "actual" : "despues",
      detail:
        client.phase === "activo" && client.activeSince
          ? `desde el ${dayWords(limaDayOf(new Date(client.activeSince)))}`
          : "desde su primer pago",
    },
  ]
  return (
    <ol aria-label="Fase del cliente" className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      {steps.map((step, index) => (
        <li
          key={step.key}
          aria-current={step.state === "actual" ? "step" : undefined}
          className="flex min-w-0 items-center gap-1"
        >
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <span
            className={cn(
              "inline-flex min-w-0 flex-wrap items-center gap-x-1 rounded-full border px-2 py-0.5",
              step.state === "actual"
                ? "border-foreground/30 bg-background text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            {step.state === "hecho" ? (
              <Check aria-hidden className="size-3 shrink-0" />
            ) : step.state === "actual" ? (
              <CircleDot aria-hidden className="size-3 shrink-0" />
            ) : null}
            <span className={step.state === "actual" ? "font-semibold" : "font-medium"}>
              {step.label}
            </span>
            {step.detail ? <span className="text-muted-foreground">· {step.detail}</span> : null}
            <span className="sr-only">{PHASE_STATE_WORDS[step.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * El próximo paso, en orden (ADR 0196): primero una conversación que espera una respuesta nuestra
 * (solo Administración: la Bandeja es suya), después, en alta, lo primero que le falta y, al final,
 * la tarea más próxima con «Hecho» y «Cambiar fecha». «Nueva tarea» siempre. Al lado, lo que decide
 * Administración.
 */
export function ClientNextStep({
  client,
  isAdmin,
  actions,
}: {
  client: ClientDetail
  isAdmin: boolean
  actions: ClientHeaderActions
}) {
  const waiting = useInbox(
    { cliente: client.id, estado: "te_toca", limit: 1 },
    { enabled: isAdmin },
  )
  const conversation = isAdmin ? (waiting.data?.items[0] ?? null) : null
  const altaMissing = client.phase === "en_alta" ? (client.alta?.missing[0] ?? null) : null
  const step = client.nextStep
  const words = step ? nextStepWords(step) : null
  const assignee = step ? client.openTasks.find((task) => task.id === step.taskId)?.assignee : null
  const selling = !client.organization && client.opportunity !== null
  const decided = !client.organization && client.opportunity === null
  const nothing = !conversation && !altaMissing && !step
  const row = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
  return (
    // Se acomodan por el ancho que tienen, no por el de la ventana: con el
    // panel lateral abierto el texto del próximo paso quedaba de una letra por
    // línea (QA del ARM, 12 nov). Lo que no cabe baja a la línea siguiente.
    <div className="flex flex-wrap items-stretch gap-3">
      <section
        aria-labelledby="ficha-proximo"
        className="flex min-w-0 flex-[999_1_28rem] flex-col gap-2.5 rounded-xl border bg-card p-4"
      >
        <h2 id="ficha-proximo" className="text-xs font-medium text-muted-foreground">
          Próximo paso
        </h2>
        {conversation ? (
          <div className={row}>
            <p className="min-w-0 flex-[1_1_15rem] text-sm [overflow-wrap:anywhere]">
              <span className="font-semibold">Te toca responder</span>
              {" · "}
              {conversation.who.name || conversation.who.address} por{" "}
              {conversation.channel === "correo"
                ? "correo"
                : INBOX_CHANNEL_WORDS[conversation.channel]}
              {conversation.preview ? (
                <span className="text-muted-foreground"> · «{conversation.preview}»</span>
              ) : null}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                actions.onConversation(
                  conversation.kind === "chat"
                    ? { kind: "chat", chatId: conversation.id }
                    : { kind: "correo", emailId: conversation.id },
                )
              }
            >
              Responder
            </Button>
          </div>
        ) : null}
        {altaMissing ? (
          <div className={row}>
            <p className="min-w-0 flex-[1_1_15rem] text-sm [overflow-wrap:anywhere]">
              <span className="font-semibold">Falta en el alta</span>
              {" · "}
              {altaMissing}
            </p>
            <Button
              type="button"
              size="sm"
              variant={conversation ? "outline" : "default"}
              onClick={actions.onAlta}
            >
              Ver el alta
            </Button>
          </div>
        ) : null}
        <div className={row}>
          {step && words ? (
            <p className="min-w-0 flex-[1_1_15rem] text-sm [overflow-wrap:anywhere]">
              <span className={step.overdue ? "font-semibold text-destructive" : "font-semibold"}>
                {words.when}
              </span>
              {" · "}
              {words.what}
              {assignee ? <span className="text-muted-foreground"> · {assignee.name}</span> : null}
            </p>
          ) : nothing ? (
            <p className="min-w-0 flex-[1_1_15rem] text-sm">
              <span className="font-semibold">Sin próximo paso.</span>{" "}
              <span className="text-muted-foreground">
                {selling
                  ? "Una venta abierta sin tarea por delante se enfría: pon la siguiente."
                  : "Nada por delante."}
              </span>
            </p>
          ) : (
            <p className="min-w-0 flex-[1_1_15rem] text-sm text-muted-foreground">
              Sin tarea por delante.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {step ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant={conversation || altaMissing ? "outline" : "default"}
                  disabled={actions.donePending}
                  onClick={() => actions.onDone(step)}
                >
                  {step.kind === "presentacion" ? "Cómo fue…" : "Hecho"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => actions.onMove(step)}
                >
                  Cambiar fecha
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant={step || !nothing ? "ghost" : "default"}
              onClick={actions.onTask}
            >
              Nueva tarea
            </Button>
          </div>
        </div>
      </section>
      {isAdmin && (selling || decided) ? (
        <section
          aria-labelledby="ficha-decide"
          className="flex min-w-0 flex-[1_1_auto] flex-col gap-2 rounded-xl border bg-card p-4"
        >
          <h2 id="ficha-decide" className="text-xs font-medium text-muted-foreground">
            Decides tú
          </h2>
          {selling ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => actions.onDecide("invitar")}
              >
                {client.waitlistRequest?.status === "invitada" ? "Invitar otra vez" : "Invitar"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => actions.onDecide("alta")}
              >
                Dar de alta
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => actions.onDecide("no_por_ahora")}
              >
                No por ahora
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => actions.onDecide("perdido")}
              >
                Perdido
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{wordOf(STAGE_WORDS, client.stage, "Decidida")}.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={actions.reopenPending}
                onClick={actions.onReopen}
              >
                Abrir otra venta
              </Button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}
