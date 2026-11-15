import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import { Badge, Button, toast } from "@odentia/ui"
import {
  AgentMark,
  common,
  DatePickerButton,
  ExpandableText,
  type FieldControl,
  FormDrawer,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { useFocusOnLeave } from "../../lib/focus"
import { supportDayTime } from "../../lib/support-words"
import { ProductMark } from "../product"
import { CHAT_CHANNEL_WORDS, chatChannelOf, momentWords, useChatsConfig } from "./chat-api"
import { ChatDrawer } from "./chat-drawer"
import { ChatOwnerDrawer, type ChatOwnerSubject } from "./chat-owner-drawer"
import { cargaMarkedWords } from "./client-files-tab"
import { ClientSearch } from "./client-search"
import { EmailDrawer } from "./email-drawer"
import { ClientName, type ClientTab, invalidateArm, OpenClientButton } from "./hoy-links"
import { NewClientDrawer, type NewClientValues } from "./new-client-drawer"

/**
 * Lo que preparó Kairós y espera el sí de una persona (`/api/admin/kairos`):
 * la tarjeta con su por qué, con qué datos y cuándo vence; Enviar o Aprobar,
 * Cambiar y Ahora no. Aprobar ejecuta la misma operación de la pantalla en el
 * servidor; un correo sale una sola vez, y un WhatsApp también, por el número
 * de Sallca y desde su conversación (sin él configurado, se abre por wa.me y
 * queda «¿Salió?» hasta que la persona lo dice). Nada se reintenta solo.
 *
 * Los correos: «responder_correo» trae el borrador de la respuesta y se envía
 * (o se cambia en el mismo cajón de «Responder»); «correo_sin_cliente» se
 * liga a un cliente, se responde sin ligarlo o crea el cliente con el correo.
 * «posible_carga» (solo Administración): «Sí, es la carga» la marca con la
 * operación de Documentos y «No» no la vuelve a preguntar; si ya pasaron 30
 * días desde que llegó, el botón dice antes que se borra al marcarlo.
 */

/** El tipo y el estado se leen como texto: uno nuevo del servidor no rompe la pantalla. */
export const kairosItemSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  product: z.enum(CLINICAL_PRODUCTS).nullable(),
  kind: z.string(),
  title: z.string(),
  reason: z.string(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()),
  ready: z.boolean(),
  /** Quién redactó el mensaje o el guion: el modelo o, si no está configurado, una plantilla. */
  drafter: z.enum(["modelo", "plantilla"]).nullable().default(null),
  /** Lo que se dice de un borrador hecho con plantilla (lo escribe el servidor); null si no. */
  draftNote: z.string().nullable().default(null),
  adminOnly: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedByName: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
})
export type KairosItem = z.infer<typeof kairosItemSchema>
export const kairosItemsSchema = z.object({
  items: z.array(kairosItemSchema),
  total: z.number().int().nonnegative(),
})

const decisionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  outreach: z
    .object({
      id: z.string(),
      channel: z.string(),
      to: z.string().nullable(),
      status: z.string(),
      whatsappUrl: z.string().nullable(),
      /** Salió por el número de Sallca: su conversación y, fuera de las 24 h, la plantilla. */
      chatId: z.string().nullable().default(null),
      template: z.string().nullable().default(null),
      /** Por qué no salió, si Meta lo rechazó. */
      why: z.string().nullable().default(null),
    })
    .nullable(),
  emailSent: z.boolean().nullable(),
})
type Decision = z.infer<typeof decisionSchema>

/** Lo que solo aprueba Administración (precios, ligar personas, fusionar, la carga de datos): el servidor también lo exige. */
const ADMIN_KINDS = new Set([
  "propuesta",
  "vinculo",
  "duplicado",
  "posible_carga",
  "chat_sin_cliente",
])

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null
const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : []

/** La pestaña de la ficha donde vive lo que preparó Kairós. */
export function kairosItemTab(kind: string): ClientTab {
  switch (kind) {
    case "propuesta":
    case "guion":
    case "presentacion_hecha":
      return "venta"
    case "vinculo":
      return "contactos"
    case "mensaje":
    case "responder_correo":
    case "responder_chat":
      return "historial"
    case "posible_carga":
      return "documentos"
    default:
      return "resumen"
  }
}

const channelOf = (item: Pick<KairosItem, "payload">): "correo" | "whatsapp" | null => {
  const channel = text(item.payload.channel)
  return channel === "correo" || channel === "whatsapp" ? channel : null
}

