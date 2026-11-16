import { canAttend } from "@odentia/auth/permissions"
import { Badge, Button, cn, FieldGroup, FieldLegend, FieldSeparator, FieldSet, toast } from "@odentia/ui"
import {
  AgentMark,
  addSubmitErrors,
  applySubmitError,
  ConfirmDialog,
  clearSubmitErrors,
  DetailDrawer,
  focusFirstInvalid,
  FormDrawer,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useDraftSaved,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useStore } from "@tanstack/react-form"
import { Link } from "@tanstack/react-router"
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import {
  addFormAddendum,
  discardFormResponse,
  FORM_RESPONSE_STATUS_LABELS,
  type FormResponse,
  type FormSchemaDef,
  type FormTemplate,
  fetchFormAddenda,
  finalizedWords,
  finalizeFormResponse,
  startFormResponse,
  sectionTotal,
  updateFormResponse,
  writesForm,
} from "../../lib/clinical-forms"
import { useMemberName, useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import { appWords } from "../../lib/product-words"
import { DeclaredResponse } from "./declared-response"
import { X } from "lucide-react"
import { CLINICAL_NAME } from "../../lib/agent-names"
import { ChoiceButtons } from "../choice-buttons"
import { answersWords, changesWritten, choicesOf, proposalsOf, proposedWords, proposesValue, useClioFormProposals } from "./clio-form-proposals"
import type { DictationSuggestion } from "./dictation-session"
import type { PatientDocument } from "../../lib/patients"
import { imageTypeLabel } from "./document-labels"
import {
  AnswerAppField,
  AnswerLabel,
  type AttachmentOption,
  answerSpan,
  isAsideNote,
  answersForServer,
  isEmptyAnswer,
  isFieldVisible,
  missingRequired,
  sameWords,
} from "./form-fields"
import { templateOptionLabel } from "../../lib/form-templates"
import { answersFromPrevious, answerWords, defaultResponsible, draftOf, newFormSubmitWords, reusableAnswer } from "../../lib/consultation-forms"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(activeOrgLocale(), { dateStyle: "medium" }) : "—"

/** «13 nov 2026, 9:51 p. m.», en la hora de la clínica. */
/** Cuándo fue la anterior: la que quedó a medias, el día que se firmó su atención, y se dice. */
const previousWhen = (form: Pick<FormResponse, "status" | "finalizedAt" | "encounterFinalizedAt" | "updatedAt">) =>
  form.status === "finalizado" ? when(form.finalizedAt) : `${when(form.encounterFinalizedAt ?? form.updatedAt)}, a medias`

const whenAt = (value: string) =>
  new Date(value).toLocaleString(activeOrgLocale(), { dateStyle: "medium", timeStyle: "short", timeZone: activeOrgTimeZone() })

function statusOf(response: FormResponse): {
  label: string
  tone: "default" | "secondary" | "outline"
} {
  return {
    label: FORM_RESPONSE_STATUS_LABELS[response.status],
    tone:
      response.status === "finalizado"
        ? "default"
        : response.status === "descartado"
          ? "outline"
          : "secondary",
  }
}

const newResponseSchema = z.object({
  templateId: z.string().min(1, "Elige la ficha."),
  professionalUserId: z.string(),
})

export function NewResponseDrawer({
  open,
  onClose,
  templates,
  patientId,
  encounterId,
  defaultProfessionalUserId,
  loading = false,
  drafts = [],
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** En el orden en que se ofrecen: desde la atención, primero los de su especialidad. */
  templates: FormTemplate[]
  patientId: string
  encounterId?: string
  /** Desde la atención, el responsable por defecto es quien atiende. */
  defaultProfessionalUserId?: string
  /** Mientras llegan las fichas en uso: sin ellas todavía no se dice que no hay ninguna. */
  loading?: boolean
  /** Las fichas a medias de esta atención: elegir una de ellas la abre, en vez de empezar otra igual. */
  drafts?: ReadonlyArray<Pick<FormResponse, "id" | "templateId" | "templateTitle" | "status" | "source">>
  onCreated: (id: string) => Promise<void>
}) {
  // Solo quien puede atender responde por un formulario; quien llevó la atención y ya no atiende no se propone.
  const responsibles = useOrgMembers().filter((member) => canAttend(member.role))
  const me = useMyUserId()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (value: z.infer<typeof newResponseSchema>) =>
      // Si la atención ya no está en curso, se empieza igual sin unirlo a ella (`detached`).
      startFormResponse({
        templateId: value.templateId,
        patientId,
        encounterId: encounterId ?? null,
        professionalUserId: value.professionalUserId || null,
        answers: {},
      }),
  })
  const form = useAppForm({
    defaultValues: {
      templateId: "",
      professionalUserId: defaultResponsible(defaultProfessionalUserId, me, responsibles),
    },
    validators: { onSubmit: newResponseSchema },
    onSubmit: async ({ value }) => {
      // La que ya está a medias se abre: una ficha a medias se ve una sola vez.
      const chosen = templates.find((template) => template.id === value.templateId)
      const open = chosen ? draftOf(chosen, drafts) : null
      if (open) {
        form.reset()
        await onCreated(open)
        return
      }
      const result = await create.mutateAsync(value)
      form.reset()
      if (result.detached) {
        // La pantalla tenía un dato viejo (la atención se firmó o se anuló en otra pestaña): se
        // dice lo que pasó y se vuelve a pedir todo, para que deje de ofrecer esa atención.
        toast.info(
          "La atención ya no está en curso: la ficha de consulta se empezó suelta y quedó en Documentos, en la página del paciente.",
          { duration: 10_000 },
        )
        void queryClient.invalidateQueries()
      }
      await onCreated(result.data.id)
    },
  })
  const surface = useFormSurface(form)
  // Si la elegida ya está a medias, el botón dice lo que hace: la abre.
  const chosenId = useStore(form.store, (state) => state.values.templateId)
  // Sin ninguna ficha en uso no se abre una lista vacía: se dice dónde se crean.
  if (open && !loading && templates.length === 0) return <NoFormsDrawer onClose={onClose} />
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        form.reset()
        onClose()
      }}
      title="Nueva ficha"
      description="Se ofrece la versión en uso de cada ficha. Se guarda sola mientras la llenas."
      submitLabel={newFormSubmitWords(chosenId, templates, drafts)}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="templateId">
          {(field) => (
            <field.SelectField
              label="Ficha"
              placeholder="Elige la ficha"
              // Dos formularios con el mismo título llevan lo que los distingue: preguntas y fecha.
              options={templates.map((t) => ({
                value: t.id,
                label: `${templateOptionLabel(t, templates, whenAt)}${draftOf(t, drafts) ? " · a medias: se abre la que empezaste" : ""}`,
              }))}
            />
          )}
        </form.AppField>
        <form.AppField name="professionalUserId">
          {(field) => (
            <field.SelectField
              label="Profesional responsable"
              options={[
                { value: "", label: "Sin asignar" },
                ...responsibles.map((m) => ({ value: m.userId, label: m.user.name })),
              ]}
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

/** «Nuevo › Ficha» sin ninguna en uso: dónde se crean, y el camino si se puede abrir Configuración. */
function NoFormsDrawer({ onClose }: { onClose: () => void }) {
  const canSettings = usePermission("settings.read")
  return (
    <DetailDrawer open title="Nueva ficha" description="Aún no tienes fichas en uso." onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Las fichas se crean y se ajustan en Configuración › Fichas de consulta. Ahí también están las que vienen con{" "}
          {appWords().name}, si las dejaste de usar.
        </p>
        {canSettings ? (
          <Link
            to="/settings/consultation-forms"
            className="w-fit font-medium text-primary underline-offset-4 hover:underline"
          >
            Ir a Fichas de consulta
          </Link>
        ) : (
          <p className="text-muted-foreground">Pídeselo a quien administra la clínica.</p>
        )}
      </div>
    </DetailDrawer>
  )
}

/** La pregunta de la anterior con la misma clave, si la tenía. */
function previousField(previous: FormResponse, id: string) {
  for (const section of previous.templateSnapshot.sections) {
    const field = section.fields.find((item) => item.id === id)
    if (field) return field
  }
  return null
}

/** `parcial`: se guardó todo menos las respuestas que no valen, que siguen marcadas en su pregunta. */
type SaveState = "guardado" | "pendiente" | "guardando" | "error" | "parcial"

/**
 * Lo que no se guardó, para cuando la pantalla ya no está para decirlo en su pregunta. Cada
 * motivo ya dice qué quedó guardado en su lugar (lo arma el servidor).
 */
function rejectedWords(rejected: Record<string, string>): string {
  return `${Object.values(rejected).join(" ")} Lo demás quedó guardado.`
}

/** Una respuesta dicha tal cual, si es corta; `null` si no cabe en una frase. */
function shownValue(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "number") return String(value)
  if (typeof value === "string" && value.trim() && value.trim().length <= 40) return value.trim()
  return null
}

/**
 * Lo que se pierde al salir, en palabras de quien decide: «No se guardó «15» en «Intensidad del
 * dolor (0–10)». Lo demás ya está guardado.» `pending`: además hay un cambio que aún no se guardó
 * y que «Descartar y salir» tampoco guardará.
 */
export function lostWords(lost: Array<{ label: string; value: unknown }>, pending: boolean): string {
  const parts = lost.map(({ label, value }) => {
    const shown = shownValue(value)
    return shown === null ? `lo que escribiste en «${label}»` : `«${shown}» en «${label}»`
  })
  const what =
    parts.length === 1
      ? `No se guardó ${parts[0]}.`
      : `No se guardaron ${parts.slice(0, -1).join(", ")} ni ${parts.at(-1)}.`
  return `${what} ${pending ? "Tampoco lo último que cambiaste, que aún no se guardaba." : "Lo demás ya está guardado."}`
}

const SAVE_FAILED_WORDS = "Tus últimos cambios no se guardaron. Si sales, se pierden."

/**
 * Para finalizar, cada obligatoria visible tiene respuesta: lo que falta se
 * dice en su pregunta (la misma regla que el servidor al cerrar).
 */
function finalizeSchema(schema: FormSchemaDef) {
  return z.object({ answers: z.record(z.string(), z.unknown()) }).superRefine((value, ctx) => {
    for (const field of missingRequired(schema, value.answers)) {
      ctx.addIssue({
        code: "custom",
        path: ["answers", field.id],
        message: "Responde esta pregunta para finalizar.",
      })
    }
  })
}

const discardSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Indica el motivo del descarte.")
    .max(2000, "El motivo admite hasta 2000 caracteres."),
})

