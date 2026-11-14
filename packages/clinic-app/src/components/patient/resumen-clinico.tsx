import { diagnosisCodeLabel } from "@odentia/clinical"
import { Button, buttonVariants } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { allergyName, allergyRank, allergySeverityWord, bySeverity } from "../../lib/allergies"
import { useMemberName, useMyUserId, usePermission } from "../../lib/crm"
import {
  declaredGroupOf,
  pregnancyGroupOf,
  pregnancyWords,
  saidByWords,
  saidNoGroupOf,
  saidNoWords,
  shortDay,
} from "../../lib/declared-health"
import { clinicToday } from "../../lib/inventory"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import {
  asaLabel,
  isCurrentMedication,
  type OpenEncounterBrief,
  type PatientHealth,
  type PatientSummary,
} from "../../lib/patients"
import { usePersonArchived } from "../../lib/person-archived"
import { productUi } from "../../product/product-ui"
import { AllergyQuickActions } from "./allergies-card"
import { EncounterReadDrawer } from "./encounter-read-drawer"
import { SummaryCard } from "./resumen-tab"

/** Lo que le falta a la atención, dicho para quien no necesariamente la lleva. */
const MISSING_LABELS: Record<OpenEncounterBrief["missing"][number], string> = {
  reason: "motivo",
  diagnosis: "diagnóstico",
  evolution: "evolución",
  signature: "colegiatura de quien atiende",
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit" })
  return sameDay
    ? `hoy ${time}`
    : `${date.toLocaleDateString(activeOrgLocale(), { day: "2-digit", month: "short" })} ${time}`
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Atención en curso: lo primero que ve quien abre la ficha. Dice qué lleva,
 * qué le falta para cerrarse y lleva a continuarla (o a leerla si la atiende
 * otro profesional).
 */
export function OpenEncounterCard({
  patientId,
  encounter,
}: {
  patientId: string
  encounter: OpenEncounterBrief
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const myUserId = useMyUserId()
  const memberName = useMemberName()
  const mine = encounter.professionalUserId === myUserId
  const missing = encounter.missing.map((key) => MISSING_LABELS[key])
  return (
    <section
      aria-labelledby="open-encounter-title"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 p-5"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="open-encounter-title" className="font-heading text-base font-medium">
          {/* De otro día no está «en curso»: quedó abierta (QA de la ficha del 10 nov, B12). */}
          {formatClock(encounter.startedAt).startsWith("hoy") ? "Atención en curso" : "Atención abierta"}
          <span className="font-normal text-muted-foreground">
            {" "}
            · {formatClock(encounter.startedAt)}
            {mine ? "" : ` · atiende ${memberName(encounter.professionalUserId)}`}
          </span>
        </h2>
        <p className="text-sm">
          <span className="text-muted-foreground">Motivo:</span>{" "}
          {encounter.reason ?? "sin registrar"}
        </p>
        {/* Solo lo que lleva y lo que le falta: sin «0 diagnósticos». */}
        <p className="text-sm text-muted-foreground">
          {[
            encounter.diagnosisCount > 0 ? plural(encounter.diagnosisCount, "diagnóstico", "diagnósticos") : "",
            encounter.procedureCount > 0 ? plural(encounter.procedureCount, "procedimiento", "procedimientos") : "",
            missing.length > 0
              ? `Para cerrarla falta ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} y ${missing.at(-1)}`}`
              : "Lista para cerrar",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {/* Quien la lleva ya tiene «Continuar la atención» arriba: aquí no se repite. */}
      {canWrite && mine ? null : (
        <Link
          to="/patients/$patientId/encounters/$encounterId"
          params={{ patientId, encounterId: encounter.id }}
          className={buttonVariants()}
        >
          Ver atención
        </Link>
      )}
    </section>
  )
}

function Alert({
  tone,
  title,
  detail,
}: {
  tone: "danger" | "warning" | "muted"
  title: string
  detail?: string | null
}) {
  const toneClass =
    tone === "danger"
      ? "border-destructive/40 bg-destructive/5"
      : tone === "warning"
        ? "border-warning/40 bg-warning/5"
        : "border-dashed"
  return (
    <li className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
    </li>
  )
}

/**
 * Antecedentes y alertas antes de tocar al paciente (Resumen de quien atiende):
 * alergias de la más grave a la menos (tablero 7: no hay «por confirmar»), condiciones
 * activas y medicación vigente, en columnas para que muchas no alarguen la página;
 * nunca se oculta ninguna. Sin alergias registradas dice lo que consta
 * («no preguntado» o «niega»), nunca «ninguna»: no es lo mismo.
 */
export function ClinicalAlertsCard({
  patientId,
  patientName,
  health,
  sex,
  onAntecedentes,
}: {
  patientId: string
  patientName: string
  health: PatientHealth | null
  /** El sexo registrado del paciente, para decir «ella» o «él» de quien declaró; sin él no se supone. */
  sex?: string | null
  onAntecedentes: () => void
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const archived = usePersonArchived()
  const allergies = (health?.allergies ?? [])
    .filter((allergy) => allergy.isActive && allergy.verification !== "descartada")
    .sort(bySeverity)
  const conditions = (health?.conditions ?? []).filter((condition) => condition.status === "activa")
  // La que toma: sin fin o con fin desde hoy, la misma regla del cierre y del aviso «Pregúntale a…».
  const today = clinicToday()
  const medications = (health?.medications ?? []).filter((medication) => isCurrentMedication(medication, today))
  const allergyState = health?.reviewStatus.allergies ?? "unknown"
  // Lo que dijo la persona y nadie revisó, con la misma marca que la franja (lo decide el servidor).
  // Quién dijo cada cosa y cuándo lo trae su declaración, no quien figure hoy como su representante.
  const groups = health?.declared
  const said = (topic: "allergies" | "conditions" | "medications", id: string): string | null => {
    const group = declaredGroupOf(groups, topic, id)
    return group ? `${saidByWords(group.by, sex)} · sin revisar` : null
  }
  const saidNo = (topic: "allergies" | "conditions" | "medications"): string | null => {
    const group = saidNoGroupOf(groups, topic)
    return group
      ? `${saidNoWords(group.by, sex).toLocaleLowerCase("es")}${group.at ? ` (${shortDay(group.at)})` : ""}`
      : null
  }
  const pregnancyGroup = pregnancyGroupOf(groups)
  const pregnancy = health?.pregnancy ? pregnancyWords(health.pregnancy) : null
  const asa = asaLabel(health?.asaClass)
  // Lo que no es una alerta, en una línea: «niega» solo si se le preguntó, si no, «no preguntado»
  // (ADR 0035). Antes de atender se veían solo las alergias (QA del 8 nov, entrega 3).
  // Sin los antecedentes cargados no se afirma nada: «no preguntado» sería falso mientras cargan.
  const quiet = !health
    ? []
    : [
    conditions.length === 0
      ? `Enfermedades: ${saidNo("conditions") ?? groupWord(health?.reviewStatus.conditions, "niega", "sin enfermedades activas")}`
      : null,
    medications.length === 0
      ? `Medicación: ${saidNo("medications") ?? groupWord(health?.reviewStatus.medications, "ninguna", "sin medicación vigente")}`
      : null,
    // ASA en odentIA siempre; en latidIA solo si alguien la clasificó.
    asa || productUi().health.showsAsa ? (asa ?? "ASA: sin clasificar") : null,
  ].filter((part): part is string => part !== null)
  return (
    <SummaryCard
      title="Antecedentes y alertas"
      action={
        <Button type="button" size="sm" variant="outline" onClick={onAntecedentes}>
          Antecedentes
        </Button>
      }
    >
      <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]">
        {pregnancy && health?.pregnancy ? (
          <Alert
            // Pasado el término ya no alarma: pide confirmarlo.
            tone={pregnancy.confirm ? "muted" : "warning"}
            title={pregnancy.title}
            detail={[
              pregnancy.confirm
                ? `${pregnancy.detail}: pregúntale si sigue embarazada`
                : health.pregnancy.weeksToday === null
                  ? pregnancy.detail
                  : `dijo ${health.pregnancy.weeksSaid} ${health.pregnancy.weeksSaid === 1 ? "semana" : "semanas"} el ${shortDay(health.pregnancy.saidOn ?? "")}`,
              pregnancyGroup ? `${saidByWords(pregnancyGroup.by, sex)} · sin revisar` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ) : null}
        {allergies.map((allergy) => (
          <Alert
            key={allergy.id}
            tone={allergyRank(allergy) === 0 ? "danger" : "warning"}
            title={`${[allergy.kind === "intolerancia" ? "Intolerancia" : "Alergia", allergySeverityWord(allergy)]
              .filter(Boolean)
              .join(" ")} · ${allergyName(allergy)}`}
            detail={[
              allergy.reaction ?? (said("allergies", allergy.id) ? "no dijo qué le pasó" : "reacción no descrita"),
              said("allergies", allergy.id) ?? (allergy.source === "paciente" ? "la dijo el paciente" : null),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ))}
        {/* Sin el dato no se afirma nada de las alergias: «no preguntado» y «No tiene alergias»
            se veían mientras cargaba a quien tiene una severa (QA de la ficha del 10 nov, M2). */}
        {!health ? (
          <li className="col-span-full rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground" aria-busy="true">
            Consultando sus alergias y antecedentes…
          </li>
        ) : null}
        {health && allergies.length === 0 ? (
          <li className="col-span-full flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2">
            <span className="text-sm font-medium">
              {saidNo("allergies")
                ? `Alergias: ${saidNo("allergies")} · sin revisar`
                : allergyState === "none"
                  ? "Alergias: niega"
                  : "Alergias: no preguntado"}
            </span>
            {allergyState === "unknown" && canWrite && !archived ? (
              <AllergyQuickActions patientId={patientId} patientName={patientName} />
            ) : null}
          </li>
        ) : null}
        {conditions.map((condition) => (
          <Alert
            key={condition.id}
            tone="warning"
            title={condition.name}
            detail={
              [
                condition.diagnosisCode ? diagnosisCodeLabel(condition.diagnosisSystem, condition.diagnosisCode) : condition.notes,
                said("conditions", condition.id),
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
          />
        ))}
        {medications.map((medication) => (
          <Alert
            key={medication.id}
            tone="muted"
            title={[medication.name, medication.dose, medication.frequency].filter(Boolean).join(" · ")}
            detail={said("medications", medication.id) ?? "Medicamento vigente"}
          />
        ))}
        {quiet.length > 0 ? (
          <li className="col-span-full text-sm text-muted-foreground">{quiet.join(" · ")}</li>
        ) : null}
      </ul>
    </SummaryCard>
  )
}

/** Un grupo de antecedentes sin filas: niega, no se le preguntó o se registró sin nada vigente. */
function groupWord(state: string | undefined, denied: string, recorded: string): string {
  return state === "none" ? denied : state === "recorded" ? recorded : "no preguntado"
}

/** «8 oct», en la zona de la clínica. */
function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    timeZone: activeOrgTimeZone(),
  })
}

/**
 * La última atención cerrada: cuándo, por qué, quién y qué encontró (los
 * diagnósticos y las piezas), con «Ver» para leerla entera; cada dato llega a 2
 * líneas como máximo.
 */
export function LastVisitCard({
  patientId,
  summary,
  onPeriodontal,
}: {
  patientId: string
  summary: PatientSummary
  /** «Ver periodontograma»: lo abre encima, sin salir del Resumen. */
  onPeriodontal?: (chartId: string) => void
}): React.JSX.Element {
  const memberName = useMemberName()
  const visit = summary.lastVisit
  const professional = summary.lastEncounter?.professionalUserId
  // «Ver» la lee al lado: la ficha sigue a la vista.
  const [reading, setReading] = useState(false)
  const gums = summary.periodontal
  // «Encías: Periodontitis · Estadio III · Grado B · sangrado 10 % (12 oct)».
  const gumsLine = gums
    ? [
        gums.classification
          ? `${gums.classification.startsWith("Estadio") ? "Periodontitis · " : ""}${gums.classification}`
          : null,
        gums.bleedingPercent !== null ? `sangrado ${gums.bleedingPercent} % (${dayOf(gums.date)})` : `sondaje del ${dayOf(gums.date)}`,
        gums.partial ? "parcial" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null
  return (
    <SummaryCard
      title="Última atención"
      action={
        visit ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setReading(true)}>
            Ver
          </Button>
        ) : undefined
      }
    >
      {visit && reading ? (
        <EncounterReadDrawer
          patientId={patientId}
          encounterId={visit.encounterId}
          title={[visit.finalizedAt ? dayOf(visit.finalizedAt) : null, visit.reason || "Atención"].filter(Boolean).join(" · ")}
          onClose={() => setReading(false)}
        />
      ) : null}
      {visit ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="line-clamp-2 font-medium">
            {[visit.finalizedAt ? dayOf(visit.finalizedAt) : null, visit.reason || "Atención"]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="line-clamp-2 text-muted-foreground">
            {[
              professional ? memberName(professional) : null,
              visit.diagnoses.length > 0 ? visit.diagnoses.join(", ") : null,
              visit.teeth.length > 0
                ? `${visit.teeth.length === 1 ? "pieza" : "piezas"} ${visit.teeth.join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Sin diagnósticos registrados"}
          </p>
          {gums && gumsLine ? (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <p>
                <span className="text-muted-foreground">Encías:</span> {gumsLine}
              </p>
              {onPeriodontal ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onPeriodontal(gums.chartId)}>
                  Ver periodontograma
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        // «Atender» ya está en la cabecera, siempre a la vista.
        <p className="text-sm text-muted-foreground">Todavía no tiene atenciones</p>
      )}
    </SummaryCard>
  )
}