/** El botón del sí, en palabras de lo que hace (una carga que ya pasó los 30 días lo dice antes). */
export function approveLabel(
  item: Pick<KairosItem, "kind" | "payload">,
  /** El WhatsApp de Sallca está configurado: el mensaje sale de ahí, no se abre wa.me. */
  throughChat = false,
): string {
  switch (item.kind) {
    case "posible_carga":
      return item.payload.dueNow === true
        ? "Sí, es la carga: se borra al marcarlo"
        : "Sí, es la carga"
    case "mensaje":
      return channelOf(item) === "whatsapp" && !throughChat ? "Abrir WhatsApp" : "Enviar"
    case "guion":
      return "Listo"
    case "dato":
      return "Completar"
    case "vinculo":
      return "Ligar"
    case "duplicado":
      return "Revisar las dos"
    case "demo":
      return "Ir a Demos"
    case "presentacion_hecha":
      return "Sí, se hizo"
    case "responder_correo":
      return "Enviar"
    default:
      return "Aprobar"
  }
}

/** Lo que se puede cambiar aquí antes del sí; lo demás se cambia en la ficha. */
const CHANGEABLE = new Set(["mensaje", "presentacion_hecha", "dato", "correo_sin_cliente"])

/** «No» de una posible carga: no se vuelve a preguntar; «Ahora no» de lo demás. */
export const discardLabel = (kind: string): string => (kind === "posible_carga" ? "No" : "Ahora no")

/** Lo que dice el aviso después de decidir una posible carga (la fecha la da el servidor). */
export function possibleCargaDoneWords(
  item: Pick<KairosItem, "payload">,
  action: "aprobar" | "descartar",
  result: Record<string, unknown> | null,
): string {
  const filename = text(item.payload.filename) ?? "El archivo"
  if (action === "descartar") return `Listo: ${filename} no es la carga y se guarda`
  return cargaMarkedWords(filename, {
    file: { id: text(result?.fileId) ?? "", deleteAfter: text(result?.deleteAfter) },
    dueNow: result?.dueNow === true,
    deletedNow: false,
  })
}

/** «Vence el jue 13 nov, 10:05»; en rojo si le quedan menos de 6 horas (y lo dice la palabra «Vence»). */
function dueWords(expiresAt: string, now: Date): { text: string; urgent: boolean } {
  const left = new Date(expiresAt).getTime() - now.getTime()
  return { text: `Vence el ${supportDayTime(expiresAt)}`, urgent: left < 6 * 3_600_000 }
}

/** Lo que Kairós redacta antes de estar listo: hasta tenerlo, no se puede enviar. */
const DRAFTED = new Set(["mensaje", "guion", "responder_correo"])

/** «Juana Pérez <juana@…>» de un correo que llegó. */
const senderOf = (item: KairosItem): string => {
  const from = text(item.payload.from) ?? ""
  const name = text(item.payload.fromName)
  return name ? `${name} <${from}>` : from
}

/**
 * Responder o crear el cliente de un correo: Soporte, solo lo que llegó a
 * soporte@ (lo demás es comercial; el servidor lo niega igual y Kairós ni
 * siquiera se lo muestra).
 */
export const canAnswer = (item: KairosItem, isAdmin: boolean) =>
  isAdmin || text(item.payload.mailbox) === "soporte"

/** A quién va la respuesta: el remitente o, si pidió otra dirección (Reply-To), esa. */
export const replyTargetOf = (item: KairosItem): string => {
  const replyTo = text(item.payload.replyTo)
  return replyTo && replyTo !== text(item.payload.from)
    ? `${replyTo} (la dirección que pidió para responderle)`
    : senderOf(item)
}

const outreachWords = (item: KairosItem): string | null => {
  if (item.kind === "responder_correo") return `Respuesta por correo a ${replyTargetOf(item)}`
  const channel = channelOf(item)
  const to = text(item.payload.to)
  if (!channel) return null
  return channel === "whatsapp"
    ? `Por WhatsApp${to ? ` a ${to}` : ""}`
    : `Por correo${to ? ` a ${to}` : ""}`
}

/**
 * Lo que se dice después del sí de un WhatsApp que salió por el número de
 * Sallca: salió (o la plantilla para retomar, si pasaron 24 h: el texto no
 * va), no salió con el motivo de Meta, o no se sabe (no se reintenta).
 */
export function chatSendWords(outreach: {
  status: string
  to: string | null
  template: string | null
  why: string | null
}): { tone: "success" | "error" | "warning"; text: string } {
  const to = outreach.to ? ` a ${outreach.to}` : ""
  if (outreach.status === "enviado")
    return outreach.template
      ? {
          tone: "success",
          text: `Salió por WhatsApp${to} la plantilla para retomar: pasaron 24 horas desde su último mensaje y el texto no va. Cuando responda, sigue en su conversación.`,
        }
      : { tone: "success", text: `Salió por WhatsApp${to}. Queda en su historial.` }
  if (outreach.status === "no_salio")
    return {
      tone: "error",
      text: `No salió por WhatsApp${outreach.why ? `: ${outreach.why}` : ""}`,
    }
  return {
    tone: "warning",
    text: "No se sabe si salió por WhatsApp: no se reintenta. Revísalo en su historial y di si salió.",
  }
}

