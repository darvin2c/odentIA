import { formatMoney } from "@odentia/clinical"
import { Button, buttonVariants } from "@odentia/ui"
import { AgentMark, EmptyState, SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleCheck } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useReceptionName } from "../../lib/agent-names"
import { ACTION_LABEL, type AgentProposal } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { fetchConsents } from "../../lib/clinical-forms"
import { type TaskItem, usePermission } from "../../lib/crm"
import { fetchPatientAccount3 } from "../../lib/finance-collect"
import { useOrgProfile } from "../../lib/org"
import type { PatientFull, PatientHealth, PatientSummary } from "../../lib/patients"
import { filiationGapsText, isHealthReviewPending } from "../../lib/patients"
import { usePersonArchived } from "../../lib/person-archived"
import { FiliacionSectionDrawer, type FiliacionSectionKey } from "./filiacion-section-drawer"
import { dueWords, isOverdue } from "../crm/crm-helpers"
import { TaskDrawer } from "../crm/task-drawer"
import { useCollectFlow } from "./collect-flow"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"
import { ConsentSigningScreen } from "./consent-signing"
import { PersonalLinkActions } from "./send-personal-link"
import { useOpenWide, type WideTarget } from "./wide-section"
import { LastVisitLinesSkeleton } from "../skeletons/person-sections"

interface Pending {
  id: string
  title: string
  detail: string
  action: ReactNode
  /** Lo propone el agente: se distingue con su identidad visual. */
  agent?: boolean
  /** La acción trae su propio aviso y varios botones: va debajo, a lo ancho. */
  stacked?: boolean
}