const addendumSchema = z.object({
  text: z.string().trim().min(1, "Escribe la adenda.").max(5000, "La adenda admite hasta 5000 caracteres."),
})

/**
 * El detalle de una respuesta. Lo que respondió el paciente se lee y se corrige
 * aparte (`DeclaredResponse`): nunca se edita; lo del equipo se llena aquí.
 */
export function ResponseDetail({
  response,
  previous: latest = null,
  first = null,
  canWrite,
  sex,
  encounterId,
  onChanged,
}: {
  response: FormResponse
  /** La anterior del mismo tipo, ya finalizada: su respuesta va debajo de cada pregunta de la de hoy. */
  previous?: FormResponse | null
  /** La de inicio, si no es la anterior: «Comparar con: Anterior · Inicio». */
  first?: FormResponse | null
  canWrite: boolean
  /** El sexo registrado del paciente, para decir quién lo dijo. */
  sex?: string | null
  /** La atención en curso desde la que se abre: lo que se revise ahí queda ligado a ella. */
  encounterId?: string
  onChanged: () => Promise<void>
}) {
  if (response.source === "portal")
    return (
      <DeclaredResponse response={response} canWrite={canWrite} sex={sex} encounterId={encounterId} onChanged={onChanged} />
    )
  return <StaffResponseDetail response={response} previous={latest} first={first} canWrite={canWrite} onChanged={onChanged} />
}

/**
 * «Descartar borrador»: con su motivo, que queda en la traza (`form_response.discard`). La misma
 * operación desde la ficha abierta y desde su fila en «Fichas para esta atención».
 */
export function DiscardFormDialog({
  responseId,
  onClose,
  onDiscarded,
}: {
  responseId: string
  onClose: () => void
  onDiscarded: () => Promise<void>
}) {
  const discard = useMutation({
    mutationFn: (reason: string) => discardFormResponse(responseId, reason),
  })
  const discardForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: discardSchema },
    onSubmit: async ({ value }) => {
      await discard.mutateAsync(value.reason.trim())
      onClose()
      toast.success("Borrador descartado")
      await onDiscarded()
    },
  })
  const discardError = useFormSubmitError(discardForm)
  const discarding = useStore(discardForm.store, (state) => state.isSubmitting)
  return (
    <ConfirmDialog
      open
      title="Descartar borrador"
      description="No cuenta como registro clínico y ya no se podrá editar. Queda la traza con el motivo."
      confirmLabel="Descartar"
      pending={discarding}
      error={discardError}
      onClose={onClose}
      onConfirm={() => void submitForm(discardForm)}
    >
      {/* El motivo acompaña a «Descartar»: escribirlo no es un cambio del formulario que se pierda al salir. */}
      <div data-draft-ignore>
        <discardForm.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo" aria-required="true" maxLength={2000} />}
        </discardForm.AppField>
      </div>
    </ConfirmDialog>
  )
}