interface DecideInput {
  item: KairosItem
  action: "aprobar" | "descartar"
  edited?: Record<string, unknown>
  /** La pestaña abierta en el clic para el WhatsApp: el navegador no bloquea la que se abre así. */
  tab?: Window | null
}

/** Abre una pestaña vacía en el clic, si el sí va a dar un enlace de WhatsApp (sin el número de Sallca). */
export function tabForWhatsApp(
  item: KairosItem,
  action: "aprobar" | "descartar",
  throughChat = false,
): Window | null {
  if (
    throughChat ||
    action !== "aprobar" ||
    item.kind !== "mensaje" ||
    channelOf(item) !== "whatsapp"
  )
    return null
  try {
    return window.open("about:blank", "_blank")
  } catch {
    return null
  }
}

function openWhatsApp(url: string, tab: Window | null | undefined): void {
  if (tab && !tab.closed) {
    tab.opener = null
    tab.location.href = url
    return
  }
  window.open(url, "_blank", "noopener")
}

/**
 * Aprobar o descartar. El resultado lo dice el servidor: hecho, vencido (lo
 * vuelve a preparar), fallido (con su motivo), el correo enviado o del que no
 * se sabe si salió, o el enlace de WhatsApp que queda «¿Salió?».
 */
export function useKairosDecide() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async ({ item, action, edited }: DecideInput): Promise<Decision> =>
      decisionSchema.parse(
        await api<unknown>(`/api/admin/kairos/items/${item.id}/decide`, {
          method: "POST",
          body: JSON.stringify({ action, ...(edited ? { edited } : {}) }),
        }),
      ),
    onError: (_error, { tab }) => {
      tab?.close()
    },
    onSuccess: (decision, { item, action, tab }) => {
      invalidateArm(queryClient, item.clientId)
      if (decision.status === "vencida" || decision.status === "fallida") {
        tab?.close()
        toast.error(decision.error ?? "No se pudo hacer: ya no vale")
        return
      }
      if (item.kind === "posible_carga") {
        toast.success(possibleCargaDoneWords(item, action, decision.result))
        return
      }
      if (action === "descartar") {
        toast.success("Listo: no se hace")
        return
      }
      if (item.kind === "chat_sin_cliente") {
        toast.success("Listo: sus mensajes, los de antes y los que vengan, quedan en su ficha")
        return
      }
      const outreach = decision.outreach
      if (outreach?.channel === "whatsapp" && outreach.chatId) {
        tab?.close()
        const words = chatSendWords(outreach)
        toast[words.tone](words.text)
        return
      }
      if (outreach?.channel === "whatsapp" && outreach.whatsappUrl) {
        const url = outreach.whatsappUrl
        openWhatsApp(url, tab)
        toast.success("Se abrió WhatsApp con el mensaje. Cuando lo envíes, di si salió.", {
          action: {
            label: "Abrir otra vez",
            onClick: () => window.open(url, "_blank", "noopener"),
          },
        })
        return
      }
      tab?.close()
      if (outreach?.channel === "correo") {
        if (decision.emailSent) toast.success(`Enviado${outreach.to ? ` a ${outreach.to}` : ""}`)
        else
          toast.warning("No se sabe si el correo salió: no se reintenta. Revísalo y di si salió.")
        return
      }
      const open = text(decision.result?.open)
      if (open === "fusion") {
        const keepId = text(decision.result?.keepId)
        toast.success("Abre la ficha para decidir si se fusionan")
        if (keepId)
          void navigate({
            to: "/clients/$clientId",
            params: { clientId: keepId },
            search: { tab: undefined },
          })
        return
      }
      if (open === "demos") {
        void navigate({ to: "/demos" })
        return
      }
      toast.success("Hecho")
    },
  })
}

/** Una tarjeta de lo que Kairós dejó listo. */
export function KairosItemCard({
  item,
  isAdmin,
  now,
}: {
  item: KairosItem
  isAdmin: boolean
  now: Date
}) {
  if (CHAT_KINDS.has(item.kind)) return <ChatItemCard item={item} isAdmin={isAdmin} now={now} />
  return <DecisionCard item={item} isAdmin={isAdmin} now={now} />
}

/** Lo que llega por WhatsApp, Instagram o Messenger: se decide y se responde en la conversación. */
const CHAT_KINDS = new Set(["chat_sin_cliente", "responder_chat"])

