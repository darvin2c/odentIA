/**
 * Resumen de la ficha del cliente (tablero 3 del lienzo, ADR 0196): «Lo que hay que saber» que
 * escribe Kairós, cada frase con su fuente dicha por el servidor, y lo que toca según su fase: por
 * vender, «Qué falta saber»; en alta, lo que falta del alta; activa, sus señales de riesgo. Sus
 * datos (con «Cambiar datos»), sus personas (las de la ficha y las de su cuenta, con «Agregar» y
 * «Ver todas»), las tareas abiertas y lo último que pasó, con quien lo escribió. Lo que Kairós dejó
 * esperando un sí se dice aquí y se decide en Kairós: nada sale solo.
 */
import { Button } from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  DetailField,
  DetailList,
  ErrorState,
  LoadingState,
  PersonAvatar,
  useListSearch,
} from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { CircleAlert, Plus } from "lucide-react"
import * as React from "react"
import type { ClientTab } from "../../lib/list-search"
import type { ClientTabProps } from "./account-tabs"
import { ClientDataDrawer } from "./client-data-drawer"
import {
  ACTIVITY_WORDS,
  type ActivityRow,
  type ClientDetail,
  type ContactRow,
  dayWords,
  limaDayOf,
  limaTimeOf,
  ORIGIN_WORDS,
  PROFESSIONALS_WORDS,
  ROLE_WORDS,
  relativeDayWords,
  TOOL_WORDS,
  whenWords,
  wordOf,
} from "./client-model"
import { useClientDetail, useClientKairosItems } from "./client-queries"
import { ContactDrawer } from "./contact-drawer"
import { type ConversationTarget, ConversationDrawer } from "./conversation-drawer"

/** Adónde lleva cada fuente de Kairós (`tipo:id`); cómo se dice, el servidor (`label`). */
const SOURCE_OF: Record<string, { label: string; tab: ClientTab }> = {
  solicitud: { label: "Solicitud", tab: "venta" },
  contacto: { label: "Persona", tab: "contactos" },
  actividad: { label: "Lo anotado", tab: "historial" },
  tarea: { label: "Tarea", tab: "resumen" },
  propuesta: { label: "Propuesta", tab: "venta" },
  cliente: { label: "Ficha", tab: "resumen" },
  venta: { label: "Venta", tab: "venta" },
}

/** Cuántas personas se ven en el Resumen; «Ver todas» abre las demás. */
const PEOPLE_SHOWN = 4

/** «Qué falta saber»: lo que la ficha aún no tiene y hace falta para venderle bien. */
export function missingFacts(client: ClientDetail): string[] {
  const people = client.contacts.filter((contact) => contact.source === "contacto")
  return [
    client.city ? null : "En qué ciudad está",
    client.professionals ? null : "Cuántos profesionales atienden",
    client.currentTool ? null : "Qué usan hoy para su agenda e historias",
    people.some((contact) => contact.roles.includes("decide")) ? null : "Quién decide",
    client.organization || people.some((contact) => contact.roles.includes("paga"))
      ? null
      : "Quién paga",
    people.some((contact) => contact.phone || contact.email) ? null : "Cómo contactarla",
  ].filter((fact): fact is string => fact !== null)
}

