import { ChoiceButtons } from "@odentia/clinic-app/components/choice-buttons"
import { ChoiceSelect } from "@odentia/clinic-app/components/ui/choice-select"
import {
  type InterviewSectionsProps,
  type ProductHealthUi,
  type SubFieldError,
  type SubFieldErrors,
  subFieldError,
} from "@odentia/clinic-app/product/product-ui"
import {
  ACTIVITY,
  ALCOHOL,
  CONTRACEPTION_METHODS,
  type MedicalHistory,
  medicalHistoryLines,
  parseMedicalHistory,
  readMedicalHistory,
  TOBACCO,
  YES_NO,
  type YesNo,
} from "@odentia/medical"
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from "@odentia/ui"
import { DatePickerButton, regionToday } from "@odentia/ui-patterns"
import { ChevronDown } from "lucide-react"
import { type ReactNode, useState } from "react"

type Rec = Record<string, unknown>

const YES_NO_OPTIONS: ReadonlyArray<{ value: YesNo; label: string }> = YES_NO.map((value) => ({
  value,
  label: value === "si" ? "Sí" : "No",
}))
const options = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))

function groupOf(answers: Rec, key: string): Rec {
  const group = answers[key]
  return group && typeof group === "object" && !Array.isArray(group) ? (group as Rec) : {}
}

/** Un número entero escrito, o nada si está vacío o no es número. */
function wholeOrNothing(text: string): number | undefined {
  const value = text.trim() === "" ? Number.NaN : Number(text)
  return Number.isInteger(value) ? value : undefined
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          {title} <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-2 sm:grid-cols-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** El error de un dato bajo su campo; nada si no lo hay. */
function PartError({ error }: { error: SubFieldError }) {
  return error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null
}

/**
 * Embarazo o lactancia: sí o no, con el día en que se dijo (hoy, por omisión);
 * otro toque sobre lo marcado lo deja sin responder.
 */
function Statement({
  label,
  idPrefix,
  value,
  withWeeks,
  disabled,
  onChange,
  errors,
  errorKey,
}: {
  label: string
  idPrefix: string
  value: Rec | undefined
  withWeeks: boolean
  disabled: boolean
  onChange: (next: Rec | undefined) => void
  errors: SubFieldErrors | undefined
  /** «embarazoLactancia.embarazo»: lo suyo en `errors`; la clave sola es el sí o no. */
  errorKey: string
}) {
  const estado = value?.estado === "si" || value?.estado === "no" ? (value.estado as YesNo) : null
  const fecha = typeof value?.fecha === "string" ? value.fecha : ""
  const weeks = typeof value?.semanas === "number" ? String(value.semanas) : ""
  const stateError = subFieldError(
    errors,
    errors?.[`${errorKey}.estado`] ? `${errorKey}.estado` : errorKey,
    `${idPrefix}-estado`,
  )
  const dateError = subFieldError(errors, `${errorKey}.fecha`, `${idPrefix}-fecha`)
  const weeksError = subFieldError(errors, `${errorKey}.semanas`, `${idPrefix}-semanas`)
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <span id={`${idPrefix}-estado`} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex flex-wrap items-end gap-3">
        <ChoiceButtons
          aria-labelledby={`${idPrefix}-estado`}
          value={estado}
          options={YES_NO_OPTIONS}
          disabled={disabled}
          invalid={stateError.invalid}
          aria-describedby={stateError.describedBy}
          onChange={(next) =>
            onChange({
              ...value,
              estado: next,
              fecha: fecha || regionToday(),
              ...(next === "no" ? { semanas: undefined } : {}),
            })
          }
          onClear={() => onChange(undefined)}
        />
        {estado ? (
          <Field className="w-auto" data-invalid={dateError.invalid}>
            <FieldLabel htmlFor={`${idPrefix}-fecha`} className="text-xs text-muted-foreground">
              Lo dijo el
            </FieldLabel>
            <DatePickerButton
              id={`${idPrefix}-fecha`}
              value={fecha}
              max={regionToday()}
              disabled={disabled}
              aria-invalid={dateError.invalid}
              aria-describedby={dateError.describedBy}
              onChange={(next) => onChange({ ...value, fecha: next || regionToday() })}
            />
            <PartError error={dateError} />
          </Field>
        ) : null}
        {withWeeks && estado === "si" ? (
          <Field className="w-auto" data-invalid={weeksError.invalid}>
            <FieldLabel htmlFor={`${idPrefix}-semanas`} className="text-xs text-muted-foreground">
              Semanas ese día
            </FieldLabel>
            <Input
              id={`${idPrefix}-semanas`}
              className="w-24"
              inputMode="numeric"
              maxLength={2}
              value={weeks}
              disabled={disabled}
              aria-invalid={weeksError.invalid}
              aria-describedby={weeksError.describedBy}
              onChange={(event) =>
                onChange({
                  ...value,
                  semanas: wholeOrNothing(event.target.value.replace(/\D/g, "")),
                })
              }
            />
            <PartError error={weeksError} />
          </Field>
        ) : null}
      </div>
      <PartError error={stateError} />
    </div>
  )
}