function DecisionCard({ item, isAdmin, now }: { item: KairosItem; isAdmin: boolean; now: Date }) {
  const decide = useKairosDecide()
  const [changing, setChanging] = useState(false)
  const [replying, setReplying] = useState(false)
  const [creating, setCreating] = useState(false)
  const leave = useFocusOnLeave<HTMLLIElement>()
  const emailId = text(item.payload.emailId)
  /** El sí del ítem con lo que se cambió: lo usan «Responder» (el texto) y «Crear cliente» (el cliente). */
  const approveWith = async (edited: Record<string, unknown>) => {
    leave.markLeaving()
    await decide.mutateAsync({ item, action: "aprobar", edited })
  }
  const due = dueWords(item.expiresAt, now)
  // Una posible carga a los 25 días ya es urgente (a los 30 se borraría al marcarla).
  const urgent = due.urgent || (item.kind === "posible_carga" && item.payload.urgent === true)
  const facts = textList(item.payload.facts)
  const subject = text(item.payload.subject)
  const body = text(item.payload.body)
  const onlyAdmin = ADMIN_KINDS.has(item.kind) && !isAdmin
  const needsClient = item.kind === "correo_sin_cliente" && !text(item.payload.clientId)
  const throughChat = useChatsConfig().data?.whatsapp === true
  const run = (action: "aprobar" | "descartar") => {
    const tab = tabForWhatsApp(item, action, throughChat)
    leave.markLeaving()
    decide.mutate(
      { item, action, tab },
      { onError: (error) => toast.error(submitErrorMessage(error)) },
    )
  }
  const pending = decide.isPending
  return (
    <li ref={leave.ref} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <AgentMark size="sm" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium [overflow-wrap:anywhere]">{item.title}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {item.clientId && item.clientName ? (
              <ClientName clientId={item.clientId} tab={kairosItemTab(item.kind)}>
                {item.clientName}
              </ClientName>
            ) : (
              <span>Sin cliente todavía</span>
            )}
            {item.product ? <ProductMark product={item.product} /> : null}
          </p>
        </div>
        <Badge variant={urgent ? "destructive" : "outline"}>{due.text}</Badge>
      </div>
      <p className="text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">Por qué: </span>
        {item.reason}
      </p>
      {facts.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">Con qué datos</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground [overflow-wrap:anywhere]">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {DRAFTED.has(item.kind) ? (
        item.ready && body ? (
          <div className="rounded-lg bg-muted p-3 text-sm">
            {outreachWords(item) ? (
              <p className="text-xs text-muted-foreground">{outreachWords(item)}</p>
            ) : null}
            {subject ? (
              <p className="mt-1 font-medium [overflow-wrap:anywhere]">{subject}</p>
            ) : null}
            <ExpandableText
              text={body}
              lines={3}
              label="el texto completo"
              className="mt-1 whitespace-pre-line"
            />
            {item.drafter === "plantilla" && item.draftNote ? (
              <p className="mt-2 text-xs text-muted-foreground">{item.draftNote}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Kairós lo está redactando; cuando esté listo se puede enviar.
          </p>
        )
      ) : null}
      {onlyAdmin ? (
        <p className="text-sm text-muted-foreground">Esto lo aprueba Administración.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onlyAdmin ? null : needsClient ? (
          <Button type="button" size="sm" disabled={pending} onClick={() => setChanging(true)}>
            Elegir el cliente
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={pending || (DRAFTED.has(item.kind) && !item.ready)}
            onClick={() => run("aprobar")}
          >
            {approveLabel(item, throughChat)}
          </Button>
        )}
        {item.kind === "responder_correo" && emailId && item.ready ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setReplying(true)}
          >
            Cambiar
          </Button>
        ) : null}
        {item.kind === "correo_sin_cliente" && emailId && canAnswer(item, isAdmin) ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setReplying(true)}
            >
              Responder
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setCreating(true)}
            >
              Crear cliente con este correo
            </Button>
          </>
        ) : null}
        {!onlyAdmin && CHANGEABLE.has(item.kind) && !needsClient && item.ready ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setChanging(true)}
          >
            Cambiar
          </Button>
        ) : !CHANGEABLE.has(item.kind) &&
          item.kind !== "demo" &&
          item.kind !== "responder_correo" &&
          item.clientId ? (
          <OpenClientButton
            clientId={item.clientId}
            tab={kairosItemTab(item.kind)}
            label={
              item.kind === "propuesta"
                ? "Cambiar en la ficha"
                : item.kind === "posible_carga"
                  ? "Ver en Documentos"
                  : "Abrir ficha"
            }
          />
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run("descartar")}
        >
          {discardLabel(item.kind)}
        </Button>
      </div>
      {CHANGEABLE.has(item.kind) ? (
        <KairosChangeDrawer
          item={item}
          open={changing}
          onClose={() => setChanging(false)}
          onApproving={leave.markLeaving}
        />
      ) : null}
      {emailId && replying ? (
        item.kind === "responder_correo" ? (
          // «Cambiar» es responder con el borrador de Kairós; «Enviar» es su sí.
          <EmailDrawer
            emailId={emailId}
            open
            replying
            draft={body ?? ""}
            draftNote={item.drafter === "plantilla" ? item.draftNote : null}
            onSend={(edited) => approveWith({ body: edited })}
            onClose={() => setReplying(false)}
          />
        ) : (
          // Responder sin ligarlo: el ítem sigue esperando que digan de quién es.
          <EmailDrawer emailId={emailId} open replying onClose={() => setReplying(false)} />
        )
      ) : null}
      {creating ? (
        <NewClientDrawer
          open
          title="Crear cliente con este correo"
          initial={newClientFromEmail(item)}
          onCreated={(clientId) => approveWith({ clientId })}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </li>
  )
}

