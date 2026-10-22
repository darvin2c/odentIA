import { Badge, Button } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { AdminRequest } from "../../components/agent/admin-draft"
import { AdminLine } from "../../components/agent/admin-line"
import { AdminPreview } from "../../components/agent/admin-recommendation"
import { ADMIN_PAGE_KEY, type AdminLineView, type AdminPage, refreshAdmin } from "../../lib/admin"
import { writingWeekRows } from "../../lib/writing-hours"
import { type AgentRoles, namedAgentRoles } from "../../lib/agent"
import { ADMIN_NAME, AGENT_NAME_REASONS, useReceptionName } from "../../lib/agent-names"
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

/**
 * A qué hora escribe: el «Horario para escribir» de Agente (decisión 18 v3),
 * el mismo para todo lo que sale solo. Aquí solo se dice y se lleva ahí.
 */
function WritingHoursNote({ page }: { page: AdminPage }) {
  const rows = writingWeekRows(page.writingHours)
  return (
    <section aria-label="Horario para escribir" className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-4 text-sm">
      <p className="min-w-0 flex-1 basis-64">
        <span className="font-semibold">Horario para escribir:</span>{" "}
        {rows.map((row) => `${row.days} ${row.hours ?? "no escribimos"}`).join(" · ")}, con la hora de cada sede. Como mucho un mensaje al día por
        persona.
      </p>
      <Link to="/agent" hash="horario-para-escribir" className={LINK}>
        Ver o cambiar
      </Link>
    </section>
  )
}

/** Lo que falta para que las líneas que escriben puedan salir, con su acción. */
/** Solo novedades y promociones pide permiso (ADR 0030): lo demás es parte del servicio. */
const PURPOSE_WORDS = {
  novedades: { what: "novedades y promociones", field: "novedades y promociones" },
} as const

/**
 * Lo que falta para que lo prendido escriba, cada cosa con su acción. Sin
 * Sofi o sin Argos, «Recordar la cita» y sus avisos no salen
 * aunque estén prendidos: se dice y se ofrece encenderlos a quien puede.
 */
function MissingNotices({
  page,
  onOpen,
  canWrite,
  powering,
  onTurnOn,
}: {
  page: AdminPage
  onOpen: (key: string) => void
  canWrite: boolean
  powering: boolean
  onTurnOn: () => void
}) {
  const receptionName = useReceptionName()
  const writing = page.lines.filter((line) => line.enabled && line.agentPart)
  if (writing.length === 0) return null
  const what = writing.length === 1 ? `«${writing[0]!.name}» está prendida` : `${writing.length} líneas que escriben están prendidas`
  const offWords =
    !page.enabled && !page.receptionOn
      ? `${ADMIN_NAME} y ${receptionName} están apagados`
      : !page.enabled
        ? `${ADMIN_NAME} está apagado`
        : !page.receptionOn
          ? `${receptionName} no está atendiendo`
          : null
  // Sin ellos no sale nada: lo ve quien puede encenderlos.
  if (offWords) {
    if (!canWrite) return null
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-semibold">
            {what}, pero {offWords}: no le sale ningún mensaje a nadie
          </p>
          <p>
            {page.enabled
              ? `${receptionName} es quien escribe. Al encenderla salen los recordatorios y los avisos de lo que pase desde ahí; no se envía lo que quedó atrás.`
              : `${ADMIN_NAME} detecta a quién escribir y ${receptionName} escribe. Al encenderlos salen los recordatorios y los avisos de lo que pase desde ahí; no se envía lo que quedó atrás.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!page.enabled ? (
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={powering} onClick={onTurnOn}>
              Encender a {ADMIN_NAME}
            </Button>
          ) : null}
          {!page.receptionOn ? (
            <Link to="/agent/recepcion" className={LINK}>
              Encender a {receptionName}
            </Link>
          ) : null}
        </div>
      </div>
    )
  }
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
      {!page.whatsapp ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
          <div className="min-w-0 flex-1 basis-64">
            <p className="font-semibold">Sin WhatsApp conectado: solo puede escribir por correo</p>
            <p>A quien no tenga correo no le llega nada: avisa por qué y, si la línea tiene su tarea prendida, queda la tarea de llamada.</p>
          </div>
          <Link to="/settings/integrations/whatsapp" search={{ mensaje: undefined }} className={LINK}>
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
  const receptionName = useReceptionName()

  const pageQuery = useQuery({
    queryKey: ADMIN_PAGE_KEY,
    queryFn: () => apiFetch<{ data: AdminPage }>("/api/agent/admin"),
    enabled: canRead,
    retry: false,
  })
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    select: (body) => ({ data: namedAgentRoles(body.data, receptionName) }),
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
        <ErrorState title="No tienes acceso a esta sección" message="Pídelo a quien administra la clínica. Las citas que esperan su sí siguen en «Esperan su sí»." />
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
        title={`${ADMIN_NAME}, tu agente administrador`}
        subtitle={
          <>
            <p className="min-w-0">{AGENT_NAME_REASONS.administrador}</p>
            {page && canWrite ? (
              <label htmlFor="administrador-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
                {page.enabled ? "Encendido" : "Apagado"}
                <Switch
                  id="administrador-encendido"
                  checked={page.enabled}
                  disabled={power.isPending}
                  aria-label={page.enabled ? `Apagar a ${ADMIN_NAME}` : `Encender a ${ADMIN_NAME}`}
                  onCheckedChange={(next: boolean) => power.mutate(next)}
                />
              </label>
            ) : page ? (
              <Badge variant={page.enabled ? "success" : "secondary"}>{page.enabled ? "Encendido" : "Apagado"}</Badge>
            ) : null}
          </>
        }
      />
      <Link to="/agent" className={`-mt-3 w-fit ${LINK}`}>
        Volver al resumen del agente
      </Link>
      {role ? <p className="-mt-2 max-w-prose text-sm">{role.role}</p> : null}

      {pageQuery.isPending || rolesQuery.isPending ? (
        <LoadingState message={`Cargando a ${ADMIN_NAME}…`} />
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
                    Encender a {ADMIN_NAME}
                  </Button>
                ) : null}
              </div>
            </Card>
          )}

          <MissingNotices page={page} onOpen={open} canWrite={canWrite} powering={power.isPending} onTurnOn={() => power.mutate(true)} />

          {page.enabled && canWrite ? <AdminRequest onOpen={open} /> : null}

          {/* Con él apagado también se ven las prendidas: «Recordar la cita» viene prendida en toda clínica nueva (ADR 0026). */}
          {page.enabled || on.length > 0 ? (
            <LineBlock
              id="administrador-prendidas"
              title="Prendidas"
              hint={
                page.enabled
                  ? `Esto se hace solo. Cada línea dice quién lo hace: ${ADMIN_NAME}, o una persona de tu equipo. Al tocar una, se abre con su flujo.`
                  : `Empiezan a hacerse solas cuando enciendas a ${ADMIN_NAME}. Puedes apagarlas antes. Al tocar una, se abre con su flujo.`
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
                ? `Están apagadas: no pasa nada con ellas. Si hoy tienen casos, ${ADMIN_NAME} te las recomienda en Inicio.`
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

          <WritingHoursNote page={page} />
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
