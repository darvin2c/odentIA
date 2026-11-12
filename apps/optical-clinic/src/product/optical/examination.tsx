import { ChoiceButtons } from "@odentia/clinic-app/components/choice-buttons"
import {
  type ExaminationFieldsProps,
  type ProductExaminationUi,
  subFieldError,
} from "@odentia/clinic-app/product/product-ui"
import {
  ACUITY_FIELDS,
  EYE_NOTE_MAX,
  EYES,
  type Eye,
  type EyeExam,
  eyeExamLines,
  eyeExamSummary,
  HEALTH_PARTS,
  HEALTH_STATE_LABELS,
  type HealthState,
  PD_FIELDS,
  readEyeExam,
  referralSigns,
  USES_LENSES,
  type UsesLenses,
} from "@odentia/optical"
import { Alert, AlertDescription, AlertTitle, Field, FieldError, FieldLabel, Input, Textarea } from "@odentia/ui"
import { numberOf, PrismBases } from "./lens-fields"

/**
 * El borrador del examen: lo mismo que se guarda, con los números como se
 * escriben («−1,25», «31,5») hasta guardarlos. Lo que no se entiende se manda tal
 * cual y el servidor dice qué dato está mal, junto a él.
 */
type Text = string | undefined
interface RefractionDraft {
  esfera?: Text
  cilindro?: Text
  eje?: Text
  adicion?: Text
  prisma?: Text
  base?: Text
  prisma2?: Text
  base2?: Text
}
type PdKey = (typeof PD_FIELDS)[number]["key"]
interface EyeExamDraft {
  acompanante?: { nombre?: string; parentesco?: string }
  antecedentes?: { usaLentes?: UsesLenses; nota?: string }
  agudeza?: Partial<Record<Eye, Partial<Record<(typeof ACUITY_FIELDS)[number]["key"], string>>>>
  refraccion?: Partial<Record<Eye, RefractionDraft>>
  dp?: Partial<Record<PdKey, Text>>
  salud?: Partial<Record<(typeof HEALTH_PARTS)[number]["key"], { estado: HealthState; nota?: string }>> & {
    presion?: Partial<Record<Eye, Text>>
  }
}

const REFRACTION_FIELDS = [
  { key: "esfera", label: "Esfera", placeholder: "−1,25" },
  { key: "cilindro", label: "Cilindro", placeholder: "−0,50" },
  { key: "eje", label: "Eje", placeholder: "180" },
  { key: "adicion", label: "Adición", placeholder: "+2,00" },
  { key: "prisma", label: "Prisma (Δ)", placeholder: "" },
] as const

const STATE_OPTIONS = (["sin_alteraciones", "con_hallazgos", "no_realizado"] as const).map((value) => ({
  value,
  label: HEALTH_STATE_LABELS[value],
}))

/** Un número guardado, como se escribe en la pantalla: con coma y con signo en las dioptrías. */
function textOf(value: number | undefined, signed = false): Text {
  if (value === undefined) return undefined
  const text = String(Math.abs(value)).replace(".", ",")
  if (!signed) return String(value).replace(".", ",")
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : "0"
}

function draftOf(saved: unknown): EyeExamDraft | null {
  const exam = readEyeExam(saved)
  if (!exam) return null
  const refraccion: EyeExamDraft["refraccion"] = {}
  for (const { key: eye } of EYES) {
    const r = exam.refraccion?.[eye]
    if (!r) continue
    refraccion[eye] = {
      esfera: textOf(r.esfera, true),
      cilindro: textOf(r.cilindro, true),
      eje: textOf(r.eje),
      adicion: textOf(r.adicion, true),
      prisma: textOf(r.prisma),
      base: r.base,
      prisma2: textOf(r.prisma2),
      base2: r.base2,
    }
  }
  const dp: EyeExamDraft["dp"] = {}
  for (const { key } of PD_FIELDS) if (exam.dp?.[key] !== undefined) dp[key] = textOf(exam.dp[key])
  const presion: Partial<Record<Eye, Text>> = {}
  for (const { key: eye } of EYES) {
    if (exam.salud?.presion?.[eye] !== undefined) presion[eye] = textOf(exam.salud.presion[eye])
  }
  const { presion: _saved, ...health } = exam.salud ?? {}
  return {
    ...(exam.acompanante ? { acompanante: exam.acompanante } : {}),
    ...(exam.antecedentes ? { antecedentes: exam.antecedentes } : {}),
    ...(exam.agudeza ? { agudeza: exam.agudeza } : {}),
    refraccion,
    dp,
    salud: { ...health, presion },
  }
}