/** «Hoy 09:05»: la hora del mensaje, con mayúscula al empezar la línea. */
const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1)

/**
 * Lo que dice debajo del título de una conversación: cuándo escribió y, sin
 * cliente, que es solo de Administración (WhatsApp) o hasta cuándo se le
 * puede responder (Instagram y Messenger no dejan retomar con plantilla).
 */
export function chatItemMeta(item: Pick<KairosItem, "kind" | "payload">, now: Date): string[] {
  const channel = chatChannelOf(item.payload.channel)
  const receivedAt = text(item.payload.receivedAt)
  const when = receivedAt ? momentWords(receivedAt, now) : null
  if (item.kind === "responder_chat") return [CHAT_CHANNEL_WORDS[channel], ...(when ? [when] : [])]
  const until =
    channel !== "whatsapp" && receivedAt
      ? `Responde hasta ${momentWords(new Date(Date.parse(receivedAt) + 86_400_000).toISOString(), now)}`
      : "Solo administración"
  return [...(when ? [capitalized(when)] : []), until]
}

/** Lo que se sabe de la conversación sin cliente para «¿De quién es?». */
export function chatSubjectOf(item: Pick<KairosItem, "payload">): ChatOwnerSubject | null {
  const chatId = text(item.payload.chatId)
  if (!chatId) return null
  const raw = item.payload.suggestion
  const hint = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  const contactId = text(hint?.contactId)
  const contactName = text(hint?.contactName)
  const clientId = text(hint?.clientId)
  const clientName = text(hint?.clientName)
  return {
    chatId,
    channel: chatChannelOf(item.payload.channel),
    address: text(item.payload.address) ?? "",
    displayName: text(item.payload.displayName),
    lastBody: text(item.payload.lastBody),
    receivedAt: text(item.payload.receivedAt),
    suggestion:
      contactId && contactName && clientId && clientName
        ? { contactId, contactName, clientId, clientName }
        : null,
  }
}

/**
 * La tarjeta de una conversación: quién escribió, cuándo, lo que dice y
 * «Responder»; sin cliente, además «¿De quién es?». Decir de quién es es el sí
 * del ítem (la misma operación que «Mover a otra clínica»).
 */
function ChatItemCard({ item, isAdmin, now }: { item: KairosItem; isAdmin: boolean; now: Date }) {
  const decide = useKairosDecide()
  const leave = useFocusOnLeave<HTMLLIElement>()
  const [replying, setReplying] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const chatId = text(item.payload.chatId)
  const subject = item.kind === "chat_sin_cliente" ? chatSubjectOf(item) : null
  const onlyAdmin = ADMIN_KINDS.has(item.kind) && !isAdmin
  const body = text(item.payload.lastBody) ?? "Mandó un archivo"
  const pending = decide.isPending
  return (
    <li ref={leave.ref} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <AgentMark size="sm" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium [overflow-wrap:anywhere]">{item.title}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {chatItemMeta(item, now).map((words, index) => (
              <span key={words} className="flex items-center gap-x-2">
                {index > 0 ? <span aria-hidden>·</span> : null}
                {words}
              </span>
            ))}
            {item.product ? <ProductMark product={item.product} /> : null}
          </p>
        </div>
      </div>
      <blockquote className="rounded-lg border-l-2 bg-muted p-3 text-sm [overflow-wrap:anywhere]">
        <ExpandableText
          text={body}
          lines={3}
          label="el mensaje completo"
          className="whitespace-pre-line"
        />
      </blockquote>
      {item.payload.maybeCarga === true && isAdmin ? (
        <p className="text-sm text-muted-foreground">
          Trae un Excel, CSV o Word: puede ser la carga de datos.
        </p>
      ) : null}
      {onlyAdmin ? (
        <p className="text-sm text-muted-foreground">Esto lo decide Administración.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {chatId ? (
            <Button type="button" size="sm" disabled={pending} onClick={() => setReplying(true)}>
              Responder
            </Button>
          ) : null}
          {subject ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setDeciding(true)}
            >
              ¿De quién es?
            </Button>
          ) : null}
          {item.clientId ? (
            <OpenClientButton clientId={item.clientId} tab="historial" label="Abrir ficha" />
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              leave.markLeaving()
              decide.mutate(
                { item, action: "descartar" },
                { onError: (error) => toast.error(submitErrorMessage(error)) },
              )
            }}
          >
            Ahora no
          </Button>
        </div>
      )}
      {chatId && replying ? (
        <ChatDrawer chatId={chatId} open onClose={() => setReplying(false)} />
      ) : null}
      {subject && deciding ? (
        <ChatOwnerDrawer
          subject={subject}
          onAssign={async ({ clientId, contactId }) => {
            leave.markLeaving()
            await decide.mutateAsync({
              item,
              action: "aprobar",
              edited: { clientId, ...(contactId ? { contactId } : {}) },
            })
          }}
          onClose={() => setDeciding(false)}
        />
      ) : null}
    </li>
  )
}