export function ClientSummaryTab({ clientId, isAdmin }: ClientTabProps) {
  const detail = useClientDetail(clientId)
  const [editing, setEditing] = React.useState(false)
  const [conversation, setConversation] = React.useState<ConversationTarget | null>(null)
  if (detail.isPending) return <LoadingState message="Cargando el resumen…" />
  if (detail.isError)
    return (
      <ErrorState
        title="No pude cargar el resumen"
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    )
  const client = detail.data
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-4">
        <KnowCard client={client} />
        <section
          aria-labelledby="resumen-datos"
          className="@container flex flex-col gap-3 rounded-xl border bg-card p-4"
        >
          <div className="flex items-center gap-2">
            <h2 id="resumen-datos" className="text-base font-semibold">
              Datos
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setEditing(true)}
            >
              Cambiar datos
            </Button>
          </div>
          <DetailList>
            <DetailField label="Ciudad">
              {client.city || <span className="text-muted-foreground">Falta</span>}
            </DetailField>
            <DetailField label="Profesionales">
              {client.professionals ? wordOf(PROFESSIONALS_WORDS, client.professionals) : null}
            </DetailField>
            <DetailField label="Usan hoy">
              {client.currentTool ? wordOf(TOOL_WORDS, client.currentTool) : null}
            </DetailField>
            <DetailField label="Cómo llegó">
              {wordOf(ORIGIN_WORDS, client.origin, "Otro")}
              {client.originDetail ? ` · ${client.originDetail}` : ""}
              {client.referredBy ? (
                <>
                  {" · la refirió "}
                  <Link
                    to="/clients/$clientId"
                    params={{ clientId: client.referredBy.id }}
                    className="underline underline-offset-2"
                  >
                    {client.referredBy.name}
                  </Link>
                </>
              ) : null}
            </DetailField>
            <DetailField label="Responsable">{client.owner?.name || "Sin responsable"}</DetailField>
            {isAdmin && client.opportunity ? (
              <DetailField label="Vende">
                {client.opportunity.seller?.name ?? "Sin vendedor"}
                {client.opportunity.expectedOn
                  ? ` · espera cerrar el ${dayWords(client.opportunity.expectedOn)}`
                  : ""}
              </DetailField>
            ) : null}
            <DetailField label="Primer contacto">
              {dayWords(limaDayOf(new Date(client.createdAt)))}
            </DetailField>
          </DetailList>
        </section>
        <RecentActivities client={client} onConversation={setConversation} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {/* Activa, sus señales van en «Lo que hay que saber»; en alta, aquí. */}
        {client.riskSignals.length && client.phase !== "activo" ? (
          <RiskCard client={client} />
        ) : null}
        <KairosWaiting clientId={clientId} />
        <PeopleCard client={client} />
        <OpenTasks client={client} />
      </div>
      <ClientDataDrawer client={client} open={editing} onClose={() => setEditing(false)} />
      <ConversationDrawer
        target={conversation}
        open={conversation !== null}
        onClose={() => setConversation(null)}
      />
    </div>
  )
}