function bodyOf(draft: unknown): Record<string, unknown> | null {
  const d = draft as EyeExamDraft | null
  if (!d) return null
  const refraccion: Record<string, Record<string, unknown>> = {}
  for (const { key: eye } of EYES) {
    const r = d.refraccion?.[eye]
    if (!r) continue
    const prisma = numberOf(r.prisma)
    const prisma2 = numberOf(r.prisma2)
    const lens = {
      esfera: numberOf(r.esfera),
      cilindro: numberOf(r.cilindro),
      eje: numberOf(r.eje),
      adicion: numberOf(r.adicion),
      prisma,
      // Sin prisma, su base no se guarda: se borró el prisma y la base quedó escondida.
      base: prisma === undefined ? undefined : r.base || undefined,
      prisma2: prisma === undefined ? undefined : prisma2,
      base2: prisma === undefined || prisma2 === undefined ? undefined : r.base2 || undefined,
    }
    if (Object.values(lens).some((value) => value !== undefined)) refraccion[eye] = lens
  }
  const pairs = (values: Partial<Record<string, Text>> | undefined, keys: readonly string[] = EYES.map((eye) => eye.key)) => {
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const value = numberOf(values?.[key])
      if (value !== undefined) out[key] = value
    }
    return Object.keys(out).length ? out : undefined
  }
  const { presion, ...health } = d.salud ?? {}
  const body = {
    acompanante: d.acompanante?.nombre?.trim() || d.acompanante?.parentesco?.trim() ? d.acompanante : undefined,
    antecedentes: d.antecedentes,
    agudeza: d.agudeza,
    refraccion: Object.keys(refraccion).length ? refraccion : undefined,
    dp: pairs(d.dp, PD_FIELDS.map((field) => field.key)),
    salud: { ...health, presion: pairs(presion) },
  }
  // Lo vacío no se guarda: el servidor limpia el resto y, sin nada, deja el examen en null.
  const exam = readEyeExam(JSON.parse(JSON.stringify(body)))
  return exam ? { ...exam } : (JSON.parse(JSON.stringify(body)) as Record<string, unknown>)
}