/** «ceod: 6», debajo de la sección que lleva total. */
function SectionTotal({ words }: { words: string | null }) {
  return words ? (
    <p className="text-sm font-medium" aria-live="polite">
      {words}
    </p>
  ) : null
}

/** Otra pestaña o persona guardó esta ficha mientras se escribía. */
const isStale = (error: unknown) => error instanceof ApiError && error.shape.code === "STALE_DRAFT"

/** Las marcas de Clío que siguen valiendo tras guardar: la pregunta cambiada a mano ya es de la persona. */
function marksKept(before: FormResponse, after: FormResponse): FormResponse["clioAccepted"] {
  const same = (id: string) => JSON.stringify(before.answers?.[id] ?? null) === JSON.stringify(after.answers?.[id] ?? null)
  return Object.fromEntries(Object.entries(after.clioAccepted ?? before.clioAccepted ?? {}).filter(([id]) => same(id)))
}

function StaffResponseDetail({
  response,
  previous: latest = null,
  first = null,
  canWrite,
  onChanged,
}: {
  response: FormResponse
  /** La anterior del mismo tipo, ya finalizada: su respuesta va debajo de cada pregunta de la de hoy. */
  previous?: FormResponse | null
  /** La de inicio, si no es la anterior: «Comparar con: Anterior · Inicio». */
  first?: FormResponse | null
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const queryClient = useQueryClient()
  // Con qué se compara: la anterior, o la de inicio en un tratamiento largo.
  const [against, setAgainst] = useState<"anterior" | "inicio">("anterior")
  const fromStart = against === "inicio" && !!first
  const previous = fromStart ? first : latest
  const memberName = useMemberName()
  const schema = response.templateSnapshot
  // La ficha de una atención la llena quien la lleva (o tomó el relevo): los demás la leen.
  const leads = writesForm(response, useMyUserId())
  const editable = response.status === "borrador" && canWrite && leads
  // Dentro de una atención en curso, la ficha se cierra con la firma.
  const inAttention = response.encounterId !== null && response.encounterStatus === "borrador"
  const articleRef = useRef<HTMLElement | null>(null)
  const [saveState, setSaveState] = useState<SaveState>("guardado")
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  // Los textos largos opcionales que se abrieron con «+ Observaciones».
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set())
  // Cambios sin guardar: `version` cuenta cada cambio y `saved` el último guardado.
  const version = useRef(0)
  const saved = useRef(0)
  // Las respuestas como quedaron guardadas: viajan como base del próximo guardado.
  const savedAnswers = useRef<Record<string, unknown>>(response.answers ?? {})
  // Un solo guardado a la vez: el siguiente sale con la base que dejó el anterior.
  const inFlight = useRef<Promise<void> | null>(null)
  /** Lo guardado deja al día la lista: al reabrir el formulario se parte de lo último. */
  const remember = (updated: FormResponse) =>
    queryClient.setQueryData<{ data: FormResponse[] }>(["form-responses", response.patientId], (old) =>
      old ? { ...old, data: old.data.map((row) => (row.id === updated.id ? { ...row, ...updated, clioAccepted: marksKept(row, updated) } : row)) } : old,
    )
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Si el último guardado falló: el autoguardado corre con el estado de su render, que
  // ya dice «pendiente» por el cambio que lo disparó, así que el fallo se recuerda aquí.
  const saveFailed = useRef(false)
  // Lo que el último guardado no aceptó (`answers.<id>` → por qué): sigue en pantalla, sin guardar.
  const rejected = useRef<Record<string, string>>({})
  // El valor que se mandó en cada una de esas preguntas: mientras siga ahí, es lo que se pierde.
  const rejectedValues = useRef<Record<string, unknown>>({})
  // Las preguntas que cambiaron desde el último guardado que salió.
  const changed = useRef(new Set<string>())
  // «Descartar y salir»: lo que estaba por guardarse ya no se guarda al cerrarse.
  const discarded = useRef(false)
  const draftSaved = useDraftSaved({
    onDiscard: () => {
      discarded.current = true
      clearTimeout(timer.current ?? undefined)
    },
  })

  const validators = useMemo(() => ({ onSubmit: finalizeSchema(schema) }), [schema])
  // Los valores de partida, una sola vez: rehechos en cada render, el formulario los tomaba como
  // nuevos con la ficha sin tocar, y lo confirmado de Clío dejaba atrás la base del próximo
  // guardado (409 `STALE_DRAFT`, y la respuesta siguiente no se guardaba).
  const [defaultValues] = useState(() => ({ answers: { ...response.answers } as Record<string, unknown> }))
  const form = useAppForm({
    defaultValues,
    validators,
    listeners: {
      onChange: ({ fieldApi }) => {
        version.current += 1
        changed.current.add(fieldApi.name)
        typedHere.current.add(fieldApi.name.replace(/^answers\./, ""))
        setSaveState("pendiente")
      },
    },
    // «Finalizar…»: con todo respondido y guardado, se pide la confirmación.
    onSubmit: async () => {
      const unsaved = await persist()
      // Una respuesta que no vale no se finaliza a medias: se corrige antes, en su pregunta.
      if (Object.keys(unsaved).length > 0) throw new ApiError(400, { fields: unsaved })
      setFinalizeOpen(true)
    },
  })
  const answers = useStore(form.store, (state) => state.values.answers)
  const formError = useFormSubmitError(form)
  // «Usar lo de la anterior»: lo que respondió en cada pregunta que hoy sigue vacía.
  const fromPrevious = editable && previous ? answersFromPrevious(response, previous, answers, isEmptyAnswer) : {}
  const copyPrevious = () => {
    const entries = Object.entries(fromPrevious)
    for (const [id, value] of entries) form.setFieldValue(`answers.${id}`, value)
    setAnnouncement(entries.length === 1 ? "Se copió 1 respuesta de la anterior." : `Se copiaron ${entries.length} respuestas de la anterior.`)
    focusAfter(null)
  }

  // Lo que propuso Clío al dictar (entrega 11, forma B): se confirma aquí, en cada pregunta.
  const clio = useClioFormProposals()
  const proposals = editable ? proposalsOf(clio, response.id) : []
  // Lo que se confirma junto; lo que cambia lo escrito a mano se decide de a una, en su pregunta.
  const readyProposals = proposals.filter((item) => item.status === "lista")
  const valued = proposals.filter(proposesValue)
  const overWritten = valued.filter(changesWritten).length
  const proposalFor = (fieldId: string) => proposals.find((item) => item.payload["fieldId"] === fieldId) ?? null
  // Las preguntas que se escribieron en este panel: si otra persona respondió otra, el descarte lo dice.
  const typedHere = useRef(new Set<string>())
  // Las propuestas cuyo descarte ya salió: el efecto no lo manda dos veces mientras llega.
  const discardSent = useRef(new Set<string>())
  // Ocupado desde el primer toque: guardar lo escrito antes de confirmar también cuenta.
  const [confirming, setConfirming] = useState(false)
  // Lo que oye el lector de pantalla: cuándo llegan propuestas y cuándo se confirmaron.
  const [announcement, setAnnouncement] = useState("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando llegan propuestas nuevas.
  useEffect(() => {
    if (valued.length > 0) setAnnouncement(`${CLINICAL_NAME} propone ${answersWords(valued.length)} en esta ficha.`)
  }, [valued.length])
  const busy = confirming || !!clio?.busy
  /** Lo que se escribe o elige en una pregunta de esta ficha. */
  const fieldControl = (fieldId: string) =>
    articleRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(fieldId)}"] :is(input, textarea, button, [role="combobox"])`) ?? null
  // «Usar en Percusión» de «No pude usar esto»: lo dictado va al lado de su pregunta mientras siga
  // vacía, y el foco va a ella. No llena nada: la respuesta la elige o la escribe la persona.
  const hint = editable && clio?.hint?.responseId === response.id ? clio.hint : null
  const hintFor = (fieldId: string) => (hint?.fieldId === fieldId && isEmptyAnswer(answers[fieldId]) ? hint : null)
  useEffect(() => {
    if (!hint) return
    const focus = () => {
      const control = fieldControl(hint.fieldId)
      if (!control || control.closest("[data-field]")?.contains(document.activeElement)) return
      control.scrollIntoView?.({ block: "center" })
      control.focus()
    }
    const frame = requestAnimationFrame(focus)
    // El cajón pone el foco al abrirse: cuando termina, vuelve a la pregunta.
    const later = setTimeout(focus, 300)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(later)
    }
  }, [hint])
  /** Tras confirmar o descartar el botón desaparece: el foco vuelve a la pregunta, o a la ficha. */
  const focusAfter = (fieldId: string | null) =>
    requestAnimationFrame(() => {
      ;((fieldId ? fieldControl(fieldId) : null) ?? articleRef.current)?.focus()
    })
  // Respondida a mano, la pregunta ya es de la persona: lo que proponía Clío ahí se descarta solo,
  // y no aparece después en «Firmar la atención». Si la respondió otra persona, se dice qué quedó.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando cambian las respuestas guardadas o lo propuesto.
  useEffect(() => {
    if (!clio || busy) return
    const saved = (response.answers ?? {}) as Record<string, unknown>
    for (const item of proposals) {
      const fieldId = String(item.payload["fieldId"])
      const value = saved[fieldId]
      // Con el mismo valor es la que se acaba de confirmar; con el que corrige, la pregunta sigue
      // diciendo lo que Clío vio («Ya dice…»): esas no se tocan.
      const same = (other: unknown) => JSON.stringify(value) === JSON.stringify(other ?? null)
      const correcting = item.payload["replaces"] !== undefined && same(item.payload["replaces"])
      if (isEmptyAnswer(value) || same(item.payload["value"]) || correcting || discardSent.current.has(item.id)) continue
      discardSent.current.add(item.id)
      clio.discard(item)
      if (proposesValue(item) && !typedHere.current.has(fieldId)) {
        const field = schema.sections.flatMap((section) => section.fields).find((candidate) => candidate.id === fieldId)
        toast(`${CLINICAL_NAME} proponía «${proposedWords(item)}» en «${field?.label ?? "una pregunta"}»; quedó «${proposedWords({ ...item, payload: { ...item.payload, value } })}», que escribió otra persona.`)
      }
    }
  }, [response.answers, proposals.length])
  // El segundo toque llega antes de que el botón se vea ocupado: la ref lo frena en el acto.
  const confirmingRef = useRef(false)
  const accept = async (items: DictationSuggestion[]) => {
    if (!clio || confirmingRef.current) return
    confirmingRef.current = true
    setConfirming(true)
    // Lo que se confirma ahora es de Clío: su marca se ve aunque antes se haya tocado la pregunta.
    for (const item of items) typedHere.current.delete(String(item.payload["fieldId"]))
    try {
      // Lo escrito aquí sale antes: así lo confirmado no lo pisa ni choca con su guardado.
      await persist()
      await clio.accept(items)
      setAnnouncement(items.length === 1 ? "Confirmada." : `Confirmadas las ${items.length}.`)
      focusAfter(items.length === 1 ? String(items[0]?.payload["fieldId"]) : null)
    } catch (error) {
      if (isStale(error)) setStale(true)
      toast.error(submitErrorMessage(error))
    } finally {
      confirmingRef.current = false
      setConfirming(false)
    }
  }
  /**
   * «¿Cuál?»: la persona elige una de las opciones entre las que Clío dudaba. La respuesta queda
   * escrita por ella, como si la hubiera tocado en la pregunta, y la duda se descarta con lo que
   * eligió: así queda la constancia de que Clío había dudado. Clío no decide nada.
   */
  const choose = async (item: DictationSuggestion, fieldId: string, label: string, value: string) => {
    if (!clio || confirmingRef.current) return
    confirmingRef.current = true
    setConfirming(true)
    typedHere.current.add(fieldId)
    discardSent.current.add(item.id)
    try {
      form.setFieldValue(`answers.${fieldId}`, value)
      await persist()
      clio.discard(item, value)
      setAnnouncement(`Guardaste «${value}» en «${label}».`)
      focusAfter(fieldId)
    } catch (error) {
      discardSent.current.delete(item.id)
      if (isStale(error)) setStale(true)
      toast.error(submitErrorMessage(error))
    } finally {
      confirmingRef.current = false
      setConfirming(false)
    }
  }
  const discardProposal = (item: DictationSuggestion) => {
    if (!clio) return
    discardSent.current.add(item.id)
    clio.discard(item)
    setAnnouncement("Propuesta descartada.")
    focusAfter(String(item.payload["fieldId"]))
    // Como los demás «Deshacer» de la app: tiempo para leerlo y volver atrás.
    toast(proposesValue(item) ? `Descartaste lo que proponía ${CLINICAL_NAME}: «${proposedWords(item)}».` : "Descartaste el aviso de esa pregunta.", {
      duration: 10_000,
      action: {
        label: "Deshacer",
        onClick: () => {
          discardSent.current.delete(item.id)
          clio.restore(item)
        },
      },
    })
  }
  // Lo que entró a la ficha desde fuera de este panel (lo aceptado de Clío, aquí o en la barra del
  // dictado) se adopta en las preguntas que aquí nadie tocó: así no aparece «Otra pestaña guardó…».
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando cambian las respuestas guardadas.
  useEffect(() => {
    const server = (response.answers ?? {}) as Record<string, unknown>
    for (const [id, value] of Object.entries(server)) {
      const base = savedAnswers.current[id] ?? null
      if (JSON.stringify(value ?? null) === JSON.stringify(base)) continue
      const mine = JSON.stringify(form.state.values.answers[id] ?? null)
      // Ya está en pantalla (lo confirmado de Clío): solo se pone al día la base del guardado.
      const shown = mine === JSON.stringify(value ?? null)
      if (!shown && mine !== JSON.stringify(base)) continue
      const wasSaved = version.current === saved.current
      savedAnswers.current = { ...savedAnswers.current, [id]: value }
      if (!shown) form.setFieldValue(`answers.${id}`, value, { dontRunListeners: true })
      // Ya está guardado en el servidor: no es un cambio por guardar.
      if (wasSaved) {
        saved.current = version.current
        changed.current.delete(`answers.${id}`)
        setSaveState("guardado")
      }
    }
  }, [response.answers])

  // El aviso de «salir sin guardar» (×, Escape y el menú) sale solo si algo se pierde de verdad:
  // lo pendiente se guarda al cerrarse, así que no cuenta. Se pierde lo que el servidor no aceptó
  // (mientras siga escrito) o lo que no se pudo guardar.
  const lostAnswers = Object.keys(rejected.current).flatMap((name) => {
    const id = name.replace(/^answers\./, "")
    const field = schema.sections.flatMap((section) => section.fields).find((f) => f.id === id)
    const value = rejectedValues.current[name]
    return field && JSON.stringify(answers[id] ?? null) === JSON.stringify(value ?? null) ? [{ label: field.label, value }] : []
  })
  const lostNames = new Set(Object.keys(rejected.current))
  const pendingElse = [...changed.current].some((name) => !lostNames.has(name))
  const lost =
    !editable
      ? null
      : saveState === "error"
        ? SAVE_FAILED_WORDS
        : lostAnswers.length > 0
          ? lostWords(lostAnswers, pendingElse && (saveState === "pendiente" || saveState === "guardando"))
          : null
  // Se dice en cada cambio, no solo cuando cambia lo que se pierde: así la columna no cuenta como
  // «sin guardar» las teclas de lo que se guardará solo al cerrarse.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answers` y `saveState` marcan cada cambio.
  useEffect(() => draftSaved(lost === null, lost), [draftSaved, lost, answers, saveState])

  const documentsQuery = useQuery({
    queryKey: ["patient-documents", response.patientId, "activos"],
    queryFn: () =>
      apiFetch<{ data: PatientDocument[] }>(`/api/patients/${response.patientId}/documents`),
    enabled: editable && schema.sections.some((s) => s.fields.some((f) => f.type === "adjunto")),
  })
  const attachments: AttachmentOption[] = (documentsQuery.data?.data ?? []).map((d) => ({
    id: d.id,
    label: `${d.label} · ${imageTypeLabel(d.imageType) ?? d.category}`,
  }))

  /**
   * Guarda lo pendiente; si el servidor lo rechaza, lanza su error. Devuelve las respuestas que
   * no valen (un «15» en una escala de 0 a 10): esas no se guardaron y las demás sí.
   */
  const persist = async (): Promise<Record<string, string>> => {
    clearTimeout(timer.current ?? undefined)
    // Si hay uno en curso se espera: el siguiente sale con la base al día.
    while (inFlight.current) await inFlight.current.catch(() => {})
    const target = version.current
    if (target === saved.current) return rejected.current
    setSaveState("guardando")
    const sent = { ...form.state.values.answers }
    const sentNames = [...changed.current]
    changed.current.clear()
    const run = (async () => {
      try {
        const updated = await updateFormResponse(response.id, {
          answers: answersForServer(schema, sent),
          // De qué respuestas guardadas partió: si otra pestaña guardó otras, se avisa en vez de pisarlas.
          baseAnswers: savedAnswers.current,
        })
        const { rejected: unsaved = {}, ...row } = updated.data
        rejected.current = unsaved
        rejectedValues.current = Object.fromEntries(
          Object.keys(unsaved).map((name) => [name, sent[name.replace(/^answers\./, "")]]),
        )
        savedAnswers.current = row.answers ?? {}
        remember(row)
        saved.current = target
        saveFailed.current = false
        setSaveState(version.current !== target ? "pendiente" : Object.keys(unsaved).length > 0 ? "parcial" : "guardado")
      } catch (error) {
        for (const name of sentNames) changed.current.add(name)
        setSaveState("error")
        saveFailed.current = true
        throw error
      }
    })()
    inFlight.current = run
    try {
      await run
    } finally {
      if (inFlight.current === run) inFlight.current = null
    }
    return rejected.current
  }
  // Guardado automático 1,2 s después del último cambio: lo que el servidor
  // rechaza se dice en su pregunta (`answers.<id>`) o junto a los botones.
  const autosave = () => {
    // Mientras se decide «¿Salir sin guardar?» (o cualquier otra pregunta) no se guarda:
    // «Descartar y salir» no debe encontrar guardado lo que descarta. Al seguir aquí, se guarda.
    if (document.querySelector('[role="alertdialog"]')) {
      timer.current = setTimeout(autosave, 500)
      return
    }
    const failedBefore = saveFailed.current
    persist()
      .then((unsaved) => {
        // Lo que no vale se marca en su pregunta, sin borrar las marcas de lo que falta responder;
        // cada aviso se va solo al corregir su pregunta.
        if (Object.keys(unsaved).length > 0) addSubmitErrors(form, unsaved)
        else if (failedBefore) clearSubmitErrors(form)
      })
      .catch((error: unknown) => {
        if (isStale(error)) setStale(true)
        applySubmitError(form, error)
      })
  }
  // Otra pestaña o persona guardó mientras se escribía: se trae lo último y lo escrito aquí se queda.
  const [stale, setStale] = useState(false)
  const bringLatest = async () => {
    await onChanged()
    const latest = queryClient.getQueryData<{ data: FormResponse[] }>(["form-responses", response.patientId])?.data.find((row) => row.id === response.id)
    if (!latest) return
    const server = (latest.answers ?? {}) as Record<string, unknown>
    for (const [id, value] of Object.entries(server)) {
      if (!changed.current.has(`answers.${id}`)) form.setFieldValue(`answers.${id}`, value, { dontRunListeners: true })
    }
    savedAnswers.current = server
    setStale(false)
    clearSubmitErrors(form)
    // Lo escrito aquí sale de nuevo, ahora sobre lo último.
    version.current += 1
    autosave()
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: guarda al cambiar respuestas; `autosave` se rehace en cada render.
  useEffect(() => {
    if (version.current === saved.current || !editable) return
    clearTimeout(timer.current ?? undefined)
    timer.current = setTimeout(autosave, 1200)
    return () => {
      clearTimeout(timer.current ?? undefined)
    }
  }, [answers])
  // Al cambiar de formulario o salir, se guarda lo pendiente; si falla, se avisa
  // (la pantalla ya no está para decirlo junto a la pregunta). Con «Descartar y salir», no.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al desmontar; lee el borrador vigente al salir.
  useEffect(
    () => () => {
      if (discarded.current) return
      const title = response.templateTitle ?? "la ficha"
      // Primero termina el guardado en curso; después, si aún falta algo, sale con la base que dejó.
      void (async () => {
        while (inFlight.current) await inFlight.current.catch(() => {})
        if (discarded.current) return
        // Lo que no valía se queda sin guardar: se dice al salir, ya sin su pregunta a la vista.
        const warn = (unsaved: Record<string, string>) => {
          if (Object.keys(unsaved).length > 0)
            toast.warning(`«${title}»: ${rejectedWords(unsaved)}`, { description: "Vuelve a abrirlo para corregirlas." })
        }
        if (version.current === saved.current) return warn(rejected.current)
        try {
          const updated = await updateFormResponse(response.id, {
            answers: answersForServer(schema, form.state.values.answers),
            baseAnswers: savedAnswers.current,
          })
          const { rejected: unsaved = {}, ...row } = updated.data
          remember(row)
          warn(unsaved)
        } catch (error) {
          toast.error(`No se guardaron los últimos cambios de «${title}». ${submitErrorMessage(error)}`, {
            description: "Vuelve a abrirlo y revisa las respuestas.",
          })
        }
      })()
    },
    [],
  )

  const finalize = useMutation({ mutationFn: () => finalizeFormResponse(response.id) })
  const confirmFinalize = () => {
    finalize
      .mutateAsync()
      .then(async () => {
        setFinalizeOpen(false)
        toast.success("Ficha finalizada")
        await onChanged()
      })
      .catch((error: unknown) => {
        // Lo que falte o esté mal se dice en su pregunta, ya sin el diálogo delante.
        setFinalizeOpen(false)
        applySubmitError(form, error)
        focusFirstInvalid(articleRef.current)
      })
  }

  const addendaQuery = useQuery({
    queryKey: ["form-addenda", response.id],
    queryFn: () => fetchFormAddenda(response.id),
    enabled: response.status === "finalizado",
  })
  const addAddendum = useMutation({
    mutationFn: (text: string) => addFormAddendum(response.id, text),
  })
  const addendumRef = useRef<HTMLDivElement | null>(null)
  const addendumForm = useAppForm({
    defaultValues: { text: "" },
    validators: { onSubmit: addendumSchema },
    onSubmit: async ({ value }) => {
      await addAddendum.mutateAsync(value.text.trim())
      addendumForm.reset()
      draftSaved(true)
      await queryClient.invalidateQueries({ queryKey: ["form-addenda", response.id] })
      toast.success("Adenda registrada")
    },
  })
  const addendumError = useFormSubmitError(addendumForm)
  const addingAddendum = useStore(addendumForm.store, (state) => state.isSubmitting)
  const status = statusOf(response)

  return (
    // Sin otra tarjeta dentro del panel: su título ya es el de la ficha; aquí, quién y en qué versión.
    // Lo que recibe el foco deja sitio abajo para el pie pegado: no queda tapado por «Descartar borrador…».
    <article
      ref={articleRef}
      tabIndex={-1}
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-6 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&_:is(input,textarea,button,[role=combobox],[role=radio])]:scroll-mb-20"
    >
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`${ids}-title`} className="sr-only">
            {response.templateTitle ?? "Ficha"} · versión {response.templateVersion}
          </h3>
          <p className="text-sm text-muted-foreground">
            Versión {response.templateVersion} ·{" "}
            {response.professionalUserId ? memberName(response.professionalUserId) : "Sin profesional asignado"}
            {/* Quién lo finalizó, con fecha y hora: lo terminado después de firmar la atención lleva la suya, y se ve. */}
            {response.finalizedAt
              ? ` · ${finalizedWords(response, whenAt, response.finalizedBy ? memberName(response.finalizedBy) : null)}`
              : ""}
            {response.encounterStatus === "anulada" ? " · de una atención anulada" : ""}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={status.tone}>{status.label}</Badge>
          {editable ? (
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {saveState === "guardando"
                ? "Guardando…"
                : saveState === "pendiente"
                  ? "Cambios sin guardar"
                  : saveState === "error"
                    ? "No se guardó"
                    : saveState === "parcial"
                      ? "Guardado, menos lo marcado"
                      : "Guardado"}
            </span>
          ) : null}
        </span>
      </header>
      {response.status === "borrador" && canWrite && !leads ? (
        <p className="rounded-md bg-muted p-3 text-sm">
          La llena quien lleva la atención
          {response.encounterProfessionalUserId ? ` (${memberName(response.encounterProfessionalUserId)})` : ""}. Cuando la
          finalice, puedes agregarle una adenda.
        </p>
      ) : null}
      {response.status === "descartado" ? (
        <p className="rounded-md bg-muted p-3 text-sm">
          Descartado {when(response.discardedAt)} · {response.discardReason}
        </p>
      ) : null}
      {first && latest ? (
        <div role="group" aria-label="Comparar con" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Comparar con:</span>
          {(["anterior", "inicio"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={against === option ? "default" : "outline"}
              className="min-h-11 sm:min-h-8"
              aria-pressed={against === option}
              onClick={() => setAgainst(option)}
            >
              {option === "anterior" ? `Anterior · ${when(latest.finalizedAt)}` : `Inicio · ${when(first.finalizedAt)}`}
            </Button>
          ))}
        </div>
      ) : null}
      {previous ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3 text-sm">
          <p>
            Debajo de cada pregunta, {fromStart ? "lo de la de inicio" : "lo de la anterior"}:{" "}
            {previousWhen(previous)}
            {previous.professionalUserId ? ` · ${memberName(previous.professionalUserId)}` : " · sin profesional asignado"}.
          </p>
          {/* Copia de un toque lo de la anterior en lo que hoy sigue vacío; lo escrito hoy no se toca. */}
          {editable && Object.keys(fromPrevious).length > 0 ? (
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={copyPrevious}>
              Usar lo de {fromStart ? "la de inicio" : "la anterior"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {proposals.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
          <span className="flex items-start gap-2">
            <AgentMark size="sm" />
            <span>
              {valued.length > 0 ? (
                <>
                  <strong>
                    {CLINICAL_NAME} propone {answersWords(valued.length)}
                  </strong>{" "}
                  de lo que dictaste. {valued.length === 1 ? "No entra hasta que la confirmes." : "Ninguna entra hasta que la confirmes."}
                  {overWritten > 0
                    ? ` ${overWritten === 1 ? "Una cambia" : `${overWritten} cambian`} lo que ya estaba escrito: ${overWritten === 1 ? "decídela" : "decídelas"} en su pregunta.`
                    : ""}
                </>
              ) : (
                <>
                  {CLINICAL_NAME} no pudo llenar {proposals.length === 1 ? "1 pregunta: elige tú." : `${proposals.length} preguntas: elige tú en cada una.`}
                </>
              )}
            </span>
          </span>
          {readyProposals.length > 1 ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={busy}
              onClick={() => void accept(readyProposals)}
            >
              Confirmar las {readyProposals.length}
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* Cada sección de la ficha es un grupo con su título; lo corto va de a pares y, en el teléfono, en una columna. */}
      <FieldGroup className="gap-6">
        {schema.sections.map((section, sectionIndex) => {
          const shown = section.fields.filter((field) => isFieldVisible(field, answers))
          // La pregunta que se llama como su sección («Hábitos» › «Hábitos»): el título ya la nombra.
          const twin = shown.find((field) => sameWords(field.label, section.title)) ?? null
          return (
            <Fragment key={section.id}>
              {sectionIndex > 0 ? <FieldSeparator /> : null}
              <FieldSet className="gap-4">
                <FieldLegend>
                  {twin ? <AnswerLabel field={{ ...twin, label: section.title }} /> : section.title}
                </FieldLegend>
                <div className="grid grid-cols-1 items-start gap-x-4 gap-y-6 @md:grid-cols-2">
          {shown.map((field) => {
              // Por la clave de la pregunta: una versión nueva de la ficha conserva las que no cambió.
              const before = previous ? previousField(previous, field.id) : null
              // Lo poco frecuente se pliega: «Observaciones» vacía, sin propuesta de Clío ni respuesta
              // en la anterior, queda en «+ Observaciones» hasta que se abre.
              const folded =
                editable &&
                isAsideNote(field) &&
                !unfolded.has(field.id) &&
                isEmptyAnswer(answers[field.id]) &&
                !proposalFor(field.id) &&
                !(before && !isEmptyAnswer(previous?.answers?.[field.id]))
              if (folded)
                return (
                  <div key={field.id} className={cn("flex", answerSpan(field))} data-field={field.id}>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11 sm:min-h-8"
                      onClick={() => {
                        setUnfolded((open) => new Set(open).add(field.id))
                        const focusOpened = () => {
                          const opened = articleRef.current?.querySelector<HTMLElement>(
                            `[data-field="${CSS.escape(field.id)}"] textarea`,
                          )
                          if (!opened || document.activeElement === opened) return
                          opened.focus()
                          // El foco solo lo asoma: el campo entero, a la vista.
                          opened.scrollIntoView({ block: "nearest" })
                        }
                        requestAnimationFrame(focusOpened)
                        // En el cajón del teléfono, el botón que desaparece devuelve el foco al cajón
                        // después del primer intento: se pone otra vez en el campo.
                        setTimeout(focusOpened, 100)
                      }}
                    >
                      + {field.label}
                    </Button>
                  </div>
                )
              return (
                <form.AppField key={field.id} name={`answers.${field.id}`}>
                  {(answerField) => {
                    const earlier = previous?.answers?.[field.id]
                    // «Usar»: copia la respuesta anterior a la de hoy con un clic (la pieza, la clase…); nada se copia solo.
                    const reusable = editable && before ? reusableAnswer(field, before, earlier) : undefined
                    const beforeId = `${ids}-antes-${field.id}`
                    const said = hintFor(field.id)
                    const saidId = `${ids}-dictado-${field.id}`
                    const proposal = proposalFor(field.id)
                    const changes = proposal ? changesWritten(proposal) : false
                    const valued = proposal ? proposesValue(proposal) : false
                    // Entre cuáles opciones dudó Clío: se eligen aquí con un toque.
                    const choices = proposal && !valued ? choicesOf(proposal) : []
                    const late = response.afterSigning?.[field.id]
                    // Lo aceptado de Clío, mientras siga siendo eso: si se cambia a mano, ya es de la persona.
                    const mark = response.clioAccepted?.[field.id]
                    const marked = mark && JSON.stringify(answers[field.id] ?? null) === JSON.stringify(response.answers?.[field.id] ?? null) && !typedHere.current.has(field.id)
                    return (
                      <div className={cn("flex min-w-0 flex-col gap-2", answerSpan(field))} data-field={field.id}>
                        <AnswerAppField
                          field={field}
                          hideLabel={field === twin}
                          disabled={!editable}
                          attachments={attachments}
                          // La respuesta anterior y lo dictado se oyen al llegar a la pregunta, no solo se ven.
                          describedBy={[previous && before ? beforeId : null, said ? saidId : null].filter(Boolean).join(" ") || undefined}
                        />
                        {said ? (
                          <div className="flex flex-wrap items-center justify-between gap-1 rounded-lg bg-agent-soft px-2 py-1 text-sm">
                            <span id={saidId} className="min-w-0 [overflow-wrap:anywhere]">
                              <strong>Dictaste:</strong> «{said.said}». Elige o escribe la respuesta.
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11 sm:size-8"
                              aria-label={`Quitar lo dictado de «${field.label}»`}
                              onClick={() => {
                                clio?.clearHint()
                                focusAfter(field.id)
                              }}
                            >
                              <X className="size-4" aria-hidden />
                            </Button>
                          </div>
                        ) : null}
                        {proposal ? (
                          <div
                            role="group"
                            aria-label={`Propuesta de ${CLINICAL_NAME} para «${field.label}»`}
                            className={`flex flex-wrap items-center justify-between gap-1 rounded-lg px-2 py-1 text-sm ${valued ? "bg-agent-soft" : "bg-muted"}`}
                          >
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                              {changes ? (
                                <>
                                  {/* Cambia lo ya escrito: dice lo que hay y lo que dijo; lo decide quien escribió, de a una. */}
                                  <strong>{CLINICAL_NAME} propone:</strong> {proposedWords(proposal)} · ya dice «
                                  {proposedWords({ ...proposal, payload: { ...proposal.payload, value: proposal.payload["replaces"] } })}»
                                  {proposal.sourceText ? `; dijiste «${proposal.sourceText}»` : ""}.
                                </>
                              ) : proposal.status === "lista" || valued ? (
                                <>
                                  {/* La de la segunda lectura también propone un valor, pero por revisar: se dice. */}
                                  <strong>{CLINICAL_NAME} propone{proposal.status === "lista" ? "" : ", revísala"}:</strong> {proposedWords(proposal)}
                                  {proposal.sourceText ? ` · dijiste «${proposal.sourceText}»` : ""}
                                </>
                              ) : (
                                <>
                                  <strong>{CLINICAL_NAME} no la llenó:</strong> {proposal.note ?? "elige tú."}
                                </>
                              )}
                            </span>
                            {choices.length >= 2 ? (
                              <span className="order-last flex basis-full flex-wrap items-center gap-2 pb-1">
                                <span aria-hidden className="font-medium">
                                  ¿Cuál?
                                </span>
                                <ChoiceButtons
                                  aria-label={`¿Cuál? ${field.label}`}
                                  value={null}
                                  options={choices.map((choice) => ({ value: choice, label: choice }))}
                                  // En celdas iguales: las opciones largas se parten en dos líneas y caben a 390 px.
                                  columns={choices.length <= 4 ? (Math.max(2, choices.length) as 2 | 3 | 4) : undefined}
                                  className="min-w-0 flex-1"
                                  onChange={(value) => void choose(proposal, field.id, field.label, value)}
                                  disabled={busy}
                                />
                              </span>
                            ) : null}
                            <span className="flex items-center gap-1">
                              {valued ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={changes ? "outline" : "default"}
                                  className="min-h-11 sm:min-h-8"
                                  aria-label={
                                    changes
                                      ? `Cambiar «${field.label}» a ${proposedWords(proposal)}`
                                      : `Confirmar ${proposedWords(proposal)} en «${field.label}»`
                                  }
                                  disabled={busy}
                                  onClick={() => void accept([proposal])}
                                >
                                  {changes ? `Cambiar a ${proposedWords(proposal)}` : "Confirmar"}
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-11 sm:size-8"
                                aria-label={`Descartar la propuesta de ${CLINICAL_NAME} para «${field.label}»`}
                                disabled={busy}
                                onClick={() => discardProposal(proposal)}
                              >
                                <X className="size-4" aria-hidden />
                              </Button>
                            </span>
                          </div>
                        ) : null}
                        {marked ? (
                          <p className="text-xs text-muted-foreground">
                            {CLINICAL_NAME} · {mark.atSign ? "confirmó al firmar" : "confirmó"} {mark.by ? memberName(mark.by) : "alguien del equipo"}, {whenAt(mark.at)}
                          </p>
                        ) : null}
                        {/* Cambiada con la atención ya firmada: queda dicho en su pregunta, con quién y cuándo. */}
                        {late ? (
                          <p className="text-xs text-muted-foreground">
                            Respondida después de firmar la atención: {late.by ? memberName(late.by) : "alguien del equipo"}, {whenAt(late.at)}
                          </p>
                        ) : null}
                        {previous && before ? (
                          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span id={beforeId}>
                              {previousWhen(previous)}: {answerWords(before, earlier)}
                            </span>
                            {reusable !== undefined ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="link"
                                className="h-auto min-h-8 p-0 text-xs"
                                aria-label={`Usar la respuesta anterior en «${field.label}»: ${answerWords(before, earlier)}`}
                                onClick={() => answerField.handleChange(reusable)}
                              >
                                Usar
                              </Button>
                            ) : null}
                          </p>
                        ) : null}
                      </div>
                    )
                  }}
                </form.AppField>
              )
            })}
                </div>
                <SectionTotal words={sectionTotal(section, answers)} />
              </FieldSet>
            </Fragment>
          )
        })}
      </FieldGroup>
      {formError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {formError}
          {stale ? (
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void bringLatest()}>
              Traer lo último sin perder lo tuyo
            </Button>
          ) : null}
        </p>
      ) : null}
      {/* El pie de la ficha: pegado abajo del panel, siempre a la vista, y después de las preguntas al
          recorrerla con el teclado (arriba era la primera parada). En una atención en curso la ficha se
          cierra con la firma, sin otro cierre (revisión final del 15 nov): lo dice la descripción del
          panel. Suelta o después de firmar, «Finalizar…». */}
      {editable ? (
        <div className="sticky bottom-0 z-10 -mx-6 -mb-4 flex flex-wrap items-center justify-between gap-2 border-t bg-card px-6 py-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11 sm:min-h-8"
            onClick={() => setDiscardOpen(true)}
          >
            Descartar borrador…
          </Button>
          {inAttention ? null : (
            <Button type="button" onClick={() => void submitForm(form, { root: articleRef.current })}>
              Finalizar…
            </Button>
          )}
        </div>
      ) : null}
      {response.status === "finalizado" ? (
        <section aria-label="Adendas" className="flex flex-col gap-2 border-t pt-3">
          <h4 className="text-sm font-semibold">Adendas</h4>
          {(addendaQuery.data?.data ?? []).length === 0 && !addendaQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Sin adendas.</p>
          ) : null}
          {(addendaQuery.data?.data ?? []).map((item) => (
            <div key={item.id} className="rounded-md border p-2 text-sm">
              <p className="text-xs text-muted-foreground">
                {item.createdBy ? memberName(item.createdBy) : "—"} ·{" "}
                {new Date(item.createdAt).toLocaleString(activeOrgLocale(), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
              <p className="whitespace-pre-wrap">{item.text}</p>
            </div>
          ))}
          {canWrite ? (
            <div ref={addendumRef} className="flex flex-col gap-2">
              <addendumForm.AppField name="text">
                {(field) => (
                  <field.TextareaField
                    label="Nueva adenda"
                    rows={2}
                    maxLength={5000}
                    placeholder="Corrección o alcance posterior; no modifica lo finalizado"
                  />
                )}
              </addendumForm.AppField>
              {addendumError ? (
                <p role="alert" className="text-sm text-destructive">
                  {addendumError}
                </p>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={addingAddendum}
                onClick={() => void submitForm(addendumForm, { root: addendumRef.current })}
              >
                Agregar adenda
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      <ConfirmDialog
        open={finalizeOpen}
        variant="default"
        title="Finalizar ficha"
        description="Quedará inmutable en la historia clínica. Las correcciones posteriores se hacen con adendas."
        confirmLabel="Finalizar"
        pending={finalize.isPending}
        onClose={() => setFinalizeOpen(false)}
        onConfirm={confirmFinalize}
      />
      {discardOpen ? (
        <DiscardFormDialog responseId={response.id} onClose={() => setDiscardOpen(false)} onDiscarded={onChanged} />
      ) : null}
    </article>
  )
}
