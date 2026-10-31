import { Button } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, DetailSection, LoadingState, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ADMIN_LINE_WHERE, type AdminAdvice, type AdminRecommendation, type AdminUnreached, refreshAdmin } from "../../lib/admin"
import { ADMIN_NAME, useReceptionName, withReceptionNameIn } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { QueryErrorState } from "../../lib/query-error"
import { AdminPersonItem, WhoDoesIt } from "./admin-line"
import { PersonLink } from "../person-link"

const PREVIEW = 4
const hour = (iso: string) => new Date(iso).toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit" })
/** La hora como cierre de frase: «p. m.» ya trae su punto. */
const hourEnd = (iso: string) => {
  const text = hour(iso)
  return text.endsWith(".") ? text : `${text}.`
}

/**
 * Una recomendación de Argos: una línea apagada que hoy tiene casos.
 * Dice cómo se calculó y quiénes son, y ofrece dos cosas: resolverlo solo esta
 * vez o prender la línea. Nada se ejecuta al abrirla.
 */
export function AdminRecommendationDrawer({ recommendationKey, onClose }: { recommendationKey: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const canTasks = usePermission("tasks.write")
  const canDecide = usePermission("agent.decide")
  const canAdmin = usePermission("agent.write")
  const [showAll, setShowAll] = useState(false)
  const [confirmOnce, setConfirmOnce] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ["agent-admin-advice", recommendationKey],
    queryFn: () => apiFetch<{ data: AdminRecommendation }>(`/api/agent/admin/recommendations/${recommendationKey}`),
    enabled: recommendationKey !== null,
    retry: false,
  })
  const once = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch<{ data: { created: number; total: number; writes: boolean; all: number } }>(`/api/agent/admin/recommendations/${recommendationKey}/once`, { method: "POST" }),
    onSuccess: (response) => {
      const { created, total, writes, all } = response.data
      // Si había más casos de los que se atienden de una vez, se dice el número real.
      const left = all > total ? ` Quedaron ${all - total} de ${all} sin atender: son más de los que se atienden de una vez.` : ""
      setDone(
        created === 0
          ? `Eso ya se pidió hoy: no se duplicó nada.${left}`
          : writes
            ? `Listo: ${receptionName} le${created === 1 ? "" : "s"} escribe a ${created === 1 ? "1 persona" : `${created} personas`} en unos minutos. A quien no pueda, lo verás en Inicio con el motivo.${left}`
            : `${created} ${created === 1 ? "tarea creada" : "tareas creadas"}${created < total ? `; las otras ${total - created} ya existían` : ""}. Las ves en Tareas.${left}`,
      )
      setConfirmOnce(false)
      refreshAdmin(queryClient)
    },
  })
  const stop = useMutation({
    retry: false,
    mutationFn: () => apiFetch(`/api/agent/admin/lines/${recommendationKey}`, { method: "PATCH", body: JSON.stringify({ noRecommend: true }) }),
    onSuccess: () => {
      refreshAdmin(queryClient)
      close()
    },
  })

  function close() {
    setShowAll(false)
    setDone(null)
    setConfirmOnce(false)
    once.reset()
    stop.reset()
    onClose()
  }

  if (recommendationKey === null) return null
  // Los textos del servidor nombran a «Sofi»: con otro nombre en la clínica, se dice el suyo.
  const item = query.data ? withReceptionNameIn(query.data.data, receptionName) : undefined
  const where = ADMIN_LINE_WHERE[recommendationKey]
  const rows = item ? (showAll ? item.items : item.items.slice(0, PREVIEW)) : []
  // «Solo esta vez» lo pide quien puede crear las tareas o, si el agente escribe, quien decide por él.
  const canOnce = item?.once ? (item.actor === "agente" ? canDecide : canTasks) : false

  return (
    <DetailDrawer open title={`Recomendación de ${ADMIN_NAME}`} description={item?.title} onClose={close} isSubmitting={once.isPending || stop.isPending}>
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
                      {row.patientId || row.contactId ? (
                        <PersonLink patientId={row.patientId} contactId={row.contactId} className="font-semibold text-primary hover:underline">
                          {row.personName}
                        </PersonLink>
                      ) : row.opportunityId ? (
                        <Link to="/pipeline" search={{ oportunidad: row.opportunityId }} className="font-semibold text-primary hover:underline">
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
            {item.once && item.total > 0 && canOnce ? (
              <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-3.5">
                <div className="flex flex-col gap-0.5">
                  <p className="text-[15px] font-bold">Solo esta vez</p>
                  <p className="text-sm">{item.once.detail}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full"
                  disabled={once.isPending}
                  aria-describedby={once.isError && !confirmOnce ? "recomendacion-una-vez-error" : undefined}
                  onClick={() => setConfirmOnce(true)}
                >
                  {item.once.label}
                </Button>
                {/* Con la confirmación abierta, el error se dice dentro de ella. */}
                {once.isError && !confirmOnce ? (
                  <p id="recomendacion-una-vez-error" role="alert" className="text-sm text-destructive">
                    {submitErrorMessage(once.error)}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-2.5 rounded-xl border border-agent-border bg-agent-soft p-3.5">
              <div className="flex flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-bold">
                  Prenderla <WhoDoesIt actor={item.actor} />
                </p>
                <p className="text-sm">
                  Desde ahora, y solo para lo que ocurra desde que la prendas: {item.description.charAt(0).toLowerCase() + item.description.slice(1)}
                </p>
              </div>
              {/* La página de Argos solo la abre quien administra el agente: a los demás no se les ofrece un enlace que rebota. */}
              {canAdmin ? (
                <Link
                  to="/agent/administrador"
                  search={{ linea: item.key }}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Ver su flujo y prender
                </Link>
              ) : (
                <p className="text-[13px] text-muted-foreground">La prende quien administra el agente.</p>
              )}
            </div>
            {where ? (
              <Link to={where.to} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8">
                {where.label}
              </Link>
            ) : null}
          </DetailSection>

          {canAdmin ? (
            <div className="flex flex-col gap-2 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 basis-48 text-[13px] text-muted-foreground">
                  ¿No te sirve? Pide que no te la recomiende más. Sigue en «Listas para activar» por si cambias de idea.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 sm:min-h-10"
                  disabled={stop.isPending}
                  aria-describedby={stop.isError ? "recomendacion-no-recomendar-error" : undefined}
                  onClick={() => stop.mutate()}
                >
                  No recomendarla más
                </Button>
              </div>
              {stop.isError ? (
                <p id="recomendacion-no-recomendar-error" role="alert" className="text-sm text-destructive">
                  {submitErrorMessage(stop.error)}
                </p>
              ) : null}
            </div>
          ) : null}

          {item.once ? (
            <ConfirmDialog
              open={confirmOnce}
              title={item.once.label}
              description={`${item.once.detail} La línea sigue apagada. Si hoy ya se pidió, no se repite.`}
              confirmLabel={item.actor === "agente" ? "Escribirles" : "Crear las tareas"}
              variant="default"
              pending={once.isPending}
              error={once.isError ? submitErrorMessage(once.error) : null}
              onClose={() => {
                if (!once.isPending) setConfirmOnce(false)
              }}
              onConfirm={() => once.mutate()}
            />
          ) : null}
        </div>
      )}
    </DetailDrawer>
  )
}

/**
 * Las personas a las que el agente no pudo escribir en los últimos 3 días,
 * por motivo y con cómo habilitar a cada una. No es una lista de errores: cada
 * motivo es algo que una persona puede corregir.
 */
export function AdminUnreachedDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const query = useQuery({
    queryKey: ["agent-admin-unreached"],
    queryFn: () => apiFetch<{ data: AdminUnreached }>("/api/agent/admin/unreached"),
    enabled: open,
    retry: false,
  })
  if (!open) return null
  const data = query.data?.data
  return (
    <DetailDrawer
      open
      title="El agente no pudo escribirles"
      description={data ? `${data.total} ${data.total === 1 ? "persona" : "personas"} en los últimos 3 días` : undefined}
      onClose={onClose}
    >
      {query.isPending ? (
        <LoadingState kind="indeterminate" message="Cargando…" />
      ) : query.isError || !data ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : data.total === 0 ? (
        <p className="text-sm text-muted-foreground">Ya no queda nadie: en los últimos 3 días el agente pudo escribirle a todos.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <DetailSection title="Por qué, y cómo habilitarlo">
            <ul className="flex flex-col gap-2">
              {data.byCause.map((row) => (
                <li key={row.cause} className="rounded-xl bg-muted px-3.5 py-3 text-sm">
                  <p className="font-semibold">
                    {row.total} {row.total === 1 ? "persona" : "personas"}: {row.reason}
                  </p>
                  <p className="text-muted-foreground">{row.fix}</p>
                </li>
              ))}
            </ul>
          </DetailSection>
          <DetailSection title="Quiénes son">
            <ul className="flex flex-col divide-y rounded-xl border bg-card">
              {data.people.map((row) => (
                <AdminPersonItem key={row.id} row={row} lineName={row.lineName} />
              ))}
            </ul>
          </DetailSection>
        </div>
      )}
    </DetailDrawer>
  )
}

/** Lo que Argos recomendaría hoy con los datos de ahora, aunque esté apagado. */
export function AdminPreview() {
  const [open, setOpen] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ["agent-admin-advice", "preview"],
    queryFn: () => apiFetch<{ data: AdminAdvice }>("/api/agent/admin/recommendations?all=1&preview=1"),
    retry: false,
  })
  if (query.isPending) return <LoadingState kind="indeterminate" message="Calculando con tus datos de ahora…" />
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const items = query.data.data.recommendations
  return (
    <>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Hoy no recomendaría nada: ninguna línea apagada tiene casos.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-semibold">{item.title}</p>
                {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
              </div>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setOpen(item.key)}>
                Ver la lista
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AdminRecommendationDrawer recommendationKey={open} onClose={() => setOpen(null)} />
    </>
  )
}
