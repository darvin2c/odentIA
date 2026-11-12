import { ChoiceButtons } from "@odentia/clinic-app/components/choice-buttons"
import { subFieldError } from "@odentia/clinic-app/product/product-ui"
import {
  type ContactLens,
  EYES,
  type Eye,
  type PrescriptionKind,
  type PrescriptionLenses,
  PRISM_BASES,
  type PrismBase,
  type Refraction,
  typedNumber,
} from "@odentia/optical"
import { Field, FieldError, FieldLabel, Input } from "@odentia/ui"

/**
 * Los lentes de una receta como se escriben («−1,25», «8,6»), por ojo, para los
 * cajones de la receta: la de lentes de contacto de la atención, la externa y la
 * que se vuelve a emitir. Lo que no se entiende se manda tal cual y el servidor
 * dice qué dato está mal, junto a él.
 */
export interface LensDraft {
  esfera?: string
  cilindro?: string
  eje?: string
  adicion?: string
  prisma?: string
  base?: string
  prisma2?: string
  base2?: string
  curvaBase?: string
  diametro?: string
  marca?: string
}
export type LensDrafts = Record<Eye, LensDraft>
export const EMPTY_LENSES: LensDrafts = { od: {}, oi: {} }

/** «−1,25», «‒1,25» pegado de una receta impresa, «+2», «1.5» → número (`typedNumber`). */
export const numberOf = typedNumber

/** Un número guardado como se escribe: con coma y, en las dioptrías, con signo. */
export function textOf(value: number | undefined, signed = false): string | undefined {
  if (value === undefined) return undefined
  if (!signed) return String(value).replace(".", ",")
  const text = String(Math.abs(value)).replace(".", ",")
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : "0"
}

/** Los lentes guardados (o propuestos) como borrador del cajón. */
export function lensDraftsOf(lenses: PrescriptionLenses | null | undefined): LensDrafts {
  const out: LensDrafts = { od: {}, oi: {} }
  for (const { key: eye } of EYES) {
    const lens = lenses?.[eye] as (Refraction & ContactLens) | undefined
    if (!lens) continue
    out[eye] = {
      esfera: textOf(lens.esfera, true),
      cilindro: textOf(lens.cilindro, true),
      eje: textOf(lens.eje),
      adicion: textOf(lens.adicion, true),
      prisma: textOf(lens.prisma),
      base: lens.base,
      prisma2: textOf(lens.prisma2),
      base2: lens.base2,
      curvaBase: textOf(lens.curvaBase),
      diametro: textOf(lens.diametro),
      marca: lens.marca,
    }
  }
  return out
}

/** El borrador como lo pide el servidor: solo los ojos con algo escrito, y el prisma solo en los anteojos. */
export function lensesBody(kind: PrescriptionKind, drafts: LensDrafts): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const { key: eye } of EYES) {
    const d = drafts[eye]
    const prisma = kind === "anteojos" ? numberOf(d.prisma) : undefined
    const prisma2 = prisma === undefined ? undefined : numberOf(d.prisma2)
    const lens: Record<string, unknown> = {
      esfera: numberOf(d.esfera),
      cilindro: numberOf(d.cilindro),
      eje: numberOf(d.eje),
      adicion: numberOf(d.adicion),
      ...(kind === "anteojos"
        ? {
            prisma,
            base: prisma === undefined ? undefined : d.base || undefined,
            prisma2,
            base2: prisma2 === undefined ? undefined : d.base2 || undefined,
          }
        : { curvaBase: numberOf(d.curvaBase), diametro: numberOf(d.diametro), marca: d.marca?.trim() || undefined }),
    }
    if (Object.values(lens).some((value) => value !== undefined)) out[eye] = lens
  }
  return out
}

export function lensesDirty(drafts: LensDrafts): boolean {
  return EYES.some((eye) => Object.values(drafts[eye.key]).some((value) => typeof value === "string" && value.trim() !== ""))
}

type Errors = Record<string, string | undefined> | null | undefined

/**
 * La base del prisma de un ojo y, si es compuesto, el segundo prisma en el otro
 * eje (uno horizontal y otro vertical). Cada elección se puede quitar; quitar la
 * base quita también el segundo prisma.
 */
