import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { AdminRequest } from "../../components/agent/admin-draft"
import { AdminLine } from "../../components/agent/admin-line"
import { AdminPreview } from "../../components/agent/admin-recommendation"
import { ADMIN_PAGE_KEY, type AdminLineView, type AdminPage, refreshAdmin } from "../../lib/admin"
import type { AgentRoles } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

interface AdminSearch {
  /** Línea abierta: llega aquí desde una recomendación o un aviso. */
  linea?: string
  /** El aviso «no pude escribirle a N personas» pide ver solo a esas personas. */
  ver?: "no-pudo"
}

export const Route = createFileRoute("/_org/agent/administrador")({
  validateSearch: (search: Record<string, unknown>): AdminSearch => ({
    ...(typeof search.linea === "string" && search.linea ? { linea: search.linea } : {}),
    ...(search.ver === "no-pudo" ? { ver: "no-pudo" as const } : {}),
  }),
  component: AdministratorPage,
})

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"
/** Horas en punto y medias, para elegir el horario de silencio sin un campo de hora del navegador. */
const HOURS = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}`)

function Card({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6">
      <div>
        <h2 id={id} className="font-heading text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}

/** Un bloque de la lista: las prendidas o las listas para activar. */
function LineBlock({
  id,
  title,
  hint,
  lines,
  empty,
  open,
  onOpen,
  canWrite,
  adminOn,
  unreachedOnly,
}: {
  id: string
  title: string
  hint: string
  lines: AdminLineView[]
  empty: string
  open: string | undefined
  onOpen: (key: string | undefined) => void
  canWrite: boolean
  adminOn: boolean
  unreachedOnly: boolean
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 id={id} className="font-heading text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {lines.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="elevated flex flex-col divide-y rounded-xl border bg-card">
          {lines.map((line) => (
            <AdminLine
              key={line.key}
              line={line}
              open={open === line.key}
              onToggle={() => onOpen(open === line.key ? undefined : line.key)}
              canWrite={canWrite}
              adminOn={adminOn}
              unreachedOnly={unreachedOnly && open === line.key}
              onShowAll={() => onOpen(line.key)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function QuietHours({ page, canWrite }: { page: AdminPage; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<{ quietStart: string; quietEnd: string } | null>(null)
  const save = useMutation({
    retry: false,
    mutationFn: (input: { quietStart: string; quietEnd: string }) =>
      apiFetch("/api/agent/admin/settings", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: () => {
      setDraft(null)
      refreshAdmin(queryClient)
    },
  })
  const none = page.quietStart === page.quietEnd
  return (
    <section aria-label="Horario de silencio" className="flex flex-col gap-3 rounded-xl bg-muted p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 basis-64">
          <span className="font-semibold">Horario de silencio:</span>{" "}
          {none
            ? "el agente puede escribir por su cuenta a cualquier hora."
            : `el agente no escribe por su cuenta entre las ${page.quietStart} y las ${page.quietEnd}, con la hora de cada sede.`}{" "}
          Como mucho un mensaje al día por persona.
        </p>
        {canWrite && !draft ? (
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setDraft({ quietStart: page.quietStart, quietEnd: page.quietEnd })}>
            Cambiar
          </Button>
        ) : null}
      </div>
      {draft ? (
        <div className="flex flex-wrap items-end gap-3">
          {(["quietStart", "quietEnd"] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-xs font-semibold">
              {field === "quietStart" ? "No escribe desde las" : "Hasta las"}
              <Select value={draft[field]} onValueChange={(value) => setDraft({ ...draft, [field]: String(value) })}>
                <SelectTrigger className="w-28" aria-label={field === "quietStart" ? "Inicio del horario de silencio" : "Fin del horario de silencio"}>
                  <SelectValue>{draft[field]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ))}
          <Button type="button" size="sm" className="min-h-11 sm:min-h-9" disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-9" disabled={save.isPending} onClick={() => setDraft(null)}>
            Cancelar
          </Button>
          {save.isError ? (
            <p role="alert" className="basis-full text-destructive">
              {mutationErrorMessage(save.error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** Lo que falta para que las líneas que escriben puedan salir, con su acción. */
const PURPOSE_WORDS = {
  recordatorio: { what: "recordatorios de citas y controles", field: "recordatorios" },
  seguimiento: { what: "otros mensajes de la clínica", field: "otros mensajes" },
} as const

function MissingNotices({ page, onOpen }: { page: AdminPage; onOpen: (key: string) => void }) {
  const writes = page.lines.some((line) => line.enabled && line.agentPart)
  if (!page.enabled || !writes) return null
  return (
    <>
      {page.permissionGaps.map((gap) => (
        <div key={gap.purpose} role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-semibold">
              Prendida, pero casi no escribe: en 30 días no pudo escribirle a {gap.refused} de {gap.total} personas
            </p>
            <p>
              No aceptaron recibir {PURPOSE_WORDS[gap.purpose].what}.{" "}
              {gap.asks
                ? "Tu registro de pacientes ya lo pregunta: a quienes se registraron antes, pídeselo y márcalo en su ficha, en «Mensajes de la clínica»."
                : `Tu registro de pacientes no pregunta por ${PURPOSE_WORDS[gap.purpose].field}: actívalo y cada paciente nuevo podrá aceptarlo al registrarse.`}
            </p>
          </div>
          {gap.asks ? (
            <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={() => onOpen(gap.lineKey)}>
              Ver a quiénes no pudo escribir
            </Button>
          ) : (
            <Link to="/settings/patient-registration" className={LINK}>
              Preguntarlo en el registro
            </Link>
          )}
        </div>
      ))}
      {!page.receptionOn ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-semibold">Recepción está apagada: las que escriben a las personas quedan en pausa</p>
            <p>Recepción es quien escribe. Vuelven a salir cuando la enciendas; no se envía lo que quedó atrás. Las que dejan trabajo al equipo siguen.</p>
          </div>
          <Link to="/agent/recepcion" className={LINK}>
            Encender Recepción
          </Link>
        </div>
      ) : null}
      {!page.whatsapp ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-semibold">Sin WhatsApp conectado: solo puede escribir por correo</p>
            <p>A quien no tenga correo no le llega nada: avisa por qué y, si la línea tiene su tarea prendida, queda la tarea de llamada.</p>
          </div>
          <Link to="/settings/integrations/whatsapp" className={LINK}>
            Conectar WhatsApp
          </Link>
        </div>
      ) : null}
    </>
  )
}

function AdministratorPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate({ from: Route.fullPath })
  const { linea, ver } = Route.useSearch()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")

  const pageQuery = useQuery({
    queryKey: ADMIN_PAGE_KEY,
    queryFn: () => apiFetch<{ data: AdminPage }>("/api/agent/admin"),
    enabled: canRead,
    retry: false,
  })
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const power = useMutation({
    retry: false,
    mutationFn: (enabled: boolean) => apiFetch("/api/agent/admin/settings", { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSettled: () => refreshAdmin(queryClient),
  })

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="No tienes acceso a esta sección" message="Pídelo a quien administra la clínica. Tus pendientes siguen en su pestaña." />
      </PageShell>
    )
  }
  const page = pageQuery.data?.data
  const role = rolesQuery.data?.data.roles.find((item) => item.id === "administrador")
  const principles = rolesQuery.data?.data.principles ?? []
  const open = (key: string | undefined) => void navigate({ search: key ? { linea: key } : {}, replace: true })
  const on = page?.lines.filter((line) => line.enabled) ?? []
  const off = page?.lines.filter((line) => !line.enabled) ?? []

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Administrador"
        subtitle={role?.audience}
        actions={
          page && canWrite ? (
            <label htmlFor="administrador-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
              {page.enabled ? "Encendido" : "Apagado"}
              <Switch
                id="administrador-encendido"
                checked={page.enabled}
                disabled={power.isPending}
                aria-label={page.enabled ? "Apagar al Administrador" : "Encender al Administrador"}
                onCheckedChange={(next: boolean) => power.mutate(next)}
              />
            </label>
          ) : page ? (
            <Badge variant={page.enabled ? "success" : "secondary"}>{page.enabled ? "Encendido" : "Apagado"}</Badge>
          ) : null
        }
      />
      <Link to="/agent" className={`-mt-3 w-fit ${LINK}`}>
        Volver al resumen del agente
      </Link>
      {role ? <p className="-mt-2 max-w-prose text-sm">{role.role}</p> : null}

      {pageQuery.isPending || rolesQuery.isPending ? (
        <LoadingState message="Cargando al Administrador…" />
      ) : pageQuery.isError || !page || !role ? (
        <QueryErrorState error={pageQuery.error ?? rolesQuery.error} onRetry={() => void (pageQuery.isError ? pageQuery : rolesQuery).refetch()} />
      ) : (
        <>
          {power.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(power.error)}
            </p>
          ) : null}

          {page.enabled ? (
            <section aria-label="Hoy" className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl bg-muted p-4 text-sm">
              <span className="font-semibold">Hoy</span>
              <span>
                {page.today.recommendations} {page.today.recommendations === 1 ? "recomendación" : "recomendaciones"} en Inicio
              </span>
              <span>
                {page.today.done} {page.today.done === 1 ? "cosa hecha" : "cosas hechas"} por su cuenta
              </span>
              <span>
                {page.today.yours} {page.today.yours === 1 ? "tarea abierta le toca" : "tareas abiertas le tocan"} a tu equipo
              </span>
            </section>
          ) : (
            <Card
              id="administrador-apagado"
              title="Con tus datos de hoy, esto te recomendaría"
              hint="Calculado ahora. Mientras esté apagado no recomienda ni hace nada."
            >
              {canWrite ? <AdminPreview /> : <p className="text-sm text-muted-foreground">La vista previa la ve quien administra el agente.</p>}
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-4 text-sm">
                <p className="min-w-0 flex-1 basis-64">
                  {on.length > 0 ? (
                    <>
                      <span className="font-semibold">Al encenderlo solo hace lo que ya está prendido.</span> Las demás líneas empiezan
                      apagadas: él te recomienda en Inicio las que hoy tienen casos, y tú prendes las que quieras, una por una.
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">Al encenderlo no hace nada por su cuenta.</span> Las líneas de la lista empiezan
                      apagadas. Él te recomienda en Inicio las que hoy tienen casos, y tú prendes las que quieras, una por una.
                    </>
                  )}
                </p>
                {canWrite ? (
                  <Button type="button" className="min-h-11" disabled={power.isPending} onClick={() => power.mutate(true)}>
                    Encender al administrador
                  </Button>
                ) : null}
              </div>
            </Card>
          )}

          <MissingNotices page={page} onOpen={open} />

          {page.enabled && canWrite ? <AdminRequest onOpen={open} /> : null}

          {/* Con él apagado también se ven las prendidas: «Recordar la cita» viene prendida en toda clínica nueva (ADR 0026). */}
          {page.enabled || on.length > 0 ? (
            <LineBlock
              id="administrador-prendidas"
              title="Prendidas"
              hint={
                page.enabled
                  ? "Esto se hace solo. Cada línea dice quién lo hace: el agente, o una persona de tu equipo. Al tocar una, se abre con su flujo."
                  : "Empiezan a hacerse solas cuando enciendas al administrador. Puedes apagarlas antes. Al tocar una, se abre con su flujo."
              }
              lines={on}
              empty="Todavía no hay ninguna prendida. Prende abajo las que quieras, una por una."
              open={linea}
              onOpen={open}
              canWrite={canWrite}
              adminOn={page.enabled}
              unreachedOnly={ver === "no-pudo"}
            />
          ) : null}
          <LineBlock
            id="administrador-listas"
            title="Listas para activar"
            hint={
              page.enabled
                ? "Están apagadas: no pasa nada con ellas. Si hoy tienen casos, el administrador te las recomienda en Inicio."
                : "Lo que podrá hacer cuando lo enciendas. Tócalas para ver su flujo."
            }
            lines={off}
            empty="Todas están prendidas."
            open={linea}
            onOpen={open}
            canWrite={canWrite}
            adminOn={page.enabled}
            unreachedOnly={ver === "no-pudo"}
          />

          <QuietHours page={page} canWrite={canWrite} />
          {page.monthTemplates > 0 ? (
            <p className="text-sm text-muted-foreground">
              Este mes salieron {page.monthTemplates} {page.monthTemplates === 1 ? "mensaje aprobado" : "mensajes aprobados"} por WhatsApp. WhatsApp cobra
              cada uno según el país; responder dentro de las 24 horas no cuenta.
            </p>
          ) : null}

          <Card id="administrador-llega" title="Hasta dónde llega solo" hint="Solo hace lo que una persona prendió.">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Quién decide</dt>
                <dd className="text-muted-foreground">{role.confirms}</dd>
              </div>
              <div>
                <dt className="font-semibold">Nunca</dt>
                <dd className="text-muted-foreground">{role.never}</dd>
              </div>
            </dl>
          </Card>

          <Card id="administrador-sabe" title="Qué sabe" hint="De dónde salen sus números, y lo que no lee.">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Puede ver</dt>
                <dd className="text-muted-foreground">{role.sees}</dd>
              </div>
              <div>
                <dt className="font-semibold">No ve</dt>
                <dd className="text-muted-foreground">{role.notSees}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">
              Cada persona ve solo lo de aquello que su rol ya puede ver: caja no ve atenciones y recepción no ve cobranza.
            </p>
          </Card>

          <Card id="administrador-comporta" title="Cómo se comporta" hint="Primero la base que comparten todos los agentes; después cómo trabaja él.">
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-semibold">La base</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                {principles.map((principle) => (
                  <li key={principle}>{principle}</li>
                ))}
              </ul>
            </div>
            {role.behaves ? (
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-semibold">Al trabajar</p>
                <p className="text-muted-foreground">{role.behaves}</p>
              </div>
            ) : null}
          </Card>

          <Card id="administrador-prueba" title="Cómo se prueba" hint={role.testedWith ?? "Con lo que haría hoy con tus datos."}>
            <p className="text-sm text-muted-foreground">
              Cada línea apagada dice cuántos casos tendría hoy, y al abrirla se ve su flujo entero antes de prenderla.
            </p>
            {role.later ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Más adelante:</span> {role.later}
              </p>
            ) : null}
          </Card>

          <Card id="administrador-aprende" title="Qué aprende, y de quién es" hint="Lo que cambia con el uso, y a quién le pertenece.">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Qué aprende</dt>
                <dd className="text-muted-foreground">{role.learnsFrom}</dd>
              </div>
              {role.learningOwner ? (
                <div>
                  <dt className="font-semibold">De quién es</dt>
                  <dd className="text-muted-foreground">{role.learningOwner}</dd>
                </div>
              ) : null}
            </dl>
            {role.learnsLater ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Más adelante:</span> {role.learnsLater}
              </p>
            ) : null}
          </Card>
        </>
      )}
    </PageShell>
  )
}
