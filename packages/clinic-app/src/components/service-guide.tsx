import { PATIENT_GUIDE_LIMITS, type PatientGuide, parsePatientGuide } from "@odentia/clinical"
import {
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Textarea,
} from "@odentia/ui"
import { Plus, X } from "lucide-react"
import { type ReactNode, useState } from "react"

/** Hay algo que explicar, sin contar blancos. */
export function hasGuide(guide: PatientGuide | null | undefined): guide is PatientGuide {
  return parsePatientGuide(guide) !== null
}

/**
 * Lo que se guarda de lo escrito: sin blancos ni filas a medias y, si no queda
 * nada, null. `undefined` (no se tocó) no cambia nada: un texto sugerido solo se
 * vuelve real al pulsar «Guardar», y hasta entonces vive en `draft`.
 */
export function guideToSave(draft: PatientGuide | undefined): { patientGuide: PatientGuide | null } | null {
  if (draft === undefined) return null
  return { patientGuide: parsePatientGuide(draft) }
}

/** Se ofrece el texto sugerido solo si el servicio está vacío y nada se ha escrito. */
export function offersSuggestion(
  saved: PatientGuide | null | undefined,
  suggestion: PatientGuide | null | undefined,
  draft: PatientGuide | undefined,
): boolean {
  return !hasGuide(saved) && !hasGuide(draft) && hasGuide(suggestion)
}

/**
 * «Lo que se le explica al paciente», en el formulario del servicio. Sugerir no
 * guarda: «Usar el texto sugerido» solo llena `draft`; lo vuelve real su «Guardar».
 */
export function ServiceGuideSection({
  idPrefix,
  saved,
  suggestion,
  draft,
  reviewedWords,
  consents,
  disabled = false,
  onChange,
}: {
  idPrefix: string
  saved: PatientGuide | null | undefined
  suggestion: PatientGuide | null | undefined
  /** Lo escrito; `undefined` mientras no se toca. */
  draft: PatientGuide | undefined
  /** «Revisado por Ana el 3 oct 2026», solo si está guardado. */
  reviewedWords: string | null
  /** Los consentimientos unidos a este servicio, con su enlace si lo puede abrir. */
  consents: ReactNode
  disabled?: boolean
  onChange: (next: PatientGuide, source: "escrito" | "sugerido") => void
}) {
  const [usedSuggestion, setUsedSuggestion] = useState(false)
  return (
    <FieldSet>
      <FieldLegend>Lo que se le explica al paciente</FieldLegend>
      <FieldGroup>
        {offersSuggestion(saved, suggestion, draft) && suggestion ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <span>Hay un texto sugerido para este servicio.</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setUsedSuggestion(true)
                onChange(suggestion, "sugerido")
              }}
            >
              Usar el texto sugerido
            </Button>
          </div>
        ) : null}
        {usedSuggestion && draft !== undefined ? (
          <p role="status" className="rounded-md bg-warning-soft p-3 text-sm">
            Texto sugerido sin revisar. Revísalo y ajústalo a cómo lo hace tu clínica: saldrá en cada presupuesto de este
            servicio cuando pulses «Guardar».
          </p>
        ) : null}
        <GuideFields
          idPrefix={idPrefix}
          value={draft ?? saved ?? {}}
          disabled={disabled}
          onChange={(next) => onChange(next, "escrito")}
        />
        {reviewedWords && draft === undefined ? <p className="text-xs text-muted-foreground">{reviewedWords}</p> : null}
        {consents}
      </FieldGroup>
    </FieldSet>
  )
}

