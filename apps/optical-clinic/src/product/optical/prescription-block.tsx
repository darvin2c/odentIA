import { apiFetch } from "@odentia/clinic-app/lib/api"
import type { EncounterBlockContext, ProductEncounterBlocks } from "@odentia/clinic-app/product/product-ui"
import { EYES, lensesFromExam, lensText, readEyeExam, refractionText } from "@odentia/optical"
import { Button, Field, FieldError, FieldLabel, Input, toast } from "@odentia/ui"
import { FormDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"

interface IssuedPrescription {
  id: string
  kind: "anteojos" | "contacto"
  encounterId: string | null
  voidedAt: string | null
  lenses: Record<"od" | "oi", Record<string, unknown> | undefined>
}

/** Los datos del lente de contacto que no salen de la refracción: curva base, diámetro y marca, por ojo. */
type ContactExtra = Record<"od" | "oi", { curvaBase: string; diametro: string; marca: string }>
const EMPTY_EXTRA: ContactExtra = {
  od: { curvaBase: "", diametro: "", marca: "" },
  oi: { curvaBase: "", diametro: "", marca: "" },
}

function decimalOf(text: string): number | string | undefined {
  const clean = text.trim().replace(",", ".")
  if (!clean) return undefined
  const value = Number(clean)
  return Number.isFinite(value) ? value : text
}

/**
 * «Receta de lentes» en la atención (entrega 3 del plan): con la refracción del
 * examen guardada, la de anteojos se emite con un toque; la de lentes de contacto
 * pide además su curva base, su diámetro y su marca. La firma quien lleva la
 * atención.
 */
export function usePrescriptionBlocks(ctx: EncounterBlockContext): ProductEncounterBlocks {
  const queryClient = useQueryClient()
  const exam = readEyeExam(ctx.detail.encounter.examination)
  const fromExam = lensesFromExam(exam?.refraccion)
  const [contactOpen, setContactOpen] = useState(false)
  const [extra, setExtra] = useState<ContactExtra>(EMPTY_EXTRA)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = ["lens-prescriptions", ctx.patientId] as const
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ data: { items: IssuedPrescription[] } }>(`/api/patients/${ctx.patientId}/lens-prescriptions`).then((body) => body.data),
    enabled: ctx.canRead,
  })
  const issued = (list.data?.items ?? []).filter((item) => item.encounterId === ctx.encounterId && !item.voidedAt)
  const issue = useMutation({
    mutationFn: async (kind: "anteojos" | "contacto") => {
      await ctx.flush()
      ctx.onPendingChange(true)
      const lenses =
        kind === "contacto" && fromExam
          ? Object.fromEntries(
              EYES.filter((eye) => fromExam[eye.key]).map((eye) => [
                eye.key,
                {
                  ...fromExam[eye.key],
                  curvaBase: decimalOf(extra[eye.key].curvaBase),
                  diametro: decimalOf(extra[eye.key].diametro),
                  marca: extra[eye.key].marca.trim() || undefined,
                },
              ]),
            )
          : undefined
      return apiFetch(`/api/patients/${ctx.patientId}/lens-prescriptions`, {
        method: "POST",
        body: JSON.stringify({ encounterId: ctx.encounterId, kind, ...(lenses ? { lenses } : {}) }),
      })
    },
    onSuccess: async (_result, kind) => {
      await queryClient.invalidateQueries({ queryKey: key })
      await ctx.onChanged()
      toast.success(kind === "anteojos" ? "Receta de anteojos emitida" : "Receta de lentes de contacto emitida")
      setContactOpen(false)
      setExtra(EMPTY_EXTRA)
    },
    onError: (cause: unknown) => {
      const fields = (cause as { fields?: Record<string, string> }).fields
      if (fields) setErrors(fields)
      else toast.error(submitErrorMessage(cause))
    },
    onSettled: () => ctx.onPendingChange(false),
  })
  const has = (kind: "anteojos" | "contacto") => issued.some((item) => item.kind === kind)
  const disabled = !ctx.canWrite || !ctx.writable || ctx.locked || issue.isPending
  const content = (
    <div className="flex flex-col gap-3">
      {fromExam ? (
        <dl className="grid grid-cols-[2.5rem_1fr] gap-x-2 gap-y-1 text-sm">
          {EYES.filter((eye) => fromExam[eye.key]).map((eye) => (
            <div key={eye.key} className="contents">
              <dt className="font-semibold">{eye.short}</dt>
              <dd className="tabular-nums">{refractionText(fromExam[eye.key])}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Anota la refracción en el examen de la vista y guárdala: de ahí sale la receta.</p>
      )}
      {issued.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {issued.map((item) => (
            <li key={item.id}>
              Emitida: {item.kind === "anteojos" ? "anteojos" : "lentes de contacto"} ·{" "}
              {EYES.filter((eye) => item.lenses[eye.key]).map((eye) => `${eye.short} ${lensText(item.lenses[eye.key] as never)}`).join(" · ")}
            </li>
          ))}
        </ul>
      ) : null}
      {ctx.canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={disabled || !fromExam || has("anteojos")} onClick={() => issue.mutate("anteojos")}>
            {has("anteojos") ? "Receta de anteojos emitida" : "Emitir receta de anteojos"}
          </Button>
          <Button type="button" variant="outline" disabled={disabled || !fromExam || has("contacto")} onClick={() => setContactOpen(true)}>
            {has("contacto") ? "Receta de lentes de contacto emitida" : "Emitir receta de lentes de contacto"}
          </Button>
        </div>
      ) : null}
    </div>
  )
  const overlay = (
    <FormDrawer
      open={contactOpen}
      onClose={() => setContactOpen(false)}
      title="Receta de lentes de contacto"
      description="La graduación es la de la refracción; agrega la curva base, el diámetro y la marca de cada ojo."
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        setErrors({})
        issue.mutate("contacto")
      }}
      isSubmitting={issue.isPending}
      isDirty={EYES.some((eye) => Object.values(extra[eye.key]).some(Boolean))}
      submitLabel="Emitir"
    >
      <div className="flex flex-col gap-4">
        {EYES.filter((eye) => fromExam?.[eye.key]).map((eye) => (
          <fieldset key={eye.key} className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">
              {eye.label}: {refractionText(fromExam?.[eye.key])}
            </legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  { key: "curvaBase", label: "Curva base (mm)", mode: "decimal" },
                  { key: "diametro", label: "Diámetro (mm)", mode: "decimal" },
                  { key: "marca", label: "Marca", mode: "text" },
                ] as const
              ).map((field) => {
                const id = `contacto-${eye.key}-${field.key}`
                const message = errors[`lentes.${eye.key}.${field.key}`]
                return (
                  <Field key={field.key} data-invalid={message ? true : undefined}>
                    <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
                      {field.label}
                    </FieldLabel>
                    <Input
                      id={id}
                      inputMode={field.mode}
                      value={extra[eye.key][field.key]}
                      aria-invalid={message ? true : undefined}
                      onChange={(event) =>
                        setExtra((all) => ({ ...all, [eye.key]: { ...all[eye.key], [field.key]: event.target.value } }))
                      }
                    />
                    {message ? <FieldError>{message}</FieldError> : null}
                  </Field>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </FormDrawer>
  )
  return {
    blocks: [
      {
        key: "receta-lentes",
        title: "Receta de lentes",
        description: "Sale de la refracción del examen de la vista.",
        summary: issued.length ? `${issued.length === 1 ? "1 receta emitida" : `${issued.length} recetas emitidas`}` : "",
        empty: false,
        content,
      },
    ],
    overlay,
  }
}
