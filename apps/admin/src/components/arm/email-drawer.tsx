/**
 * Un correo que llegó (`GET /api/admin/clients/inbound/:emailId`): lo que dice,
 * cuántos adjuntos trae (se leen en Documentos; aquí nunca se abren) y lo que
 * ya se le respondió, con «Responder» cuando quien mira puede (Soporte, solo
 * lo de soporte@: lo demás ni lo ve). Responder es el mismo envío de
 * «Escribir»: «Para» el remitente, «Desde» quien firma (lo dice el servidor),
 * «Re: …», el cuerpo y, solo Administración y con cliente, una propuesta en
 * PDF; debajo, plegado, el correo que se responde. Si se corta, «No se sabe si
 * salió» con «Salió / No salió»: nunca se vuelve a enviar solo.
 *
 * Desde Kairós (`responder_correo`) llega con su borrador y «Enviar» es el sí
 * del ítem (`onSend`): la misma respuesta, sin propuesta.
 */
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { Badge, Button, toast } from "@odentia/ui"
import {
  common,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageNotice,
  SpeechInput,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { useIsAdmin } from "../../lib/session"
import { supportDayTime } from "../../lib/support-words"
import { ProductMark } from "../product"
import { invalidateArm } from "./hoy-links"
import { resolveOutreach, SendUnknownError, sendEmailReply, useClientProposals } from "./sale-api"
import { proposalStatusWords } from "./sale-words"
import { type OutreachCheck, OutreachCheckDrawer } from "./write-drawer"

const replySchema = z.object({
  id: z.string(),
  status: z.string(),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
})

export const inboundEmailSchema = z.object({
  id: z.string(),
  mailbox: z.string(),
  product: z.string(),
  from: z.string(),
  fromName: z.string().nullable(),
  to: z.string(),
  subject: z.string().nullable(),
  /** Nulo pasados 30 días: el texto se borra. */
  text: z.string().nullable(),
  receivedAt: z.string(),
  senderVerified: z.boolean(),
  attachments: z.number().int().nonnegative(),
  clientId: z.string().nullable(),
  staff: z.object({ userId: z.string(), name: z.string() }).nullable(),
  canReply: z.boolean(),
  replyFrom: z.object({ name: z.string(), address: z.string() }).nullable().default(null),
  replySubject: z.string().default(""),
  replies: z.array(replySchema),
})
export type InboundEmail = z.infer<typeof inboundEmailSchema>

/** La clave del correo; toda respuesta o «¿Salió?» la refresca. */
export const inboundEmailKey = (emailId: string) => ["admin", "correo", emailId] as const

export function useInboundEmail(emailId: string, enabled = true) {
  return useQuery({
    queryKey: inboundEmailKey(emailId),
    enabled,
    queryFn: async () =>
      inboundEmailSchema.parse(
        await api<unknown>(`/api/admin/clients/inbound/${encodeURIComponent(emailId)}`),
      ),
  })
}

const REPLY_STATUS_WORDS: Record<string, string> = {
  pendiente: "Falta decir si salió",
  enviado: "Salió",
  incierto: "No se sabe si salió",
  no_salio: "No salió",
}

/** «hola@», «soporte@» o la dirección de una persona, como la escribió quien mandó el correo. */
const mailboxWords = (email: InboundEmail) =>
  email.mailbox === "persona" ? email.to : `${email.mailbox}@`

const senderWords = (email: InboundEmail) =>
  email.fromName ? `${email.fromName} <${email.from}>` : email.from

/** Lo que quedó sin saber si salió: se resuelve antes de responder otra vez. */
const unsettled = (email: InboundEmail) =>
  email.replies.filter((reply) => reply.status === "incierto" || reply.status === "pendiente")

const isProduct = (value: string): value is (typeof CLINICAL_PRODUCTS)[number] =>
  (CLINICAL_PRODUCTS as readonly string[]).includes(value)

export interface EmailDrawerProps {
  emailId: string
  open: boolean
  onClose: () => void
  /** Abre directo en «Responder» (Kairós, «Responder» de una fila). */
  replying?: boolean
  /** El borrador con que empieza la respuesta (el de Kairós). */
  draft?: string
  /** Lo dice el borrador hecho con plantilla. */
  draftNote?: string | null
  /** «Enviar» como el sí de un ítem de Kairós: sin propuesta, la misma respuesta. */
  onSend?: (body: string) => Promise<void>
}

export function EmailDrawer(props: EmailDrawerProps) {
  if (!props.open) return null
  return <EmailSurface {...props} />
}

type Phase = { kind: "leer" } | { kind: "responder" } | OutreachCheck

function EmailSurface({
  emailId,
  onClose,
  replying = false,
  draft,
  draftNote = null,
  onSend,
}: EmailDrawerProps) {
  const queryClient = useQueryClient()
  const email = useInboundEmail(emailId)
  const [phase, setPhase] = useState<Phase>({ kind: replying ? "responder" : "leer" })
  const refresh = (clientId: string | null | undefined) => {
    void queryClient.invalidateQueries({ queryKey: inboundEmailKey(emailId) })
    invalidateArm(queryClient, clientId)
  }

  if (!email.data) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title={replying ? "Responder" : "Correo"}
        onSubmit={(event) => event.preventDefault()}
        isLoading={email.isPending}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {email.isError ? (
          <ErrorState
            title="No pude abrir el correo"
            error={email.error}
            onRetry={() => void email.refetch()}
          />
        ) : (
          <LoadingState message="Abriendo el correo…" />
        )}
      </FormDrawer>
    )
  }
  const data = email.data

  if (phase.kind === "whatsapp" || phase.kind === "incierto") {
    return (
      <OutreachCheckDrawer
        phase={phase}
        onClose={onClose}
        onResolved={() => {
          refresh(data.clientId)
          onClose()
        }}
      />
    )
  }
  if (phase.kind === "responder" && data.canReply) {
    return (
      <ReplyForm
        email={data}
        draft={draft ?? ""}
        draftNote={draftNote}
        onSend={onSend}
        onClose={onClose}
        onUnknown={(check) => {
          refresh(data.clientId)
          setPhase(check)
        }}
        onSent={() => refresh(data.clientId)}
      />
    )
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={data.subject?.trim() || "Correo sin asunto"}
      description={`De ${senderWords(data)}`}
      onSubmit={(event) => {
        event.preventDefault()
        setPhase({ kind: "responder" })
      }}
      hideSubmit={!data.canReply}
      submitLabel="Responder"
      cancelLabel={common.actions.close}
    >
      <EmailReading email={data} onResolved={() => refresh(data.clientId)} />
    </FormDrawer>
  )
}