function RiskCard({ client }: { client: ClientDetail }) {
  return (
    <section
      aria-labelledby="resumen-riesgo"
      className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-card p-4"
    >
      <h2 id="resumen-riesgo" className="flex items-center gap-2 text-base font-semibold">
        <CircleAlert aria-hidden className="size-4 text-destructive" />
        Señales de riesgo
      </h2>
      <ul className="flex flex-col gap-1.5 text-sm">
        {client.riskSignals.map((signal) => (
          <li key={signal.code}>{signal.words}</li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Cada señal sale de un hecho; las cifras las calcula el sistema.
      </p>
    </section>
  )
}

/** Lo que toca saber según la fase: lo que falta para venderle, del alta, o sus señales de riesgo. */
function PhaseFacts({ client, go }: { client: ClientDetail; go: (tab: ClientTab) => void }) {
  if (client.phase === "en_alta") {
    const missing = client.alta?.missing ?? []
    if (!missing.length) return null
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Lo que falta del alta</h3>
        <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
          {missing.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => go("alta")}
          >
            Ver el alta
          </Button>
        </div>
      </div>
    )
  }
  if (client.phase === "activo")
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Señales de riesgo</h3>
        {client.riskSignals.length ? (
          <ul className="flex flex-col gap-0.5 text-sm">
            {client.riskSignals.map((signal) => (
              <li key={signal.code} className="flex items-start gap-1.5">
                <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{signal.words}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Sin señales de riesgo hoy.</p>
        )}
        <div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => go("uso")}
          >
            Ver el uso
          </Button>
        </div>
      </div>
    )
  const missing = missingFacts(client)
  if (!missing.length) return null
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">Qué falta saber</h3>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
        {missing.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </div>
  )
}

function KnowCard({ client }: { client: ClientDetail }) {
  const { setParam } = useListSearch()
  const go = (tab: ClientTab) => setParam("tab", tab === "resumen" ? undefined : tab)
  return (
    <AgentSurface aria-labelledby="resumen-saber" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2.5">
        <AgentMark size="sm" />
        <h2 id="resumen-saber" className="text-base font-semibold">
          Lo que hay que saber
        </h2>
      </div>
      {client.summary?.sources.length ? (
        <ul className="flex flex-col gap-2 text-sm">
          {client.summary.sources.map((sentence) => {
            const source = SOURCE_OF[sentence.source.split(":")[0] ?? ""]
            const label = sentence.label ?? source?.label ?? null
            return (
              <li
                key={`${sentence.source}-${sentence.text}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{sentence.text}</span>
                {source && label ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => go(source.tab)}
                  >
                    {label}
                  </Button>
                ) : label ? (
                  <span className="text-xs text-muted-foreground">{label}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : client.summary?.text ? (
        <p className="text-sm whitespace-pre-wrap">{client.summary.text}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Kairós aún no escribió su resumen: lo arma cada mañana con lo anotado.
        </p>
      )}
      {client.summary?.at ? (
        <p className="text-xs text-muted-foreground">
          Lo renovó {relativeDayWords(limaDayOf(new Date(client.summary.at)))} a las{" "}
          {limaTimeOf(client.summary.at)}.
        </p>
      ) : null}
      {client.signals.length ? (
        <p className="text-sm">
          <span className="font-medium">Kairós marca: </span>
          {client.signals.map((signal) => signal.words).join(" · ")}
        </p>
      ) : null}
      <PhaseFacts client={client} go={go} />
    </AgentSurface>
  )
}

/** Lo que Kairós preparó para este cliente: se revisa y se decide en Kairós. */
function KairosWaiting({ clientId }: { clientId: string }) {
  const items = useClientKairosItems(clientId)
  if (items.isPending || items.isError || !items.data.total) return null
  return (
    <AgentSurface aria-labelledby="resumen-kairos" className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2.5">
        <AgentMark size="sm" />
        <h2 id="resumen-kairos" className="text-base font-semibold">
          Kairós propone · {items.data.total}
        </h2>
      </div>
      <ul className="flex flex-col gap-2 text-sm">
        {items.data.items.map((item) => (
          <li key={item.id} className="flex flex-col gap-0.5">
            <span className="font-medium [overflow-wrap:anywhere]">{item.title}</span>
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              Por qué: {item.reason}
            </span>
            <span className="text-xs text-muted-foreground">
              Espera tu sí hasta el {dayWords(limaDayOf(new Date(item.expiresAt)))},{" "}
              {limaTimeOf(item.expiresAt)}.
            </span>
          </li>
        ))}
      </ul>
      <div>
        <Button variant="outline" size="sm" render={<Link to="/kairos" />}>
          Revisar en Kairós
        </Button>
      </div>
    </AgentSurface>
  )
}

/** Lo que se dice bajo el nombre de una persona: su cargo y sus papeles, o que es de la cuenta. */
function personLine(person: ContactRow): string {
  if (person.source === "miembro")
    return ["Está en su cuenta", person.user?.roleLabel].filter(Boolean).join(" · ")
  const roles = person.roles.map((role) => wordOf(ROLE_WORDS, role, role)).join(", ")
  return (
    [person.title, roles, person.user ? "Está en su cuenta" : null].filter(Boolean).join(" · ") ||
    "Papel por confirmar"
  )
}

/**
 * Sus personas: las de la ficha (la principal primero) y, con cuenta, las de su equipo que aún no
 * son una persona del cliente, de solo lectura. «Agregar» abre el formulario; «Ver todas», el
 * cajón con todas y lo que se hace con cada una.
 */
function PeopleCard({ client }: { client: ClientDetail }) {
  const { setParam } = useListSearch()
  const [adding, setAdding] = React.useState(false)
  const people = [
    ...client.contacts.filter((contact) => contact.source === "contacto"),
    ...client.contacts.filter((contact) => contact.source === "miembro"),
  ]
  const shown = people.slice(0, PEOPLE_SHOWN)
  const rest = people.length - shown.length
  return (
    <section
      aria-labelledby="resumen-personas"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="resumen-personas" className="text-base font-semibold">
          Personas
        </h2>
        <div className="ml-auto flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Agregar
          </Button>
          {people.length ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setParam("tab", "contactos")}
            >
              Ver todas
            </Button>
          ) : null}
        </div>
      </div>
      {shown.length ? (
        <ul className="flex flex-col gap-3">
          {shown.map((person) => (
            <li
              key={person.id ?? person.user?.userId ?? person.email ?? person.name}
              className="flex items-start gap-2.5"
            >
              <PersonAvatar name={person.name} className="size-8" />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium [overflow-wrap:anywhere]">
                  {person.name}
                  {person.isPrimary ? (
                    <span className="font-normal text-muted-foreground"> · principal</span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {personLine(person)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Aún no tiene personas: agrega con quién hablamos, quién decide y quién paga.
        </p>
      )}
      {rest > 0 ? (
        <p className="text-xs text-muted-foreground">
          {rest === 1 ? "Y 1 persona más." : `Y ${rest} personas más.`}
        </p>
      ) : null}
      <ContactDrawer
        clientId={client.id}
        open={adding}
        onClose={() => setAdding(false)}
        contact={null}
      />
    </section>
  )
}

function OpenTasks({ client }: { client: ClientDetail }) {
  return (
    <section
      aria-labelledby="resumen-tareas"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4"
    >
      <h2 id="resumen-tareas" className="text-base font-semibold">
        Tareas abiertas
      </h2>
      {client.openTasks.length ? (
        <ul className="flex flex-col gap-2.5 text-sm">
          {client.openTasks.map((task) => (
            <li key={task.id} className="flex flex-col gap-0.5">
              <span className={task.overdue ? "font-medium text-destructive" : "font-medium"}>
                {task.overdue && task.dueOn < limaDayOf(new Date())
                  ? `Venció el ${dayWords(task.dueOn)}`
                  : relativeDayWords(task.dueOn)}
                {task.dueAt ? `, ${limaTimeOf(task.dueAt)}` : ""}
              </span>
              <span className="[overflow-wrap:anywhere]">
                {task.title}
                {task.assignee ? (
                  <span className="text-muted-foreground"> · {task.assignee.name}</span>
                ) : null}
              </span>
              {task.byKairos ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <AgentMark size="sm" className="size-4 rounded [&>svg]:size-2.5" />
                  La puso Kairós
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Sin tareas abiertas.</p>
      )}
    </section>
  )
}

/** Quién lo hizo: quien lo escribió si llegó de fuera, Kairós o la persona que lo anotó. */
function activityWho(activity: ActivityRow): string {
  if (activity.from) return activity.from
  if (activity.byKairos) return "Kairós"
  return activity.author?.name || "Sin autor registrado"
}

function RecentActivities({
  client,
  onConversation,
}: {
  client: ClientDetail
  onConversation: (target: ConversationTarget) => void
}) {
  const { setParam } = useListSearch()
  return (
    <section
      aria-labelledby="resumen-ultimo"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <h2 id="resumen-ultimo" className="text-base font-semibold">
          Lo último que pasó
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setParam("tab", "historial")}
        >
          Ver el historial
        </Button>
      </div>
      {client.recentActivities.length ? (
        <ul className="flex flex-col divide-y">
          {client.recentActivities.map((activity) => {
            const what = `${wordOf(ACTIVITY_WORDS, activity.kind, "Nota")}${
              activity.direction === "salio"
                ? " · salió"
                : activity.direction === "entro"
                  ? " · entró"
                  : ""
            }`
            const target: ConversationTarget | null = activity.emailId
              ? { kind: "correo", emailId: activity.emailId }
              : activity.chatId
                ? { kind: "chat", chatId: activity.chatId }
                : null
            return (
              <li key={activity.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  {target ? (
                    <button
                      type="button"
                      onClick={() => onConversation(target)}
                      className="font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {what}
                      <span className="sr-only">
                        : abrir {target.kind === "correo" ? "el correo" : "la conversación"}
                      </span>
                    </button>
                  ) : (
                    <span className="font-medium">{what}</span>
                  )}
                  <span className="text-muted-foreground">
                    {activityWho(activity)} · {whenWords(activity.happenedAt)}
                  </span>
                </span>
                <span className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                  {activity.body}
                </span>
                {activity.outcome ? (
                  <span className="text-sm text-muted-foreground">
                    Quedó en: {activity.outcome}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Aún no se anotó nada. «Anotar» deja lo que pasó en una llamada o un WhatsApp.
        </p>
      )}
    </section>
  )
}
