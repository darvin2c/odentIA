import {
  type AnesthesiaAtSigning,
  anesthesiaUsesParts,
  type EpinephrineCheck,
  epinephrineCheckOf,
  isCurrentMedication,
  LOCAL_ANESTHETICS,
  type LocalAnestheticKey,
  localAnesthesiaWords,
  OFFICE_ASA_CLASSES,
  type Vitals,
} from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { useMemberName } from "../../lib/crm"
import { shortDay } from "../../lib/declared-health"
import type { HealthGap } from "../../lib/encounters"
import { clinicToday } from "../../lib/inventory"
import { ASA_OPTIONS, asaLabel, type PatientHealth, setPatientAsaApi } from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"
import { RadioChips } from "../ui/radio-chips"

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} y ${words[words.length - 1]}`
}

/** «Exodoncia simple · Lidocaína 2 % con epinefrina»: los procedimientos y, aparte, el anestésico. */
function usesWords(uses: readonly string[]): string {
  const { procedures, anesthetics } = anesthesiaUsesParts(uses)
  return [listWords(procedures), listWords(anesthetics)].filter(Boolean).join(" · ")
}

const GAP_WORDS: Record<Exclude<HealthGap, "asa">, string> = {
  allergies: "sus alergias",
  conditions: "sus enfermedades",
  medications: "su medicación",
}

/**
 * Lo que se sabe de su salud antes de anestesiar, en una frase: lo que tiene, lo que niega y lo que
 * nunca se le preguntó. «Niega alergias, enfermedades y medicación.»
 */
export function anesthesiaHealthWords(
  health: Pick<PatientHealth, "allergies" | "conditions" | "medications" | "reviewStatus"> | null,
  gaps: readonly HealthGap[],
  risks: readonly string[],
  today: string,
): string {
  const parts: string[] = []
  if (health) {
    const allergies = health.allergies.filter((row) => row.isActive).map((row) => row.substance)
    const conditions = health.conditions
      .filter((row) => row.status === "activa")
      .map((row) => row.name)
    const medications = health.medications
      .filter((row) => isCurrentMedication(row, today))
      .map((row) => [row.genericName ?? row.name, row.dose].filter(Boolean).join(" "))
    const denied = [
      allergies.length === 0 && health.reviewStatus.allergies === "none" ? "alergias" : "",
      conditions.length === 0 && health.reviewStatus.conditions === "none" ? "enfermedades" : "",
      medications.length === 0 && health.reviewStatus.medications === "none" ? "medicación" : "",
    ].filter(Boolean)
    if (allergies.length > 0) parts.push(`Alergia a ${listWords(allergies)}.`)
    if (conditions.length > 0) parts.push(`Tiene ${listWords(conditions)}.`)
    if (medications.length > 0) parts.push(`Toma ${listWords(medications)}.`)
    if (denied.length > 0) parts.push(`Niega ${listWords(denied)}.`)
  }
  if (risks.length > 0) parts.push(`Dijo que ${listWords(risks)}.`)
  const unasked = gaps.flatMap((gap) => (gap === "asa" ? [] : [GAP_WORDS[gap]]))
  if (unasked.length > 0) parts.push(`Falta preguntarle por ${listWords(unasked)}.`)
  return parts.join(" ")
}

/**
 * El tope de epinefrina y si falta tomar la presión, con la misma regla que guarda la firma
 * (`epinephrineCheckOf`): sus enfermedades activas, la ASA donde el producto la pide, la presión de
 * hoy y su edad.
 */
export function epinephrineOf(
  health: Pick<PatientHealth, "conditions" | "asaClass"> | null,
  input: { asksAsa: boolean; vitals: Vitals | null; ageYears: number | null },
): EpinephrineCheck | null {
  if (!health) return null
  return epinephrineCheckOf({
    conditions: health.conditions.filter((row) => row.status === "activa"),
    asaClass: input.asksAsa ? health.asaClass : null,
    vitals: input.vitals,
    ageYears: input.ageYears,
  })
}

/**
 * La anestesia ya está contestada y no hay nada que avisar: la ASA puesta (si el producto la pide),
 * nada por preguntarle, sin alergias, enfermedades ni medicación vigentes, sin nada dicho del
 * corazón y sin avisos del anestésico. Entonces el bloque va en dos líneas, con «Cambiar» (QA del
 * 16 nov, Q18: ocupaba unos 260 px en la página y otra vez en el diálogo de firmar). Con cualquier
 * aviso clínico el bloque va entero: una alergia o un anticoagulante no se pliegan nunca.
 */
export function anesthesiaAnswered(input: {
  asksAsa: boolean
  health: Pick<PatientHealth, "allergies" | "conditions" | "medications" | "asaClass"> | null
  gaps: readonly HealthGap[]
  risks: readonly string[]
  warnings: readonly string[]
  today: string
}): boolean {
  const { health } = input
  if (!health) return false
  if (input.asksAsa && !health.asaClass) return false
  // La ASA recién puesta puede seguir un instante en lo que falta: ya no falta.
  if (input.gaps.some((gap) => gap !== "asa")) return false
  if (input.risks.length > 0 || input.warnings.length > 0) return false
  return (
    !health.allergies.some((row) => row.isActive) &&
    !health.conditions.some((row) => row.status === "activa") &&
    !health.medications.some((row) => isCurrentMedication(row, input.today))
  )
}

/**
 * La línea de anestesia (QA del 16 nov, E5b y E5c): aparece en cuanto algo de hoy usa anestesia
 * local (lo marcado «Hoy» en el plan o lo registrado hoy), antes de anestesiar, y se repite al
 * firmar. Dice sus alergias, su medicación y lo que dijo; pide la ASA con un toque donde el
 * producto la pide; y con el anestésico elegido y el peso de los signos vitales, el máximo. Avisa
 * y no frena.
 */
export function EncounterAnesthesiaLine({
  patientId,
  encounterId,
  uses,
  asksAsa,
  gaps,
  risks,
  health,
  vitals,
  ageYears,
  anesthetic,
  onAnestheticChange,
  canWrite,
  disabled = false,
  atSign = false,
  onComplete,
  weightFromOther = false,
  onAddWeight,
}: {
  patientId: string
  encounterId: string
  /** Lo de hoy que usa anestesia: los servicios marcados y los anestésicos de sus materiales. */
  uses: readonly string[]
  asksAsa: boolean
  gaps: readonly HealthGap[]
  risks: readonly string[]
  health: PatientHealth | null
  vitals: Vitals | null
  ageYears: number | null
  anesthetic: LocalAnestheticKey
  onAnestheticChange: (next: LocalAnestheticKey) => void
  canWrite: boolean
  disabled?: boolean
  /** En el diálogo de firmar: dice que se puede firmar igual. */
  atSign?: boolean
  /** «Completar en Antecedentes». */
  onComplete?: () => void
  /** El peso viene de otra atención de hoy: se dice, para que se sepa de dónde salió el máximo. */
  weightFromOther?: boolean
  /** «Anotar su peso»: lleva a los signos vitales del examen clínico. */
  onAddWeight?: () => void
}): React.JSX.Element | null {
  const ids = useId()
  const queryClient = useQueryClient()
  const memberName = useMemberName()
  const [saving, setSaving] = useState(false)
  /** «Cambiar» en la línea corta: abre el bloque entero. */
  const [expanded, setExpanded] = useState(false)
  if (uses.length === 0) return null
  const today = clinicToday()
  const asa = health?.asaClass ?? null
  const words = localAnesthesiaWords({
    weightKg: vitals?.peso ?? null,
    anesthetic,
    ageYears,
    epinephrine: epinephrineOf(health, { asksAsa, vitals, ageYears }),
  })
  const said = anesthesiaHealthWords(health, gaps, risks, today)
  const asaMissing = asksAsa && !asa
  const chooseAsa = async (next: string) => {
    setSaving(true)
    try {
      await setPatientAsaApi(patientId, next, encounterId)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patient-health", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["encounter-closing", patientId] }),
      ])
    } catch (cause) {
      toast.error(submitErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const setBy = health?.asaClassSetBy ? memberName(health.asaClassSetBy) : null
  const setAt = health?.asaClassSetAt ? shortDay(health.asaClassSetAt) : null
  // Contestada y sin nada que avisar: dos líneas, sin el color de aviso, con «Cambiar».
  if (!expanded && anesthesiaAnswered({ asksAsa, health, gaps, risks, warnings: words.warnings, today }))
    return (
      <section
        aria-labelledby={`${ids}-title`}
        className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-lg border p-3 text-sm"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p id={`${ids}-title`} className="font-medium">
            Anestesia local · {usesWords(uses)}
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              asksAsa && asa ? `ASA ${asa}` : null,
              said.replace(/\.$/, "") || null,
              words.dose ? `${words.dose}${weightFromOther ? " (peso anotado hoy en otra atención)" : ""}` : "Sin peso anotado: sin dosis máxima",
            ]
              .filter(Boolean)
              .join(" · ")}
            .
          </p>
        </div>
        {canWrite ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label="Cambiar la anestesia: la ASA o el anestésico"
            onClick={() => setExpanded(true)}
          >
            Cambiar
          </Button>
        ) : null}
      </section>
    )
  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning-soft p-3 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p id={`${ids}-title`} className="font-medium">
            Anestesia local · {usesWords(uses)}
          </p>
          <p className="text-xs text-muted-foreground">
            {said}
            {asaMissing ? `${said ? " " : ""}Falta clasificar su riesgo anestésico (ASA).` : ""}
            {atSign ? " Puedes firmar igual." : ""}
          </p>
        </div>
        {onComplete && gaps.some((gap) => gap !== "asa") ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onComplete}
          >
            Completar en Antecedentes
          </Button>
        ) : null}
      </div>
      {asksAsa ? (
        <div className="flex flex-col gap-1.5">
          <span id={`${ids}-asa`} className="text-xs font-medium">
            Riesgo anestésico (ASA)
          </span>
          {canWrite && (asa === null || (OFFICE_ASA_CLASSES as readonly string[]).includes(asa)) ? (
            <RadioChips
              aria-labelledby={`${ids}-asa`}
              aria-describedby={`${ids}-asa-name`}
              value={asa as (typeof OFFICE_ASA_CLASSES)[number] | null}
              options={OFFICE_ASA_CLASSES.map((value) => ({ value, label: `ASA ${value}` }))}
              disabled={disabled || saving}
              onChange={(next) => void chooseAsa(next)}
            />
          ) : null}
          {/* El nombre largo va debajo de la elegida (ASA 2020), con quién la puso y cuándo. */}
          <p id={`${ids}-asa-name`} className="text-xs text-muted-foreground">
            {asa
              ? [asaLabel(asa), setBy && setAt ? `la clasificó ${setBy} el ${setAt}` : null]
                  .filter(Boolean)
                  .join(" · ")
              : canWrite
                ? `Elige una: ${ASA_OPTIONS.slice(0, 4)
                    .map(([, label]) => label.replace(/^ASA /, ""))
                    .join("; ")}.`
                : "Sin clasificar."}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-anesthetic`} className="text-xs font-medium">
          Anestésico
        </label>
        <ChoiceSelect
          id={`${ids}-anesthetic`}
          value={anesthetic}
          disabled={disabled}
          aria-describedby={`${ids}-dose`}
          onChange={(event) => onAnestheticChange(event.target.value as LocalAnestheticKey)}
        >
          {LOCAL_ANESTHETICS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </ChoiceSelect>
        <p id={`${ids}-dose`} className="text-sm font-medium">
          {words.dose
            ? `${words.dose}.${weightFromOther ? " Con el peso anotado hoy en otra atención." : ""}`
            : "Anota su peso en los signos vitales para ver la dosis máxima."}
          {/* Lleva a los signos vitales del examen clínico (QA del 18 nov: había que adivinarlo). */}
          {!words.dose && onAddWeight && canWrite ? (
            <>
              {" "}
              <Button type="button" size="sm" variant="link" className="h-auto p-0" disabled={disabled} onClick={onAddWeight}>
                Anotar su peso
              </Button>
            </>
          ) : null}
        </p>
        {words.warnings.map((warning) => (
          <p key={warning} className="text-sm">
            {warning}
          </p>
        ))}
      </div>
    </section>
  )
}

