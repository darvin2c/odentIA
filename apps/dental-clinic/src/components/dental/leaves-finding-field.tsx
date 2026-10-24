import {
  conditionLabel,
  findingDefinition,
  TREATMENT_RESULT_CONDITIONS,
} from "@odentia/dental"
import { Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { useDentalProfile } from "../../lib/dental/profile"
import { variantFieldLabel } from "./odontogram-notation"

const NOTHING = "nada"

/**
 * «Deja en la pieza» (lo tratado queda dibujado; fase 3, paso 5): lo que un
 * servicio por pieza o por superficies deja dibujado al completarse. odentIA
 * lo trae puesto en los servicios de su biblioteca; en uno propio se elige
 * aquí. En clínicas de Perú la variante va con su sigla (NTS 188), salvo la
 * causa de una ausencia, que se deduce al completar. Las reglas viven en el
 * servidor (`validateLeavesFinding`); esto solo ofrece lo que encaja.
 */
export function LeavesFindingField({
  idPrefix,
  scope,
  condition,
  variant,
  onChange,
  disabled = false,
}: {
  idPrefix: string
  /** Dónde se hace el servicio: solo por pieza o por superficies deja algo. */
  scope: string | null | undefined
  condition: string
  variant: string
  onChange: (condition: string, variant: string) => void
  disabled?: boolean
}) {
  const official = useDentalProfile().odontogram
  if (scope !== "tooth" && scope !== "surfaces") return null
  // Lo que se dibuja en las caras necesita un servicio por superficies.
  const options = TREATMENT_RESULT_CONDITIONS.filter(
    (code) => scope === "surfaces" || findingDefinition(code)?.scope !== "surface",
  )
  const def = condition ? findingDefinition(condition) : undefined
  const items = Object.fromEntries([
    [NOTHING, "Nada"],
    ...options.map((code) => [code, conditionLabel(code)]),
  ])
  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-deja`}>Deja en la pieza</FieldLabel>
        <Select
          value={condition || NOTHING}
          items={items}
          onValueChange={(value) => onChange(!value || value === NOTHING ? "" : value, "")}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-deja`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NOTHING}>Nada</SelectItem>
            {options.map((code) => (
              <SelectItem key={code} value={code}>
                {conditionLabel(code)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {condition
            ? "Al completarlo, la pieza queda dibujada con esto, en buen estado."
            : "Si deja algo en la pieza, al completarlo queda dibujado en el odontograma."}
        </p>
      </Field>
      {def?.variants?.length ? (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-deja-variante`}>
            {variantFieldLabel(official, def.code)}
          </FieldLabel>
          <Select
            value={variant}
            items={Object.fromEntries(
              def.variants.map((item) => [
                item.value,
                official && item.abbreviation ? `${item.label} · ${item.abbreviation}` : item.label,
              ]),
            )}
            onValueChange={(value) => onChange(condition, value ?? "")}
            disabled={disabled}
          >
            <SelectTrigger id={`${idPrefix}-deja-variante`}>
              <SelectValue placeholder="Elige…" />
            </SelectTrigger>
            <SelectContent>
              {def.variants.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {official && item.abbreviation ? `${item.label} · ${item.abbreviation}` : item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {def.code === "missing_tooth" ? (
            <p className="text-xs text-muted-foreground">
              Si no la eliges, la causa se deduce al completarla: por caries si la motivó una caries
              o un resto radicular; si no, por otras razones.
            </p>
          ) : null}
        </Field>
      ) : null}
    </div>
  )
}

/** Lo que viaja al servidor: el hallazgo y su variante, o null. */
export function leavesFindingBody(
  condition: string,
  variant: string,
): { condition: string; variant?: string } | null {
  if (!condition) return null
  return variant ? { condition, variant } : { condition }
}
