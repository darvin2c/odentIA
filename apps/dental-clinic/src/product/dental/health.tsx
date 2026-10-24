import type {
  InterviewSectionsProps,
  ProductHealthUi,
} from "@odentia/clinic-app/product/product-ui"
import {
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
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

/** «Odontológicos y hábitos» de la entrevista de salud, como antes del issue 229. */
function DentalInterviewSections({ answers, update, disabled, idPrefix }: InterviewSectionsProps) {
  const [open, setOpen] = useState(true)
  const fid = (name: string): string => `${idPrefix}-${name}`
  const raw = answers.antecedentesOdontologicos
  const odontologicos: Rec =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Rec) : {}
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          Odontológicos y hábitos <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-2 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={fid("od-ult")}>Última visita</FieldLabel>
            <Input
              id={fid("od-ult")}
              value={strOf(odontologicos["ultimaVisita"])}
              disabled={disabled}
              onChange={(e) =>
                update(
                  "antecedentesOdontologicos",
                  "ultimaVisita",
                  e.target.value === "" ? undefined : e.target.value,
                )
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fid("od-cep")}>Cepillados al día (0–10)</FieldLabel>
            <Input
              id={fid("od-cep")}
              type="number"
              min={0}
              max={10}
              value={strOf(odontologicos["cepilladosAlDia"])}
              disabled={disabled}
              onChange={(e) => {
                const t = e.target.value.trim()
                update(
                  "antecedentesOdontologicos",
                  "cepilladosAlDia",
                  t === "" ? undefined : Number(t),
                )
              }}
            />
          </Field>
          <Field>
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
              <SelectTrigger id={fid("od-exp")}>
                <SelectValue placeholder="Sin indicar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sin-indicar">Sin indicar</SelectItem>
                <SelectItem value="positiva">Positiva</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="traumatica">Traumática</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
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
              <SelectTrigger id={fid("od-ans")}>
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
          </Field>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id={fid("od-hilo")}
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
          <Field>
            <FieldLabel htmlFor={fid("od-hab")}>Hábitos (separados por coma, máx. 10)</FieldLabel>
            <Input
              id={fid("od-hab")}
              placeholder="tabaquismo, onicofagia"
              value={
                Array.isArray(odontologicos["habitos"])
                  ? (odontologicos["habitos"] as string[]).join(", ")
                  : ""
              }
              disabled={disabled}
              onChange={(e) => {
                const items = e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter((x) => x !== "")
                  .slice(0, 10)
                update("antecedentesOdontologicos", "habitos", items.length > 0 ? items : undefined)
              }}
            />
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
  Summary: () => null,
}