/** La anestesia de ese día en la atención firmada: la ASA con quién la puso, el peso y el máximo. */
export function AnesthesiaAtSigningView({
  value,
}: {
  value: AnesthesiaAtSigning
}): React.JSX.Element {
  const parts = anesthesiaUsesParts(value.uses)
  const asa = value.asaClass ? asaLabel(value.asaClass) : null
  const before =
    value.asaBefore !== undefined && value.asaBefore !== value.asaClass
      ? ` (antes: ${value.asaBefore ? `ASA ${value.asaBefore}` : "sin clasificar"})`
      : ""
  const who =
    value.asaSetBy && value.asaSetAt
      ? ` · la clasificó ${value.asaSetBy} el ${shortDay(value.asaSetAt)}`
      : ""
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {/* Los procedimientos y, aparte, el anestésico de sus materiales (auditor, 18 nov, H7). */}
      {parts.procedures.length > 0 ? <li>Para {listWords(parts.procedures)}</li> : null}
      {parts.anesthetics.length > 0 ? <li>Anestésico: {listWords(parts.anesthetics)}</li> : null}
      {asa ? (
        <li>
          {asa}
          {before}
          {who}
        </li>
      ) : null}
      {value.dose ? (
        <li>{value.dose}</li>
      ) : value.weightKg === null ? (
        <li>Sin peso anotado: sin dosis máxima</li>
      ) : null}
      {value.warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  )
}
