import { PATIENT_GUIDE_LIMITS, type PatientGuide, parsePatientGuide } from "@odentia/clinical"
import { Button, FieldGroup, FieldLegend, FieldSet } from "@odentia/ui"
import { withFieldGroup } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { Plus, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"

/** La explicación mientras se escribe: cada dato, un campo del formulario. */
export interface GuideDraft {
  visits: string
  visitLength: string
  how: string
  includes: string
  excludes: string
  aftercare: string
  warnings: string
  schedule: Array<{ when: string; what: string }>
}

export const EMPTY_GUIDE: GuideDraft = {
  visits: "",
  visitLength: "",
  how: "",
  includes: "",
  excludes: "",
  aftercare: "",
  warnings: "",
  schedule: [],
}

/** Lo guardado (o sugerido), en los campos. */
export function guideDraftOf(guide: PatientGuide | null | undefined): GuideDraft {
  return { ...EMPTY_GUIDE, ...guide, schedule: guide?.schedule ?? [] }
}

const longText = (limit: number) => z.string().max(limit, `Escribe como mucho ${limit} caracteres.`)

/** Los mismos límites que `patientGuideSchema` de la API, con su mensaje en cada campo. */
export const guideSchema = z.object({
  visits: longText(PATIENT_GUIDE_LIMITS.short),
  visitLength: longText(PATIENT_GUIDE_LIMITS.short),
  how: longText(PATIENT_GUIDE_LIMITS.text),
  includes: longText(PATIENT_GUIDE_LIMITS.text),
  excludes: longText(PATIENT_GUIDE_LIMITS.text),
  aftercare: longText(PATIENT_GUIDE_LIMITS.text),
  warnings: longText(PATIENT_GUIDE_LIMITS.text),
  schedule: z
    .array(
      z
        .object({
          when: longText(PATIENT_GUIDE_LIMITS.scheduleWhen),
          what: longText(PATIENT_GUIDE_LIMITS.scheduleWhat),
        })
        .superRefine((row, ctx) => {
          // Una fila a medias se perdería al guardar: se pide lo que le falta.
          if (row.when.trim() && !row.what.trim())
            ctx.addIssue({ code: "custom", path: ["what"], message: "Escribe qué se hace" })
          if (row.what.trim() && !row.when.trim())
            ctx.addIssue({ code: "custom", path: ["when"], message: "Escribe cuándo" })
        }),
    )
    .max(PATIENT_GUIDE_LIMITS.scheduleRows),
})

/** Hay algo que explicar, sin contar blancos. */
export function hasGuide(guide: PatientGuide | null | undefined): guide is PatientGuide {
  return parsePatientGuide(guide) !== null
}

/** Lo escrito, sin blancos ni filas vacías; sin nada, null. */
export function guideFromDraft(draft: GuideDraft | PatientGuide): PatientGuide | null {
  return parsePatientGuide(draft)
}

/** Dicen lo mismo, sin contar blancos ni el orden en que llegaron sus datos. */
export function sameGuide(
  a: GuideDraft | PatientGuide | null | undefined,
  b: GuideDraft | PatientGuide | null | undefined,
): boolean {
  return JSON.stringify(parsePatientGuide(a)) === JSON.stringify(parsePatientGuide(b))
}

/**
 * Lo que se envía al guardar: nada si lo escrito dice lo mismo que lo guardado
 * (null). Un texto sugerido solo llega aquí cuando se pulsa «Guardar»; hasta
 * entonces vive en los campos.
 */
export function guideToSave(
  saved: PatientGuide | null | undefined,
  draft: GuideDraft,
): { patientGuide: PatientGuide | null } | null {
  return sameGuide(saved, draft) ? null : { patientGuide: guideFromDraft(draft) }
}

/** Se ofrece el texto sugerido solo si el servicio está vacío y nada se ha escrito. */
export function offersSuggestion(
  saved: PatientGuide | null | undefined,
  suggestion: PatientGuide | null | undefined,
  draft: GuideDraft | PatientGuide | null | undefined,
): boolean {
  return !hasGuide(saved) && !hasGuide(draft) && hasGuide(suggestion)
}

/** La explicación en sus campos; calendario y señales de alarma, detrás de su botón. */
export const GuideFields = withFieldGroup({
  defaultValues: EMPTY_GUIDE,
  props: {} as { idPrefix: string; disabled?: boolean },
  render: function GuideFieldsRender({ group, idPrefix, disabled = false }) {
    const [askWarnings, setAskWarnings] = useState(false)
    const schedule = useStore(group.store, (state) => state.values.schedule) ?? []
    const warnings = useStore(group.store, (state) => state.values.warnings)
    const showSchedule = schedule.length > 0
    const showWarnings = askWarnings || Boolean(warnings)
    const addRow = () => group.setFieldValue("schedule", [...schedule, { when: "", what: "" }])
    return (
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <group.AppField name="visits">
            {(field) => (
              <field.TextField
                id={`${idPrefix}-visits`}
                label="Visitas"
                maxLength={PATIENT_GUIDE_LIMITS.short}
                placeholder="p. ej. 1 a 2"
                disabled={disabled}
              />
            )}
          </group.AppField>
          <group.AppField name="visitLength">
            {(field) => (
              <field.TextField
                id={`${idPrefix}-length`}
                label="Duración de cada visita"
                maxLength={PATIENT_GUIDE_LIMITS.short}
                placeholder="p. ej. 60 a 90 minutos"
                disabled={disabled}
              />
            )}
          </group.AppField>
        </div>
        <group.AppField name="how">
          {(field) => (
            <field.TextareaField
              id={`${idPrefix}-how`}
              label="Cómo se hace"
              rows={3}
              maxLength={PATIENT_GUIDE_LIMITS.text}
              disabled={disabled}
            />
          )}
        </group.AppField>
        <group.AppField name="includes">
          {(field) => (
            <field.TextareaField
              id={`${idPrefix}-includes`}
              label="Qué incluye"
              rows={3}
              maxLength={PATIENT_GUIDE_LIMITS.text}
              disabled={disabled}
            />
          )}
        </group.AppField>
        <group.AppField name="excludes">
          {(field) => (
            <field.TextareaField
              id={`${idPrefix}-excludes`}
              label="Qué no incluye"
              rows={3}
              maxLength={PATIENT_GUIDE_LIMITS.text}
              disabled={disabled}
            />
          )}
        </group.AppField>
        <group.AppField name="aftercare">
          {(field) => (
            <field.TextareaField
              id={`${idPrefix}-aftercare`}
              label="Después"
              rows={3}
              maxLength={PATIENT_GUIDE_LIMITS.text}
              disabled={disabled}
            />
          )}
        </group.AppField>
        {showSchedule ? (
          <FieldSet>
            <FieldLegend>Calendario</FieldLegend>
            <FieldGroup>
              {schedule.map((_, index) => (
                // Las filas no se reordenan: su posición las identifica.
                // biome-ignore lint/suspicious/noArrayIndexKey: se agregan y se quitan, sin reordenar.
                <div key={index} className="flex flex-wrap items-start gap-2">
                  <group.AppField name={`schedule[${index}].when`}>
                    {(field) => (
                      <field.TextField
                        id={`${idPrefix}-when-${index}`}
                        className="min-w-32 flex-1"
                        label="Cuándo"
                        maxLength={PATIENT_GUIDE_LIMITS.scheduleWhen}
                        disabled={disabled}
                      />
                    )}
                  </group.AppField>
                  <group.AppField name={`schedule[${index}].what`}>
                    {(field) => (
                      <field.TextField
                        id={`${idPrefix}-what-${index}`}
                        className="min-w-48 flex-[2]"
                        label="Qué"
                        maxLength={PATIENT_GUIDE_LIMITS.scheduleWhat}
                        disabled={disabled}
                      />
                    )}
                  </group.AppField>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-6 min-h-11 min-w-11"
                    aria-label={`Quitar la fila ${index + 1} del calendario`}
                    disabled={disabled}
                    onClick={() =>
                      group.setFieldValue(
                        "schedule",
                        schedule.filter((__, at) => at !== index),
                      )
                    }
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
                    onClick={addRow}
                  >
                    <Plus aria-hidden /> Agregar fila
                  </Button>
                </div>
              ) : null}
            </FieldGroup>
          </FieldSet>
        ) : null}
        {showWarnings ? (
          <group.AppField name="warnings">
            {(field) => (
              <field.TextareaField
                id={`${idPrefix}-warnings`}
                label="Señales de alarma"
                rows={3}
                maxLength={PATIENT_GUIDE_LIMITS.text}
                disabled={disabled}
              />
            )}
          </group.AppField>
        ) : null}
        {!showSchedule || !showWarnings ? (
          <div className="flex flex-wrap gap-2">
            {!showSchedule ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={addRow}
              >
                <Plus aria-hidden /> Agregar calendario
              </Button>
            ) : null}
            {!showWarnings ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setAskWarnings(true)}
              >
                <Plus aria-hidden /> Agregar señales de alarma
              </Button>
            ) : null}
          </div>
        ) : null}
      </FieldGroup>
    )
  },
})

