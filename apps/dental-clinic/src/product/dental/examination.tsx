import type {
  ExaminationFieldsProps,
  ProductExaminationUi,
} from "@odentia/clinic-app/product/product-ui"
import { CORE_VITAL_KEYS } from "@odentia/clinical"
import {
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"

/** El examen de la boca como se edita: cada campo como texto, vacío si no se escribió. */
interface DentalExamDraft {
  extraoral: { atm: string; ganglios: string; labios: string }
  intraoral: {
    encias: string
    lengua: string
    paladar: string
    pisoBoca: string
    carrillos: string
    orofaringe: string
  }
  higieneOral: string
}

function strMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.trim() !== "") out[key] = raw
  }
  return out
}

const blank = (): DentalExamDraft => ({
  extraoral: { atm: "", ganglios: "", labios: "" },
  intraoral: { encias: "", lengua: "", paladar: "", pisoBoca: "", carrillos: "", orofaringe: "" },
  higieneOral: "",
})

/** Examen persistido a borrador editable (sin copiar exámenes antiguos a consultas nuevas: cada atención parte en null). */
function draftOf(examination: unknown): DentalExamDraft | null {
  if (!examination || typeof examination !== "object") return null
  const extraoral = strMap((examination as Record<string, unknown>).extraoral)
  const intraoral = strMap((examination as Record<string, unknown>).intraoral)
  const higiene = (examination as Record<string, unknown>).higieneOral
  const draft: DentalExamDraft = {
    extraoral: {
      atm: extraoral.atm ?? "",
      ganglios: extraoral.ganglios ?? "",
      labios: extraoral.labios ?? "",
    },
    intraoral: {
      encias: intraoral.encias ?? "",
      lengua: intraoral.lengua ?? "",
      paladar: intraoral.paladar ?? "",
      pisoBoca: intraoral.pisoBoca ?? "",
      carrillos: intraoral.carrillos ?? "",
      orofaringe: intraoral.orofaringe ?? "",
    },
    higieneOral: typeof higiene === "string" ? higiene : "",
  }
  const empty =
    Object.values(draft.extraoral).every((v) => v === "") &&
    Object.values(draft.intraoral).every((v) => v === "") &&
    draft.higieneOral === ""
  return empty ? null : draft
}

function bodyOf(value: unknown): Record<string, unknown> | null {
  const exam = value as DentalExamDraft | null
  if (!exam) return null
  const pick = (group: Record<string, string>): Record<string, string> | undefined => {
    const cleaned: Record<string, string> = {}
    for (const [key, raw] of Object.entries(group)) {
      const trimmed = raw.trim()
      if (trimmed) cleaned[key] = trimmed
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined
  }
  const extraoral = pick(exam.extraoral)
  const intraoral = pick(exam.intraoral)
  const higieneOral = exam.higieneOral === "" ? undefined : exam.higieneOral
  return extraoral || intraoral || higieneOral ? { extraoral, intraoral, higieneOral } : null
}

const EXTRAORAL: ReadonlyArray<{
  key: keyof DentalExamDraft["extraoral"]
  label: string
  id: string
}> = [
  { key: "atm", label: "ATM", id: "atm" },
  { key: "ganglios", label: "Ganglios", id: "ganglios" },
  { key: "labios", label: "Labios", id: "labios" },
]

const INTRAORAL: ReadonlyArray<{
  key: keyof DentalExamDraft["intraoral"]
  label: string
  id: string
}> = [
  { key: "encias", label: "Encías", id: "encias" },
  { key: "lengua", label: "Lengua", id: "lengua" },
  { key: "paladar", label: "Paladar", id: "paladar" },
  { key: "pisoBoca", label: "Piso de boca", id: "piso" },
  { key: "carrillos", label: "Carrillos", id: "carrillos" },
  { key: "orofaringe", label: "Orofaringe", id: "oro" },
]

/** Extraoral, higiene oral e intraoral, en la grilla de dos columnas del bloque. */
function DentalExamFields({ idPrefix, draft, onChange, disabled }: ExaminationFieldsProps) {
  const examination = draft as DentalExamDraft | null
  const edit = (group: "extraoral" | "intraoral", key: string, value: string) => {
    const prev = examination ?? blank()
    onChange({ ...prev, [group]: { ...prev[group], [key]: value } })
  }
  return (
    <>
      {EXTRAORAL.map((field) => (
        <Field key={field.key}>
          <FieldLabel htmlFor={`${idPrefix}-ex-${field.id}`}>{field.label}</FieldLabel>
          <Input
            id={`${idPrefix}-ex-${field.id}`}
            value={examination?.extraoral[field.key] ?? ""}
            disabled={disabled}
            onChange={(e) => edit("extraoral", field.key, e.target.value)}
          />
        </Field>
      ))}
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-ex-higiene`}>Higiene oral</FieldLabel>
        <Select
          value={examination?.higieneOral ?? ""}
          onValueChange={(v) => onChange({ ...(examination ?? blank()), higieneOral: v ?? "" })}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-ex-higiene`}>
            <SelectValue placeholder="Sin indicar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Sin indicar</SelectItem>
            <SelectItem value="buena">Buena</SelectItem>
            <SelectItem value="regular">Regular</SelectItem>
            <SelectItem value="mala">Mala</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {INTRAORAL.map((field) => (
        <Field key={field.key}>
          <FieldLabel htmlFor={`${idPrefix}-ex-${field.id}`}>{field.label}</FieldLabel>
          <Input
            id={`${idPrefix}-ex-${field.id}`}
            value={examination?.intraoral[field.key] ?? ""}
            disabled={disabled}
            onChange={(e) => edit("intraoral", field.key, e.target.value)}
          />
        </Field>
      ))}
    </>
  )
}

/**
 * El examen de la boca de odentIA: extraoral, intraoral e higiene oral, con
 * los ocho signos vitales de siempre. Al leer la atención no se muestra, como
 * antes del issue 229.
 */
export const dentalExamination: ProductExaminationUi = {
  title: "Examen clínico",
  description: "Signos vitales, examen extraoral, intraoral e higiene oral.",
  vitals: CORE_VITAL_KEYS,
  draft: draftOf,
  body: bodyOf,
  summary: (draft) => (draft ? "Examen registrado" : ""),
  Fields: (props) => <DentalExamFields {...props} />,
  VitalsNote: () => null,
  readLines: () => [],
}
