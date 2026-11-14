import {
  type InterviewSectionsProps,
  type ProductHealthUi,
  type SubFieldError,
  subFieldError,
} from "@odentia/clinic-app/product/product-ui"
import {
  CHILDHOOD_WORDS,
  childhoodLines,
  DENTAL_BRUSHINGS_MAX,
  DENTAL_HABITS_MAX,
  dentalHabitsErrors,
  dentalInterviewErrors,
  dentalInterviewLines,
} from "@odentia/dental"
import { CIGARETTE_BAND_LABELS, CIGARETTE_BANDS, EARLY_CHILDHOOD_MAX_AGE, isChildAge } from "@odentia/clinical"
import { regionToday } from "@odentia/ui-patterns"
import {
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { ChevronDown } from "lucide-react"
import { useState } from "react"

type Rec = Record<string, unknown>

/** Lo que muestra cada lista con su nombre; sin `items`, Base UI mostraría la clave guardada. */
const EXPERIENCE_ITEMS: Record<string, string> = {
  "sin-indicar": "Sin indicar",
  positiva: "Positiva",
  regular: "Regular",
  traumatica: "Traumática",
}
const ANXIETY_ITEMS: Record<string, string> = {
  "sin-indicar": "Sin indicar",
  ninguna: "Ninguna",
  leve: "Leve",
  moderada: "Moderada",
  alta: "Alta",
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
}

/** Los hábitos como se leen: separados por coma, sin vacíos. */
function habitsOf(text: string): string[] {
  return text
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
}

/** «Odontológicos y hábitos» de la entrevista de salud, como antes del issue 229. */
function DentalInterviewSections({
  answers,
  update,
  disabled,
  idPrefix,
  errors,
}: InterviewSectionsProps) {
  const [open, setOpen] = useState(true)
  const fid = (name: string): string => `${idPrefix}-${name}`
  const raw = answers.antecedentesOdontologicos
  const odontologicos: Rec =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : {}
  // El error de cada dato va bajo su campo, con su control marcado.
  const err = (key: string, name: string) =>
    subFieldError(errors, `antecedentesOdontologicos.${key}`, fid(name))
  const ultimaVisita = err("ultimaVisita", "od-ult")
  const cepillados = err("cepilladosAlDia", "od-cep")
  const experiencia = err("experienciaPrevia", "od-exp")
  const ansiedad = err("ansiedadDental", "od-ans")
  const hilo = err("hiloDental", "od-hilo")
  const bruxismo = err("bruxismo", "od-brux")
  const habitos = err("habitos", "od-hab")
  const savedHabits = Array.isArray(odontologicos["habitos"]) ? (odontologicos["habitos"] as string[]).join(", ") : ""
  // Lo escrito se conserva tal cual (la coma recién puesta incluida) mientras diga lo mismo que lo guardado.
  const [habitsText, setHabitsText] = useState(savedHabits)
  const shownHabits = habitsOf(habitsText).join(", ") === savedHabits ? habitsText : savedHabits
  const fieldError = (error: SubFieldError) =>
    error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          Odontológicos y hábitos <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-2 sm:grid-cols-2">
          <Field data-invalid={ultimaVisita.invalid}>
            <FieldLabel htmlFor={fid("od-ult")}>Última visita</FieldLabel>
            <Input
              id={fid("od-ult")}
              value={strOf(odontologicos["ultimaVisita"])}
              disabled={disabled}
              aria-invalid={ultimaVisita.invalid}
              aria-describedby={ultimaVisita.describedBy}
              onChange={(e) =>
                update(
                  "antecedentesOdontologicos",
                  "ultimaVisita",
                  e.target.value === "" ? undefined : e.target.value,
                )
              }
            />
            {fieldError(ultimaVisita)}
          </Field>
          <Field data-invalid={cepillados.invalid}>
            <FieldLabel htmlFor={fid("od-cep")}>Cepillados al día (0–{DENTAL_BRUSHINGS_MAX})</FieldLabel>
            <Input
              id={fid("od-cep")}
              inputMode="numeric"
              maxLength={4}
              value={strOf(odontologicos["cepilladosAlDia"])}
              disabled={disabled}
              aria-invalid={cepillados.invalid}
              aria-describedby={cepillados.describedBy}
              onChange={(e) => {
                const t = e.target.value.trim().replace(",", ".")
                // Lo que no es un número queda tal cual para que el campo diga qué corregir.
                update(
                  "antecedentesOdontologicos",
                  "cepilladosAlDia",
                  t === "" ? undefined : Number.isNaN(Number(t)) ? t : Number(t),
                )
              }}
            />
            {fieldError(cepillados)}
          </Field>
          <Field data-invalid={experiencia.invalid}>
            <FieldLabel htmlFor={fid("od-exp")}>Experiencia previa</FieldLabel>
            <Select
              // Con sus nombres: sin ellos, el campo muestra la clave («sin-indicar», QA del 6 nov).
              items={EXPERIENCE_ITEMS}
              value={
                strOf(odontologicos["experienciaPrevia"]) === ""
                  ? "sin-indicar"
                  : strOf(odontologicos["experienciaPrevia"])
              }
              onValueChange={(v) =>
                update(
                  "antecedentesOdontologicos",
                  "experienciaPrevia",
                  !v || v === "sin-indicar" ? undefined : v,
                )
              }
              disabled={disabled}
            >
              <SelectTrigger
                id={fid("od-exp")}
                aria-invalid={experiencia.invalid}
                aria-describedby={experiencia.describedBy}
              >
                <SelectValue placeholder="Sin indicar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sin-indicar">Sin indicar</SelectItem>
                <SelectItem value="positiva">Positiva</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="traumatica">Traumática</SelectItem>
              </SelectContent>
            </Select>
            {fieldError(experiencia)}
          </Field>
          <Field data-invalid={ansiedad.invalid}>
            <FieldLabel htmlFor={fid("od-ans")}>Ansiedad dental</FieldLabel>
            <Select
              items={ANXIETY_ITEMS}
              value={
                strOf(odontologicos["ansiedadDental"]) === ""
                  ? "sin-indicar"
                  : strOf(odontologicos["ansiedadDental"])
              }
              onValueChange={(v) =>
                update(
                  "antecedentesOdontologicos",
                  "ansiedadDental",
                  !v || v === "sin-indicar" ? undefined : v,
                )
              }
              disabled={disabled}
            >
              <SelectTrigger
                id={fid("od-ans")}
                aria-invalid={ansiedad.invalid}
                aria-describedby={ansiedad.describedBy}
              >
                <SelectValue placeholder="Sin indicar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sin-indicar">Sin indicar</SelectItem>
                <SelectItem value="ninguna">Ninguna</SelectItem>
                <SelectItem value="leve">Leve</SelectItem>
                <SelectItem value="moderada">Moderada</SelectItem>
                <SelectItem value="alta">Alta</SelectItem>
              </SelectContent>
            </Select>
            {fieldError(ansiedad)}
          </Field>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={fid("od-hilo")}
                  aria-invalid={hilo.invalid}
                  aria-describedby={hilo.describedBy}
                  checked={odontologicos["hiloDental"] === true}
                  disabled={disabled}
                  onCheckedChange={(c: boolean) =>
                    update("antecedentesOdontologicos", "hiloDental", c === true ? true : undefined)
                  }
                />
                <label htmlFor={fid("od-hilo")} className="text-sm">
                  Hilo dental
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={fid("od-brux")}
                  aria-invalid={bruxismo.invalid}
                  aria-describedby={bruxismo.describedBy}
                  checked={odontologicos["bruxismo"] === true}
                  disabled={disabled}
                  onCheckedChange={(c: boolean) =>
                    update("antecedentesOdontologicos", "bruxismo", c === true ? true : undefined)
                  }
                />
                <label htmlFor={fid("od-brux")} className="text-sm">
                  Bruxismo
                </label>
              </div>
            </div>
            {fieldError(hilo)}
            {fieldError(bruxismo)}
          </div>
          <Field data-invalid={habitos.invalid}>
            <FieldLabel htmlFor={fid("od-hab")}>Hábitos (separados por coma, máx. {DENTAL_HABITS_MAX})</FieldLabel>
            <Input
              id={fid("od-hab")}
              aria-invalid={habitos.invalid}
              aria-describedby={habitos.describedBy}
              placeholder="tabaquismo, onicofagia"
              value={shownHabits}
              disabled={disabled}
              onChange={(e) => {
                setHabitsText(e.target.value)
                const items = habitsOf(e.target.value)
                update("antecedentesOdontologicos", "habitos", items.length > 0 ? items : undefined)
              }}
            />
            {fieldError(habitos)}
          </Field>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const ANSWER_ITEMS: Record<string, string> = { "sin-indicar": "Sin indicar", si: "Sí", no: "No", no_sabe: "No sabe" }
const TOBACCO_ITEMS: Record<string, string> = {
  "sin-indicar": "Sin indicar",
  nunca: "Nunca fumó",
  fuma: "Fuma",
  dejo: "Lo dejó",
}
const CIGARETTE_ITEMS: Record<string, string> = {
  "sin-indicar": "Sin indicar",
  ...Object.fromEntries(CIGARETTE_BANDS.map((band) => [band, CIGARETTE_BAND_LABELS[band]])),
}
const LACTATION_ITEMS: Record<string, string> = { "sin-indicar": "Sin indicar", si: "Sí", no: "No" }

/** Una lista corta con «Sin indicar» primero; elegirlo quita el dato. */
function Pick({
  id,
  label,
  items,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string
  label: string
  items: Record<string, string>
  value: string
  onChange: (value: string | undefined) => void
  disabled: boolean
  error: SubFieldError
}) {
  return (
    <Field data-invalid={error.invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value === "" ? "sin-indicar" : value}
        onValueChange={(v) => onChange(!v || v === "sin-indicar" ? undefined : String(v))}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-invalid={error.invalid} aria-describedby={error.describedBy}>
          <SelectValue placeholder="Sin indicar" />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null}
    </Field>
  )
}

/**
 * Lo que cambia lo que se hace en la cita (mesa del 13 nov): el corazón (antibiótico antes de
 * atender), la anestesia, si fuma y cuánto, y la lactancia, con la forma de latidIA
 * (`habitos`, `embarazoLactancia.lactancia` con el día en que se dijo).
 */
function DentalRiskSections({ answers, update, disabled, idPrefix, sex, age, errors }: InterviewSectionsProps) {
  // A un niño no se le pregunta si fuma ni la lactancia; lo ya anotado sí se ve.
  const child = isChildAge(age)
  const [open, setOpen] = useState(true)
  const fid = (name: string): string => `${idPrefix}-${name}`
  const group = (key: string): Rec => {
    const raw = answers[key]
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : {}
  }
  const odontologicos = group("antecedentesOdontologicos")
  const heart = (odontologicos["corazon"] ?? {}) as Rec
  const habits = group("habitos")
  const lactation = (group("embarazoLactancia")["lactancia"] ?? {}) as Rec
  const setHeart = (key: string, value: string | undefined) => {
    const next = { ...heart, [key]: value }
    if (value === undefined) delete next[key]
    update("antecedentesOdontologicos", "corazon", Object.keys(next).length ? next : undefined)
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          Corazón, anestesia y tabaco <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-2 sm:grid-cols-2">
          <Pick
            id={fid("od-corazon")}
            label="Válvula operada, problema del corazón de nacimiento o endocarditis"
            items={ANSWER_ITEMS}
            value={strOf(heart["riesgoEndocarditis"])}
            onChange={(v) => setHeart("riesgoEndocarditis", v)}
            disabled={disabled}
            error={subFieldError(errors, "antecedentesOdontologicos.corazon", fid("od-corazon"))}
          />
          <Pick
            id={fid("od-antibiotico")}
            label="Su médico le indicó antibiótico antes del dentista"
            items={ANSWER_ITEMS}
            value={strOf(heart["antibioticoPrevio"])}
            onChange={(v) => setHeart("antibioticoPrevio", v)}
            disabled={disabled}
            error={subFieldError(errors, "antecedentesOdontologicos.corazon.antibioticoPrevio", fid("od-antibiotico"))}
          />
          <Pick
            id={fid("od-anestesia")}
            label="Problema con la anestesia o sangrado largo tras una extracción"
            items={ANSWER_ITEMS}
            value={strOf(odontologicos["problemaAnestesia"])}
            onChange={(v) => update("antecedentesOdontologicos", "problemaAnestesia", v)}
            disabled={disabled}
            error={subFieldError(errors, "antecedentesOdontologicos.problemaAnestesia", fid("od-anestesia"))}
          />
          {child && strOf(habits["tabaco"]) === "" ? null : (
          <Pick
            id={fid("od-tabaco")}
            label="Tabaco"
            items={TOBACCO_ITEMS}
            value={strOf(habits["tabaco"])}
            onChange={(v) => {
              update("habitos", "tabaco", v)
              // Cuántos al día se dice solo de quien fuma.
              if (v !== "fuma") update("habitos", "cigarrillos", undefined)
            }}
            disabled={disabled}
            error={subFieldError(errors, "habitos.tabaco", fid("od-tabaco"))}
          />
          )}
          {habits["tabaco"] === "fuma" ? (
            <Pick
              id={fid("od-cigarrillos")}
              label="Cigarrillos al día"
              items={CIGARETTE_ITEMS}
              value={strOf(habits["cigarrillos"])}
              onChange={(v) => update("habitos", "cigarrillos", v)}
              disabled={disabled}
              error={subFieldError(errors, "habitos.cigarrillos", fid("od-cigarrillos"))}
            />
          ) : null}
          {sex === "M" || (child && strOf(lactation["estado"]) === "") ? null : (
            <Pick
              id={fid("od-lactancia")}
              label="Lactancia"
              items={LACTATION_ITEMS}
              value={strOf(lactation["estado"])}
              // Con el día en que se dijo, como el embarazo: hoy, si cambia la respuesta.
              onChange={(v) =>
                update(
                  "embarazoLactancia",
                  "lactancia",
                  v ? { estado: v, fecha: v === lactation["estado"] && strOf(lactation["fecha"]) ? lactation["fecha"] : regionToday() } : undefined,
                )
              }
              disabled={disabled}
              error={subFieldError(errors, "embarazoLactancia.lactancia", fid("od-lactancia"))}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Una respuesta de «de pequeño» por lista, con «Sin indicar» primero. */
const childItems = (words: Record<string, string>): Record<string, string> => ({
  "sin-indicar": "Sin indicar",
  ...Object.fromEntries(Object.entries(words).map(([key, text]) => [key, text.replace(/^./, (letter) => letter.toLocaleUpperCase("es"))])),
})
const CHILD_FIELDS = [
  { key: "biberon", label: "Biberón o pecho para dormir", early: true },
  { key: "chupon", label: "Chupón o dedo", early: true },
  { key: "dulcesEntreComidas", label: "Dulces o jugos entre comidas", early: false },
  { key: "pastaConFluor", label: "Pasta de dientes con flúor", early: false },
  { key: "quienCepilla", label: "Quién le cepilla los dientes", early: false },
] as const

/**
 * «De pequeño» (mesa del 13 nov, entrega 7): lo que cuenta quien cuida a un menor
 * de 12, con las claves de `antecedentesOdontologicos`. Sale para un niño, o si ya
 * hay algo anotado; biberón y chupón, hasta los 6 años.
 */
function ChildhoodSections({ answers, update, disabled, idPrefix, age, errors }: InterviewSectionsProps) {
  const [open, setOpen] = useState(true)
  const raw = answers.antecedentesOdontologicos
  const odontologicos: Rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : {}
  const child = isChildAge(age)
  const shown = CHILD_FIELDS.filter(
    (field) =>
      strOf(odontologicos[field.key]) !== "" ||
      (child && (!field.early || (age as number) <= EARLY_CHILDHOOD_MAX_AGE)),
  )
  if (shown.length === 0) return null
  const fid = (name: string): string => `${idPrefix}-od-${name}`
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          De pequeño <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-2 sm:grid-cols-2">
          {shown.map((field) => (
            <Pick
              key={field.key}
              id={fid(field.key)}
              label={field.label}
              items={childItems(CHILDHOOD_WORDS[field.key])}
              value={strOf(odontologicos[field.key])}
              onChange={(v) => update("antecedentesOdontologicos", field.key, v)}
              disabled={disabled}
              error={subFieldError(errors, `antecedentesOdontologicos.${field.key}`, fid(field.key))}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Lo guardado del corazón, la anestesia, el tabaco y la lactancia, y lo de pequeño, debajo del resumen de antecedentes. */
function DentalHistorySummary({ answers }: { answers: Rec }) {
  const lines = dentalInterviewLines(answers)
  const raw = answers.antecedentesOdontologicos
  const childhood = childhoodLines(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : null)
  if (lines.length === 0 && childhood.length === 0) return null
  return (
    <>
      {lines.length > 0 ? (
        <section aria-label="Corazón, anestesia y tabaco" className="flex flex-col gap-2 elevated rounded-xl border bg-card p-4">
          <h3 className="font-heading text-sm font-medium">Corazón, anestesia y tabaco</h3>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {childhood.length > 0 ? (
        <section aria-label="De pequeño" className="flex flex-col gap-2 elevated rounded-xl border bg-card p-4">
          <h3 className="font-heading text-sm font-medium">De pequeño</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {childhood.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  )
}

/** odentIA en Antecedentes: el embarazo en «Personales», sus antecedentes odontológicos y lo que cambia la cita. */
export const dentalHealth: ProductHealthUi = {
  asksPregnancy: true,
  showsAsa: true,
  InterviewSections: (props) => (
    <>
      <DentalRiskSections {...props} />
      <ChildhoodSections {...props} />
      <DentalInterviewSections {...props} />
    </>
  ),
  validate: (answers) => ({ ...dentalInterviewErrors(answers), ...dentalHabitsErrors(answers) }),
  Summary: (props) => <DentalHistorySummary {...props} />,
}
