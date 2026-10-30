import { ExpandableText, submitErrorMessage, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { Button, InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@odentia/ui"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch, apiUpload } from "../lib/api"
import { API_URL } from "../lib/auth-client"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { useMyRole } from "../lib/crm"
import { appWords } from "../lib/product-words"

/** Lo que admite `POST /api/help/cases/:id/attachments` (`SUPPORT_ATTACHMENT_MAX_BYTES`). */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"]

/** Lo que se dice de un archivo antes de subirlo, con las palabras del servidor; nada si se puede subir. */
function attachmentProblem(file: File): string | null {
  if (!ATTACHMENT_TYPES.includes(file.type)) return "El archivo no es válido: se admite JPG, PNG, WebP o PDF reales"
  if (file.size > ATTACHMENT_MAX_BYTES) return "El archivo no puede superar 10 MB"
  return null
}

/** La respuesta en el caso, con los límites y palabras de la ruta. */
const replySchema = z.object({
  body: z.string().trim().min(1, "Escribe tu respuesta.").max(4000, "Escribe como mucho 4000 caracteres."),
})

/** Cuánto dura el acceso diagnóstico: las opciones que admite la ruta (5 a 60 minutos). */
const MINUTES_OPTIONS = [
  { value: "15", label: "15 minutos" },
  { value: "30", label: "30 minutos" },
  { value: "60", label: "1 hora" },
] as const
const grantSchema = z.object({
  minutes: z.enum(["15", "30", "60"], "Elige por cuánto tiempo."),
})

/**
 * Responder en un caso abierto. Cada caso guarda su borrador (`drafts`): no se
 * envía el texto de un caso en otro ni se pierde al cambiar.
 */
function CaseReplyForm({
  caseId,
  drafts,
  onSend,
}: {
  caseId: string
  drafts: Record<string, string>
  onSend: (body: string) => Promise<unknown>
}) {
  const form = useAppForm({
    defaultValues: { body: drafts[caseId] ?? "" },
    validators: { onSubmit: replySchema },
    onSubmit: async ({ value }) => {
      await onSend(value.body.trim())
      drafts[caseId] = ""
      form.reset({ body: "" })
    },
  })
  const onSubmit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
      <form.AppField
        name="body"
        listeners={{
          onChange: ({ value }) => {
            drafts[caseId] = value
          },
        }}
      >
        {(field) => (
          <field.Control label="Tu respuesta a soporte" hideLabel id="soporte-respuesta">
            {(control) => (
              <InputGroup className="border-input bg-card">
                <InputGroupTextarea
                  {...control.props}
                  rows={1}
                  maxLength={4000}
                  className="max-h-32 min-h-11"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Responde a soporte…"
                />
                <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="sm"
                    className="min-h-11 px-4 sm:min-h-9"
                    disabled={pending}
                    aria-busy={pending}
                  >
                    Enviar
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            )}
          </field.Control>
        )}
      </form.AppField>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}

const supportStatus = z.enum(["abierto", "en_atencion", "esperando_clinica", "resuelto"])
type SupportStatus = z.infer<typeof supportStatus>

const STATUS_LABEL: Record<SupportStatus, string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la clínica",
  resuelto: "Resuelto",
}

const supportCaseItem = z.object({
  id: z.string(),
  kind: z.enum(["pregunta", "problema", "acceso", "cobro"]),
  question: z.string(),
  status: supportStatus,
  unread: z.boolean(),
})
type SupportCaseItem = z.infer<typeof supportCaseItem>

const supportMessageItem = z.object({
  id: z.string(),
  authorKind: z.enum(["cliente", "staff", "sistema"]),
  body: z.string(),
  createdAt: z.string(),
})

const supportAttachmentItem = z.object({
  id: z.string(),
  mimeType: z.string(),
  filename: z.string(),
  size: z.number(),
})

const supportGrantItem = z.object({
  id: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  active: z.boolean(),
})

const supportCaseDetail = supportCaseItem.extend({
  messages: z.array(supportMessageItem),
  attachments: z.array(supportAttachmentItem),
  grants: z.array(supportGrantItem),
})
export const casesEnvelope = z.object({ data: z.array(supportCaseItem) })
export type { SupportCaseItem }
const detailEnvelope = z.object({ data: supportCaseDetail })

/**
 * «Tus casos con soporte»: conversación pública del caso, reapertura,
 * adjuntos reales y consentimiento de acceso diagnóstico. Las notas internas
 * del equipo nunca llegan aquí: la API solo entrega mensajes públicos.
 */
export function SupportCasesSection({ initialCaseId = null }: { initialCaseId?: string | null }) {
  const queryClient = useQueryClient()
  const role = useMyRole()
  const canGrant = role === "owner" || role === "admin"
  // Abierta desde el correo, la sección se muestra con ese caso abierto.
  const [selectedId, setSelectedId] = useState<string | null>(initialCaseId)
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (initialCaseId) sectionRef.current?.scrollIntoView({ block: "start" })
  }, [initialCaseId])
  // Borrador por caso: no se envía el texto de un caso en otro ni se pierde al cambiar.
  const replyDrafts = useRef<Record<string, string>>({})
  // Lo que se dice del archivo elegido antes de subirlo (tamaño, tipo).
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const cases = useQuery({
    queryKey: ["support-cases"],
    queryFn: () => apiFetch("/api/help/cases").then((body: unknown) => casesEnvelope.parse(body).data),
    staleTime: 30_000,
    retry: false,
  })
  const detail = useQuery({
    queryKey: ["support-case", selectedId],
    queryFn: () => apiFetch(`/api/help/cases/${selectedId}`).then((body: unknown) => detailEnvelope.parse(body).data),
    enabled: selectedId !== null,
    staleTime: 15_000,
    retry: false,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["support-cases"] })
    void queryClient.invalidateQueries({ queryKey: ["support-case"] })
  }

  const sendReply = useMutation({
    retry: false,
    mutationFn: (input: { id: string; body: string }) =>
      apiFetch(`/api/help/cases/${input.id}/messages`, { method: "POST", body: JSON.stringify({ body: input.body }) }),
    onSuccess: invalidate,
  })
  const reopen = useMutation({
    retry: false,
    mutationFn: () => apiFetch(`/api/help/cases/${selectedId}/reopen`, { method: "POST" }),
    onSuccess: invalidate,
  })
  const upload = useMutation({
    retry: false,
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append("file", file)
      return apiUpload(`/api/help/cases/${selectedId}/attachments`, form)
    },
    onSuccess: invalidate,
  })
  const grant = useMutation({
    retry: false,
    mutationFn: (minutes: number) =>
      apiFetch(`/api/help/cases/${selectedId}/grants`, {
        method: "POST",
        body: JSON.stringify({ minutes }),
      }),
    onSuccess: invalidate,
  })
  const grantForm = useAppForm({
    defaultValues: { minutes: "30" as string },
    validators: { onSubmit: grantSchema },
    onSubmit: async ({ value }) => {
      await grant.mutateAsync(Number.parseInt(value.minutes, 10))
    },
  })
  const onGrantSubmit = useFormSubmit(grantForm)
  const grantError = useFormSubmitError(grantForm)
  const granting = useStore(grantForm.store, (state) => state.isSubmitting)
  const revoke = useMutation({
    retry: false,
    mutationFn: (grantId: string) =>
      apiFetch(`/api/help/cases/${selectedId}/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId }),
      }),
    onSuccess: invalidate,
  })
  const markSeen = useMutation({
    retry: false,
    mutationFn: (id: string) => apiFetch(`/api/help/cases/${id}/seen`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["support-cases"] }),
  })

  const items = [...(cases.data ?? [])].sort((a, b) => Number(b.unread) - Number(a.unread))
  const kase = detail.data ?? null
  const activeGrant = kase?.grants.find((item) => item.active) ?? null
  const resolved = kase?.status === "resuelto"
  // Lo que se dice junto a «Adjuntar»: el archivo elegido o lo que respondió el servidor al subirlo.
  const attachError = fileProblem ?? (upload.isError ? submitErrorMessage(upload.error) : null)

  const markedRef = useRef<string | null>(null)

  function openCase(id: string) {
    markedRef.current = null
    setFileProblem(null)
    upload.reset()
    grantForm.reset()
    setSelectedId(id)
  }

  // Visto solo con la conversación ya abierta y observada: una vez por
  // apertura, sin re-marcar en cada refetch.
  useEffect(() => {
    if (selectedId !== null && detail.data !== undefined && markedRef.current !== selectedId) {
      markedRef.current = selectedId
      markSeen.mutate(selectedId)
    }
  }, [selectedId, detail.data, markSeen])

  return (
    <section ref={sectionRef} aria-label="Tus casos con soporte" className="flex flex-col gap-2 border-t pt-3.5">
      <h3 className="text-sm font-bold">Tus casos con soporte</h3>
      {cases.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando tus casos…</p>
      ) : cases.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pude cargar tus casos ahora.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aún no tienes casos. Cuando envías una pregunta o reportas un problema, aquí sigue su conversación.
        </p>
      ) : selectedId === null ? (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5">
              <span className="flex w-full flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
                  {STATUS_LABEL[item.status]}
                </span>
                {item.unread ? (
                  <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                    Nueva respuesta
                  </span>
                ) : null}
              </span>
              <ExpandableText
                text={item.question}
                label="Consulta del caso"
                className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 self-start sm:min-h-9"
                onClick={() => openCase(item.id)}
                aria-label={`Abrir caso: ${item.question.slice(0, 80)}`}
              >
                Abrir caso
              </Button>
            </li>
          ))}
        </ul>
      ) : kase === null ? (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="link" className="h-auto self-start p-0 text-sm" onClick={() => setSelectedId(null)}>
            ← Todos los casos
          </Button>
          {detail.isPending ? (
            <p className="text-sm text-muted-foreground">Cargando la conversación…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                No pude cargar este caso.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 self-start sm:min-h-9"
                onClick={() => void detail.refetch()}
              >
                Reintentar
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => setSelectedId(null)}>
              ← Todos los casos
            </Button>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">
              {STATUS_LABEL[kase.status]}
            </span>
          </div>
          <ExpandableText
            text={`«${kase.question}»`}
            label="Consulta inicial del caso"
            className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]"
          />

          {detail.isPending ? (
            <p className="text-sm text-muted-foreground">Cargando la conversación…</p>
          ) : detail.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No pude cargar este caso.
            </p>
          ) : (
            <>
              <ol className="flex flex-col gap-2" aria-live="polite">
                {kase.messages.map((message) => (
                  <li
                    key={message.id}
                    className={
                      message.authorKind === "staff"
                        ? "max-w-[92%] self-start rounded-2xl rounded-bl-md border border-primary/20 bg-primary-soft px-3.5 py-2.5 text-sm"
                        : "max-w-[92%] self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground"
                    }
                  >
                    {message.authorKind === "staff" ? (
                      <p className="text-xs font-bold text-muted-foreground">{appWords().name} · soporte</p>
                    ) : null}
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
                  </li>
                ))}
              </ol>

              {kase.attachments.length > 0 ? (
                <ul className="flex flex-col gap-1.5" aria-label="Adjuntos del caso">
                  {kase.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary underline underline-offset-4"
                        href={`${API_URL}/api/help/cases/${kase.id}/attachments/${attachment.id}?org=${encodeURIComponent(orgSlugFromHostname(requestHostname()) ?? "")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Paperclip className="size-4" aria-hidden />
                        {attachment.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}

              {resolved ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start sm:min-h-9"
                    disabled={reopen.isPending}
                    onClick={() => reopen.mutate()}
                  >
                    Reabrir el caso
                  </Button>
                  {reopen.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {submitErrorMessage(reopen.error)}
                    </p>
                  ) : null}
                </>
              ) : (
                <CaseReplyForm
                  key={kase.id}
                  caseId={kase.id}
                  drafts={replyDrafts.current}
                  onSend={(body) => sendReply.mutateAsync({ id: kase.id, body })}
                />
              )}

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  aria-label="Adjuntar archivo al caso"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ""
                    if (!file) return
                    const problem = attachmentProblem(file)
                    setFileProblem(problem)
                    if (problem) upload.reset()
                    else upload.mutate(file)
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  disabled={upload.isPending || resolved}
                  aria-busy={upload.isPending}
                  aria-invalid={attachError ? true : undefined}
                  aria-describedby={resolved ? "soporte-adjunto-motivo" : attachError ? "soporte-adjunto-error" : undefined}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip className="size-4" aria-hidden />
                  {upload.isPending ? "Subiendo…" : "Adjuntar (JPG, PNG, WebP o PDF, máx. 10 MB)"}
                </Button>
              </div>
              {resolved ? (
                <p id="soporte-adjunto-motivo" className="text-sm text-muted-foreground">
                  Para adjuntar archivos, reabre el caso.
                </p>
              ) : attachError ? (
                <p id="soporte-adjunto-error" role="alert" className="text-sm text-destructive">
                  {attachError}
                </p>
              ) : null}

              {!canGrant ? (
                <p className="text-sm text-muted-foreground">Solo quien administra la clínica puede autorizar acceso diagnóstico a soporte.</p>
              ) : resolved && !activeGrant ? (
                <p className="text-sm text-muted-foreground">
                  El caso está resuelto: si soporte necesita ver el diagnóstico de tu clínica, reábrelo y autoriza el acceso.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
                  <p className="font-bold">Acceso diagnóstico de soporte</p>
                  {activeGrant ? (
                    <>
                      <p>
                        Soporte puede ver el diagnóstico de tu clínica hasta el{" "}
                        {new Date(activeGrant.expiresAt).toLocaleString()}. Solo configuración operacional, nunca tus
                        pacientes ni secretos.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 self-start sm:min-h-9"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(activeGrant.id)}
                      >
                        Revocar ahora
                      </Button>
                      {revoke.isError ? (
                        <p role="alert" className="text-sm text-destructive">
                          {submitErrorMessage(revoke.error)}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p className="text-muted-foreground">
                        Si soporte lo necesita, puedes autorizar que vea el diagnóstico de tu clínica (configuración,
                        nunca pacientes ni secretos). Eliges por cuánto tiempo, máximo 1 hora, y lo revocas cuando
                        quieras. Solo quien es propietario o administra la clínica puede autorizarlo.
                      </p>
                      <form noValidate onSubmit={onGrantSubmit} className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-end gap-2">
                          <grantForm.AppField name="minutes">
                            {(field) => (
                              <field.SelectField
                                label="Duración"
                                id="soporte-minutos"
                                className="w-auto"
                                triggerClassName="w-44"
                                options={MINUTES_OPTIONS}
                                placeholder="30 minutos"
                              />
                            )}
                          </grantForm.AppField>
                          <Button
                            type="submit"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-9"
                            disabled={granting}
                            aria-busy={granting}
                          >
                            Autorizar acceso
                          </Button>
                        </div>
                        {grantError ? (
                          <p role="alert" className="text-sm text-destructive">
                            {grantError}
                          </p>
                        ) : null}
                      </form>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