/**
 * «Lo que se le explica al paciente», en el formulario del servicio. Sugerir no
 * guarda: «Usar el texto sugerido» solo llena los campos; lo vuelve real su «Guardar».
 */
export const ServiceGuideSection = withFieldGroup({
  defaultValues: EMPTY_GUIDE,
  props: {} as {
    idPrefix: string
    saved: PatientGuide | null | undefined
    suggestion: PatientGuide | null | undefined
    /** «Revisado por Ana el 3 oct 2026», solo si está guardado y sin cambios. */
    reviewedWords: string | null
    /** Los consentimientos unidos a este servicio, con su enlace si lo puede abrir. */
    consents: ReactNode
    disabled?: boolean
  },
  render: function ServiceGuideSectionRender({
    group,
    idPrefix,
    saved,
    suggestion,
    reviewedWords,
    consents,
    disabled = false,
  }) {
    const draft = useStore(group.store, (state) => state.values)
    const useSuggestion = () => {
      const next = guideDraftOf(suggestion)
      for (const key of [
        "visits",
        "visitLength",
        "how",
        "includes",
        "excludes",
        "aftercare",
        "warnings",
        "schedule",
      ] as const) {
        group.setFieldValue(key, next[key] as never)
      }
    }
    return (
      <FieldSet>
        <FieldLegend>Lo que se le explica al paciente</FieldLegend>
        <FieldGroup>
          {offersSuggestion(saved, suggestion, draft) ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm"
            >
              <span>Hay un texto sugerido para este servicio.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={useSuggestion}
              >
                Usar el texto sugerido
              </Button>
            </div>
          ) : null}
          {!hasGuide(saved) && hasGuide(suggestion) && sameGuide(draft, suggestion) ? (
            <p role="status" className="rounded-md bg-warning-soft p-3 text-sm">
              Texto sugerido sin revisar. Revísalo y ajústalo a cómo lo hace tu clínica: saldrá en
              cada presupuesto de este servicio cuando pulses «Guardar».
            </p>
          ) : null}
          <GuideFields
            form={group as never}
            fields={
              {
                visits: "visits",
                visitLength: "visitLength",
                how: "how",
                includes: "includes",
                excludes: "excludes",
                aftercare: "aftercare",
                warnings: "warnings",
                schedule: "schedule",
              } as never
            }
            idPrefix={idPrefix}
            disabled={disabled}
          />
          {reviewedWords ? <p className="text-xs text-muted-foreground">{reviewedWords}</p> : null}
          {consents}
        </FieldGroup>
      </FieldSet>
    )
  },
})

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
