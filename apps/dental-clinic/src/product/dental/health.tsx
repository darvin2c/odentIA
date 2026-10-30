import {
  type InterviewSectionsProps,
  type ProductHealthUi,
  type SubFieldError,
  subFieldError,
} from "@odentia/clinic-app/product/product-ui"
import { DENTAL_BRUSHINGS_MAX, DENTAL_HABITS_MAX, dentalInterviewErrors } from "@odentia/dental"
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

/** odentIA en Antecedentes: el embarazo en «Personales» y sus antecedentes odontológicos. */
export const dentalHealth: ProductHealthUi = {
  asksPregnancy: true,
  InterviewSections: (props) => <DentalInterviewSections {...props} />,
  validate: (answers) => dentalInterviewErrors(answers),
  Summary: () => null,
}