/**
 * Lo médico de la entrevista (issue 229, decisión 13): embarazo y lactancia
 * con fecha y gineco-obstétricos (no a un hombre), hábitos y vacunas.
 */
function MedicalInterviewSections({
  answers,
  update,
  setGroup,
  disabled,
  idPrefix,
  sex,
  errors,
}: InterviewSectionsProps) {
  const fid = (name: string) => `${idPrefix}-${name}`
  // El error de cada dato («grupo.clave») va bajo su campo, con su control marcado.
  const err = (key: string, name: string) => subFieldError(errors, key, fid(name))
  const furError = err("ginecoObstetricos.fur", "go-fur")
  const methodError = err("ginecoObstetricos.metodo", "go-metodo")
  const tobaccoError = err("habitos.tabaco", "tabaco")
  const cigarettesError = err("habitos.cigarrillosDia", "cigarrillos")
  const alcoholError = err("habitos.alcohol", "alcohol")
  const activityError = err("habitos.actividadFisica", "actividad")
  const countsError = err("ginecoObstetricos", "go-conteos")
  const pregnancy = groupOf(answers, "embarazoLactancia")
  const gyneco = groupOf(answers, "ginecoObstetricos")
  const habits = groupOf(answers, "habitos")
  const vaccines = Array.isArray(answers.vacunas)
    ? (answers.vacunas as Array<{ vacuna?: string; fecha?: string }>)
    : []
  const setCount = (key: string) => (event: { target: { value: string } }) =>
    update("ginecoObstetricos", key, wholeOrNothing(event.target.value.replace(/\D/g, "")))
  const setVaccines = (next: Array<{ vacuna?: string; fecha?: string }>) =>
    setGroup("vacunas", next.length ? next : undefined)
  return (
    <>
      {sex === "M" ? null : (
        <Section title="Embarazo y lactancia">
          <Statement
            label="Embarazo"
            idPrefix={fid("embarazo")}
            value={pregnancy.embarazo as Rec | undefined}
            withWeeks
            disabled={disabled}
            onChange={(next) => update("embarazoLactancia", "embarazo", next)}
            errors={errors}
            errorKey="embarazoLactancia.embarazo"
          />
          <Statement
            label="Lactancia"
            idPrefix={fid("lactancia")}
            value={pregnancy.lactancia as Rec | undefined}
            withWeeks={false}
            disabled={disabled}
            onChange={(next) => update("embarazoLactancia", "lactancia", next)}
            errors={errors}
            errorKey="embarazoLactancia.lactancia"
          />
          <p className="text-xs text-muted-foreground sm:col-span-2">
            La receta avisa con esto: por eso se guarda el día en que se dijo.
          </p>
        </Section>
      )}
      {sex === "M" ? null : (
        <Section title="Gineco-obstétricos">
          <Field data-invalid={furError.invalid}>
            <FieldLabel htmlFor={fid("go-fur")}>Última regla</FieldLabel>
            <DatePickerButton
              id={fid("go-fur")}
              value={typeof gyneco.fur === "string" ? gyneco.fur : ""}
              max={regionToday()}
              emptyLabel="Sin registrar"
              disabled={disabled}
              aria-invalid={furError.invalid}
              aria-describedby={furError.describedBy}
              onChange={(next) => update("ginecoObstetricos", "fur", next || undefined)}
            />
            <PartError error={furError} />
          </Field>
          <Field data-invalid={methodError.invalid}>
            <FieldLabel htmlFor={fid("go-metodo")}>Método anticonceptivo</FieldLabel>
            <ChoiceSelect
              id={fid("go-metodo")}
              value={typeof gyneco.metodo === "string" ? gyneco.metodo : ""}
              disabled={disabled}
              aria-invalid={methodError.invalid}
              aria-describedby={methodError.describedBy}
              onChange={(event) =>
                update("ginecoObstetricos", "metodo", event.target.value || undefined)
              }
            >
              <option value="">Sin registrar</option>
              {options(CONTRACEPTION_METHODS).map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </ChoiceSelect>
            <PartError error={methodError} />
          </Field>
          <div className="grid grid-cols-3 gap-3 sm:col-span-2">
            {(
              [
                ["gestas", "Embarazos"],
                ["partos", "Partos"],
                ["cesareas", "Cesáreas"],
              ] as const
            ).map(([key, label]) => {
              const countError = err(`ginecoObstetricos.${key}`, `go-${key}`)
              // La regla entre los tres (partos y cesáreas no más que embarazos) marca los tres y se dice debajo.
              const invalid = countError.invalid ?? countsError.invalid
              const describedBy =
                [countError.describedBy, countsError.describedBy].filter(Boolean).join(" ") || undefined
              return (
                <Field key={key} data-invalid={invalid}>
                  <FieldLabel htmlFor={fid(`go-${key}`)}>{label}</FieldLabel>
                  <Input
                    id={fid(`go-${key}`)}
                    inputMode="numeric"
                    maxLength={2}
                    value={typeof gyneco[key] === "number" ? String(gyneco[key]) : ""}
                    disabled={disabled}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={setCount(key)}
                  />
                  <PartError error={countError} />
                </Field>
              )
            })}
            <div className="col-span-3">
              <PartError error={countsError} />
            </div>
          </div>
        </Section>
      )}
      <Section title="Hábitos">
        <Field
          className="sm:col-span-2"
          data-invalid={tobaccoError.invalid || cigarettesError.invalid}
        >
          <FieldLabel id={fid("tabaco")}>Tabaco</FieldLabel>
          <div className="flex flex-wrap items-center gap-3">
            <ChoiceButtons
              aria-labelledby={fid("tabaco")}
              value={
                typeof habits.tabaco === "string" ? (habits.tabaco as keyof typeof TOBACCO) : null
              }
              options={options(TOBACCO)}
              disabled={disabled}
              invalid={tobaccoError.invalid}
              aria-describedby={tobaccoError.describedBy}
              onChange={(next) => {
                update("habitos", "tabaco", next)
                if (next !== "fuma") update("habitos", "cigarrillosDia", undefined)
              }}
              onClear={() => {
                update("habitos", "tabaco", undefined)
                update("habitos", "cigarrillosDia", undefined)
              }}
            />
            {habits.tabaco === "fuma" ? (
              <span className="flex items-center gap-2">
                <Input
                  aria-label="Cigarrillos al día"
                  className="w-20"
                  inputMode="numeric"
                  maxLength={3}
                  value={
                    typeof habits.cigarrillosDia === "number" ? String(habits.cigarrillosDia) : ""
                  }
                  disabled={disabled}
                  aria-invalid={cigarettesError.invalid}
                  aria-describedby={cigarettesError.describedBy}
                  onChange={(event) =>
                    update(
                      "habitos",
                      "cigarrillosDia",
                      wholeOrNothing(event.target.value.replace(/\D/g, "")),
                    )
                  }
                />
                <span className="text-sm text-muted-foreground">al día</span>
              </span>
            ) : null}
          </div>
          <PartError error={tobaccoError} />
          <PartError error={cigarettesError} />
        </Field>
        <Field data-invalid={alcoholError.invalid}>
          <FieldLabel id={fid("alcohol")}>Alcohol</FieldLabel>
          <ChoiceButtons
            aria-labelledby={fid("alcohol")}
            value={
              typeof habits.alcohol === "string" ? (habits.alcohol as keyof typeof ALCOHOL) : null
            }
            options={options(ALCOHOL)}
            disabled={disabled}
            invalid={alcoholError.invalid}
            aria-describedby={alcoholError.describedBy}
            onChange={(next) => update("habitos", "alcohol", next)}
            onClear={() => update("habitos", "alcohol", undefined)}
          />
          <PartError error={alcoholError} />
        </Field>
        <Field data-invalid={activityError.invalid}>
          <FieldLabel id={fid("actividad")}>Actividad física</FieldLabel>
          <ChoiceButtons
            aria-labelledby={fid("actividad")}
            value={
              typeof habits.actividadFisica === "string"
                ? (habits.actividadFisica as keyof typeof ACTIVITY)
                : null
            }
            options={options(ACTIVITY)}
            disabled={disabled}
            invalid={activityError.invalid}
            aria-describedby={activityError.describedBy}
            onChange={(next) => update("habitos", "actividadFisica", next)}
            onClear={() => update("habitos", "actividadFisica", undefined)}
          />
          <PartError error={activityError} />
        </Field>
      </Section>
      <Section title="Vacunas">
        <div className="flex flex-col gap-3 sm:col-span-2">
          {vaccines.map((row, index) => {
            const nameError = err(`vacunas.${index}.vacuna`, `vac-${index}`)
            const dateError = err(`vacunas.${index}.fecha`, `vac-fecha-${index}`)
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id; se quitan por su lugar.
                key={index}
                className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
              >
                <Field data-invalid={nameError.invalid}>
                  <FieldLabel htmlFor={fid(`vac-${index}`)}>Vacuna</FieldLabel>
                  <Input
                    id={fid(`vac-${index}`)}
                    maxLength={120}
                    placeholder="Ej.: influenza, hepatitis B, tétanos"
                    value={row.vacuna ?? ""}
                    disabled={disabled}
                    aria-invalid={nameError.invalid}
                    aria-describedby={nameError.describedBy}
                    onChange={(event) =>
                      setVaccines(
                        vaccines.map((item, i) =>
                          i === index ? { ...item, vacuna: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <PartError error={nameError} />
                </Field>
                <Field data-invalid={dateError.invalid}>
                  <FieldLabel htmlFor={fid(`vac-fecha-${index}`)}>Fecha</FieldLabel>
                  <DatePickerButton
                    id={fid(`vac-fecha-${index}`)}
                    value={row.fecha ?? ""}
                    max={regionToday()}
                    emptyLabel="Sin fecha"
                    disabled={disabled}
                    aria-invalid={dateError.invalid}
                    aria-describedby={dateError.describedBy}
                    onChange={(next) =>
                      setVaccines(
                        vaccines.map((item, i) =>
                          i === index
                            ? { vacuna: item.vacuna, ...(next ? { fecha: next } : {}) }
                            : item,
                        ),
                      )
                    }
                  />
                  <PartError error={dateError} />
                </Field>
                {disabled ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setVaccines(vaccines.filter((_, i) => i !== index))}
                  >
                    Quitar
                  </Button>
                )}
              </div>
            )
          })}
          {disabled ? null : (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setVaccines([...vaccines, { vacuna: "" }])}
              >
                Agregar vacuna
              </Button>
            </div>
          )}
        </div>
      </Section>
    </>
  )
}

/** Lo guardado, debajo del resumen de antecedentes: embarazo y lactancia primero, con su fecha. */
function MedicalHistorySummary({ answers }: { answers: Rec }) {
  const today = regionToday()
  const history: MedicalHistory = readMedicalHistory(answers, today)
  const lines = medicalHistoryLines(history, today)
  if (lines.length === 0) return null
  return (
    <section
      aria-label="Antecedentes médicos"
      className="flex flex-col gap-2 elevated rounded-xl border bg-card p-4"
    >
      <h3 className="font-heading text-sm font-medium">Antecedentes médicos</h3>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}

/** latidIA en Antecedentes: el embarazo con fecha en su sección, gineco-obstétricos, hábitos y vacunas. */
export const medicalHealth: ProductHealthUi = {
  asksPregnancy: false,
  InterviewSections: (props) => <MedicalInterviewSections {...props} />,
  Summary: (props) => <MedicalHistorySummary {...props} />,
  validate: (answers, today) => {
    const parsed = parseMedicalHistory(answers, today)
    return parsed.ok || !parsed.field ? {} : { [parsed.field]: parsed.error }
  },
}
