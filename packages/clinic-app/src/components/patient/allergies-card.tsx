import { appWords } from "../../lib/product-words"
import { ALLERGY_REMOVAL_REASONS } from "@odentia/clinical"
import { Button, cn, Collapsible, CollapsibleContent, CollapsibleTrigger, toast } from "@odentia/ui"
import { FormDrawer, RowActions, submitErrorMessage, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Plus } from "lucide-react"
import { useId, useState } from "react"
import { z } from "zod"
import {
  allergyDay,
  allergyEntry,
  allergyListDetail,
  allergyName,
  allergyPhrase,
  allergyTitle,
  bySeverity,
  REMOVAL_REASON_LABELS,
  sinceWords,
} from "../../lib/allergies"
import { useMemberName, usePermission } from "../../lib/crm"
import {
  type Allergy,
  addAllergyApi,
  codeAllergyApi,
  markAllergiesReviewedApi,
  type PatientHealth,
  removeAllergyApi,
  restoreAllergyApi,
} from "../../lib/patients"
import { ChoiceButtons } from "../choice-buttons"
import { type AllergenChoice, AllergenPicker } from "./allergen-picker"

/**
 * Alergias una por una (issue 43, tablero 7 del lienzo de Pacientes): la lista
 * con su origen, «Agregar alergia» con tres datos, «Quitar» con motivo (solo
 * quien escribe en la historia; no se borra: queda en «Alergias quitadas») y
 * «Elegir de la lista» para lo escrito a mano. Las reglas son del servidor.
 */

const SEVERITY_OPTIONS = [
  { value: "leve", label: "Leve" },
  { value: "moderada", label: "Moderada" },
  { value: "severa", label: "Severa" },
  { value: "desconocida", label: "No se sabe" },
] as const
type SeverityChoice = (typeof SEVERITY_OPTIONS)[number]["value"]

const REASON_OPTIONS = ALLERGY_REMOVAL_REASONS.map((value) => ({
  value,
  label: REMOVAL_REASON_LABELS[value] ?? value,
}))
type ReasonChoice = (typeof ALLERGY_REMOVAL_REASONS)[number]

/** Lo que falló en una acción de un solo botón, junto a ese botón (también dentro de un texto en línea). */
function ActionError({ error }: { error: unknown }) {
  return error ? (
    <span role="alert" className="block w-full text-sm text-destructive">
      {submitErrorMessage(error)}
    </span>
  ) : null
}

async function refresh(queryClient: QueryClient, patientId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["patient-health", patientId] }),
    queryClient.invalidateQueries({ queryKey: ["patient", patientId] }),
    queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
  ])
}

/** Volver a ponerla, también desde el «Deshacer» del aviso. */
function useRestoreAllergy(patientId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (allergy: Allergy) => restoreAllergyApi(patientId, allergy.id),
    onSuccess: async (_result, allergy) => {
      await refresh(queryClient, patientId)
      toast.success(`Alergia a ${allergyPhrase(allergy)} puesta otra vez`)
    },
    // También se llama desde el «Deshacer» del aviso: el fallo se dice en otro aviso.
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
}

/** Quién la dijo y cuándo: «Registrada por la Dra. Ana · 3 oct», «La declaró el paciente · 17 oct». */
function useOriginText(): (allergy: Allergy) => string {
  const memberName = useMemberName()
  return (allergy) => {
    const day = allergy.createdAt ? ` · ${allergyDay(allergy.createdAt)}` : ""
    if (allergy.source === "paciente") return `La declaró el paciente${day}`
    return allergy.createdBy
      ? `Registrada por ${memberName(allergy.createdBy)}${day}`
      : `Registrada${day}`
  }
}

