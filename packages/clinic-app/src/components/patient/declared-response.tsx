import { KINSHIP_LABELS } from "@odentia/clinical"
import { Badge, Button, cn, toast } from "@odentia/ui"
import { submitErrorMessage, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import {
  addFormAddendum,
  type FinalizedFormResponse,
  type FormFieldDef,
  type FormResponse,
  fetchFormAddenda,
  finalizeFormResponse,
} from "../../lib/clinical-forms"
import { useMemberName } from "../../lib/crm"
import { shortDay } from "../../lib/declared-health"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { FirmaView } from "./firma-pad"
import { isFieldVisible } from "./form-fields"

/**
 * Lo que respondió el paciente (o quien habla por él) en un cuestionario, para
 * leer: es suyo y no se cambia (mesa del 13 nov). Si algo no es así, el equipo
 * agrega una corrección, que queda aparte con su nombre y la hora, antes o
 * después de «Marcar como revisado». Revisarlo dice lo que pasó de verdad con
 * sus respuestas y deja quién lo revisó; desde la atención queda ligado a ella.
 */

/** «13 nov, 2:27 p. m.», en la zona de la clínica. */
function dayAndTime(value: string): string {
  return new Date(value)
    .toLocaleString(activeOrgLocale(), {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: activeOrgTimeZone(),
    })
    .replace(/\.(?=,)/, "")
}

/** El paciente lo envió y nadie del equipo lo revisó todavía. */
export function isDeclaredUnreviewed(response: FormResponse): boolean {
  return response.source === "portal" && response.status === "borrador" && response.submittedAt !== null
}

/** Quién lo envió: la propia persona («ella», «él») o quien habla por ella («su madre, Carla»). */
function senderWho(response: FormResponse, sex: string | null | undefined): string {
  const sender = response.respondent
  if (sender && sender.relationship !== "self" && sender.relationship !== null) {
    const kin =
      sender.kinship && sender.kinship in KINSHIP_LABELS
        ? KINSHIP_LABELS[sender.kinship as keyof typeof KINSHIP_LABELS]
        : sender.relationshipDetail?.trim()
    const first = sender.name.trim().split(/\s+/)[0] ?? sender.name
    return kin ? `su ${kin.toLocaleLowerCase("es")}, ${first}` : `${first}, que habla por el paciente`
  }
  return sex === "F" ? "ella" : sex === "M" ? "él" : ""
}

/**
 * «Lo envió Marta Ríos desde su enlace el 13 nov, 2:27 p. m.»: quién, por dónde
 * y cuándo, solo con lo que quedó guardado. Sin el canal (lo de antes), no se dice.
 */
export function sentWords(response: FormResponse): string {
  const name = response.respondent?.name ?? "el paciente"
  if (!response.submittedAt) return `Lo está respondiendo ${name}: todavía no lo envió.`
  const via =
    response.submittedVia === "enlace" ? " desde su enlace" : response.submittedVia === "portal" ? " desde el portal" : ""
  return `Lo envió ${name}${via} el ${dayAndTime(response.submittedAt)}.`
}

/** Una respuesta en palabras, como la escribió: «Sí», «8 de 10», la lista unida o el texto tal cual. */
export function declaredAnswerText(field: FormFieldDef, value: unknown): string {
  if (value === null || value === undefined || value === "") return "No respondió"
  if (value === true) return "Sí"
  if (value === false) return "No"
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(", ") : "No respondió"
  if (field.type === "escala" && typeof value === "number") return `${value} de ${field.max ?? 10}`
  if (field.type === "numero" && field.unit) return `${String(value)} ${field.unit}`
  if (field.type === "fecha" && typeof value === "string") return shortDay(value) || value
  if (field.type === "adjunto") return "Adjuntó un archivo (está en Documentos)"
  return String(value)
}

/** La plantilla con que respondió le preguntaba por sus alergias (lo único que pasa a Antecedentes). */
export function asksAllergies(response: FormResponse): boolean {
  return (response.templateSnapshot?.sections ?? []).some((section) =>
    section.fields.some((field) => field.definition === "AllergyIntolerance.code"),
  )
}

/** Lo que pasó al revisarlo, dicho tal cual: qué entró a Antecedentes o que nada entró. */
export function reviewedWords(response: FormResponse, passed: readonly string[]): string {
  if (passed.length > 0) {
    const list =
      passed.length === 1 ? passed[0] : `${passed.slice(0, -1).join(", ")} y ${passed[passed.length - 1]}`
    return `Revisado. Pasó a Antecedentes: ${list}, como alergia que dijo y falta confirmar.`
  }
  return asksAllergies(response)
    ? "Revisado. Nada nuevo pasó a Antecedentes: no nombró una alergia que no estuviera ya."
    : "Revisado. Nada pasó a Antecedentes: sus respuestas quedan aquí y en Documentos."
}

const correctionSchema = z.object({
  text: z.string().trim().min(1, "Escribe la corrección.").max(5000, "La corrección admite hasta 5000 caracteres."),
})

export function DeclaredResponse({
  response,
  canWrite,
  sex,
  encounterId,
  disabled = false,
  limit,
  onChanged,
}: {
  response: FormResponse
  canWrite: boolean
  /** El sexo registrado del paciente, para decir «ella» o «él»; sin él no se supone. */
  sex?: string | null
  /** La atención en curso desde la que se revisa: lo revisado queda ligado a ella. */
  encounterId?: string
  disabled?: boolean
  /** En la atención, cuántas respuestas se muestran: lo demás se abre en Documentos. */
  limit?: number
  onChanged?: () => Promise<void> | void
}): React.JSX.Element {
  const ids = useId()
  const queryClient = useQueryClient()
  const memberName = useMemberName()
  const [correcting, setCorrecting] = useState(false)
  const correctionRef = useRef<HTMLDivElement | null>(null)
  const sent = response.submittedAt !== null
  const unreviewed = isDeclaredUnreviewed(response)
  const reviewed = response.status === "finalizado"
  const who = senderWho(response, sex)

  const corrections = useQuery({
    queryKey: ["form-addenda", response.id],
    queryFn: () => fetchFormAddenda(response.id),
    enabled: sent && response.status !== "descartado",
  })
  const refresh = async () => {
    await Promise.all(
      [["form-responses", response.patientId], ["patient-health", response.patientId], ["patient", response.patientId]].map(
        (queryKey) => queryClient.invalidateQueries({ queryKey }),
      ),
    )
    await onChanged?.()
  }
  const review = useMutation({
    mutationFn: () => finalizeFormResponse(response.id, encounterId ?? null),
    onSuccess: async (result: { data: FinalizedFormResponse }) => {
      toast.success(reviewedWords(response, result.data.passedAllergies ?? []))
      await refresh()
    },
  })
  const addCorrection = useMutation({ mutationFn: (text: string) => addFormAddendum(response.id, text) })
  const correctionForm = useAppForm({
    defaultValues: { text: "" },
    validators: { onSubmit: correctionSchema },
    onSubmit: async ({ value }) => {
      await addCorrection.mutateAsync(value.text.trim())
      correctionForm.reset()
      setCorrecting(false)
      await queryClient.invalidateQueries({ queryKey: ["form-addenda", response.id] })
      toast.success("Corrección guardada: queda aparte, con tu nombre y la hora")
    },
  })
  // Al abrirla se escribe sin otro clic: el foco va al texto de la corrección.
  useEffect(() => {
    if (correcting) correctionRef.current?.querySelector("textarea")?.focus()
  }, [correcting])
  const correctionError = useFormSubmitError(correctionForm)
  const savingCorrection = useStore(correctionForm.store, (state) => state.isSubmitting)

  const fields = (response.templateSnapshot?.sections ?? [])
    .flatMap((section) => section.fields)
    .filter((field) => isFieldVisible(field, response.answers ?? {}))
  const shown = limit === undefined ? fields : fields.slice(0, limit)
  const list = corrections.data?.data ?? []
  // Quien lo escribió, para decirlo sin suponer su sexo.
  const author = who === "ella" || who === "él" ? who : "la persona"

  return (
    <article aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h3 id={`${ids}-title`} className="text-base font-semibold">
          {response.templateTitle ?? "Formulario"}
        </h3>
        <p className="text-sm text-muted-foreground">{sentWords(response)}</p>
        <div>
          {reviewed ? (
            <Badge variant="secondary" className="h-auto min-h-5 max-w-full py-px text-left whitespace-normal">
              {response.finalizedBy
                ? `Lo revisó ${memberName(response.finalizedBy)}${response.finalizedAt ? `, ${shortDay(response.finalizedAt)}` : ""}`
                : `Revisado${response.finalizedAt ? ` el ${shortDay(response.finalizedAt)}` : ""}`}
            </Badge>
          ) : unreviewed ? (
            <Badge
              variant="outline"
              className="h-auto min-h-5 max-w-full border-dashed border-warning/30 bg-warning-soft py-px text-left whitespace-normal text-warning"
            >
              Lo dijo {who || "la persona"} · por revisar
            </Badge>
          ) : response.status === "descartado" ? (
            <Badge variant="outline">Descartado</Badge>
          ) : (
            <Badge variant="outline">Sin enviar</Badge>
          )}
        </div>
        {sent && response.status !== "descartado" ? (
          <p className="text-sm text-muted-foreground">
            Es lo que {author} escribió y no se cambia. Si algo no es así, agrega una corrección: queda aparte, con tu
            nombre y la hora.
          </p>
        ) : null}
        {response.status === "descartado" ? (
          <p className="rounded-md bg-muted p-3 text-sm">
            Descartado{response.discardedAt ? ` el ${shortDay(response.discardedAt)}` : ""} · {response.discardReason}
          </p>
        ) : null}
      </header>
      <dl className="flex flex-col gap-3">
        {shown.map((field) => {
          const value = response.answers?.[field.id]
          const signature =
            field.type === "firma" && value && typeof value === "object" ? (value as Record<string, unknown>) : null
          const strokes = Array.isArray(signature?.strokes) ? (signature.strokes as number[][][]) : []
          const signer = typeof signature?.signerName === "string" ? signature.signerName : ""
          const empty = value === null || value === undefined || value === "" || (field.type === "firma" && strokes.length === 0)
          return (
            <div key={field.id} className="flex flex-col gap-0.5">
              <dt className="text-sm text-muted-foreground">{field.label}</dt>
              <dd className={cn("text-sm whitespace-pre-wrap", empty ? "text-muted-foreground" : "font-medium")}>
                {field.type === "firma" ? (
                  strokes.length > 0 ? (
                    <>
                      <FirmaView strokes={strokes} label={`${field.label}: ${signer}`} />
                      <span className="text-xs font-normal text-muted-foreground">Firmó: {signer || "—"}</span>
                    </>
                  ) : (
                    "No firmó"
                  )
                ) : (
                  declaredAnswerText(field, value)
                )}
              </dd>
            </div>
          )
        })}
      </dl>
      {limit !== undefined && fields.length > shown.length ? (
        <p className="text-xs text-muted-foreground">
          Hay {fields.length - shown.length} {fields.length - shown.length === 1 ? "respuesta más" : "respuestas más"} en
          Documentos.
        </p>
      ) : null}
      {list.length > 0 ? (
        <section aria-label="Correcciones" className="flex flex-col gap-2">
          {list.map((item) => (
            <div key={item.id} className="rounded-md border bg-background p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Corrección · {item.createdBy ? memberName(item.createdBy) : "Equipo"} · {dayAndTime(item.createdAt)}
              </p>
              <p className="whitespace-pre-wrap">{item.text}</p>
            </div>
          ))}
        </section>
      ) : null}
      {unreviewed && asksAllergies(response) ? (
        <p className="text-xs text-muted-foreground">
          Al marcarlo como revisado, las alergias que escribió pasan a su lista y avisan al recetar; lo ya registrado no
          cambia.
        </p>
      ) : null}
      {correcting ? (
        <div ref={correctionRef} className="flex flex-col gap-2 rounded-md border p-3">
          <correctionForm.AppField name="text">
            {(field) => <field.TextareaField label="Tu corrección" rows={3} maxLength={5000} />}
          </correctionForm.AppField>
          <p className="text-xs text-muted-foreground">
            Lo que {author} escribió no cambia. Para que su ficha diga otra cosa, corrígelo también en sus
            antecedentes.
          </p>
          {correctionError ? (
            <p role="alert" className="text-sm text-destructive">
              {correctionError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={savingCorrection}
              onClick={() => {
                correctionForm.reset()
                setCorrecting(false)
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={savingCorrection}
              onClick={() => void submitForm(correctionForm, { root: correctionRef.current })}
            >
              {savingCorrection ? "Guardando…" : "Guardar corrección"}
            </Button>
          </div>
        </div>
      ) : null}
      {review.error ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(review.error)}
        </p>
      ) : null}
      {canWrite && sent && response.status !== "descartado" && !correcting ? (
        <div className="flex flex-wrap justify-between gap-2 border-t pt-3">
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setCorrecting(true)}>
            {list.length > 0 ? "Agregar otra corrección" : "Agregar una corrección"}
          </Button>
          {unreviewed ? (
            <Button type="button" size="sm" disabled={disabled || review.isPending} onClick={() => review.mutate()}>
              {review.isPending ? "Marcando…" : "Marcar como revisado"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
