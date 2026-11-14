import { Alert, AlertDescription, AlertTitle, Button } from "@odentia/ui"
import { internationalText, SkeletonRegion } from "@odentia/ui-patterns"
import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { allergyName } from "../../lib/allergies"
import { saidNoWords } from "../../lib/declared-health"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { type TaskItem, useCan, usePermission } from "../../lib/crm"
import {
  ageFrom,
  fetchPatientHealth,
  hcLabel,
  type PatientFull,
  type PatientSummary,
} from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { type PersonPage, RELATIONSHIP_WORDS, relationshipText } from "../../lib/people"
import { TaskDrawer } from "../crm/task-drawer"
import { storesTomography } from "../patient/document-labels"
import { NewPatientDrawer, type NewPatientTarget } from "../patient/new-patient-drawer"
import { NextUpCard, usePersonUpcoming } from "../patient/next-up"
import { ClinicalAlertsCard, LastVisitCard, OpenEncounterCard } from "../patient/resumen-clinico"
import { PatientPendingCard, SummaryCard } from "../patient/resumen-tab"
import { useOpenWide } from "../patient/wide-section"
import { PersonLink } from "../person-link"
import { LastVisitLinesSkeleton } from "../skeletons/person-sections"
import { WriteToPersonDialog } from "../write-to-person"
import { PersonConversations } from "./person-conversations"
import { PersonAgentMemory, PersonNotes } from "./person-notes"
import { PersonTomographies } from "./person-tomographies"
import { productUi } from "../../product/product-ui"

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{children}</dd>
    </div>
  )
}

/**
 * Resumen de la persona (tablero 2): lo que hace falta para atenderla de un
 * vistazo —teléfono, alergias, próxima cita, saldo, conversación y
 * oportunidad—, «Falta su registro como paciente» si aún no lo es, sus
 * pendientes, sus notas y lo que recuerda el agente. Cada dato se pide con su
 * permiso.
 *
 * Para quien lee la clínica es el Resumen clínico (ADR 0035): arriba la
 * atención en curso, alergias y alertas, «Qué sigue» y la última atención;
 * recepción y caja ven el de siempre, con su «Qué sigue» arriba.
 *
 * «Qué sigue» es una sola lista con la próxima cita, lo del plan y el control
 * (QA del 8 nov, propuesta 5). Va por filas alineadas, nunca en columnas
 * sueltas: cada tarjeta en su fila.
 */