/** Lo que se sabe del remitente para «Nuevo cliente»: su correo, su nombre y la marca. */
export function newClientFromEmail(item: KairosItem): Partial<NewClientValues> {
  const product = text(item.payload.product)
  const mailbox = text(item.payload.mailbox)
  // La dirección real de la persona («ana.torres@»), si el ítem la trae.
  const personal = text(item.payload.to)?.split("@")[0]?.split("+")[0]
  return {
    contactName: text(item.payload.fromName) ?? "",
    email: text(item.payload.from) ?? "",
    ...(product && (CLINICAL_PRODUCTS as readonly string[]).includes(product)
      ? { product: product as ClinicalProduct }
      : {}),
    origin: "otro",
    originDetail: mailbox
      ? `Nos escribió a ${mailbox === "persona" ? (personal ? `${personal}@` : "una persona del equipo") : `${mailbox}@`}`
      : "",
  }
}

/* ---------- Cambiar ---------- */

const OUTCOMES = [
  { value: "se_hizo", label: "Se hizo" },
  { value: "no_se_conecto", label: "No se conectó" },
  { value: "reprogramar", label: "Hay que reprogramarla" },
] as const
const PROFESSIONALS = [
  { value: "", label: "Sin cambiar" },
  { value: "1", label: "1" },
  { value: "2-3", label: "De 2 a 3" },
  { value: "4-9", label: "De 4 a 9" },
  { value: "10+", label: "10 o más" },
]
const TOOLS = [
  { value: "", label: "Sin cambiar" },
  { value: "nada", label: "Nada" },
  { value: "cuaderno_excel", label: "Cuaderno o Excel" },
  { value: "otro_software", label: "Otro programa" },
]

interface ChangeValues {
  edited: {
    subject: string
    body: string
    outcome: string
    nextDueOn: string
    clientId: string
    fields: { city: string; professionals: string; currentTool: string }
  }
}

function valuesOf(item: KairosItem): ChangeValues {
  const fields = (
    item.payload.fields && typeof item.payload.fields === "object" ? item.payload.fields : {}
  ) as Record<string, unknown>
  return {
    edited: {
      subject: text(item.payload.subject) ?? "",
      body: text(item.payload.body) ?? "",
      outcome: text(item.payload.outcome) ?? "se_hizo",
      nextDueOn: text(item.payload.nextDueOn) ?? "",
      clientId: text(item.payload.clientId) ?? "",
      fields: {
        city: text(fields.city) ?? "",
        professionals: text(fields.professionals) ?? "",
        currentTool: text(fields.currentTool) ?? "",
      },
    },
  }
}

/** Solo lo que ese tipo deja cambiar (el servidor rechaza lo demás). */
function editedOf(item: KairosItem, values: ChangeValues): Record<string, unknown> {
  const edited = values.edited
  switch (item.kind) {
    case "mensaje":
      return channelOf(item) === "correo"
        ? { subject: edited.subject.trim(), body: edited.body }
        : { body: edited.body }
    case "presentacion_hecha":
      return {
        outcome: edited.outcome,
        body: edited.body,
        ...(edited.nextDueOn ? { nextDueOn: edited.nextDueOn } : {}),
      }
    case "dato": {
      const fields: Record<string, string> = {}
      if (edited.fields.city.trim()) fields.city = edited.fields.city.trim()
      if (edited.fields.professionals) fields.professionals = edited.fields.professionals
      if (edited.fields.currentTool) fields.currentTool = edited.fields.currentTool
      return { fields }
    }
    case "correo_sin_cliente":
      return { clientId: edited.clientId }
    default:
      return {}
  }
}

const changeSchema = (kind: string) =>
  z.object({
    edited: z.object({
      subject: z.string().max(200, "Usa como máximo 200 caracteres"),
      body:
        kind === "mensaje" || kind === "presentacion_hecha"
          ? z
              .string()
              .trim()
              .min(1, kind === "mensaje" ? "Escribe el mensaje" : "Escribe qué pasó")
              .max(5000, "Usa como máximo 5000 caracteres")
          : z.string(),
      outcome: z.string(),
      nextDueOn: z.string(),
      clientId:
        kind === "correo_sin_cliente"
          ? z.string().min(1, "Elige el cliente de este correo")
          : z.string(),
      fields: z.object({
        city: z.string().max(120, "Usa como máximo 120 caracteres"),
        professionals: z.string(),
        currentTool: z.string(),
      }),
    }),
  })