/** La explicación en sus campos; calendario y señales de alarma, detrás de su botón. */
export function GuideFields({
  idPrefix,
  value,
  onChange,
  disabled = false,
}: {
  idPrefix: string
  value: PatientGuide
  onChange: (next: PatientGuide) => void
  disabled?: boolean
}) {
  const [askSchedule, setAskSchedule] = useState(false)
  const [askWarnings, setAskWarnings] = useState(false)
  const set = (patch: Partial<PatientGuide>) => onChange({ ...value, ...patch })
  const schedule = value.schedule ?? []
  const showSchedule = askSchedule || schedule.length > 0
  const showWarnings = askWarnings || Boolean(value.warnings)
  const textArea = (key: "how" | "includes" | "excludes" | "aftercare" | "warnings", label: string) => (
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-${key}`}>{label}</FieldLabel>
      <Textarea
        id={`${idPrefix}-${key}`}
        rows={3}
        maxLength={PATIENT_GUIDE_LIMITS.text}
        disabled={disabled}
        value={value[key] ?? ""}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  )
  return (
    <FieldGroup>
      <div className="grid gap-4 @md:grid-cols-2 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-visits`}>Visitas</FieldLabel>
          <Input
            id={`${idPrefix}-visits`}
            maxLength={PATIENT_GUIDE_LIMITS.short}
            placeholder="p. ej. 1 a 2"
            disabled={disabled}
            value={value.visits ?? ""}
            onChange={(event) => set({ visits: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-length`}>Duración de cada visita</FieldLabel>
          <Input
            id={`${idPrefix}-length`}
            maxLength={PATIENT_GUIDE_LIMITS.short}
            placeholder="p. ej. 60 a 90 minutos"
            disabled={disabled}
            value={value.visitLength ?? ""}
            onChange={(event) => set({ visitLength: event.target.value })}
          />
        </Field>
      </div>
      {textArea("how", "Cómo se hace")}
      {textArea("includes", "Qué incluye")}
      {textArea("excludes", "Qué no incluye")}
      {textArea("aftercare", "Después")}
      {showSchedule ? (
        <FieldSet>
          <FieldLegend>Calendario</FieldLegend>
          <FieldGroup>
            {schedule.map((step, index) => (
              // Las filas no se reordenan: su posición las identifica.
              // biome-ignore lint/suspicious/noArrayIndexKey: se agregan y se quitan, sin reordenar.
              <div key={index} className="flex flex-wrap items-start gap-2">
                <Field className="min-w-32 flex-1">
                  <FieldLabel htmlFor={`${idPrefix}-when-${index}`}>Cuándo</FieldLabel>
                  <Input
                    id={`${idPrefix}-when-${index}`}
                    maxLength={PATIENT_GUIDE_LIMITS.scheduleWhen}
                    disabled={disabled}
                    value={step.when}
                    onChange={(event) =>
                      set({ schedule: schedule.map((row, at) => (at === index ? { ...row, when: event.target.value } : row)) })
                    }
                  />
                </Field>
                <Field className="min-w-48 flex-[2]">
                  <FieldLabel htmlFor={`${idPrefix}-what-${index}`}>Qué</FieldLabel>
                  <Input
                    id={`${idPrefix}-what-${index}`}
                    maxLength={PATIENT_GUIDE_LIMITS.scheduleWhat}
                    disabled={disabled}
                    value={step.what}
                    onChange={(event) =>
                      set({ schedule: schedule.map((row, at) => (at === index ? { ...row, what: event.target.value } : row)) })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6 min-h-11 min-w-11"
                  aria-label={`Quitar la fila ${index + 1} del calendario`}
                  disabled={disabled}
                  onClick={() => set({ schedule: schedule.filter((_, at) => at !== index) })}
                >
                  <X aria-hidden />
                </Button>
              </div>
            ))}
            {schedule.length < PATIENT_GUIDE_LIMITS.scheduleRows ? (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => set({ schedule: [...schedule, { when: "", what: "" }] })}
                >
                  <Plus aria-hidden /> Agregar fila
                </Button>
              </div>
            ) : null}
          </FieldGroup>
        </FieldSet>
      ) : null}
      {showWarnings ? textArea("warnings", "Señales de alarma") : null}
      {!showSchedule || !showWarnings ? (
        <div className="flex flex-wrap gap-2">
          {!showSchedule ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setAskSchedule(true)
                set({ schedule: [{ when: "", what: "" }] })
              }}
            >
              <Plus aria-hidden /> Agregar calendario
            </Button>
          ) : null}
          {!showWarnings ? (
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setAskWarnings(true)}>
              <Plus aria-hidden /> Agregar señales de alarma
            </Button>
          ) : null}
        </div>
      ) : null}
    </FieldGroup>
  )
}

/** La explicación para leer: quien no la edita y la revisión del presupuesto. */
export function GuideSummary({ guide }: { guide: PatientGuide }) {
  const rows: Array<[string, string | undefined]> = [
    ["Visitas", [guide.visits, guide.visitLength].filter(Boolean).join(" · ") || undefined],
    ["Cómo se hace", guide.how],
    ["Qué incluye", guide.includes],
    ["Qué no incluye", guide.excludes],
    ["Después", guide.aftercare],
    ["Señales de alarma", guide.warnings],
  ]
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      {rows.map(([label, text]) =>
        text ? (
          <div key={label}>
            <dt className="inline font-medium">{label}: </dt>
            <dd className="inline text-muted-foreground">{text}</dd>
          </div>
        ) : null,
      )}
      {guide.schedule?.length ? (
        <div>
          <dt className="font-medium">Calendario</dt>
          <dd>
            <ul className="text-muted-foreground">
              {guide.schedule.map((step) => (
                <li key={`${step.when}-${step.what}`}>
                  {step.when}: {step.what}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
    </dl>
  )
}
