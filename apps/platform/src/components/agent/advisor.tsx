import { Button } from "@odentia/ui"
import { AgentMark, AgentSurface, ConfirmDialog, DetailDrawer, DetailSection, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
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
const hour = (iso: string) => new Date(iso).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })
/** La hora como cierre de frase: «p. m.» ya trae su punto. */
const hourEnd = (iso: string) => {
  const text = hour(iso)
  return text.endsWith(".") ? text : `${text}.`
}

function refreshAdvisor(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ["agent-advisor", "agent-advisor-settings", "agent-advisor-preview", "tasks", "workspace-home"]) {
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
  const [showAll, setShowAll] = useState(false)
  const [confirmTasks, setConfirmTasks] = useState(false)
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
    createTasks.reset()
    hide.reset()
    onClose()
  }

  if (recommendationKey === null) return null
  const item = query.data?.data
  const where = WHERE[recommendationKey]
  const rows = item ? (showAll ? item.items : item.items.slice(0, PREVIEW)) : []

  return (
    <DetailDrawer open title="Recomendación del asesor" description={item?.title} onClose={close} isSubmitting={createTasks.isPending}>
      {query.isPending ? (
        <LoadingState kind="indeterminate" message="Calculando con tus datos de ahora…" />
      ) : query.isError || !item ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <DetailSection title="Cómo se calculó">
            <p className="text-sm">{item.how}</p>
            <p className="text-sm text-muted-foreground">Con tus datos de hoy a las {hourEnd(item.computedAt)} Los números salen de la base de datos, no de un modelo.</p>
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
            {item.total > 0 && canTasks ? (
              <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-3">
                <p className="text-sm font-semibold">
                  Crear {item.items.length} {item.items.length === 1 ? "tarea" : "tareas"}, una por persona
                </p>
                <p className="text-sm text-muted-foreground">Quedan abiertas en Tareas para que tu equipo las tome. No se envía ningún mensaje.</p>
                <Button type="button" className="min-h-11 self-start sm:min-h-9" disabled={createTasks.isPending} onClick={() => setConfirmTasks(true)}>
                  Crear las tareas
                </Button>
              </div>
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
          </DetailSection>

          {canAdmin ? (
            <DetailSection title="¿No te sirve esta recomendación?">
              <p className="text-sm text-muted-foreground">Deja de aparecer para toda la clínica. La vuelves a encender en Agente › Asesor.</p>
              <Button type="button" variant="outline" className="min-h-11 self-start sm:min-h-9" disabled={hide.isPending} onClick={() => hide.mutate()}>
                No volver a mostrar
              </Button>
              {hide.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {mutationErrorMessage(hide.error)}
                </p>
              ) : null}
            </DetailSection>
          ) : null}

          <ConfirmDialog
            open={confirmTasks}
            title={`Crear ${item.items.length} ${item.items.length === 1 ? "tarea" : "tareas"}`}
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
            {count} {count === 1 ? "recomendación" : "recomendaciones"} del asesor, con tus datos de hoy a las {hourEnd(view.recommendations[0]?.computedAt ?? new Date().toISOString())}
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
            <p className="text-xs font-semibold uppercase tracking-wide text-primary-soft-foreground">{item.area}</p>
            <p className="font-semibold">{item.title}</p>
            {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setOpen(item.key)}>
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