/** Lo que dice el correo, sus adjuntos contados y lo que ya se le respondió. */
function EmailReading({ email, onResolved }: { email: InboundEmail; onResolved: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Llegó</dt>
        <dd>{supportDayTime(email.receivedAt)}</dd>
        <dt className="text-muted-foreground">A</dt>
        <dd className="flex flex-wrap items-center gap-x-2 [overflow-wrap:anywhere]">
          {mailboxWords(email)}
          {isProduct(email.product) ? <ProductMark product={email.product} /> : null}
          {email.staff ? <span className="text-muted-foreground">({email.staff.name})</span> : null}
        </dd>
        <dt className="text-muted-foreground">De</dt>
        <dd className="[overflow-wrap:anywhere]">{senderWords(email)}</dd>
      </dl>
      {email.senderVerified ? null : (
        <PageNotice tone="aviso" label="Remitente sin verificar">
          No se pudo comprobar que lo envió esa dirección: puede no ser quien dice.
        </PageNotice>
      )}
      <section aria-label="Lo que dice" className="flex flex-col gap-2">
        {email.text ? (
          <p className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm [overflow-wrap:anywhere]">
            {email.text}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            El texto de este correo se borró a los 30 días de llegar.
          </p>
        )}
        {email.attachments > 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Paperclip aria-hidden className="size-4" />
            {email.attachments === 1 ? "1 adjunto" : `${email.attachments} adjuntos`}
            {email.clientId
              ? ": están en Documentos de su ficha."
              : ": se guardan al ligarlo a un cliente."}
          </p>
        ) : null}
      </section>
      <section aria-labelledby="correo-respuestas" className="flex flex-col gap-2">
        <h3 id="correo-respuestas" className="text-sm font-semibold">
          Lo que le respondimos
        </h3>
        {email.replies.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía nadie le respondió.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {email.replies.map((reply) => (
              <ReplyRow key={reply.id} reply={reply} onResolved={onResolved} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ReplyRow({
  reply,
  onResolved,
}: {
  reply: InboundEmail["replies"][number]
  onResolved: () => void
}) {
  const resolve = useMutation({
    mutationFn: (outcome: "salio" | "no_salio") => resolveOutreach(reply.id, outcome),
    onSuccess: (_data, outcome) => {
      toast.success(outcome === "salio" ? "Anotado: salió" : "Anotado: no salió")
      onResolved()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const open = reply.status === "pendiente" || reply.status === "incierto"
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={open ? "destructive" : "outline"}>
          {REPLY_STATUS_WORDS[reply.status] ?? "Respuesta"}
        </Badge>
        <span className="text-muted-foreground">
          {supportDayTime(reply.sentAt ?? reply.createdAt)}
          {reply.from ? ` · desde ${reply.from}` : ""}
        </span>
      </div>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{reply.body}</p>
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">¿Salió?</span>
          <Button
            type="button"
            size="sm"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate("salio")}
          >
            Salió
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate("no_salio")}
          >
            No salió
          </Button>
        </div>
      ) : null}
    </li>
  )
}

const replyFormSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Escribe la respuesta")
    .max(5000, "Usa como máximo 5000 caracteres"),
  proposalId: z.string(),
})

function ReplyForm({
  email,
  draft,
  draftNote,
  onSend,
  onClose,
  onUnknown,
  onSent,
}: {
  email: InboundEmail
  draft: string
  draftNote: string | null
  onSend: ((body: string) => Promise<void>) | undefined
  onClose: () => void
  onUnknown: (check: OutreachCheck) => void
  onSent: () => void
}) {
  const isAdmin = useIsAdmin()
  // Una propuesta viaja solo con un cliente y la elige solo Administración (como «Escribir»).
  const canAttach = isAdmin && email.clientId !== null && !onSend
  const proposals = useClientProposals(email.clientId ?? "", canAttach)
  const sendable = (proposals.data ?? []).filter(
    (proposal) => proposal.displayStatus === "borrador" || proposal.displayStatus === "enviada",
  )
  const form = useAppForm({
    defaultValues: { body: draft, proposalId: "" },
    validators: { onSubmit: replyFormSchema },
    onSubmit: async ({ value, formApi }) => {
      const body = value.body.trim()
      if (onSend) {
        await onSend(body)
        formApi.reset(value)
        onClose()
        return
      }
      try {
        const outreach = await sendEmailReply(email.id, {
          body,
          ...(value.proposalId ? { proposalId: value.proposalId } : {}),
        })
        onSent()
        toast.success(`Respuesta enviada a ${outreach.to}`)
        formApi.reset(value)
        onClose()
      } catch (error) {
        if (!(error instanceof SendUnknownError)) throw error
        formApi.reset(value)
        onUnknown({ kind: "incierto", outreachId: error.outreachId, message: error.message })
      }
    },
  })
  // Desde Kairós el servidor señala el texto como `edited.body`.
  const surface = useFormSurface(form, { fieldMap: { "edited.body": "body" } })
  const pendingReplies = unsettled(email)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Responder"
      description={email.subject?.trim() ? `A «${email.subject.trim()}»` : "A un correo sin asunto"}
      submitLabel="Enviar"
      cancelLabel="Descartar"
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Para</dt>
          <dd className="[overflow-wrap:anywhere]">{senderWords(email)}</dd>
          <dt className="text-muted-foreground">Desde</dt>
          <dd className="[overflow-wrap:anywhere]">
            {email.replyFrom ? `${email.replyFrom.name} <${email.replyFrom.address}>` : "—"}
          </dd>
          <dt className="text-muted-foreground">Asunto</dt>
          <dd className="[overflow-wrap:anywhere]">{email.replySubject}</dd>
        </dl>
        {email.replyFrom ? null : (
          <PageNotice tone="alarma" label="No puedes responder">
            Tu acceso al equipo ya no está activo: la respuesta no saldría.
          </PageNotice>
        )}
        {pendingReplies.length > 0 ? (
          <PageNotice tone="aviso" label="Antes de enviar otra">
            {pendingReplies.length === 1
              ? "Hay una respuesta de la que no se sabe si salió. Revísala en el correo antes de responder otra vez."
              : `Hay ${pendingReplies.length} respuestas de las que no se sabe si salieron. Revísalas en el correo antes de responder otra vez.`}
          </PageNotice>
        ) : null}
        <form.AppField name="body">
          {(field) => (
            <div className="flex flex-col gap-1.5">
              <field.TextareaField
                id="responder-texto"
                label="Respuesta"
                description={
                  draftNote ??
                  "Sale una sola vez, con el correo citado debajo. Si responde, vuelve a la dirección de «Desde»."
                }
                rows={8}
                maxLength={5000}
                autoFocus
              />
              <div>
                <SpeechInput
                  lang="es-PE"
                  size="icon"
                  type="button"
                  aria-label="Dictar la respuesta"
                  onTranscriptionChange={(text) =>
                    field.handleChange(`${field.state.value ? `${field.state.value} ` : ""}${text}`)
                  }
                />
              </div>
            </div>
          )}
        </form.AppField>
        {canAttach ? (
          <form.AppField name="proposalId">
            {(field) => (
              <field.SelectField
                id="responder-propuesta"
                label="Adjuntar una propuesta (opcional)"
                description={
                  proposals.isError
                    ? "No pude traer sus propuestas: puedes enviar sin adjuntar."
                    : sendable.length === 0 && !proposals.isPending
                      ? "No tiene una propuesta lista para enviar."
                      : "Va en PDF, como en «Escribir»."
                }
                options={[
                  { value: "", label: "Sin propuesta" },
                  ...sendable.map((proposal) => ({
                    value: proposal.id,
                    label: `Propuesta v${proposal.version} · ${proposal.plan.name} · ${proposalStatusWords(proposal)}`,
                  })),
                ]}
              />
            )}
          </form.AppField>
        ) : null}
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">El correo que respondes</summary>
          <p className="mt-2 text-muted-foreground">
            El {supportDayTime(email.receivedAt)}, {email.fromName ?? email.from} escribió:
          </p>
          <blockquote className="mt-1 whitespace-pre-wrap border-l-2 pl-3 text-muted-foreground [overflow-wrap:anywhere]">
            {email.text ?? "(El texto se borró a los 30 días de llegar.)"}
          </blockquote>
        </details>
      </div>
    </FormDrawer>
  )
}
