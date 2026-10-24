import { ChoiceButtons } from "@odentia/clinic-app/components/choice-buttons"
import { activeOrgLocale, activeOrgTimeZone } from "@odentia/clinic-app/lib/locale"
import { fetchPatientVitals } from "@odentia/clinic-app/lib/patients"
import type {
  ExaminationFieldsProps,
  ProductExaminationUi,
} from "@odentia/clinic-app/product/product-ui"
import { bodyMassIndex, type Vitals } from "@odentia/clinical"
import {
  EXAM_FINDING_MAX,
  EXAM_STATE_LABELS,
  EXAM_SYSTEMS,
  type ExamState,
  examCounts,
  examLines,
  examSummary,
  MEDICAL_VITAL_KEYS,
  markRestNormal,
  readSystemsExam,
  type SystemsExam,
} from "@odentia/medical"
import { Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"

const STATE_OPTIONS: ReadonlyArray<{ value: ExamState; label: string }> = [
  { value: "sin_alteraciones", label: EXAM_STATE_LABELS.sin_alteraciones },
  { value: "con_hallazgos", label: EXAM_STATE_LABELS.con_hallazgos },
]

/**
 * El borrador es el examen tal cual, con el hallazgo sin recortar mientras se
 * escribe; lo que no se entiende queda sin marcar.
 */
function draftOf(saved: unknown): SystemsExam | null {
  return readSystemsExam(saved)
}

function bodyOf(draft: unknown): Record<string, unknown> | null {
  const exam = draft as SystemsExam | null
  if (!exam || Object.keys(exam.sistemas).length === 0) return null
  return { ...exam }
}

/** «6 examinados · 2 con hallazgos · 4 sin examinar». */
function countsLine(exam: SystemsExam | null): string {
  const { examined, findings, notExamined } = examCounts(exam)
  return [
    examined === 1 ? "1 examinado" : `${examined} examinados`,
    findings === 1 ? "1 con hallazgos" : `${findings} con hallazgos`,
    `${notExamined} sin examinar`,
  ].join(" · ")
}

/**
 * Cada sistema se marca «Sin alteraciones» o «Con hallazgos» (y el hallazgo se
 * escribe con la parte del cuerpo); tocar otra vez lo marcado lo devuelve a
 * «No examinado». El botón marca solo lo que falta, nunca cambia lo marcado.
 */
function SystemsExamFields({ idPrefix, draft, onChange, disabled }: ExaminationFieldsProps) {
  const exam = draft as SystemsExam | null
  const { notExamined } = examCounts(exam)
  const set = (
    key: (typeof EXAM_SYSTEMS)[number]["key"],
    entry: SystemsExam["sistemas"][typeof key] | null,
  ) => {
    const sistemas = { ...exam?.sistemas }
    if (entry) sistemas[key] = entry
    else delete sistemas[key]
    onChange({ sistemas })
  }
  return (
    <section aria-labelledby={`${idPrefix}-systems`} className="flex flex-col sm:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="flex flex-col gap-0.5">
          <h3 id={`${idPrefix}-systems`} className="text-sm font-medium">
            Examen por sistemas
          </h3>
          <p className="text-xs text-muted-foreground">{countsLine(exam)}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || notExamined === 0}
          onClick={() => onChange(markRestNormal(exam))}
        >
          Marcar el resto sin alteraciones
        </Button>
      </div>
      {EXAM_SYSTEMS.map((system) => {
        const entry = exam?.sistemas[system.key]
        return (
          <div key={system.key} className="flex flex-col gap-2 border-t py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex flex-col">
                <span className="text-sm font-medium">{system.label}</span>
                {entry ? null : <span className="text-xs text-muted-foreground">No examinado</span>}
              </span>
              <ChoiceButtons
                label={system.label}
                value={entry?.estado ?? null}
                options={STATE_OPTIONS}
                columns={2}
                className="sm:w-auto"
                disabled={disabled}
                onChange={(estado) =>
                  set(
                    system.key,
                    estado === "con_hallazgos"
                      ? { estado, hallazgo: entry?.hallazgo ?? "" }
                      : { estado },
                  )
                }
                onClear={() => set(system.key, null)}
              />
            </div>
            {entry?.estado === "con_hallazgos" ? (
              <Field>
                <FieldLabel
                  htmlFor={`${idPrefix}-hallazgo-${system.key}`}
                  className="text-xs text-muted-foreground"
                >
                  Qué encontraste
                </FieldLabel>
                <Textarea
                  id={`${idPrefix}-hallazgo-${system.key}`}
                  rows={2}
                  maxLength={EXAM_FINDING_MAX}
                  value={entry.hallazgo ?? ""}
                  disabled={disabled}
                  placeholder="Qué y dónde: «Adenopatías submandibulares en ambos lados, de 1 cm»"
                  onChange={(event) =>
                    set(system.key, { estado: "con_hallazgos", hallazgo: event.target.value })
                  }
                />
              </Field>
            ) : null}
          </div>
        )
      })}
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Lo que no marcas queda como «No examinado» en la historia: nunca se da por normal.
      </p>
    </section>
  )
}

function decimal(value: number): string {
  return value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 1 })
}

/** «12 ago.»: el día de la clínica. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    timeZone: activeOrgTimeZone(),
  })
}

/** «PA 124/80 · peso 64 kg»: lo que se compara de una vez a otra. */
function previousLine(vitals: Vitals): string {
  const parts: string[] = []
  if (vitals.presionSistolica !== undefined && vitals.presionDiastolica !== undefined)
    parts.push(`PA ${vitals.presionSistolica}/${vitals.presionDiastolica}`)
  if (vitals.peso !== undefined) parts.push(`peso ${decimal(vitals.peso)} kg`)
  if (vitals.glucosaCapilar !== undefined) parts.push(`glucosa ${vitals.glucosaCapilar} mg/dL`)
  return parts.join(" · ")
}

/** Debajo de los signos vitales: el IMC de hoy y lo de la vez anterior, para comparar sin salir. */
function VitalsNote({
  patientId,
  encounterId,
  vitals,
}: {
  patientId: string
  encounterId: string
  vitals: Vitals | null
}) {
  const readings = useQuery({
    queryKey: ["patient-vitals", patientId],
    queryFn: () => fetchPatientVitals(patientId),
  })
  const bmi = bodyMassIndex(vitals)
  const previous = readings.data?.data
    .filter((reading) => reading.encounterId !== encounterId)
    .at(-1)
  const before = previous ? previousLine(previous.vitals) : ""
  const parts = [
    bmi === null ? "" : `IMC ${decimal(bmi)} · sale del peso y la talla.`,
    previous && before ? `La última vez, el ${shortDate(previous.startedAt)}: ${before}.` : "",
  ].filter(Boolean)
  return parts.length > 0 ? (
    <p className="text-xs text-muted-foreground">{parts.join(" ")}</p>
  ) : null
}

/**
 * El examen físico de latidIA (issue 229, decisiones 5 y 6): diez signos
 * vitales y el examen por sistemas, donde lo no marcado es «No examinado».
 */
export const medicalExamination: ProductExaminationUi = {
  title: "Examen físico",
  description: "Signos vitales y examen por sistemas.",
  vitals: MEDICAL_VITAL_KEYS,
  draft: draftOf,
  body: bodyOf,
  summary: (draft) => examSummary(draft as SystemsExam | null),
  Fields: (props) => <SystemsExamFields {...props} />,
  VitalsNote: (props) => <VitalsNote {...props} />,
  readLines: (saved) => examLines(readSystemsExam(saved)),
}
