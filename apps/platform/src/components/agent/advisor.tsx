import { Button } from "@odentia/ui"
import { AgentMark, AgentSurface, ConfirmDialog, DetailDrawer, DetailSection, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export interface AdvisorItem {
  id: string
  personName: string
  line: string
  patientId: string | null
  contactId: string | null
  opportunityId: string | null
}

export interface AdvisorRecommendation {
  key: string
  area: string
  title: string
  detail: string
  how: string
  total: number
  items: AdvisorItem[]
  days: number | null
  computedAt: string
  taskNoun: { one: string; many: string }
  /** Automatización que se puede encender desde aquí; null si no hay o el rol no las ve. */
  automation: {
    kind: string
    label: string
    shortLabel: string
    reach: string
    ruleId: string | null
    enabled: boolean
    channel: string
  } | null
}

export interface AdvisorView {
  enabled: boolean
  recommendations: AdvisorRecommendation[]
  more: number
}

export interface AdvisorSettings {
  enabled: boolean
  detections: Array<{
    key: string
    area: string
    label: string
    description: string
    on: boolean
    days: number | null
    defaultDays: number | null
    snoozedUntil: string | null
  }>
}

/** Dónde se resuelve cada recomendación, además de la acción preparada. */
const WHERE: Record<string, { to: string; label: string }> = {
  controles_vencidos: { to: "/agenda", label: "Abrir la agenda" },
  presupuestos_sin_cita: { to: "/agenda", label: "Abrir la agenda" },
  atenciones_sin_firmar: { to: "/patients", label: "Abrir pacientes" },
  seguimientos_sin_responsable: { to: "/pipeline", label: "Abrir oportunidades" },
  cobranza_vencida: { to: "/finance", label: "Abrir finanzas" },
}

const PREVIEW = 4
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const hour = (iso: string) => new Date(iso).toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit" })
/** La hora como cierre de frase: «p. m.» ya trae su punto. */
const hourEnd = (iso: string) => {
  const text = hour(iso)
  return text.endsWith(".") ? text : `${text}.`
}

function refreshAdvisor(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ["agent-advisor", "agent-advisor-settings", "agent-advisor-preview", "tasks", "workspace-home", "automation-rules"]) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/**
 * Una recomendación del asesor, para revisar y decidir: cómo se calculó,
 * quiénes son y la acción preparada. Nada se ejecuta al abrirla.
 */
export function RecommendationDrawer({ recommendationKey, onClose }: { recommendationKey: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const canTasks = usePermission("tasks.write")
  const canAdmin = usePermission("agent.write")
  const canAutomate = usePermission("crm.write")
  const [showAll, setShowAll] = useState(false)
  const [confirmTasks, setConfirmTasks] = useState(false)
  const [confirmTurnOn, setConfirmTurnOn] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ["agent-advisor", recommendationKey],
    queryFn: () => apiFetch<{ data: AdvisorRecommendation }>(`/api/agent/advisor/${recommendationKey}`),
    enabled: recommendationKey !== null,
    retry: false,
  })
  const createTasks = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: { created: number; total: number } }>(`/api/agent/advisor/${recommendationKey}/tasks`, { method: "POST" }),
    onSuccess: (response) => {
      const { created, total } = response.data
      setDone(
        created === 0
          ? "Esas tareas ya estaban creadas hoy: no se duplicó ninguna."
          : `${created} ${created === 1 ? "tarea creada" : "tareas creadas"}${created < total ? `; las otras ${total - created} ya existían` : ""}. Las ves en Tareas.`,
      )
      setConfirmTasks(false)
      refreshAdvisor(queryClient)
    },
  })
  // Encender es la operación de Automatizaciones (misma ruta y mismo permiso):
  // activar la regla que ya existe o crearla con los valores por defecto del servidor.
  const turnOn = useMutation({
    retry: false,
    mutationFn: (automation: NonNullable<AdvisorRecommendation["automation"]>) =>
      automation.ruleId
        ? apiFetch(`/api/automations/rules/${automation.ruleId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })
        : apiFetch("/api/automations/rules", {
            method: "POST",
            body: JSON.stringify({ name: capitalize(automation.label), kind: automation.kind, enabled: true }),
          }),
    onSuccess: (_response, automation) => {
      setDone(`${capitalize(automation.label)} encendido. Verás cada mensaje en Automatizaciones.`)
      setConfirmTurnOn(false)
      refreshAdvisor(queryClient)
    },
  })
  const hide = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch("/api/agent/advisor/settings", {
        method: "PUT",
        body: JSON.stringify({ detections: { [recommendationKey ?? ""]: { on: false } } }),
      }),
    onSuccess: () => {
      refreshAdvisor(queryClient)
      close()
    },
  })

  function close() {
    setShowAll(false)
    setDone(null)
    setConfirmTasks(false)
    setConfirmTurnOn(false)
    createTasks.reset()
    turnOn.reset()
    hide.reset()
    onClose()
  }

  if (recommendationKey === null) return null
  const item = query.data?.data
  const where = WHERE[recommendationKey]
  const rows = item ? (showAll ? item.items : item.items.slice(0, PREVIEW)) : []
  const automation = item?.automation ?? null
  // La automatización es la acción principal solo si está apagada y este rol puede encenderla.
  const offerTurnOn = automation !== null && !automation.enabled && canAutomate
  const taskCount = item?.items.length ?? 0
  const taskLabel = item ? `${taskCount} ${taskCount === 1 ? item.taskNoun.one : item.taskNoun.many}` : ""
  const reach = automation ? `Avisa por ${channelLabel(automation.channel)} ${automation.reach}` : ""

  return (
    <DetailDrawer open title="Recomendación del asesor" description={item?.title} onClose={close} isSubmitting={createTasks.isPending || turnOn.isPending}>
      {query.isPending ? (
        <LoadingState kind="indeterminate" message="Calculando con tus datos de ahora…" />
      ) : query.isError || !item ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <DetailSection title="Cómo se calculó">
            <div className="flex flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 text-sm">
              <p>{item.how}</p>
              <p className="text-muted-foreground">Con tus datos de hoy a las {hourEnd(item.computedAt)} Los números salen de la base de datos, no de un modelo.</p>
            </div>
          </DetailSection>

          <DetailSection title="Quiénes son">
            {item.total === 0 ? (
              <p className="text-sm text-muted-foreground">Ya no queda nadie en esta lista: se resolvió desde que se calculó.</p>
            ) : (
              <>
                <ul className="flex flex-col divide-y rounded-xl border bg-card">
                  {rows.map((row) => (
                    <li key={row.id} className="flex flex-col px-3 py-2 text-sm">
                      {row.patientId ? (
                        <Link to="/patients/$patientId" params={{ patientId: row.patientId }} className="font-semibold text-primary hover:underline">
                          {row.personName}
                        </Link>
                      ) : row.opportunityId ? (
                        <Link to="/opportunities/$opportunityId" params={{ opportunityId: row.opportunityId }} className="font-semibold text-primary hover:underline">
                          {row.personName}
                        </Link>
                      ) : (
                        <span className="font-semibold">{row.personName}</span>
                      )}
                      <span className="text-muted-foreground">{row.line}</span>
                    </li>
                  ))}
                </ul>
                {!showAll && item.items.length > PREVIEW ? (
                  <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setShowAll(true)}>
                    Ver {item.items.length === item.total ? `los ${item.total}` : `los primeros ${item.items.length} de ${item.total}`}
                  </Button>
                ) : null}
              </>
            )}
          </DetailSection>

          <DetailSection title="Lo que puedes hacer">
            {done ? (
              <p role="status" className="rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
                {done}
              </p>
            ) : null}
            {automation && offerTurnOn ? (
              <div className="flex flex-col gap-2.5 rounded-xl border border-agent-border bg-agent-soft p-3.5">
                <div className="flex flex-col gap-0.5">
                  <p className="text-[15px] font-bold">Encender el {automation.label}</p>
                  <p className="text-sm">
                    {reach}
                    {item.total > 0 && canTasks ? `: para ${taskCount === 1 ? "la persona" : `las ${taskCount} personas`} de esta lista, crea ${taskCount === 1 ? "la tarea" : "las tareas"}.` : "."}
                  </p>
                </div>
                <Button type="button" className="min-h-11 w-full" disabled={turnOn.isPending} onClick={() => setConfirmTurnOn(true)}>
                  Encender {automation.shortLabel}
                </Button>
                <p className="text-[13px] text-muted-foreground">
                  Nada se envía hasta que lo enciendas. Podrás ver cada mensaje en{" "}
                  <Link to="/automations" className="font-semibold text-primary underline-offset-2 hover:underline">
                    Automatizaciones
                  </Link>
                  .
                </p>
              </div>
            ) : automation ? (
              <p className="text-sm text-muted-foreground">
                {automation.enabled
                  ? `El ${automation.label} ya está encendido. ${reach}.`
                  : `El ${automation.label} está apagado. Lo enciende quien administra las automatizaciones.`}
              </p>
            ) : null}
            {item.total > 0 && canTasks ? (
              offerTurnOn ? (
                <Button type="button" variant="outline" className="min-h-11 w-full" disabled={createTasks.isPending} onClick={() => setConfirmTasks(true)}>
                  Solo crear {taskLabel}
                </Button>
              ) : (
                <div className="flex flex-col gap-2.5 rounded-xl border border-agent-border bg-agent-soft p-3.5">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-[15px] font-bold">Crear {taskLabel}, una por persona</p>
                    <p className="text-sm">Quedan abiertas en Tareas para que tu equipo las tome. No se envía ningún mensaje.</p>
                  </div>
                  <Button type="button" className="min-h-11 w-full" disabled={createTasks.isPending} onClick={() => setConfirmTasks(true)}>
                    Crear {taskLabel}
                  </Button>
                </div>
              )
            ) : null}
            {where ? (
              <Link to={where.to} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8">
                {where.label}
              </Link>
            ) : null}
            {createTasks.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {createTasks.error instanceof ApiError && createTasks.error.status === 403
                  ? "Tu rol no puede crear tareas."
                  : mutationErrorMessage(createTasks.error)}
              </p>
            ) : null}
            {turnOn.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {turnOn.error instanceof ApiError && turnOn.error.status === 403
                  ? "Tu rol no puede encender automatizaciones."
                  : mutationErrorMessage(turnOn.error)}
              </p>
            ) : null}
          </DetailSection>

          {canAdmin ? (
            <div className="flex flex-col gap-2 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 basis-48 text-[13px] text-muted-foreground">
                  ¿No te sirve esta recomendación? Deja de aparecer para toda la clínica; la vuelves a encender en Agente › Asesor.
                </p>
                <Button type="button" variant="outline" className="min-h-11 sm:min-h-10" disabled={hide.isPending} onClick={() => hide.mutate()}>
                  No volver a mostrar
                </Button>
              </div>
              {hide.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {mutationErrorMessage(hide.error)}
                </p>
              ) : null}
            </div>
          ) : null}

          {automation ? (
            <ConfirmDialog
              open={confirmTurnOn}
              title={`Encender el ${automation.label}`}
              description={`${reach}. Empieza a enviar desde que lo enciendes y lo pausas cuando quieras en Automatizaciones.`}
              confirmLabel={`Encender ${automation.shortLabel}`}
              variant="default"
              pending={turnOn.isPending}
              onClose={() => {
                if (!turnOn.isPending) setConfirmTurnOn(false)
              }}
              onConfirm={() => turnOn.mutate(automation)}
            />
          ) : null}
          <ConfirmDialog
            open={confirmTasks}
            title={`Crear ${taskLabel}`}
            description="Una tarea abierta por cada persona de la lista, sin responsable. Si hoy ya se crearon, no se repiten."
            confirmLabel="Crear las tareas"
            variant="default"
            pending={createTasks.isPending}
            onClose={() => {
              if (!createTasks.isPending) setConfirmTasks(false)
            }}
            onConfirm={() => createTasks.mutate()}
          />
        </div>
      )}
    </DetailDrawer>
  )
}

/**
 * «Para atender hoy»: hasta tres recomendaciones del asesor en Inicio. No
 * ocupa sitio si está apagado o si hoy no hay nada que recomendar.
 */
export function AdvisorSection() {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("agent.write")
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [dismissing, setDismissing] = useState<AdvisorRecommendation | null>(null)

  const query = useQuery({
    queryKey: ["agent-advisor", "inicio", all],
    queryFn: () => apiFetch<{ data: AdvisorView }>(`/api/agent/advisor${all ? "?all=1" : ""}`),
    retry: false,
  })
  const snooze = useMutation({
    retry: false,
    mutationFn: (key: string) =>
      apiFetch("/api/agent/advisor/settings", { method: "PUT", body: JSON.stringify({ detections: { [key]: { snoozeDays: 7 } } }) }),
    onSuccess: () => {
      setDismissing(null)
      refreshAdvisor(queryClient)
    },
  })

  const view = query.data?.data
  if (!view || !view.enabled || view.recommendations.length === 0) {
    return <RecommendationDrawer recommendationKey={open} onClose={() => setOpen(null)} />
  }
  const count = view.recommendations.length
  return (
    <AgentSurface aria-label="Para atender hoy" className="enter">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <AgentMark />
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-[17px] font-bold tracking-tight">Para atender hoy</h2>
          <p className="text-sm text-muted-foreground">
            {count} {count === 1 ? "recomendación" : "recomendaciones"} del asesor
            <span className="hidden sm:inline">, con tus datos de hoy a las {hourEnd(view.recommendations[0]?.computedAt ?? new Date().toISOString())}</span>
          </p>
        </div>
        {view.more > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setAll(true)}>
            Ver todas
          </Button>
        ) : null}
      </div>
      <ul className="grid gap-3 lg:grid-cols-3">
        {view.recommendations.map((item) => (
          <li key={item.key} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4">
            <p className="hidden text-xs font-semibold uppercase tracking-wide text-primary-soft-foreground sm:block">{item.area}</p>
            <h3 className="font-semibold">{item.title}</h3>
            {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
            {/* Sin «No me interesa» (solo quien administra), «Revisar y decidir» ocupa la fila en teléfono. */}
            <div className="mt-auto flex flex-wrap gap-1 pt-1 sm:gap-2">
              <Button type="button" size="sm" className="min-h-11 flex-1 sm:min-h-8 sm:flex-none" onClick={() => setOpen(item.key)}>
                Revisar y decidir
              </Button>
              {canAdmin ? (
                <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setDismissing(item)}>
                  No me interesa
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <RecommendationDrawer recommendationKey={open} onClose={() => setOpen(null)} />
      <ConfirmDialog
        open={dismissing !== null}
        title="Ocultarla una semana"
        description={`«${dismissing?.title ?? ""}» deja de aparecer durante 7 días para toda la clínica. Para quitarla del todo o cambiar su umbral, ve a Agente › Asesor.`}
        confirmLabel="Ocultar 7 días"
        variant="default"
        pending={snooze.isPending}
        onClose={() => {
          if (!snooze.isPending) {
            snooze.reset()
            setDismissing(null)
          }
        }}
        onConfirm={() => dismissing && snooze.mutate(dismissing.key)}
      >
        {snooze.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {mutationErrorMessage(snooze.error)}
          </p>
        ) : null}
      </ConfirmDialog>
    </AgentSurface>
  )
}

/** Lo que el asesor recomendaría hoy, para decidir si encenderlo. */
export function AdvisorPreview() {
  const [open, setOpen] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["agent-advisor-preview"],
    queryFn: () => apiFetch<{ data: AdvisorView }>("/api/agent/advisor/preview"),
    retry: false,
  })
  if (query.isPending) return <LoadingState kind="indeterminate" message="Calculando con tus datos de ahora…" />
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const items = query.data.data.recommendations
  return (
    <>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Hoy no recomendaría nada: ninguna detección encendida encuentra casos.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-semibold">{item.title}</p>
                {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
              </div>
              <SubmitButton type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" pending={false} onClick={() => setOpen(item.key)}>
                Ver la lista
              </SubmitButton>
            </li>
          ))}
        </ul>
      )}
      <RecommendationDrawer recommendationKey={open} onClose={() => setOpen(null)} />
    </>
  )
}
