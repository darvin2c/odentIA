/**
 * La cabecera de la ficha del cliente (tablero 3 del lienzo): quién es (el
 * producto, su etapa o «Con cuenta · estado», si está en riesgo), sus datos en
 * una línea, «Abrir en <slug>» si tiene cuenta y el próximo paso con «Hecho» y
 * «Cambiar fecha». Al lado, lo que decide Administración: Invitar, Dar de alta,
 * No por ahora o Perdido mientras la venta está abierta, o reabrirla. La etapa
 * no se mueve a mano: la dice el servidor.
 */
import { Badge, Button } from "@odentia/ui"
import { CircleAlert } from "lucide-react"
import { domainOf, platformUrl } from "../../lib/host"
import { invitationDueWords } from "../../lib/invitation-words"
import { ProductMark } from "../product"
import {
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
  TOOL_WORDS,
  wordOf,
} from "./client-model"
import type { SaleDecision } from "./decide-drawer"

export interface ClientHeaderActions {
  onDone: (step: NextStep) => void
  onMove: (step: NextStep) => void
  onTask: () => void
  onDecide: (decision: SaleDecision) => void
  onReopen: () => void
  donePending?: boolean
  reopenPending?: boolean
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** Lo que sigue debajo del título: producto, etapa y la línea de datos. */
export function ClientHeaderFacts({ client }: { client: ClientDetail }) {
  const invited =
    !client.organization &&
    client.waitlistRequest?.status === "invitada" &&
    client.waitlistRequest.inviteExpiresAt
      ? invitationDueWords(client.waitlistRequest.inviteExpiresAt)
      : null
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
        {client.organization ? (
          <Badge variant={planStatusVariant(client.organization.planStatus)}>
            Con cuenta · {wordOf(PLAN_STATUS_WORDS, client.organization.planStatus, "sin plan")}
          </Badge>
        ) : (
          <Badge variant="outline">{wordOf(STAGE_WORDS, client.stage, "Contacto")}</Badge>
        )}
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
    </div>
  )
}

/** El próximo paso con «Hecho» y «Cambiar fecha», y lo que decide Administración. */
export function ClientNextStep({
  client,
  isAdmin,
  actions,
}: {
  client: ClientDetail
  isAdmin: boolean
  actions: ClientHeaderActions
}) {
  const step = client.nextStep
  const words = step ? nextStepWords(step) : null
  const assignee = step ? client.openTasks.find((task) => task.id === step.taskId)?.assignee : null
  const selling = !client.organization && client.opportunity !== null
  const decided = !client.organization && client.opportunity === null
  return (
    // Se acomodan por el ancho que tienen, no por el de la ventana: con el
    // panel lateral abierto el texto del próximo paso quedaba de una letra por
    // línea (QA del ARM, 12 nov). Lo que no cabe baja a la línea siguiente.
    <div className="flex flex-wrap items-stretch gap-3">
      <section
        aria-labelledby="ficha-proximo"
        className="flex min-w-0 flex-[999_1_28rem] flex-wrap items-center gap-3 rounded-xl border bg-card p-4"
      >
        <div className="flex min-w-0 flex-[1_1_15rem] flex-col gap-0.5">
          <h2 id="ficha-proximo" className="text-xs font-medium text-muted-foreground">
            Próximo paso
          </h2>
          {step && words ? (
            <p className="text-sm [overflow-wrap:anywhere]">
              <span className={step.overdue ? "font-semibold text-destructive" : "font-semibold"}>
                {words.when}
              </span>
              {" · "}
              {words.what}
              {assignee ? <span className="text-muted-foreground"> · {assignee.name}</span> : null}
            </p>
          ) : (
            <p className="text-sm">
              <span className="font-semibold">Sin próximo paso.</span>{" "}
              <span className="text-muted-foreground">
                {selling
                  ? "Una venta abierta sin tarea por delante se enfría: pon la siguiente."
                  : "Nada por delante."}
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {step ? (
            <>
              <Button
                type="button"
                size="sm"
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
            variant={step ? "ghost" : "default"}
            onClick={actions.onTask}
          >
            Nueva tarea
          </Button>
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
                Invitar
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