export function PrismBases({
  idPrefix,
  eye,
  path,
  draft,
  disabled = false,
  errors,
  onChange,
}: {
  idPrefix: string
  eye: (typeof EYES)[number]
  /** Dónde señala el servidor los errores de este ojo: «refraccion.od», «lentes.od». */
  path: string
  draft: Pick<LensDraft, "base" | "prisma2" | "base2">
  disabled?: boolean
  errors: Errors
  onChange: (next: Pick<LensDraft, "base" | "prisma2" | "base2">) => void
}) {
  const id = `${idPrefix}-base-${eye.key}`
  const error = subFieldError(errors ?? undefined, `${path}.base`, id)
  const first = PRISM_BASES.find((item) => item.key === draft.base)
  const other = first ? PRISM_BASES.filter((item) => item.axis !== first.axis) : []
  const secondId = `${idPrefix}-prisma2-${eye.key}`
  const secondError = subFieldError(errors ?? undefined, `${path}.prisma2`, secondId)
  const baseTwoId = `${idPrefix}-base2-${eye.key}`
  const baseTwoError = subFieldError(errors ?? undefined, `${path}.base2`, baseTwoId)
  const axisOf = (key: string | undefined) => PRISM_BASES.find((item) => item.key === key)?.axis
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-xs text-muted-foreground">
        Base del prisma {eye.short}
      </span>
      <ChoiceButtons
        aria-labelledby={id}
        value={(draft.base as PrismBase | undefined) ?? null}
        options={PRISM_BASES.map((base) => ({ value: base.key, label: base.label }))}
        columns={2}
        disabled={disabled}
        invalid={error.invalid}
        aria-describedby={error.describedBy}
        onChange={(base) => onChange({ ...draft, base, ...(axisOf(draft.base2) === axisOf(base) ? { base2: undefined } : {}) })}
        onClear={() => onChange({ base: undefined, prisma2: undefined, base2: undefined })}
      />
      {error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null}
      {first ? (
        <div className="grid gap-2 sm:grid-cols-[9rem_1fr] sm:items-end">
          <Field data-invalid={secondError.invalid} className="gap-1">
            <FieldLabel htmlFor={secondId} className="text-xs text-muted-foreground">
              Otro prisma {eye.short} (Δ, opcional)
            </FieldLabel>
            <Input
              id={secondId}
              inputMode="decimal"
              autoComplete="off"
              value={draft.prisma2 ?? ""}
              disabled={disabled}
              aria-invalid={secondError.invalid}
              aria-describedby={secondError.describedBy}
              onChange={(event) =>
                onChange({ ...draft, prisma2: event.target.value, ...(event.target.value.trim() ? {} : { base2: undefined }) })
              }
            />
            {secondError.message ? <FieldError id={secondError.errorId}>{secondError.message}</FieldError> : null}
          </Field>
          {draft.prisma2?.trim() ? (
            <div className="flex flex-col gap-1">
              <span id={baseTwoId} className="text-xs text-muted-foreground">
                Su base, en el otro eje
              </span>
              <ChoiceButtons
                aria-labelledby={baseTwoId}
                value={(draft.base2 as PrismBase | undefined) ?? null}
                options={other.map((base) => ({ value: base.key, label: base.label }))}
                columns={2}
                disabled={disabled}
                invalid={baseTwoError.invalid}
                aria-describedby={baseTwoError.describedBy}
                onChange={(base2) => onChange({ ...draft, base2 })}
                onClear={() => onChange({ ...draft, base2: undefined })}
              />
              {baseTwoError.message ? <FieldError id={baseTwoError.errorId}>{baseTwoError.message}</FieldError> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const REFRACTION = [
  { key: "esfera", label: "Esfera", placeholder: "−1,25" },
  { key: "cilindro", label: "Cilindro", placeholder: "−0,50" },
  { key: "eje", label: "Eje", placeholder: "180" },
  { key: "adicion", label: "Adición", placeholder: "+2,00" },
] as const
const SPECTACLE = [{ key: "prisma", label: "Prisma (Δ)", placeholder: "" }] as const
const CONTACT = [
  { key: "curvaBase", label: "Curva base (mm)", placeholder: "8,6" },
  { key: "diametro", label: "Diámetro (mm)", placeholder: "14,2" },
  { key: "marca", label: "Marca", placeholder: "" },
] as const

/** La graduación de cada ojo para escribirla: la de anteojos con su prisma, la de contacto con curva base, diámetro y marca. */
export function LensFields({
  idPrefix,
  kind,
  value,
  onChange,
  errors,
  eyes = EYES,
  disabled = false,
}: {
  idPrefix: string
  kind: PrescriptionKind
  value: LensDrafts
  onChange: (next: LensDrafts) => void
  errors: Errors
  eyes?: ReadonlyArray<(typeof EYES)[number]>
  disabled?: boolean
}) {
  const columns = [...REFRACTION, ...(kind === "anteojos" ? SPECTACLE : CONTACT)]
  const setEye = (eye: Eye, next: LensDraft) => onChange({ ...value, [eye]: next })
  return (
    <div className="flex flex-col gap-4">
      {eyes.map((eye) => (
        <fieldset key={eye.key} className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">{eye.label}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {columns.map((column) => {
              const id = `${idPrefix}-${eye.key}-${column.key}`
              const error = subFieldError(errors ?? undefined, `lentes.${eye.key}.${column.key}`, id)
              return (
                <Field key={column.key} data-invalid={error.invalid} className="gap-1">
                  <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
                    {column.label} <span className="sr-only">{eye.label}</span>
                  </FieldLabel>
                  <Input
                    id={id}
                    inputMode={column.key === "marca" ? "text" : "decimal"}
                    autoComplete="off"
                    value={value[eye.key][column.key] ?? ""}
                    placeholder={column.placeholder}
                    disabled={disabled}
                    aria-invalid={error.invalid}
                    aria-describedby={error.describedBy}
                    onChange={(event) => {
                      const text = event.target.value
                      const next: LensDraft = { ...value[eye.key], [column.key]: text }
                      // Sin prisma no queda una base escondida.
                      if (column.key === "prisma" && !text.trim()) Object.assign(next, { base: undefined, prisma2: undefined, base2: undefined })
                      setEye(eye.key, next)
                    }}
                  />
                  {error.message ? <FieldError id={error.errorId}>{error.message}</FieldError> : null}
                </Field>
              )
            })}
          </div>
          {kind === "anteojos" && value[eye.key].prisma?.trim() ? (
            <PrismBases
              idPrefix={idPrefix}
              eye={eye}
              path={`lentes.${eye.key}`}
              draft={value[eye.key]}
              disabled={disabled}
              errors={errors}
              onChange={(next) => setEye(eye.key, { ...value[eye.key], ...next })}
            />
          ) : null}
          {errors?.[`lentes.${eye.key}`] ? <FieldError>{errors[`lentes.${eye.key}`]}</FieldError> : null}
        </fieldset>
      ))}
      {errors?.lentes ? <FieldError>{errors.lentes}</FieldError> : null}
    </div>
  )
}