export function SummaryCard({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6">
      {/* El alto de un botón, lo lleve o no: dos tarjetas en la misma fila alinean sus títulos. */}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * La lista de pendientes. Mientras alguna consulta todavía responde, no dice
 * «Sin pendientes»: lo que recepción mira de reojo no puede afirmar que no hay
 * nada antes de saberlo (QA del 6 nov, M9).
 */
export function PendingList({ pending, loading = false }: { pending: Pending[]; loading?: boolean }) {
  if (pending.length === 0 && loading)
    return (
      <SkeletonRegion message="Consultando pendientes…">
        <LastVisitLinesSkeleton />
      </SkeletonRegion>
    )
  if (pending.length === 0)
    return (
      <EmptyState
        icon={CircleCheck}
        title="Sin pendientes"
        description="No hay nada que requiera tu acción sobre esta persona ahora."
      />
    )
  return (
    <ul className="flex flex-col divide-y">
      {pending.map((item) => (
        <li
          key={item.id}
          className={`flex flex-wrap items-center justify-between gap-3 py-3 ${
            item.agent
              ? "my-2 rounded-lg border border-agent-border bg-agent-soft px-3"
              : "first:pt-0 last:pb-0"
          }`}
        >
          {item.agent ? <AgentMark size="sm" /> : null}
          {/* El texto tiene un ancho mínimo: una acción ancha baja de línea en vez de dejarlo en una columna de una palabra. */}
          <div className="min-w-0 flex-[1_1_16rem]">
            <p className="text-sm font-medium">{item.title}</p>
            {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
          </div>
          {item.stacked ? <div className="basis-full">{item.action}</div> : item.action}
        </li>
      ))}
      {loading ? (
        <li className="py-3 text-sm text-muted-foreground" role="status">
          Consultando si hay más…
        </li>
      ) : null}
    </ul>
  )
}

/**
 * Pendientes del paciente para el Resumen: lo que el agente dejó esperando el
 * sí del paciente, saldo, datos que faltan y sus tareas. Lo del plan, la
 * próxima cita y el control van en «Qué sigue», arriba (QA del 8 nov).
 * Para quien atiende suma lo clínico que le toca (antecedentes declarados por
 * revisar y consentimientos sin firmar). Cada bloque pide solo lo que su
 * permiso autoriza; el representante va en la cabecera. Cada botón actúa aquí
 * mismo: revisar, firmar, confirmar y cobrar no cambian de pestaña.
 */
export function PatientPendingCard({
  patientId,
  detail,
  clinical,
}: {
  patientId: string
  detail: PatientFull
  /** Lo clínico ya leído por el Resumen de quien atiende (no se pide aquí). */
  clinical?: { summary?: PatientSummary; health?: PatientHealth | null; loading?: boolean }
}) {
  const openWide = useOpenWide()
  const archived = usePersonArchived()
  const canSign = usePermission("clinical.write")
  const receptionName = useReceptionName()
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const canPatients = usePermission("patients.read")
  const canEditPatient = usePermission("patients.write")
  const canDecide = usePermission("agent.decide")
  const canReadAgent = usePermission("agent.read")
  const canTasks = usePermission("tasks.read")
  const canWriteTasks = usePermission("tasks.write")
  const queryClient = useQueryClient()
  // «Completar» abre el cajón con solo lo que falta, sin salir del Resumen.
  const [completing, setCompleting] = useState<FiliacionSectionKey | null>(null)
  // Una tarea de la persona se crea con el mismo cajón que en Tareas (vence con «Día y hora»).
  const [newTask, setNewTask] = useState(false)
  // «Ver tarea» la abre en ese mismo cajón, sin ir a Tareas.
  const [viewingTask, setViewingTask] = useState<string | null>(null)

  const profile = useOrgProfile()
  const orgLocale = profile.data?.locale
  const money = (cents: number, currency: string): string =>
    orgLocale ? formatMoney(cents, currency, orgLocale) : "…"
  const accountQuery = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canFinance,
  })
  // La fila del saldo se va al quedar pagado: el cajón y el ticket viven en la tarjeta.
  const collect = useCollectFlow({
    patientId,
    patientName: detail.patient.displayName,
    enabled: accountQuery.data?.data.byCurrency.some((balance) => balance.porCobrar > 0) ?? false,
  })
  const proposalsQuery = useQuery({
    queryKey: ["agent-proposals", "propuesta", "patient", patientId],
    queryFn: () =>
      apiFetch<{ data: AgentProposal[] }>(
        `/api/agent/proposals?status=propuesta&patientId=${patientId}`,
      ),
    enabled: canDecide || canReadAgent,
    retry: false,
  })
  const tasksQuery = useQuery({
    queryKey: ["patient-tasks", patientId],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=open&patientId=${patientId}`),
    enabled: canTasks && canPatients,
    retry: false,
  })
  // Firmar o confirmar pide el documento entero: el Resumen solo trae su título y sus fechas.
  const pendingConsents = clinical?.summary?.pendingConsents ?? []
  const consents = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: canSign && pendingConsents.length > 0,
  })
  const [signingId, setSigningId] = useState<string | null>(null)
  const consentOf = (id: string) => consents.data?.data.find((row) => row.id === id) ?? null
  const signing = signingId ? consentOf(signingId) : null
  const consentsChanged = () => {
    void queryClient.invalidateQueries({ queryKey: ["consents", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
  }

  const open = (label: string, target: WideTarget) => (
    <Button size="sm" variant="outline" onClick={() => openWide?.(target)}>
      {label}
    </Button>
  )

  const pending: Pending[] = []
  if (canClinical && clinical) {
    if (clinical.health && isHealthReviewPending(clinical.health))
      pending.push({
        id: "health-review",
        title: "Antecedentes declarados por revisar",
        detail: "El paciente o su responsable los declaró; falta la validación clínica.",
        action: open("Revisar", { id: "antecedentes", review: true }),
      })
    for (const consent of pendingConsents) {
      const document = consentOf(consent.id)
      const signedByLink = Boolean(consent.personSignedAt)
      pending.push({
        id: `consent-${consent.id}`,
        title: `${signedByLink ? "Consentimiento por confirmar" : "Consentimiento sin firmar"}: ${consent.title}`,
        detail:
          consents.isError ? "No se pudo leer el documento." :
          consentLinkWords({ status: "pendiente", personSignedAt: consent.personSignedAt ?? null, linkSentAt: consent.linkSentAt ?? null }) ??
          "Emitido y pendiente de la firma de la persona o su representante.",
        // Mientras se lee el documento, el botón espera: pulsarlo no abriría nada.
        action: !canSign ? null : consents.isError ? (
          <Button size="sm" variant="outline" disabled={consents.isFetching} onClick={() => void consents.refetch()}>
            Reintentar
          </Button>
        ) : signedByLink ? (
          document ? (
            <ConsentLinkActions document={document} onChanged={consentsChanged} />
          ) : (
            <Button size="sm" disabled>
              Confirmar
            </Button>
          )
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Firmar ${consent.title}`}
            disabled={!document}
            onClick={() => setSigningId(consent.id)}
          >
            Firmar
          </Button>
        ),
      })
    }
  }
  for (const proposal of proposalsQuery.data?.data ?? [])
    pending.push({
      id: `proposal-${proposal.id}`,
      agent: true,
      title: `${receptionName} propone: ${ACTION_LABEL[proposal.action] ?? proposal.action}`,
      detail:
        proposal.context.afterSummary || proposal.reason || "Espera la confirmación del paciente.",
      action: (
        <Link to="/inbox" search={{ conversation: proposal.conversationId }} className={buttonVariants({ size: "sm" })}>
          Ver la conversación
        </Link>
      ),
    })
  for (const balance of accountQuery.data?.data.byCurrency ?? []) {
    // El saldo descuenta lo que tiene a favor (decisión 22).
    if (balance.porCobrar > 0)
      pending.push({
        id: `balance-${balance.currency}`,
        title:
          balance.saldo > 0
            ? `Saldo por cobrar de ${money(balance.saldo, balance.currency)}`
            : "Lo que tiene a favor cubre lo que debe",
        detail:
          balance.aFavor > 0
            ? `Debe: ${money(balance.porCobrar, balance.currency)} · A favor: ${money(balance.aFavor, balance.currency)} · Saldo: ${money(balance.saldo, balance.currency)}`
            : "Cargos emitidos sin pago aplicado.",
        // El mismo cobro de Cobros, ahí mismo; «Aplicar…» siempre pide confirmar.
        action: collect.button({ size: "sm", variant: "outline", currency: balance.currency }),
      })
  }
  if (canEditPatient) {
    // «Faltan datos para atenderla»: lo calcula el servidor (la misma regla que
    // la Agenda y la nota del caso). Una ficha creada con lo mínimo queda además
    // con los apellidos por confirmar: guardar en «Completar» los confirma.
    const gaps = detail.missingData ?? []
    const review = detail.patient.identityNeedsReview ? "Confirma sus apellidos." : ""
    if (gaps.length > 0 || review)
      pending.push({
        id: "filiacion",
        // En una línea, qué falta (QA de la ficha del 9 nov: eran 4 líneas en casi todos).
        title: gaps.length > 0 ? `Faltan datos: ${filiationGapsText(gaps).toLowerCase()}` : "Apellidos por confirmar",
        detail: review,
        action: (() => {
          const complete = (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCompleting(gaps.length > 0 ? "completar" : "identidad")}
            >
              Completar
            </Button>
          )
          // Su enlace: enviarlo, o copiarlo y mostrar su código cuando no se puede enviar.
          return gaps.length > 0 ? (
            <PersonalLinkActions patientId={patientId} missing={filiationGapsText(gaps)} leading={complete} />
          ) : (
            <span className="flex flex-wrap gap-2">{complete}</span>
          )
        })(),
      })
  }
  for (const task of tasksQuery.data?.data ?? [])
    pending.push({
      id: `task-${task.id}`,
      title: `Tarea: ${task.title}`,
      detail: task.dueAt ? `${isOverdue(task.dueAt) ? "Venció" : "Vence"} ${dueWords(task.dueAt)}.` : "Sin fecha límite.",
      action: (
        <Button size="sm" variant="outline" onClick={() => setViewingTask(task.id)}>
          Ver tarea
        </Button>
      ),
    })

  return (
    <SummaryCard
      title="Pendientes"
      action={
        canWriteTasks && !archived ? (
          <Button size="sm" variant="outline" onClick={() => setNewTask(true)}>
            Nueva tarea
          </Button>
        ) : null
      }
    >
      <PendingList
        pending={pending}
        loading={
          Boolean(clinical?.loading) ||
          accountQuery.isLoading ||
          proposalsQuery.isLoading ||
          tasksQuery.isLoading
        }
      />
      {collect.surfaces}
      <ConsentSigningScreen
        open={signing !== null}
        documents={signing ? [signing] : []}
        patientId={patientId}
        onClose={() => setSigningId(null)}
        onSigned={consentsChanged}
      />
      {viewingTask ? (
        <TaskDrawer
          open
          taskId={viewingTask}
          patientId={patientId}
          onClose={() => setViewingTask(null)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["patient-tasks", patientId] })}
        />
      ) : null}
      {canWriteTasks ? (
        <TaskDrawer
          open={newTask}
          patientId={patientId}
          onClose={() => setNewTask(false)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["patient-tasks", patientId] })}
        />
      ) : null}
      {completing ? (
        <FiliacionSectionDrawer
          key={completing}
          patient={detail.patient}
          section={completing}
          missing={detail.missingData ?? []}
          open
          onClose={() => setCompleting(null)}
        />
      ) : null}
    </SummaryCard>
  )
}