export function AllergiesCard({
  patientId,
  patientName,
  health,
}: {
  patientId: string
  patientName: string
  health: PatientHealth
}) {
  const titleId = useId()
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
  const originText = useOriginText()
  const restore = useRestoreAllergy(patientId)
  const [adding, setAdding] = useState(false)
  const [coding, setCoding] = useState<Allergy | null>(null)
  const [removing, setRemoving] = useState<Allergy | null>(null)
  const queryClient = useQueryClient()
  const noneReviewed = useMutation({
    mutationFn: () => markAllergiesReviewedApi(patientId),
    onSuccess: async () => {
      await refresh(queryClient, patientId)
      toast.success("Anotado: no tiene alergias")
    },
  })
  const active = health.allergies.filter((allergy) => allergy.isActive).sort(bySeverity)
  const removed = health.allergies.filter((allergy) => !allergy.isActive)
  const reviewed = health.allergiesReviewedAt
    ? `Revisadas${health.allergiesReviewedBy ? ` por ${memberName(health.allergiesReviewedBy)}` : ""} · ${allergyDay(health.allergiesReviewedAt)}`
    : "Nadie las revisó todavía con el paciente"
  return (
    <section
      aria-labelledby={titleId}
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="font-heading text-base font-medium">
            Alergias
          </h3>
          <p className="text-sm text-muted-foreground">{reviewed}</p>
        </div>
        {canWrite ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Agregar alergia
          </Button>
        ) : null}
      </div>
      {active.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {health.reviewStatus.allergies === "none"
              ? "No tiene alergias: se le preguntó."
              : health.reviewStatus.allergies === "recorded"
                ? "Sin alergias vigentes."
                : "Aún no se le preguntó si tiene alergias."}
          </p>
          {/* Sin preguntar, la respuesta más común queda a un toque, como en la atención. */}
          {canWrite && health.reviewStatus.allergies === "unknown" ? (
            <Button type="button" size="sm" variant="outline" disabled={noneReviewed.isPending} onClick={() => noneReviewed.mutate()}>
              {noneReviewed.isPending ? "Guardando…" : "No tiene alergias"}
            </Button>
          ) : null}
          <ActionError error={noneReviewed.error} />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((allergy) => {
            const entry = allergyEntry(allergy)
            return (
              <li key={allergy.id} className="flex items-start gap-3 rounded-lg border px-3 py-2">
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    entry ? "bg-destructive" : "bg-muted-foreground",
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-sm font-medium">
                    {allergyTitle(allergy)}
                    {entry ? null : (
                      <span className="font-normal text-muted-foreground"> · sin codificar</span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {[allergy.reaction, originText(allergy)].filter(Boolean).join(" · ")}
                  </p>
                  {entry ? null : (
                    <p className="text-xs text-muted-foreground">
                      Escrita a mano: al recetar solo avisa si se escribe igual. Elígela de la lista
                      para que avise por su grupo.
                    </p>
                  )}
                </div>
                {canWrite && !entry ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setCoding(allergy)}
                  >
                    Elegir de la lista
                  </Button>
                ) : null}
                {canWrite ? (
                  <RowActions
                    label={`Más acciones de la alergia a ${allergyName(allergy)}`}
                    items={[
                      {
                        key: "quitar",
                        label: "Quitar",
                        tone: "danger",
                        onSelect: () => setRemoving(allergy),
                      },
                    ]}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {removed.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="group w-fit px-2 text-muted-foreground"
              >
                <ChevronRight
                  aria-hidden
                  className="transition-transform group-data-[panel-open]:rotate-90"
                />
                Alergias quitadas · {removed.length}
              </Button>
            }
          />
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col gap-2">
              {removed.map((allergy) => (
                <li
                  key={allergy.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-sm font-medium">{allergyName(allergy)}</p>
                    <p className="text-sm text-muted-foreground">
                      {[
                        allergy.removedAt
                          ? `Quitada${allergy.removedBy ? ` por ${memberName(allergy.removedBy)}` : ""} el ${allergyDay(allergy.removedAt)}`
                          : "Quitada",
                        allergy.removedReason
                          ? `«${REMOVAL_REASON_LABELS[allergy.removedReason] ?? allergy.removedReason}»`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {canWrite ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(allergy)}
                    >
                      Volver a ponerla
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <AllergyFormDrawer
        patientId={patientId}
        patientName={patientName}
        open={adding}
        onClose={() => setAdding(false)}
      />
      <AllergyFormDrawer
        patientId={patientId}
        patientName={patientName}
        coding={coding}
        open={coding !== null}
        onClose={() => setCoding(null)}
      />
      <RemoveAllergyDrawer
        patientId={patientId}
        allergy={removing}
        onClose={() => setRemoving(null)}
      />
    </section>
  )
}

/** Lo mismo que piden `/health/allergies` y `/code`, con las palabras del cajón. */
function allergySchema(coding: boolean) {
  return z
    .object({
      substance: z.custom<AllergenChoice | null>(),
      severity: z.custom<SeverityChoice | "">((value) => typeof value === "string"),
      reaction: z.string().max(2000, "Escribe como mucho 2000 caracteres."),
    })
    .superRefine((value, ctx) => {
      const substance = value.substance
      if (!substance || (coding && substance.kind !== "entry"))
        ctx.addIssue({
          code: "custom",
          path: ["substance"],
          message: coding ? "Elige la sustancia de la lista" : "Escribe la sustancia y elígela de la lista",
        })
      else if (substance.kind === "text" && substance.text.trim().length > 200)
        ctx.addIssue({ code: "custom", path: ["substance"], message: "La sustancia debe tener hasta 200 caracteres" })
      if (!coding && !value.severity)
        ctx.addIssue({
          code: "custom",
          path: ["severity"],
          message: "Elige qué tan fuerte fue; si no lo sabe, «No se sabe»",
        })
    })
}

/**
 * «Nueva alergia»: la sustancia de la lista (el tipo de alérgeno sale de ahí),
 * qué tan fuerte fue la reacción y, opcional, qué le pasó. Con `coding`,
 * «Elegir de la lista» para una escrita a mano: solo la sustancia.
 */
export function AllergyFormDrawer({
  patientId,
  patientName,
  coding = null,
  open,
  onClose,
}: {
  patientId: string
  patientName: string
  coding?: Allergy | null
  open: boolean
  onClose: () => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const form = useAppForm({
    defaultValues: { substance: null as AllergenChoice | null, severity: "" as SeverityChoice | "", reaction: "" },
    validators: { onSubmit: allergySchema(coding !== null) },
    onSubmit: async ({ value }) => {
      const choice = value.substance
      if (!choice) return
      if (coding) {
        if (choice.kind !== "entry") return
        await codeAllergyApi(patientId, coding.id, {
          substanceSystem: choice.entry.system,
          substanceCode: choice.entry.code,
        })
        await refresh(queryClient, patientId)
        toast.success("Alergia elegida de la lista")
      } else {
        const result = await addAllergyApi(patientId, {
          ...(choice.kind === "entry"
            ? { substanceSystem: choice.entry.system, substanceCode: choice.entry.code }
            : { substance: choice.text }),
          severity: value.severity || null,
          reaction: value.reaction.trim() || null,
        })
        await refresh(queryClient, patientId)
        toast.success(`Alergia a ${allergyPhrase(result.data)} registrada`)
      }
      form.reset()
      onClose()
    },
  })
  // La sustancia va de la lista o escrita: el servidor la nombra por cualquiera de los dos.
  const surface = useFormSurface(form, { fieldMap: { substanceSystem: "substance", substanceCode: "substance" } })
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        if (surface.isSubmitting) return
        form.reset()
        onClose()
      }}
      title={
        coding ? `Elegir de la lista · «${coding.substance}»` : `Nueva alergia · ${patientName}`
      }
      description={
        coding
          ? "Elige la sustancia que quiso decir. Lo que se escribió se conserva."
          : "Se anota solo quién la registró y cuándo."
      }
      submitLabel="Guardar"
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="substance">
          {(field) => {
            const entry = field.state.value?.kind === "entry" ? field.state.value.entry : null
            return (
              <field.Control
                id={`${id}-substance`}
                label="Sustancia"
                description={
                  entry
                    ? `${allergyListDetail(entry)}: el aviso al recetar compara por su código.`
                    : `Medicamentos y sus grupos (con su código ATC), ${appWords().examples.allergyOthers} y alimentos frecuentes.`
                }
              >
                {(control) => (
                  <AllergenPicker
                    id={control.id}
                    value={field.state.value}
                    onChange={(next) => field.handleChange(next)}
                    allowText={!coding}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                  />
                )}
              </field.Control>
            )
          }}
        </form.AppField>
        {coding ? null : (
          <>
            <form.AppField name="severity">
              {(field) => (
                <field.Group
                  legend="¿Qué tan fuerte fue la reacción?"
                  description="Leve: picazón o ronchas · Moderada: hinchazón o vómitos · Severa: le costó respirar o tuvo un shock. «No se sabe» igual avisa."
                >
                  {(control) => (
                    <ChoiceButtons
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      value={field.state.value || null}
                      options={SEVERITY_OPTIONS}
                      onChange={(next) => field.handleChange(next)}
                      tone="primary"
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
            <form.AppField name="reaction">
              {(field) => (
                <field.TextareaField
                  id={`${id}-reaction`}
                  label="Qué le pasó (opcional)"
                  maxLength={2000}
                  placeholder="Por ejemplo, se le hinchó la cara y le costó respirar"
                />
              )}
            </form.AppField>
          </>
        )}
      </div>
    </FormDrawer>
  )
}

const removeSchema = z.object({
  reason: z.custom<ReasonChoice | "">((value) => typeof value === "string").refine(
    (value) => value !== "",
    "Elige por qué se quita.",
  ),
})

/**
 * «Quitar» la alergia, con su motivo. Siempre en cajón (quita algo que avisa):
 * hay que decidir antes de seguir. Después, el aviso ofrece «Deshacer».
 */
function RemoveAllergyDrawer({
  patientId,
  allergy,
  onClose,
}: {
  patientId: string
  allergy: Allergy | null
  onClose: () => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const restore = useRestoreAllergy(patientId)
  const form = useAppForm({
    defaultValues: { reason: "" as ReasonChoice | "" },
    validators: { onSubmit: removeSchema },
    onSubmit: async ({ value }) => {
      if (!allergy || !value.reason) return
      await removeAllergyApi(patientId, allergy.id, value.reason)
      await refresh(queryClient, patientId)
      toast.success(`Alergia a ${allergyPhrase(allergy)} quitada`, {
        action: { label: "Deshacer", onClick: () => restore.mutate(allergy) },
      })
      form.reset()
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open={allergy !== null}
      dock={false}
      onClose={() => {
        if (surface.isSubmitting) return
        form.reset()
        onClose()
      }}
      title={allergy ? `Quitar la alergia a ${allergyPhrase(allergy)}` : "Quitar la alergia"}
      description="Dejará de avisar al recetar. No se borra: queda en «Alergias quitadas» y se puede volver a poner."
      submitLabel="Quitar alergia"
    >
      <form.AppField name="reason">
        {(field) => (
          <field.Group id={`${id}-reason`} legend="¿Por qué?">
            {(control) => (
              <ChoiceButtons
                id={control.id}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                value={field.state.value || null}
                options={REASON_OPTIONS}
                onChange={(next) => field.handleChange(next)}
                tone="primary"
              />
            )}
          </field.Group>
        )}
      </form.AppField>
    </FormDrawer>
  )
}

/**
 * En la atención (tablero 7): si nunca se revisaron sus alergias o pasaron 6
 * meses, pide preguntarle por alergias nuevas. «Sin cambios» lo deja dicho
 * con quién y cuándo; agregar o quitar una también cuenta. Sin el aviso las
 * alergias se ven igual, en la franja de la atención.
 */
export function AllergyReviewNotice({
  patientId,
  patientName,
  health,
  disabled = false,
}: {
  patientId: string
  patientName: string
  health: PatientHealth
  disabled?: boolean
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("clinical.write")
  const memberName = useMemberName()
  const [adding, setAdding] = useState(false)
  const reviewed = useMutation({
    mutationFn: () => markAllergiesReviewedApi(patientId),
    onSuccess: async () => {
      await refresh(queryClient, patientId)
      toast.success("Alergias revisadas")
    },
  })
  if (!canWrite || !health.allergyReviewDue) return null
  const active = health.allergies.filter((allergy) => allergy.isActive).sort(bySeverity)
  const asked = active.length > 0 || health.reviewStatus.allergies === "none"
  const first = patientName.trim().split(/\s+/)[0] ?? patientName
  return (
    <section
      aria-label="Revisar sus alergias"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">
          {asked
            ? `Pregúntale a ${first} si tiene alergias nuevas`
            : `Pregúntale a ${first} si tiene alergias`}
        </p>
        <p className="text-sm text-muted-foreground">
          {health.allergiesReviewedAt
            ? `Última revisión ${sinceWords(health.allergiesReviewedAt)}${health.allergiesReviewedBy ? `, por ${memberName(health.allergiesReviewedBy)}` : ""}.`
            : "Nadie las revisó todavía con el paciente."}
        </p>
      </div>
      {active.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {active.map((allergy) => (
            <li key={allergy.id} className="rounded-full border bg-background px-3 py-1 text-sm">
              {allergyTitle(allergy)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled || reviewed.isPending}
          onClick={() => reviewed.mutate()}
        >
          {reviewed.isPending ? "Guardando…" : asked ? "Sin cambios" : "No tiene alergias"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden />
          Agregar alergia
        </Button>
      </div>
      <ActionError error={reviewed.error} />
      <AllergyFormDrawer
        patientId={patientId}
        patientName={patientName}
        open={adding}
        onClose={() => setAdding(false)}
      />
    </section>
  )
}

/**
 * «Alergias: no preguntado» en el Resumen: lo mismo que la atención, ahí mismo.
 * «No tiene alergias» lo deja dicho; «Agregar alergia» abre su cajón. Antes el
 * botón llevaba a la pestaña Antecedentes y había que pulsarlo otra vez.
 */
export function AllergyQuickActions({ patientId, patientName }: { patientId: string; patientName: string }) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const reviewed = useMutation({
    mutationFn: () => markAllergiesReviewedApi(patientId),
    onSuccess: async () => {
      await refresh(queryClient, patientId)
      toast.success("Anotado: no tiene alergias")
    },
  })
  return (
    <span className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={reviewed.isPending} onClick={() => reviewed.mutate()}>
        {reviewed.isPending ? "Guardando…" : "No tiene alergias"}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
        <Plus aria-hidden />
        Agregar alergia
      </Button>
      <AllergyFormDrawer patientId={patientId} patientName={patientName} open={adding} onClose={() => setAdding(false)} />
      <ActionError error={reviewed.error} />
    </span>
  )
}
