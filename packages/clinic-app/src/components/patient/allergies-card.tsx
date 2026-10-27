import { appWords } from "../../lib/product-words"
import { ALLERGY_REMOVAL_REASONS } from "@odentia/clinical"
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldLabel,
  Textarea,
  toast,
} from "@odentia/ui"
import { FormDrawer, RowActions } from "@odentia/ui-patterns"
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Plus } from "lucide-react"
import { useId, useState } from "react"
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
import { ApiError } from "../../lib/api"
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

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
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
    onError: (error) => toast.error(errorText(error, "No se pudo volver a poner la alergia")),
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
    onError: (error) => toast.error(errorText(error, "No se pudo guardar la revisión")),
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
  const [choice, setChoice] = useState<AllergenChoice | null>(null)
  const [severity, setSeverity] = useState<SeverityChoice | null>(null)
  const [reaction, setReaction] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const reset = () => {
    setChoice(null)
    setSeverity(null)
    setReaction("")
    setErrors({})
    save.reset()
  }
  const save = useMutation({
    mutationFn: async () => {
      if (!choice) throw new Error("Elige la sustancia")
      if (coding) {
        if (choice.kind !== "entry") throw new Error("Elige la sustancia de la lista")
        return codeAllergyApi(patientId, coding.id, {
          substanceSystem: choice.entry.system,
          substanceCode: choice.entry.code,
        })
      }
      return addAllergyApi(patientId, {
        ...(choice.kind === "entry"
          ? { substanceSystem: choice.entry.system, substanceCode: choice.entry.code }
          : { substance: choice.text }),
        severity,
        reaction: reaction.trim() || null,
      })
    },
    onSuccess: async (result) => {
      await refresh(queryClient, patientId)
      toast.success(
        coding
          ? "Alergia elegida de la lista"
          : `Alergia a ${allergyPhrase(result.data)} registrada`,
      )
      reset()
      onClose()
    },
  })
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!choice) next[`${id}-substance`] = "Escribe la sustancia y elígela de la lista"
    if (!coding && !severity)
      next[`${id}-severity`] = "Elige qué tan fuerte fue; si no lo sabe, «No se sabe»"
    setErrors(next)
    if (Object.keys(next).length === 0) save.mutate()
  }
  const entry = choice?.kind === "entry" ? choice.entry : null
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (save.isPending) return
        reset()
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
      onSubmit={submit}
      isDirty={choice !== null || severity !== null || reaction.trim() !== ""}
      isSubmitting={save.isPending}
      error={save.isError ? errorText(save.error, save.error.message) : null}
      fieldErrors={errors}
      submitLabel="Guardar"
    >
      <div className="flex flex-col gap-5">
        <Field data-invalid={errors[`${id}-substance`] ? true : undefined}>
          <FieldLabel htmlFor={`${id}-substance`}>Sustancia</FieldLabel>
          <AllergenPicker
            id={`${id}-substance`}
            value={choice}
            onChange={setChoice}
            allowText={!coding}
            invalid={Boolean(errors[`${id}-substance`])}
            aria-describedby={`${id}-substance-help`}
          />
          <FieldDescription id={`${id}-substance-help`}>
            {entry
              ? `${allergyListDetail(entry)}: el aviso al recetar compara por su código.`
              : `Medicamentos y sus grupos (con su código ATC), ${appWords().examples.allergyOthers} y alimentos frecuentes.`}
          </FieldDescription>
          {errors[`${id}-substance`] ? (
            <p role="alert" className="text-sm text-destructive">
              {errors[`${id}-substance`]}
            </p>
          ) : null}
        </Field>
        {coding ? null : (
          <>
            <Field data-invalid={errors[`${id}-severity`] ? true : undefined}>
              <FieldLabel id={`${id}-severity`}>¿Qué tan fuerte fue la reacción?</FieldLabel>
              <ChoiceButtons
                label="Qué tan fuerte fue la reacción"
                value={severity}
                options={SEVERITY_OPTIONS}
                onChange={setSeverity}
                tone="primary"
              />
              <FieldDescription>
                Leve: picazón o ronchas · Moderada: hinchazón o vómitos · Severa: le costó respirar
                o tuvo un shock. «No se sabe» igual avisa.
              </FieldDescription>
              {errors[`${id}-severity`] ? (
                <p role="alert" className="text-sm text-destructive">
                  {errors[`${id}-severity`]}
                </p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-reaction`}>Qué le pasó (opcional)</FieldLabel>
              <Textarea
                id={`${id}-reaction`}
                value={reaction}
                maxLength={2000}
                placeholder="Por ejemplo, se le hinchó la cara y le costó respirar"
                onChange={(event) => setReaction(event.target.value)}
              />
            </Field>
          </>
        )}
      </div>
    </FormDrawer>
  )
}

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
  const [reason, setReason] = useState<ReasonChoice | null>(null)
  const [missing, setMissing] = useState(false)
  const remove = useMutation({
    mutationFn: (input: { allergy: Allergy; reason: ReasonChoice }) =>
      removeAllergyApi(patientId, input.allergy.id, input.reason),
    onSuccess: async (_result, input) => {
      await refresh(queryClient, patientId)
      toast.success(`Alergia a ${allergyPhrase(input.allergy)} quitada`, {
        action: { label: "Deshacer", onClick: () => restore.mutate(input.allergy) },
      })
      setReason(null)
      onClose()
    },
  })
  return (
    <FormDrawer
      open={allergy !== null}
      dock={false}
      onClose={() => {
        if (remove.isPending) return
        setReason(null)
        setMissing(false)
        remove.reset()
        onClose()
      }}
      title={allergy ? `Quitar la alergia a ${allergyPhrase(allergy)}` : "Quitar la alergia"}
      description="Dejará de avisar al recetar. No se borra: queda en «Alergias quitadas» y se puede volver a poner."
      onSubmit={(event) => {
        event.preventDefault()
        if (!allergy) return
        if (!reason) {
          setMissing(true)
          return
        }
        remove.mutate({ allergy, reason })
      }}
      isDirty={reason !== null}
      isSubmitting={remove.isPending}
      error={remove.isError ? errorText(remove.error, "No se pudo quitar la alergia") : null}
      submitLabel="Quitar alergia"
    >
      <Field data-invalid={missing && !reason ? true : undefined}>
        <FieldLabel id={`${id}-reason`}>¿Por qué?</FieldLabel>
        <ChoiceButtons
          label="Por qué se quita"
          value={reason}
          options={REASON_OPTIONS}
          onChange={(next) => {
            setReason(next)
            setMissing(false)
          }}
          tone="primary"
        />
        {missing && !reason ? (
          <p role="alert" className="text-sm text-destructive">
            Elige por qué se quita.
          </p>
        ) : null}
      </Field>
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
    onError: (error) => toast.error(errorText(error, "No se pudo guardar la revisión")),
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
    onError: (error) => toast.error(errorText(error, "No se pudo guardar la revisión")),
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
    </span>
  )
}