/** Una tabla por ojo: cada fila un ojo, cada columna un dato. En el celular, los datos de un ojo uno bajo otro. */
function EyeGrid({
  idPrefix,
  title,
  columns,
  value,
  onChange,
  disabled,
  errors,
  path,
  placeholder,
}: {
  idPrefix: string
  title: string
  columns: ReadonlyArray<{ key: string; label: string; placeholder?: string }>
  value: (eye: Eye, key: string) => string
  onChange: (eye: Eye, key: string, text: string) => void
  disabled: boolean
  errors: ExaminationFieldsProps["errors"]
  path: string
  placeholder?: string
}) {
  return (
    <fieldset className="flex flex-col gap-2 sm:col-span-2">
      <legend className="pb-1 text-sm font-medium">{title}</legend>
      {EYES.map((eye) => (
        <div key={eye.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[4rem_repeat(var(--cols),minmax(0,1fr))] sm:items-start" style={{ "--cols": columns.length } as React.CSSProperties}>
          <span className="col-span-2 pt-2 text-sm font-semibold sm:col-span-1" title={eye.label}>
            {eye.short}
          </span>
          {columns.map((column) => {
            const id = `${idPrefix}-${path}-${eye.key}-${column.key}`
            const error = subFieldError(errors, `${path}.${eye.key}.${column.key}`, id)
            return (
              <Field key={column.key} data-invalid={error.invalid} className="gap-1">
                <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
                  {column.label} <span className="sr-only">{eye.label}</span>
                </FieldLabel>
                <Input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={value(eye.key, column.key)}
                  placeholder={column.placeholder ?? placeholder}
                  disabled={disabled}
                  aria-invalid={error.invalid}
                  aria-describedby={error.describedBy}
                  onChange={(event) => onChange(eye.key, column.key, event.target.value)}
                />
                {error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null}
              </Field>
            )
          })}
        </div>
      ))}
    </fieldset>
  )
}

function EyeExamFields({ idPrefix, draft, onChange, disabled, errors }: ExaminationFieldsProps) {
  const d = (draft as EyeExamDraft | null) ?? {}
  const set = (next: EyeExamDraft) => onChange(next)
  const signs = referralSigns(readEyeExam(bodyOf(d)) ?? readEyeExamLoose(d))
  const notesId = `${idPrefix}-antecedentes-nota`
  const notesError = subFieldError(errors, "antecedentes.nota", notesId)
  const companionId = `${idPrefix}-acompanante`
  const companionError = subFieldError(errors, "acompanante.nombre", companionId)
  return (
    <div className="flex flex-col gap-5 sm:col-span-2">
      <section aria-labelledby={`${companionId}-titulo`} className="flex flex-col gap-2">
        <h3 id={`${companionId}-titulo`} className="text-sm font-medium">
          Quién acompaña <span className="font-normal text-muted-foreground">(si es menor)</span>
        </h3>
        <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
          <Field data-invalid={companionError.invalid}>
            <FieldLabel htmlFor={companionId} className="text-xs text-muted-foreground">
              Nombre
            </FieldLabel>
            <Input
              id={companionId}
              value={d.acompanante?.nombre ?? ""}
              disabled={disabled}
              aria-invalid={companionError.invalid}
              aria-describedby={companionError.describedBy}
              onChange={(event) => set({ ...d, acompanante: { ...d.acompanante, nombre: event.target.value } })}
            />
            {companionError.message ? <FieldError id={companionError.errorId}>{companionError.message}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${companionId}-parentesco`} className="text-xs text-muted-foreground">
              Parentesco
            </FieldLabel>
            <Input
              id={`${companionId}-parentesco`}
              value={d.acompanante?.parentesco ?? ""}
              placeholder="madre, padre, tutor"
              disabled={disabled}
              onChange={(event) => set({ ...d, acompanante: { ...d.acompanante, parentesco: event.target.value } })}
            />
          </Field>
        </div>
      </section>
      <section aria-labelledby={`${idPrefix}-antecedentes`} className="flex flex-col gap-2">
        <h3 id={`${idPrefix}-antecedentes`} className="text-sm font-medium">
          Antecedentes de la vista
        </h3>
        <span id={`${idPrefix}-usa`} className="text-xs text-muted-foreground">
          ¿Usa lentes?
        </span>
        <ChoiceButtons
          aria-labelledby={`${idPrefix}-usa`}
          value={d.antecedentes?.usaLentes ?? null}
          options={USES_LENSES.map((item) => ({ value: item.key, label: item.label }))}
          columns={2}
          disabled={disabled}
          onChange={(usaLentes) => set({ ...d, antecedentes: { ...d.antecedentes, usaLentes } })}
          onClear={() => set({ ...d, antecedentes: { ...d.antecedentes, usaLentes: undefined } })}
        />
        <Field data-invalid={notesError.invalid}>
          <FieldLabel htmlFor={notesId} className="text-xs text-muted-foreground">
            Lo que importa para la vista
          </FieldLabel>
          <Textarea
            id={notesId}
            rows={2}
            maxLength={EYE_NOTE_MAX}
            value={d.antecedentes?.nota ?? ""}
            disabled={disabled}
            aria-invalid={notesError.invalid}
            aria-describedby={notesError.describedBy}
            placeholder="Golpes o cirugías en los ojos, diabetes o glaucoma en la familia, horas de pantalla"
            onChange={(event) => set({ ...d, antecedentes: { ...d.antecedentes, nota: event.target.value } })}
          />
          {notesError.message ? <FieldError id={notesError.errorId}>{notesError.message}</FieldError> : null}
        </Field>
      </section>

      <EyeGrid
        idPrefix={idPrefix}
        title="Agudeza visual"
        columns={ACUITY_FIELDS.map((field) => ({ ...field, placeholder: field.near ? "J1" : "20/20" }))}
        path="agudeza"
        value={(eye, key) => d.agudeza?.[eye]?.[key as keyof NonNullable<EyeExamDraft["agudeza"]>[Eye]] ?? ""}
        // Como se escribe («CD 1 m», «20/25+1»): el servidor lo deja en su notación al guardar.
        onChange={(eye, key, text) => set({ ...d, agudeza: { ...d.agudeza, [eye]: { ...d.agudeza?.[eye], [key]: text } } })}
        disabled={disabled}
        errors={errors}
      />

      <EyeGrid
        idPrefix={idPrefix}
        title="Refracción"
        columns={REFRACTION_FIELDS}
        path="refraccion"
        value={(eye, key) => d.refraccion?.[eye]?.[key as keyof RefractionDraft] ?? ""}
        onChange={(eye, key, text) =>
          set({
            ...d,
            refraccion: {
              ...d.refraccion,
              [eye]: {
                ...d.refraccion?.[eye],
                [key]: text,
                // Sin prisma no queda una base escondida que impida guardar.
                ...(key === "prisma" && !text.trim() ? { base: undefined, prisma2: undefined, base2: undefined } : {}),
              },
            },
          })
        }
        disabled={disabled}
        errors={errors}
      />
      {EYES.some((eye) => d.refraccion?.[eye.key]?.prisma?.trim()) ? (
        <div className="flex flex-col gap-4 sm:col-span-2">
          {EYES.filter((eye) => d.refraccion?.[eye.key]?.prisma?.trim()).map((eye) => (
            <PrismBases
              key={eye.key}
              idPrefix={idPrefix}
              eye={eye}
              path={`refraccion.${eye.key}`}
              draft={d.refraccion?.[eye.key] ?? {}}
              disabled={disabled}
              errors={errors}
              onChange={(next) => set({ ...d, refraccion: { ...d.refraccion, [eye.key]: { ...d.refraccion?.[eye.key], ...next } } })}
            />
          ))}
        </div>
      ) : null}
      <p className="-mt-3 text-xs text-muted-foreground">
        Dioptrías en pasos de 0,25; el eje de 1 a 180, solo con cilindro. De aquí sale la receta de anteojos.
      </p>

      <EyeGrid
        idPrefix={idPrefix}
        title="Distancia pupilar (mm)"
        columns={[{ key: "mm", label: "Monocular, del centro de la nariz", placeholder: "31,5" }]}
        path="dp"
        value={(eye) => d.dp?.[eye] ?? ""}
        onChange={(eye, _key, text) => set({ ...d, dp: { ...d.dp, [eye]: text } })}
        disabled={disabled}
        errors={errorsWithoutColumn(errors, "dp", "mm")}
      />
      <div className="-mt-2 grid grid-cols-2 gap-2 sm:col-span-2 sm:max-w-md">
        {PD_FIELDS.filter((field) => field.key === "binocular" || field.key === "cerca").map((field) => {
          const id = `${idPrefix}-dp-${field.key}`
          const error = subFieldError(errors, `dp.${field.key}`, id)
          return (
            <Field key={field.key} data-invalid={error.invalid} className="gap-1">
              <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
                {field.label} <span className="font-normal">(opcional)</span>
              </FieldLabel>
              <Input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                value={d.dp?.[field.key] ?? ""}
                placeholder={field.key === "binocular" ? "63" : "60"}
                disabled={disabled}
                aria-invalid={error.invalid}
                aria-describedby={error.describedBy}
                onChange={(event) => set({ ...d, dp: { ...d.dp, [field.key]: event.target.value } })}
              />
              {error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null}
            </Field>
          )
        })}
      </div>

      <section aria-labelledby={`${idPrefix}-salud`} className="flex flex-col">
        <h3 id={`${idPrefix}-salud`} className="pb-2 text-sm font-medium">
          Salud del ojo
        </h3>
        {HEALTH_PARTS.map((part) => {
          const entry = d.salud?.[part.key]
          const labelId = `${idPrefix}-salud-${part.key}`
          const stateError = subFieldError(errors, `salud.${part.key}`, `${labelId}-estado`)
          const noteId = `${labelId}-nota`
          const noteError = subFieldError(errors, `salud.${part.key}.nota`, noteId)
          const setPart = (next: { estado: HealthState; nota?: string } | undefined) => {
            const salud = { ...d.salud }
            if (next) salud[part.key] = next
            else delete salud[part.key]
            set({ ...d, salud })
          }
          return (
            <div key={part.key} className="flex flex-col gap-2 border-t py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span id={labelId} className="text-sm font-medium">
                  {part.label}
                </span>
                <ChoiceButtons
                  aria-labelledby={labelId}
                  value={entry?.estado ?? null}
                  options={STATE_OPTIONS}
                  columns={3}
                  className="sm:w-auto"
                  disabled={disabled}
                  invalid={stateError.invalid}
                  aria-describedby={stateError.describedBy}
                  onChange={(estado) => setPart(estado === "sin_alteraciones" ? { estado } : { estado, nota: entry?.nota ?? "" })}
                  onClear={() => setPart(undefined)}
                />
              </div>
              {stateError.message ? <FieldError id={stateError.errorId}>{stateError.message}</FieldError> : null}
              {entry && entry.estado !== "sin_alteraciones" ? (
                <Field data-invalid={noteError.invalid}>
                  <FieldLabel htmlFor={noteId} className="text-xs text-muted-foreground">
                    {entry.estado === "con_hallazgos" ? "Qué encontraste" : "Por qué no se hizo (opcional)"}
                  </FieldLabel>
                  <Textarea
                    id={noteId}
                    rows={2}
                    maxLength={EYE_NOTE_MAX}
                    value={entry.nota ?? ""}
                    disabled={disabled}
                    aria-invalid={noteError.invalid}
                    aria-describedby={noteError.describedBy}
                    onChange={(event) => setPart({ estado: entry.estado, nota: event.target.value })}
                  />
                  {noteError.message ? <FieldError id={noteError.errorId}>{noteError.message}</FieldError> : null}
                </Field>
              ) : null}
            </div>
          )
        })}
        <div className="border-t pt-3">
          <EyeGrid
            idPrefix={idPrefix}
            title="Presión del ojo (mmHg), si la mides"
            columns={[{ key: "mmhg", label: "Presión", placeholder: "15" }]}
            path="salud.presion"
            value={(eye) => d.salud?.presion?.[eye] ?? ""}
            onChange={(eye, _key, text) => set({ ...d, salud: { ...d.salud, presion: { ...d.salud?.presion, [eye]: text } } })}
            disabled={disabled}
            errors={errorsWithoutColumn(errors, "salud.presion", "mmhg")}
          />
        </div>
      </section>

      {signs.length > 0 ? (
        <Alert role="status" className="border-warning/40 bg-warning-soft">
          <AlertTitle className="font-bold text-warning">Conviene que lo vea un oftalmólogo</AlertTitle>
          <AlertDescription className="text-foreground">
            <ul className="list-disc pl-5">
              {signs.map((sign) => (
                <li key={sign}>{sign}</li>
              ))}
            </ul>
            <p className="mt-1">
              Tú decides. Si lo derivas, crea una orden de interconsulta en los documentos de esta atención («Nuevo» › «Orden»).
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

/** Los datos de un ojo que van sin columna (`dp.od`): el servidor los señala sin el nombre de la columna. */
function errorsWithoutColumn(errors: ExaminationFieldsProps["errors"], path: string, column: string) {
  if (!errors) return errors
  const out: Record<string, string | undefined> = { ...errors }
  for (const { key: eye } of EYES) {
    const message = errors[`${path}.${eye}`]
    if (message) out[`${path}.${eye}.${column}`] = message
  }
  return out
}

/** Lo que ya se puede leer del borrador mientras tiene un dato a medias: para avisar mientras se escribe. */
function readEyeExamLoose(d: EyeExamDraft): EyeExam | null {
  const presion: Partial<Record<Eye, number>> = {}
  for (const { key: eye } of EYES) {
    const value = numberOf(d.salud?.presion?.[eye])
    if (typeof value === "number") presion[eye] = value
  }
  const { presion: _draft, ...health } = d.salud ?? {}
  return readEyeExam({ agudeza: d.agudeza, salud: { ...health, presion } }) ?? null
}

/**
 * El examen de la vista de vistIA (entrega 3 del plan): antecedentes, agudeza
 * visual, refracción, distancia pupilar y salud del ojo, por ojo. Sin signos
 * vitales: una óptica no los toma. Lo que conviene que vea un oftalmólogo se
 * informa y el optómetra decide.
 */
export const opticalExamination: ProductExaminationUi = {
  title: "Examen de la vista",
  description: "Agudeza visual, refracción, distancia pupilar y salud del ojo.",
  vitals: [],
  draft: draftOf,
  body: bodyOf,
  summary: (draft) => eyeExamSummary(readEyeExam(bodyOf(draft))),
  Fields: (props) => <EyeExamFields {...props} />,
  VitalsNote: () => null,
  readLines: (saved) => eyeExamLines(readEyeExam(saved)),
}
