import { ExpandableText } from "@odentia/ui-patterns"
import { Button, FieldLabel, InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch, apiUpload } from "../lib/api"
import { API_URL } from "../lib/auth-client"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { mutationErrorMessage } from "../lib/query-error"
import { useMyRole } from "../lib/crm"

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
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [minutes, setMinutes] = useState("30")
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
    onSuccess: (_data, input) => {
      setReplyDrafts((current) => ({ ...current, [input.id]: "" }))
      invalidate()
    },
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
    mutationFn: () => {
      const parsed = Number.parseInt(minutes, 10)
      const value = Number.isInteger(parsed) && parsed >= 5 && parsed <= 60 ? parsed : 30
      return apiFetch(`/api/help/cases/${selectedId}/grants`, {
        method: "POST",
        body: JSON.stringify({ minutes: value }),
      })
    },
    onSuccess: invalidate,
  })
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

  function submitReply(event: FormEvent) {
    event.preventDefault()
    if (selectedId === null) return
    const body = (replyDrafts[selectedId] ?? "").trim()
    if (body.length > 0 && !sendReply.isPending) sendReply.mutate({ id: selectedId, body })
  }

  const markedRef = useRef<string | null>(null)

  function openCase(id: string) {
    markedRef.current = null
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
                      <p className="text-xs font-bold text-muted-foreground">odentIA · soporte</p>
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

              {kase.status === "resuelto" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start sm:min-h-9"
                  disabled={reopen.isPending}
                  onClick={() => reopen.mutate()}
                >
                  Reabrir el caso
                </Button>
              ) : (
                <form onSubmit={submitReply}>
                  <FieldLabel htmlFor="soporte-respuesta" className="sr-only">
                    Tu respuesta a soporte
                  </FieldLabel>
                  <InputGroup className="border-input bg-card">
                    <InputGroupTextarea
                      id="soporte-respuesta"
                      rows={1}
                      maxLength={4000}
                      className="max-h-32 min-h-11"
                      value={selectedId === null ? "" : (replyDrafts[selectedId] ?? "")}
                      onChange={(event) => {
                        if (selectedId === null) return
                        const id = selectedId
                        setReplyDrafts((current) => ({ ...current, [id]: event.target.value }))
                      }}
                      placeholder="Responde a soporte…"
                    />
                    <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-1.5">
                      <InputGroupButton
                        type="submit"
                        variant="default"
                        size="sm"
                        className="min-h-11 px-4 sm:min-h-9"
                        disabled={selectedId === null || (replyDrafts[selectedId] ?? "").trim().length === 0 || sendReply.isPending}
                        aria-busy={sendReply.isPending}
                      >
                        Enviar
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </form>
              )}
              {sendReply.isError || reopen.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {mutationErrorMessage(sendReply.error ?? reopen.error)}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  aria-label="Adjuntar archivo al caso"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) upload.mutate(file)
                    event.target.value = ""
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  disabled={upload.isPending || kase.status === "resuelto"}
                  aria-busy={upload.isPending}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip className="size-4" aria-hidden />
                  {upload.isPending ? "Subiendo…" : "Adjuntar (JPG, PNG, WebP o PDF, máx. 10 MB)"}
                </Button>
              </div>
              {upload.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {mutationErrorMessage(upload.error)}
                </p>
              ) : null}

              {canGrant ? <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
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
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      Si soporte lo necesita, puedes autorizar que vea el diagnóstico de tu clínica (configuración,
                      nunca pacientes ni secretos). Eliges por cuánto tiempo, máximo 1 hora, y lo revocas cuando
                      quieras. Solo quien es propietario o administra la clínica puede autorizarlo.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <FieldLabel htmlFor="soporte-minutos">Duración</FieldLabel>
                      <Select
                        value={minutes}
                        items={{ 15: "15 minutos", 30: "30 minutos", 60: "1 hora" }}
                        onValueChange={(value) => setMinutes(value ?? "30")}
                      >
                        <SelectTrigger id="soporte-minutos" className="w-44">
                          <SelectValue placeholder="30 minutos" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="15">15 minutos</SelectItem>
                          <SelectItem value="30">30 minutos</SelectItem>
                          <SelectItem value="60">1 hora</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        disabled={grant.isPending}
                        onClick={() => grant.mutate()}
                      >
                        Autorizar acceso
                      </Button>
                    </div>
                  </>
                )}
                {grant.isError || revoke.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {mutationErrorMessage(grant.error ?? revoke.error)}
                  </p>
                ) : null}
              </div> : <p className="text-sm text-muted-foreground">Solo quien administra la clínica puede autorizar acceso diagnóstico a soporte.</p>}
            </>
          )}
        </div>
      )}
    </section>
  )
}