export function PersonSummary({
  person,
  detail,
  summary,
}: {
  person: PersonPage
  detail?: PatientFull
  /** El resumen clínico que pidió la página: solo para quien lee la historia. */
  summary?: UseQueryResult<{ data: PatientSummary }>
}) {
  const openWide = useOpenWide()
  const patientId = person.patient?.id ?? null
  const ProductClinicalCards = productUi().summary.ClinicalCards
  const can = useCan()
  const canAlerts = can("clinical.alerts") || can("clinical.read")
  // Quien recibe el CD sin leer la historia (recepción) sube aquí la tomografía.
  const receivesTomography = can("clinical.receive") && !can("clinical.read") && storesTomography()
  const canAppointments = usePermission("appointments.read")
  // «Qué sigue» lo pide quien ve alguna parte del plan (la misma condición del servidor).
  const canPlan = can("clinical.read") || can("budgets.read") || canAppointments
  const canChats = usePermission("conversations.read")
  const canCrm = usePermission("crm.read")
  const canTasks = usePermission("tasks.read")
  const canRegister = usePermission("patients.write")
  const canSendLink = can("crm.write") && can("conversations.write")
  const [registering, setRegistering] = useState(false)
  const registerTarget: NewPatientTarget = { kind: "person", person }
  const [newTask, setNewTask] = useState(false)
  const [viewingTask, setViewingTask] = useState<string | null>(null)
  const canTaskWrite = usePermission("tasks.write")
  const queryClient = useQueryClient()
  const [sendingLink, setSendingLink] = useState(false)

  const clinical = Boolean(summary && patientId)
  const health = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId ?? ""),
    enabled: clinical,
  })
  // Sin ficha, sus tareas cuelgan de la persona (las del paciente las lista «Pendientes»).
  const tasks = useQuery({
    queryKey: ["person-tasks", person.id],
    queryFn: () => apiFetch<{ data: TaskItem[] }>(`/api/tasks?status=open&contactId=${person.id}`),
    enabled: !patientId && canTasks && canCrm,
    retry: false,
  })

  const allergies = (detail?.activeAllergies ?? []).filter(
    (allergy) => allergy.verification !== "descartada",
  )
  const phoneText = person.phone ? internationalText(person.phone) : null
  // Sin teléfono propio, el de quien habla por ella (la preferida primero, como la entrega el servidor).
  const spokenPhone = phoneText ? null : (person.spokenForBy.find((other) => other.phone) ?? null)
  // El número de su WhatsApp es dato de canal: solo para quien ve sus canales.
  const whatsappElsewhere = person.channels.includes("whatsapp") ? (person.phoneWhatsApp.otherNumber ?? null) : null

  const clinicalData = summary?.data?.data
  // La próxima cita va en la cabecera: «Qué sigue» no la repite (mesa del 9 nov).
  const upcoming = usePersonUpcoming(patientId, canAppointments)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {clinical && patientId ? (
        <>
          {clinicalData?.openEncounter ? (
            <OpenEncounterCard patientId={patientId} encounter={clinicalData.openEncounter} />
          ) : null}
          {health.isError ? (
            <QueryErrorState error={health.error} onRetry={() => void health.refetch()} />
          ) : (
            <ClinicalAlertsCard
              patientId={patientId}
              patientName={person.displayName}
              health={health.data?.data ?? null}
              sex={person.sex}
              onAntecedentes={() => openWide?.({ id: "antecedentes" })}
            />
          )}
          {/* Lo del producto debajo de las alertas (latidIA: la lista de problemas, issue 229). */}
          <ProductClinicalCards patientId={patientId} onSection={(section) => openWide?.({ id: section })} />
          <NextUpCard patientId={patientId} patientName={person.displayName} upcomingId={upcoming?.appointment?.id} />
          {clinicalData ? (
            <LastVisitCard
              patientId={patientId}
              summary={clinicalData}
              onPeriodontal={(chartId) => openWide?.({ id: "periodontograma", opened: chartId })}
            />
          ) : summary?.isError ? (
            <QueryErrorState error={summary.error} onRetry={() => void summary.refetch()} />
          ) : (
            <SummaryCard title="Última atención">
              <SkeletonRegion message="Consultando…">
                <LastVisitLinesSkeleton />
              </SkeletonRegion>
            </SummaryCard>
          )}
        </>
      ) : patientId && canPlan ? (
        <NextUpCard patientId={patientId} patientName={person.displayName} upcomingId={upcoming?.appointment?.id} />
      ) : null}
      {patientId && receivesTomography && !person.archived ? (
        <PersonTomographies patientId={patientId} />
      ) : null}
      <section aria-label="Resumen" className="elevated rounded-xl border bg-card p-6">
        <dl className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {person.responsibleFor.length > 0 ? (
            <Fact label="Responsable de">
              <span className="flex flex-col gap-0.5">
                {person.responsibleFor.map((row) => {
                  const age = ageFrom(row.birthDate)
                  return (
                    <span key={row.patientId}>
                      <PersonLink patientId={row.patientId} contactId={row.personId}>
                        {row.displayName}
                      </PersonLink>
                      <span className="font-normal text-muted-foreground">
                        {" · "}
                        {[
                          age ? `${age} años` : null,
                          hcLabel(row.patientNumber),
                          row.relationshipDetail || RELATIONSHIP_WORDS[row.relationship],
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  )
                })}
              </span>
            </Fact>
          ) : null}
          {/* Para todos: antes, quien lee la clínica lo veía en «Próxima cita». */}
          <Fact label="Teléfono">
            {phoneText
              ? `${phoneText}${person.phoneWhatsApp.state === "es_su_whatsapp" ? " · WhatsApp" : ""}`
              : spokenPhone?.phone
                ? `el de ${spokenPhone.displayName} (${relationshipText(spokenPhone.relationship, spokenPhone.relationshipDetail).toLowerCase()}) · ${internationalText(spokenPhone.phone)}`
                : "Sin teléfono"}
            {/* «· WhatsApp» solo si ese número lo es; si su WhatsApp es otro, se dice cuál (QA del 8 nov). */}
            {whatsappElsewhere ? (
              <span className="block text-xs font-normal text-muted-foreground">
                Su WhatsApp es otro: {internationalText(whatsappElsewhere)}
              </span>
            ) : phoneText && person.phoneWhatsApp.state === "aun_no" && person.channels.includes("whatsapp") ? (
              // Escribe por WhatsApp desde una cuenta que no muestra su número: este teléfono no es ese
              // WhatsApp todavía, como dice Datos (QA de la ficha del 9 nov: «Canales: WhatsApp» parecía él).
              <span className="block text-xs font-normal text-muted-foreground">Aún no es su WhatsApp</span>
            ) : null}
          </Fact>
          {(canChats || canCrm) && person.channels.length > 0 ? (
            <Fact label="Canales">
              {person.channels.map((channel) => channelLabel(channel)).join(", ")}
            </Fact>
          ) : null}
          {patientId && canAlerts && detail && !clinical ? (
            <Fact label="Alergias">
              {allergies.length === 0
                ? // El «No» que marcó la persona (o quien habla por ella) no es un «niega» de la clínica.
                  detail.allergySaidNo
                  ? `${saidNoWords(detail.allergySaidNo.by, person.sex)} · sin revisar`
                  : "Sin alergias registradas"
                : allergies.map((allergy) => allergyName(allergy)).join(", ")}
            </Fact>
          ) : null}
        </dl>
      </section>
      {/* Antes era la pestaña Conversaciones (QA de la ficha del 8 nov). */}
      <PersonConversations person={person} />

      {person.kind === "por_registrar" && !person.archived ? (
        <Alert>
          <AlertTitle>Falta su registro como paciente</AlertTitle>
          <AlertDescription>
            <span className="block">
              Se necesita antes de su primera atención. Puede hacerlo por su cuenta con «Su enlace», donde también elige su cita, o tú ahora.
            </span>
            {canSendLink || canRegister ? (
              <span className="mt-2 flex flex-wrap gap-2">
                {canSendLink ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSendingLink(true)}
                  >
                    {/* Abre su conversación con «Su enlace» preparado para revisarlo: no lo envía desde aquí. */}
                    Escribirle con su enlace
                  </Button>
                ) : null}
                {canRegister ? (
                  <Button type="button" size="sm" onClick={() => setRegistering(true)}>
                    Registrar
                  </Button>
                ) : null}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {patientId && detail ? (
        <PatientPendingCard
          patientId={patientId}
          detail={detail}
          clinical={
            clinical
              ? { summary: clinicalData, health: health.data?.data, loading: Boolean(summary?.isLoading) || health.isLoading }
              : undefined
          }
        />
      ) : !patientId && canTasks && canCrm ? (
        <SummaryCard
          title="Pendientes"
          action={
            canTaskWrite && !person.archived ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setNewTask(true)}
              >
                Nueva tarea
              </Button>
            ) : undefined
          }
        >
          {(tasks.data?.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sin tareas abiertas para esta persona.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {(tasks.data?.data ?? []).map((task) => (
                <li
                  key={task.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="text-sm font-medium">{task.title}</span>
                  {/* La tarea se abre al lado, en el cajón de siempre. */}
                  <Button type="button" size="sm" variant="outline" onClick={() => setViewingTask(task.id)}>
                    Ver tarea
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SummaryCard>
      ) : null}
      <PersonNotes personId={person.id}>
        <PersonAgentMemory personId={person.id} inline />
      </PersonNotes>

      <NewPatientDrawer
        open={registering}
        onClose={() => setRegistering(false)}
        target={registerTarget}
      />
      {viewingTask ? (
        <TaskDrawer
          open
          taskId={viewingTask}
          contactId={person.id}
          onClose={() => setViewingTask(null)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["person-tasks", person.id] })}
        />
      ) : null}
      {!patientId ? (
        <TaskDrawer
          open={newTask}
          contactId={person.id}
          onClose={() => setNewTask(false)}
          onSaved={() =>
            void queryClient.invalidateQueries({ queryKey: ["person-tasks", person.id] })
          }
        />
      ) : null}
      <WriteToPersonDialog
        open={sendingLink}
        onClose={() => setSendingLink(false)}
        people={[{ contactId: person.id, displayName: person.displayName }]}
        prepareRegistration
      />
    </div>
  )
}