/** «Cambiar»: lo mismo que preparó Kairós, editable, y el mismo sí al final. */
function KairosChangeDrawer({
  item,
  open,
  onClose,
  onApproving,
}: {
  item: KairosItem
  open: boolean
  onClose: () => void
  /** Al dar el sí la tarjeta se va: el foco pasa a la vecina (`useFocusOnLeave`). */
  onApproving: () => void
}) {
  const decide = useKairosDecide()
  const throughChat = useChatsConfig().data?.whatsapp === true
  const form = useAppForm({
    defaultValues: valuesOf(item),
    validators: { onSubmit: changeSchema(item.kind) },
    onSubmit: async ({ value, formApi }) => {
      const tab = tabForWhatsApp(item, "aprobar", throughChat)
      onApproving()
      await decide.mutateAsync({ item, action: "aprobar", edited: editedOf(item, value), tab })
      formApi.reset(value)
      onClose()
    },
  })
  const channel = channelOf(item)
  const title =
    item.kind === "mensaje"
      ? "Cambiar el mensaje"
      : item.kind === "presentacion_hecha"
        ? "¿Cómo fue la presentación?"
        : item.kind === "dato"
          ? "Cambiar los datos"
          : "¿De qué cliente es este correo?"
  const submitLabel =
    item.kind === "mensaje"
      ? channel === "whatsapp" && !throughChat
        ? "Abrir WhatsApp"
        : "Enviar"
      : item.kind === "correo_sin_cliente"
        ? "Asignar"
        : "Guardar"
  return (
    <FormDrawer
      {...useFormSurface(form)}
      open={open}
      onClose={onClose}
      title={title}
      description={item.clientName ? `${item.title} · ${item.clientName}` : item.title}
      submitLabel={submitLabel}
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-5">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <AgentMark size="sm" />
          <span>Kairós lo preparó así. {item.reason}</span>
        </p>
        {item.drafter === "plantilla" && item.draftNote ? (
          <p className="text-sm text-muted-foreground">{item.draftNote}</p>
        ) : null}
        {item.kind === "mensaje" ? (
          <>
            <p className="text-sm">{outreachWords(item)}</p>
            {channel === "correo" ? (
              <form.AppField name="edited.subject">
                {(field) => <field.TextField id="kairos-asunto" label="Asunto" maxLength={200} />}
              </form.AppField>
            ) : null}
            <form.AppField name="edited.body">
              {(field) => (
                <field.TextareaField id="kairos-texto" label="Mensaje" rows={8} maxLength={5000} />
              )}
            </form.AppField>
            {channel === "whatsapp" ? (
              <p className="text-sm text-muted-foreground">
                {throughChat
                  ? "Sale una sola vez por el WhatsApp de Sallca y queda en su conversación. Si pasaron 24 horas desde su último mensaje, WhatsApp solo deja retomar con la plantilla: este texto no va."
                  : "Se abre WhatsApp con este texto; lo envías tú. Después di si salió."}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sale una sola vez. Si no se sabe si salió, no se reintenta.
              </p>
            )}
          </>
        ) : null}
        {item.kind === "presentacion_hecha" ? (
          <>
            <form.AppField name="edited.outcome">
              {(field) => <field.RadioGroupField legend="Cómo fue" options={OUTCOMES} />}
            </form.AppField>
            <form.AppField name="edited.body">
              {(field) => (
                <field.TextareaField
                  id="kairos-que-paso"
                  label="Qué pasó"
                  rows={4}
                  maxLength={5000}
                />
              )}
            </form.AppField>
            <form.AppField name="edited.nextDueOn">
              {(field) => (
                <field.Control
                  id="kairos-proximo"
                  label={
                    <>
                      Próximo paso{" "}
                      <span className="font-normal text-muted-foreground">(opcional)</span>
                    </>
                  }
                >
                  {(control) => (
                    <DatePickerButton
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      value={field.state.value}
                      onChange={(day) => {
                        field.handleChange(day)
                        field.handleBlur()
                      }}
                      emptyLabel="Sin fecha"
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          </>
        ) : null}
        {item.kind === "dato" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Kairós solo completa lo que está vacío: nunca cambia lo que escribió una persona.
            </p>
            <form.AppField name="edited.fields.city">
              {(field) => <field.TextField id="kairos-ciudad" label="Ciudad" maxLength={120} />}
            </form.AppField>
            <form.AppField name="edited.fields.professionals">
              {(field) => (
                <field.SelectField
                  id="kairos-profesionales"
                  label="Cuántos profesionales son"
                  options={PROFESSIONALS}
                />
              )}
            </form.AppField>
            <form.AppField name="edited.fields.currentTool">
              {(field) => (
                <field.SelectField
                  id="kairos-herramienta"
                  label="Con qué trabajan hoy"
                  options={TOOLS}
                />
              )}
            </form.AppField>
          </>
        ) : null}
        {item.kind === "correo_sin_cliente" ? (
          <form.AppField name="edited.clientId">
            {(field) => (
              <field.Group legend="Cliente">
                {(control) => (
                  <EmailClientPicker
                    item={item}
                    control={control}
                    value={field.state.value}
                    onChange={(clientId) => {
                      field.handleChange(clientId)
                      field.handleBlur()
                    }}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** El cliente de un correo que llegó: quién lo escribió y la búsqueda. */
function EmailClientPicker({
  item,
  control,
  value,
  onChange,
}: {
  item: KairosItem
  control: FieldControl
  value: string
  onChange: (clientId: string) => void
}) {
  const from = [text(item.payload.fromName), text(item.payload.from)].filter(Boolean).join(" · ")
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-muted p-3 text-sm">
        <p className="font-medium [overflow-wrap:anywhere]">{from || "Remitente sin nombre"}</p>
        {text(item.payload.subject) ? (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {text(item.payload.subject)}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          El correo y sus adjuntos se leen en la ficha, no aquí.
        </p>
      </div>
      <ClientSearch
        id="kairos-buscar-cliente"
        initialQuery={text(item.payload.fromName) ?? ""}
        control={control}
        value={value}
        onChange={(clientId) => onChange(clientId)}
      />
    </div>
  )
}

/* ---------- ¿Salió? ---------- */

/**
 * Los envíos aprobados de los que no se sabe si salieron: el WhatsApp abierto
 * por su enlace y el correo que quedó incierto. Los responde una persona con
 * «Salió» o «No salió» (la misma operación de los envíos de la ficha); nada se
 * reintenta solo. Vive en los ítems ya decididos, así que sigue aquí al
 * recargar.
 */
export function useKairosUnconfirmed() {
  return useQuery({
    queryKey: ["admin", "kairos", "items", "hecho", "por-confirmar"],
    queryFn: async () =>
      kairosItemsSchema
        .parse(await api<unknown>("/api/admin/kairos/items?status=hecho&limit=100"))
        .items.filter((item) => item.status === "incierta" && text(item.result?.outreachId)),
  })
}

export function KairosUnconfirmed({ product }: { product?: ClinicalProduct | undefined }) {
  const unconfirmed = useKairosUnconfirmed()
  const rows = (unconfirmed.data ?? []).filter((item) => !product || item.product === product)
  if (rows.length === 0) return null
  return (
    <section aria-labelledby="kairos-salio" className="space-y-3">
      <h2 id="kairos-salio" className="text-base font-semibold">
        ¿Salió?
      </h2>
      <p className="text-sm text-muted-foreground">
        No se sabe si estos mensajes llegaron. Dilo tú: nada se vuelve a enviar solo.
      </p>
      <ul className="divide-y rounded-xl border bg-card">
        {rows.map((item) => (
          <UnconfirmedRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function UnconfirmedRow({ item }: { item: KairosItem }) {
  const queryClient = useQueryClient()
  const leave = useFocusOnLeave<HTMLLIElement>()
  const outreachId = text(item.result?.outreachId) ?? ""
  const channel = text(item.result?.channel) ?? channelOf(item)
  const resolve = useMutation({
    mutationFn: async (outcome: "salio" | "no_salio") => {
      leave.markLeaving()
      return api(`/api/admin/clients/outreach/${outreachId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      })
    },
    onSuccess: (_data, outcome) => {
      invalidateArm(queryClient, item.clientId)
      toast.success(outcome === "salio" ? "Anotado: salió" : "Anotado: no salió")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  return (
    <li ref={leave.ref} className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex flex-wrap items-center gap-x-2 font-medium [overflow-wrap:anywhere]">
          {item.clientId && item.clientName ? (
            <ClientName clientId={item.clientId} tab="historial">
              {item.clientName}
            </ClientName>
          ) : (
            <span>{item.clientName ?? "Sin cliente"}</span>
          )}
          {item.product ? <ProductMark product={item.product} /> : null}
        </p>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {channel === "whatsapp"
            ? // Por el número de Sallca queda «incierto»; por wa.me, abierto y sin saberse.
              item.result?.outreachStatus === "incierto"
              ? "WhatsApp que no se sabe si salió"
              : "WhatsApp abierto"
            : "Correo que no se sabe si salió"}{" "}
          · {item.title}
          {item.decidedAt
            ? ` · ${item.decidedByName ? `lo aprobó ${item.decidedByName} ` : ""}el ${supportDayTime(item.decidedAt)}`
            : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={resolve.isPending || !outreachId}
          onClick={() => resolve.mutate("salio")}
        >
          Salió
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={resolve.isPending || !outreachId}
          onClick={() => resolve.mutate("no_salio")}
        >
          No salió
        </Button>
      </div>
    </li>
  )
}
