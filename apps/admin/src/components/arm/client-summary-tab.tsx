/**
 * Resumen de la ficha del cliente (tablero 3 del lienzo): «Lo que hay que
 * saber» que escribe Kairós, cada frase con su fuente, y «Qué falta saber»;
 * sus datos (con «Cambiar datos»), las personas clave, las tareas abiertas,
 * lo último que pasó y, con cuenta, las señales de riesgo. Lo que Kairós dejó
 * esperando un sí se dice aquí y se decide en Kairós: nada sale solo.
 */
import { Badge, Button } from "@odentia/ui"
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
import { CircleAlert } from "lucide-react"
import * as React from "react"
import type { ClientTab } from "../../lib/list-search"
import type { ClientTabProps } from "./account-tabs"
import { ClientDataDrawer } from "./client-data-drawer"
import {
  ACTIVITY_WORDS,
  type ClientDetail,
  countryWords,
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

/** De dónde sale cada frase de Kairós (`tipo:id`) y adónde lleva. */
const SOURCE_OF: Record<string, { label: string; tab: ClientTab }> = {
  solicitud: { label: "Solicitud", tab: "venta" },
  contacto: { label: "Persona", tab: "contactos" },
  actividad: { label: "Lo anotado", tab: "historial" },
  tarea: { label: "Tarea", tab: "resumen" },
  propuesta: { label: "Propuesta", tab: "venta" },
  cliente: { label: "Ficha", tab: "resumen" },
}

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
              {[client.city, countryWords(client.countryCode)].filter(Boolean).join(", ")}
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
        <RecentActivities client={client} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {client.riskSignals.length ? (
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
        ) : null}
        <KairosWaiting clientId={clientId} />
        <KeyPeople client={client} />
        <OpenTasks client={client} />
      </div>
      <ClientDataDrawer client={client} open={editing} onClose={() => setEditing(false)} />
    </div>
  )
}

function KnowCard({ client }: { client: ClientDetail }) {
  const { setParam } = useListSearch()
  const missing = missingFacts(client)
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
            return (
              <li
                key={`${sentence.source}-${sentence.text}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{sentence.text}</span>
                {source ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => go(source.tab)}
                  >
                    {source.label}
                  </Button>
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
          <span className="font-medium">Marca: </span>
          {client.signals.map((signal) => signal.words).join(" · ")}
        </p>
      ) : null}
      {missing.length ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Qué falta saber</h3>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
            {missing.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      ) : null}
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

function KeyPeople({ client }: { client: ClientDetail }) {
  const { setParam } = useListSearch()
  const people = client.contacts.filter((contact) => contact.source === "contacto").slice(0, 3)
  return (
    <section
      aria-labelledby="resumen-personas"
      className="flex flex-col gap-2 rounded-xl border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <h2 id="resumen-personas" className="text-base font-semibold">
          Personas clave
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setParam("tab", "contactos")}
        >
          Ver todas
        </Button>
      </div>
      {people.length ? (
        <ul className="flex flex-col gap-3">
          {people.map((contact) => (
            <li key={contact.id} className="flex items-start gap-2.5">
              <PersonAvatar name={contact.name} className="size-8" />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium [overflow-wrap:anywhere]">
                  {contact.name}
                  {contact.isPrimary ? (
                    <span className="font-normal text-muted-foreground"> · principal</span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    contact.title,
                    contact.roles.map((role) => wordOf(ROLE_WORDS, role, role)).join(", "),
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Papel por confirmar"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Aún no tiene personas: agrégalas en Contactos.
        </p>
      )}
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

function RecentActivities({ client }: { client: ClientDetail }) {
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
          {client.recentActivities.map((activity) => (
            <li key={activity.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
              <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">
                  {wordOf(ACTIVITY_WORDS, activity.kind, "Nota")}
                  {activity.direction === "salio"
                    ? " · salió"
                    : activity.direction === "entro"
                      ? " · entró"
                      : ""}
                </span>
                <span className="text-muted-foreground">
                  {activity.byKairos ? "Kairós" : (activity.author?.name ?? "Sistema")} ·{" "}
                  {whenWords(activity.happenedAt)}
                </span>
                {activity.adminOnly ? <Badge variant="outline">Solo administración</Badge> : null}
              </span>
              <span className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                {activity.body}
              </span>
              {activity.outcome ? (
                <span className="text-sm text-muted-foreground">Quedó en: {activity.outcome}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Aún no se anotó nada. «Anotar» deja lo que pasó en una llamada o un WhatsApp.
        </p>
      )}
    </section>
  )
}
