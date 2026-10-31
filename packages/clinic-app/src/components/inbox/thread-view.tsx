import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  ScrollArea,
  Spinner,
  toast,
  Badge,
} from "@odentia/ui"
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@odentia/ui/components/ai-elements/attachments"
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@odentia/ui/components/ai-elements/prompt-input"
import { ConfirmDialog, EmptyState, ErrorState, RowActions, SpeechInput } from "@odentia/ui-patterns"
import { ThreadSkeleton } from "../skeletons/inbox"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bot, CheckCircle2, ChevronDown, ChevronLeft, Copy, CornerDownLeft, Hand, PanelRight } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { AnswerTrace } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError, apiFetch, apiUpload } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import {
  channelsWords,
  closeWithoutResolvingWords,
  closureBand,
  conversationWords,
  dayWords,
  listTimeWords,
  messageDayKey,
  pendingWords,
  replyWindowWords,
  topicQuote,
  topicWords,
} from "../../lib/conversation-state"
import {
  attachmentWords,
  type ChatMessage,
  type ConversationAttention,
  type ConversationClosure,
  type ConversationDetail,
  type InboxTopic,
  type PersonChannel,
  type ResolvePreview,
  timeAgo,
  useMyUserId,
  usePermission,
} from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { createPersonalLinkForContact, createRegistrationLink } from "../../lib/patient-registration"
import { filiationGapsText } from "../../lib/patients"
import { invalidateAgentPanelQueries } from "../agent-panel"
import { AnswerTraceDrawer } from "../agent/answer-trace"
import { CaseBriefDrawer } from "../agent/case-brief"
import { CorrectDrawer, type CorrectionTarget } from "../agent/correct-drawer"
import { LessonDrawer } from "../agent/lesson-drawer"
import { BlockPersonDialog, ContactScreenBanner, conversationTarget, useContactScreenActions } from "../inbox-contact-screen"
import { InboxApprovedMessages } from "../integrations/whatsapp/inbox-approved-messages"
import { AgentActionCard, type AgentActionItem, AgentActionLines, useAgentActions } from "./agent-actions"
import { StateLabel } from "./conversation-list"
import { MessageBubble } from "./message-bubble"

type TimelineEntry =
  | { kind: "day"; key: string; words: string }
  | { kind: "message"; msg: ChatMessage }
  | { kind: "card"; item: AgentActionItem }
  | { kind: "lines"; items: AgentActionItem[] }

/**
 * Mensajes y acciones del agente, por hora y con un separador por día. Las
 * líneas seguidas se juntan: varias dicen «hizo 3 cosas» y se abren al tocar.
 */
function buildTimeline(messages: ChatMessage[], actions: AgentActionItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let day: string | null = null
  const dayOf = (at: string) => {
    const key = messageDayKey(at)
    if (key !== day) {
      day = key
      entries.push({ kind: "day", key, words: dayWords(at) })
    }
  }
  const putAction = (item: AgentActionItem) => {
    dayOf(item.at)
    const last = entries[entries.length - 1]
    if (item.style === "tarjeta") entries.push({ kind: "card", item })
    else if (last?.kind === "lines") last.items.push(item)
    else entries.push({ kind: "lines", items: [item] })
  }
  let next = 0
  for (const msg of messages) {
    while (next < actions.length && (actions[next] as AgentActionItem).at <= msg.createdAt) putAction(actions[next++] as AgentActionItem)
    dayOf(msg.createdAt)
    entries.push({ kind: "message", msg })
  }
  while (next < actions.length) putAction(actions[next++] as AgentActionItem)
  return entries
}

interface Member {
  userId: string
  role: string
  user: { email: string; name: string }
}

export function ThreadView({
  openId,
  members,
  orgName,
  orgSlug,
  canRead,
  canWrite,
  canRegister,
  prepareRegistration,
  onConsumePrepareRegistration,
  onBack,
  showBack,
  onToggleContext,
  contextOpen,
  attention,
  listClosure,
  row,
  onNextTopic,
  onOpenContext,
}: {
  /** La conversación con que se abrió; «Responder por» puede pasar a otro canal de la persona. */
  openId: string
  members: Member[]
  orgName: string
  orgSlug: string
  canRead: boolean
  canWrite: boolean
  canRegister: boolean
  prepareRegistration: boolean
  onConsumePrepareRegistration: () => void
  onBack: () => void
  showBack?: boolean
  onToggleContext?: () => void
  contextOpen?: boolean
  /** Estado de atención del hilo según la lista; ausente si se abrió por enlace y aún no está en la página cargada. */
  attention?: ConversationAttention
  /** Cierre según la lista, mientras llega el detalle. */
  listClosure?: ConversationClosure | null
  /** La conversación que muestra la fila de la persona: la cabecera dice su estado aunque se responda por otro canal. */
  row?: { id: string; status: string }
  /** Abre el siguiente tema por atender; ausente si no hay otro. */
  onNextTopic?: () => void
  /** Abre una sección de «Contexto»; ausente si quien mira no ve el contexto. */
  onOpenContext?: (section: AgentActionItem["opens"] & string) => void
}) {
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  // La conversación que responde (decisión 6 del pulido): la abierta, o la del
  // canal elegido en «Responder por». El historial es el de toda la persona.
  const [id, setId] = useState(openId)
  const switchingRef = useRef(false)
  // Si el último cambio de `id` fue «Responder por»: lo leen los efectos que vienen después.
  const lastSwitchRef = useRef(false)
  const [composer, setComposer] = useState("")
  const [older, setOlder] = useState<ChatMessage[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // WhatsApp cerró la ventana de 24 horas con el hilo ya abierto: el servidor lo dijo al enviar.
  const [windowClosed, setWindowClosed] = useState(false)
  const [markedRef, setMarkedRef] = useState<string | null>(null)
  const [registrationLink, setRegistrationLink] = useState<{
    url: string
    expiresAt: string
  } | null>(null)
  const [registrationError, setRegistrationError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const intentConsumedRef = useRef(false)

  const detailQuery = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => apiFetch<{ data: ConversationDetail }>(`/api/conversations/${id}`),
    enabled: canRead,
    // Al cambiar de canal sigue a la vista la misma persona mientras llega el otro.
    placeholderData: keepPreviousData,
  })

  const detail = detailQuery.data?.data
  const messages = useMemo(() => [...older, ...(detail?.messages ?? [])], [older, detail?.messages])
  // Los canales de la persona (fase 4 del pulido); sin el dato, solo este.
  const personChannels: PersonChannel[] = detail?.person?.channels ?? []
  const personIds = personChannels.length > 0 ? personChannels.map((item) => item.conversationId) : [id]

  // En qué se basó cada respuesta del agente, en todos sus canales: solo se ofrece en los mensajes que la tienen.
  const tracesQuery = useQuery({
    queryKey: ["agent-answer-traces", id, personIds.join(",")],
    queryFn: async () => ({
      data: (
        await Promise.all(
          personIds.map((conversationId) =>
            apiFetch<{ data: AnswerTrace[] }>(`/api/agent/answer-traces?conversationId=${conversationId}`),
          ),
        )
      ).flatMap((page) => page.data),
    }),
    enabled: canRead,
  })
  const traceByMessage = useMemo(() => {
    const map = new Map<string, AnswerTrace>()
    // Llegan de la más reciente a la más antigua: la primera de cada mensaje es la vigente.
    for (const trace of tracesQuery.data?.data ?? []) {
      if (trace.messageId && !map.has(trace.messageId)) map.set(trace.messageId, trace)
    }
    return map
  }, [tracesQuery.data])
  const [openTrace, setOpenTrace] = useState<AnswerTrace | null>(null)
  const actionsQuery = useAgentActions(id, canRead)
  // Marcar una respuesta del agente (bien o por corregir) es de quien atiende
  // conversaciones; lo que se aprende lo aprueba quien administra el agente.
  const canDecideAgent = usePermission("agent.decide")
  const canWriteConversations = usePermission("conversations.write")
  const canCorrectAgent = canDecideAgent || canWriteConversations
  const canManageAgent = usePermission("agent.write")
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState<CorrectionTarget | null>(null)
  // Resumen del caso para quien lo toma; guarda la conversación para que no siga abierto al cambiar de hilo.
  const canTakeCase = usePermission("conversations.write")
  const myUserId = useMyUserId()
  // Quien aún no es paciente solo lo ven recepción y quien dirige (`crm.read`); caja y odontología, solo pacientes.
  const canOpenPeople = usePermission("patients.read")
  const canSeeNonPatients = usePermission("crm.read")
  const [briefFor, setBriefFor] = useState<string | null>(null)
  // Temas (ADR 0050): a qué mensaje responde la caja (undefined = el tema pendiente
  // más antiguo de quien mira; null = mensaje nuevo, sin tema), si se ve solo el
  // tema y si el último envío lo dejó resuelto.
  const [replyTo, setReplyTo] = useState<string | null | undefined>(undefined)
  // «Es spam» y «Bloquear a esta persona…» (ADR 0054).
  const screenActions = useContactScreenActions()
  const [blocking, setBlocking] = useState(false)
  const [passing, setPassing] = useState<InboxTopic | null>(null)
  const [doneTopic, setDoneTopic] = useState(false)
  const keepPendingRef = useRef(false)
  // Pasadas las 24 horas: elegir un mensaje aprobado en vez de responder el tema
  // (R1), o escribirle por WhatsApp desde Instagram o Messenger (tablero 4b).
  const [useApproved, setUseApproved] = useState(false)
  const [viaWhatsapp, setViaWhatsapp] = useState(false)
  // La conversación de WhatsApp a la que fue la respuesta: el hilo de Instagram lo dice.
  const [sentToWhatsapp, setSentToWhatsapp] = useState<string | null>(null)

  useEffect(() => {
    // Cambiar de canal con «Responder por» conserva lo escrito y el historial ya cargado: es la misma persona.
    const switching = switchingRef.current
    switchingRef.current = false
    lastSwitchRef.current = switching
    if (!switching) {
      setOlder([])
      setOlderCursor(null)
      setComposer("")
      // El enlace ya preparado es de la persona: al cambiar de canal se vuelve a usar.
      setRegistrationLink(null)
      setRegistrationError(null)
      setCopied(false)
    }
    setWindowClosed(false)
    setMarkedRef(null)
    setSendError(null)
    setOpenTrace(null)
    setCorrecting(null)
    setConfirming(null)
    setReplyTo(undefined)
    setDoneTopic(false)
    setBlocking(false)
    setUseApproved(false)
    setViaWhatsapp(false)
    setSentToWhatsapp(null)
  }, [id])
  // Abrirla la deja leída en todos sus canales.
  const unread = detail ? (detail.person?.unreadCount ?? detail.conversation.unreadCount) : 0
  useEffect(() => {
    if (detail && unread > 0 && markedRef !== id) {
      setMarkedRef(id)
      void apiFetch(`/api/conversations/${id}/read`, { method: "POST" }).then(() =>
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      )
    }
  }, [detail, unread, id, markedRef, queryClient])

  // Cuando la persona vuelve a escribir, la ventana se abre de nuevo: manda lo que diga el servidor.
  const lastInboundAt = detail?.whatsappWindow?.lastInboundAt
  useEffect(() => {
    setWindowClosed(false)
  }, [lastInboundAt])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", id] })
    void queryClient.invalidateQueries({ queryKey: ["conversations"] })
  }

  const registrationMutation = useMutation({
    // Quien ya es paciente registra a un familiar; quien aún no lo es recibe «Su enlace» (ADR 0037).
    mutationFn: (contactId: string) =>
      detail?.contact.isPatient ? createRegistrationLink(contactId, id) : createPersonalLinkForContact(contactId, id),
    onSuccess: (result) => {
      setRegistrationLink(result.data)
      setRegistrationError(null)
      setCopied(false)
      pasteRegistrationLink(result.data.url)
    },
    onError: (error) => {
      setRegistrationError(error instanceof ApiError ? error.message : "No se pudo crear el enlace")
    },
  })

  // Preparar el borrador en el composer existente; el operador revisa y envía.
  // Nunca se envía automáticamente al generar el enlace. Quien ya es paciente
  // lo recibe para registrar a un familiar: el enlace no le ofrece registrarse.
  function pasteRegistrationLink(url: string) {
    setComposer(
      detail?.contact.isPatient
        ? `Aquí puedes registrar a tu hijo o a un familiar en ${orgName}: ${url}`
        : `Aquí puedes elegir tu cita y dejarnos tus datos en ${orgName}: ${url}`,
    )
  }

  // A la paciente le faltan datos: su enlace se escribe en el mensaje y quien
  // atiende lo revisa y lo envía (nunca sale solo). Dentro de la conversación
  // abierta no hace falta mensaje aprobado.
  const [linkPasted, setLinkPasted] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar de persona, no de canal.
  useEffect(() => {
    if (!lastSwitchRef.current) setLinkPasted(false)
  }, [id])
  const ownLinkMutation = useMutation({
    mutationFn: (input: { contactId: string; patientId: string }) =>
      createPersonalLinkForContact(input.contactId, id, input.patientId),
    onSuccess: (result) => {
      const firstName = detail?.contact.displayName.split(" ")[0] ?? ""
      setComposer(`${firstName ? `${firstName}, c` : "C"}ompleta tus datos y tu salud aquí (toma 2 minutos): ${result.data.url}`)
      setLinkPasted(true)
      setRegistrationError(null)
    },
    onError: (error) => {
      setRegistrationError(error instanceof ApiError ? error.message : "No se pudo preparar su enlace")
    },
  })

  // Intención `prepareRegistration` (desde Contactos → Enviar registro):
  // usa la misma mutación que el botón, una sola vez por hilo.
  // El ref evita duplicados por re-render/StrictMode; el replace del padre
  // retira el flag para que navegar de nuevo no regenere el enlace.
  // Sin intención explícita jamás se crea un token al cargar el hilo.
  useEffect(() => {
    if (!prepareRegistration) {
      intentConsumedRef.current = false
      return
    }
    if (!canRegister || !detail || intentConsumedRef.current || registrationMutation.isPending) return
    intentConsumedRef.current = true
    onConsumePrepareRegistration()
    registrationMutation.mutate(detail.contact.id)
  }, [prepareRegistration, canRegister, detail])

  const sendMutation = useMutation({
    mutationFn: (input: { text: string; replyToMessageId: string | null; keepPending: boolean; viaWhatsapp?: boolean }) =>
      apiFetch<{ data: ChatMessage & { topicResolved: boolean; conversationId?: string } }>(`/api/conversations/${id}/messages${input.viaWhatsapp ? "/whatsapp" : ""}`, {
        method: "POST",
        body: JSON.stringify({
          text: input.text,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.keepPending ? { keepPending: true } : {}),
        }),
      }),
    onSuccess: (result, input) => {
      setComposer("")
      setWindowClosed(false)
      setSendError(null)
      setReplyTo(undefined)
      if (input.viaWhatsapp) {
        setViaWhatsapp(false)
        setSentToWhatsapp(result.data.conversationId ?? null)
        toast.success(
          result.data.held ? "Quedó en su WhatsApp: le llega con «Ver respuesta»." : "Se le envió por WhatsApp.",
        )
      }
      if (result.data.topicResolved) setDoneTopic(true)
      invalidate()
      invalidateAgentPanelQueries(queryClient)
    },
    onError: sendFailed,
  })

  // «Tomar este tema», «Pasar este tema a…» y «Marcar resuelto» (ADR 0050).
  const topicMutation = useMutation({
    retry: false,
    mutationFn: ({ topicId, path, body }: { topicId: string; path: "take" | "resolve"; body?: unknown }) =>
      apiFetch(`/api/conversations/${id}/topics/${topicId}/${path}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: (_result, variables) => {
      if (variables.path === "resolve") setDoneTopic(true)
      invalidate()
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-case-brief", "crm-context", "workspace-home"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
    onError: (error) => {
      toast.error(error instanceof ApiError && error.shape.message ? error.shape.message : "No se pudo completar la acción. Inténtalo de nuevo.")
    },
  })

  /**
   * Un envío que no salió. Si WhatsApp cerró la ventana de 24 horas mientras se
   * escribía, la zona pasa a ofrecer los mensajes aprobados y lo escrito se
   * conserva; en lo demás se dice el motivo con las palabras del servidor.
   */
  function sendFailed(error: unknown) {
    const closedNow = error instanceof ApiError && error.shape.code === "WINDOW_CLOSED"
    if (closedNow && detail?.connection.capabilities?.templates) {
      setWindowClosed(true)
      setSendError(null)
      void queryClient.invalidateQueries({ queryKey: ["conversation", id] })
      return
    }
    // Conexión desactivada u otro fallo real: bloquear el envío con el motivo.
    setSendError(error instanceof ApiError ? error.message : "No se pudo enviar el mensaje")
  }

  // Envía texto y/o adjuntos del composer. Lanza en error para que PromptInput
  // conserve el texto y los adjuntos (permite reintentar sin perder nada).
  async function handleComposerSubmit(message: PromptInputMessage) {
    const text = message.text.trim()
    const files = message.files ?? []
    if (!text && files.length === 0) return
    // Todavía se ve el canal anterior: se conserva lo escrito y se envía cuando llegue.
    if (detailQuery.isPlaceholderData) throw new Error("Cambiando de canal")
    setUploading(true)
    try {
      if (text) {
        await sendMutation.mutateAsync({
          text,
          replyToMessageId: effectiveReplyTo,
          keepPending: keepPendingRef.current,
          ...(viaWhatsapp ? { viaWhatsapp: true } : {}),
        })
      }
      for (const file of files) {
        const blob = await (await fetch(file.url)).blob()
        const form = new FormData()
        form.set("file", new File([blob], file.filename ?? "adjunto", { type: file.mediaType }))
        await apiUpload(`/api/conversations/${id}/messages/media`, form)
      }
      setComposer("")
      setWindowClosed(false)
      setSendError(null)
      invalidate()
    } catch (error) {
      sendFailed(error)
      throw error
    } finally {
      keepPendingRef.current = false
      setUploading(false)
    }
  }

  // Tomar, devolver al agente, resolver, cerrar sin resolver, reabrir y asignar:
  // cada una es una operación del servidor; la pantalla solo refresca lo que la muestra.
  const actionMutation = useMutation({
    retry: false,
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      apiFetch(`/api/conversations/${id}${path}`, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: () => {
      setConfirming(null)
      invalidate()
      // Tomar y resolver también cambian sus casos derivados y las citas propuestas.
      invalidateAgentPanelQueries(queryClient)
      for (const key of ["agent-case-brief", "crm-context", "crm-activity"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
  const actionError =
    actionMutation.error instanceof ApiError
      ? actionMutation.error.shape.message
      : actionMutation.error
        ? "No se pudo completar la acción. Inténtalo de nuevo."
        : null
  // Resolver y cerrar sin resolver confirman antes con lo que dice el servidor que pasará.
  const [confirming, setConfirming] = useState<"close" | "deleteTest" | null>(null)
  const previewQuery = useQuery({
    queryKey: ["conversation-resolve-preview", id],
    queryFn: () => apiFetch<{ data: ResolvePreview }>(`/api/conversations/${id}/resolve-preview`),
    enabled: confirming !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  async function loadOlder() {
    const cursor = olderCursor ?? detail?.messagesCursor
    if (!cursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await apiFetch<{ data: ChatMessage[]; nextCursor: string | null }>(
        `/api/conversations/${id}/messages?before=${encodeURIComponent(cursor)}&limit=50`,
      )
      setOlder((prev) => [...page.data, ...prev])
      setOlderCursor(page.nextCursor)
    } catch (error) {
      // Lo ya cargado se conserva; se avisa y el botón queda para volver a intentarlo.
      toast.error(
        error instanceof ApiError && error.shape.message
          ? error.shape.message
          : "No se pudieron cargar los mensajes anteriores. Vuelve a intentarlo.",
      )
    } finally {
      setLoadingOlder(false)
    }
  }

  // Sin detalle aún no hay estructura que anticipar; con detalle en caché el
  // refetch (automático o manual) nunca lo retira: sigue visible abajo.
  if (detailQuery.isPending && !detail) {
    return <ThreadSkeleton showBack={showBack} onBack={onBack} />
  }
  if (!detail) {
    // Solo 404/403 dicen que no está o que no hay acceso; otro fallo (red, servidor) se reintenta.
    const gone =
      detailQuery.error instanceof ApiError && (detailQuery.error.status === 404 || detailQuery.error.status === 403)
    return (
      <div className="flex flex-col gap-2 p-4">
        {showBack && (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Volver">
            <ChevronLeft className="size-4" />
          </Button>
        )}
        {gone ? (
          <EmptyState
            title="Conversación no disponible"
            description="Esta conversación ya no está disponible o no tienes acceso."
            actionLabel="Volver a la bandeja"
            onAction={onBack}
          />
        ) : (
          <>
            <ErrorState
              message="No se pudo cargar la conversación. Revisa la conexión y vuelve a intentarlo."
              onRetry={() => void detailQuery.refetch()}
            />
            <Button variant="ghost" size="sm" className="self-center" onClick={onBack}>
              Volver a la bandeja
            </Button>
          </>
        )}
      </div>
    )
  }

  const conv = detail.conversation
  const closed = conv.status === "closed"
  // La ventana de 24 horas de WhatsApp la dice el servidor con el hilo, antes de que nadie escriba.
  const windowShut = windowClosed || detail.whatsappWindow?.open === false
  // La atención del propio hilo manda; la de la lista solo adelanta el dato
  // mientras llega el detalle. Sin ninguna, la cabecera calla: no se deduce aquí.
  const threadAttention = detail.attention ?? attention
  // El estado del detalle manda: reabierta, la lista podría traer todavía el cierre anterior.
  const closure = closed ? (detail.closure ?? conv.closure ?? listClosure ?? null) : null
  // La cabecera dice el estado de la persona, el de su fila, también al responder por otro canal (fase 4).
  const words =
    row && row.id !== id && attention
      ? conversationWords({ status: row.status, attention, closure: listClosure ?? null, myUserId, receptionName })
      : conversationWords({ status: conv.status, attention: threadAttention, closure, myUserId, receptionName })
  // Spam o bloqueada (ADR 0054): el aviso, el menú y la caja de texto lo leen de aquí.
  const screenView = detail.screen
  const blocked = screenView?.screen === "blocked"
  // Temas del hilo (ADR 0050): primero los de quien mira y los que nadie tomó.
  const topics = threadAttention?.topics ?? []
  const forMe = (topic: InboxTopic) => !topic.assigneeUserId || topic.assigneeUserId === myUserId
  const orderedTopics = [...topics.filter(forMe), ...topics.filter((topic) => !forMe(topic))]
  const defaultTopic = [...topics.filter(forMe)].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
  // La caja responde por defecto a la pregunta pendiente más antigua de quien mira.
  const effectiveReplyTo = replyTo === undefined ? (defaultTopic?.source?.id ?? null) : replyTo
  const replyMessage = effectiveReplyTo ? (messages.find((item) => item.id === effectiveReplyTo) ?? null) : null
  const replyTopic = effectiveReplyTo
    ? (topics.find((topic) => topic.source?.id === effectiveReplyTo || topic.askedMessageIds.includes(effectiveReplyTo)) ?? null)
    : null
  const replyText = replyMessage?.body ?? (replyTopic ? topicQuote(replyTopic) : null)
  // Pasadas las 24 horas de WhatsApp, responder una pregunta se sigue
  // escribiendo: queda por entregar y le llega con «Ver respuesta» (R1).
  const holdReply = windowShut && effectiveReplyTo !== null && !useApproved
  // Instagram y Messenger, pasadas las 24 horas: no admiten mensajes aprobados (tablero 4b).
  const metaWindow = detail.lateReply?.metaWindow ?? null
  const metaShut = metaWindow !== null && !metaWindow.open
  const firstName = detail.contact.displayName.split(/\s+/)[0] ?? detail.contact.displayName
  const metaChannel = detail.connection.provider === "messenger" ? "Messenger" : "Instagram"
  // Mensajes del tema: los que lo originaron o volvieron a preguntar por él.
  const topicMessageIds = new Set(topics.flatMap((topic) => [topic.source?.id, ...topic.askedMessageIds].filter((item): item is string => !!item)))
  const focusTopic = defaultTopic ?? orderedTopics[0] ?? null
  const jumpTo = (messageId: string) => {
    window.setTimeout(() => document.getElementById(`mensaje-${messageId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50)
  }
  // Promete responder después: se sugiere dejar el tema pendiente.
  const promises = replyTopic !== null && /\b(te (confirmo|aviso|escribo|respondo|cuento|averiguo)|consult|averigu|lo veo)/i.test(composer)
  // Caja también, para devolverle un pago (decisión 3): `TopicBand` se lo ofrece solo en los pagos.
  const conversers = members.filter((member) => ["owner", "admin", "reception", "clinician", "cashier"].includes(member.role))
  // «Responder por» (decisión 6 del pulido): otro canal de la persona, sin perder lo escrito.
  const switchTo = (next: string) => {
    if (next === id) return
    switchingRef.current = true
    setId(next)
  }
  const multiChannel = personChannels.length > 1
  // Lo que se ve es todavía el canal anterior: no se actúa hasta que llegue el elegido.
  const switching = detailQuery.isPlaceholderData
  // Dos conversaciones del mismo canal (dos hilos de correo) se distinguen por su cuenta o su hora.
  const channelName = (item: PersonChannel) => {
    const twins = personChannels.filter((other) => other.channel === item.channel)
    if (twins.length < 2) return channelLabel(item.channel)
    const sameAccount = twins.some((other) => other !== item && other.connectionName === item.connectionName)
    return `${channelLabel(item.channel)} · ${sameAccount ? listTimeWords(item.lastMessageAt) : item.connectionName}`
  }
  const channelOf = (conversationId: string | undefined) =>
    personChannels.find((item) => item.conversationId === conversationId)?.channel ?? detail.connection.channel
  const activeChannel = personChannels.find((item) => item.conversationId === id) ?? null
  // Un tema de otro canal se responde por ese canal: se dice y se ofrece pasar a él.
  const otherTopics = personChannels.filter((item) => item.conversationId !== id && item.topics > 0)
  const busy = actionMutation.isPending || switching
  const name = detail.contact.displayName
  const preview = previewQuery.data?.data
  const closeAlso = preview ? pendingWords(preview.handoffs, preview.pendingContact, "cerrar", receptionName) : []
  const previewError =
    previewQuery.error instanceof ApiError
      ? previewQuery.error.shape.message
      : previewQuery.error
        ? "No se pudo consultar qué pasará al cerrarla."
        : null

  // La línea de tiempo: mensajes y lo que hizo el agente, por hora. Lo anterior a lo cargado llega con «Cargar anteriores».
  const earliest = olderCursor ?? detail.messagesCursor ? (messages[0]?.createdAt ?? null) : null
  const timeline = buildTimeline(messages, (actionsQuery.data?.data ?? []).filter((item) => !earliest || item.at >= earliest))
  const replyTopicMine = replyTopic ? forMe(replyTopic) : false
  const topicHead = (topic: InboxTopic) => {
    const since = topic.source ? timeAgo(topic.source.createdAt) : ""
    const who = forMe(topic) ? (topic.urgent ? "Te toca · Ahora" : "Te toca") : topicWords(topic, myUserId, receptionName)
    return since ? `${who} · ${since}` : who
  }
  // Un solo aviso a la vez: del que cambia lo que pasa al enviar al que solo informa.
  const notice: { text: string; warn?: boolean; agent?: boolean } | null = promises
    ? { text: "Prometes responder después: usa «Enviar, sigue pendiente» para que el tema no se dé por resuelto.", warn: true }
    : threadAttention?.unreachable === true && topics.length > 0
      ? { text: "Sin forma de avisarle: no hay un WhatsApp ni un correo suyo por donde llegarle. Si cierra la pestaña del chat, no le llega la respuesta.", warn: true }
      : closed && canWrite
        ? { text: "Está cerrada: si le escribes, se vuelve a abrir." }
        : threadAttention?.teamLive && threadAttention.agentAttending && !doneTopic
          ? { text: `Estás conversando en vivo: ${receptionName} espera 15 minutos después del último mensaje del equipo y luego sigue con lo demás.`, agent: true }
          : null
  const topicMenu = [
    ...(replyTopic?.source ? [{ key: "ver", label: "Ver en la conversación", onSelect: () => jumpTo(replyTopic.source?.id ?? "") }] : []),
    // A qué responde la caja: otro tema, uno de sus últimos mensajes o nada.
    ...orderedTopics
      .filter((topic) => topic.source && topic.source.id !== effectiveReplyTo)
      .map((topic) => ({ key: `tema-${topic.id}`, label: `Responder a «${topicQuote(topic, 48)}»`, onSelect: () => setReplyTo(topic.source?.id ?? null) })),
    ...[...messages]
      .reverse()
      .filter((item) => item.direction === "in" && (item.conversationId ?? id) === id && !topicMessageIds.has(item.id) && item.id !== effectiveReplyTo)
      .slice(0, 3)
      .map((item) => ({ key: `mensaje-${item.id}`, label: `Responder a «${(item.body ?? attachmentWords({ contentType: item.contentType, mimeType: item.attachments[0]?.mimeType })).slice(0, 48)}»`, onSelect: () => setReplyTo(item.id) })),
    ...(effectiveReplyTo !== null ? [{ key: "sin-tema", label: "Mensaje nuevo, sin tema", onSelect: () => setReplyTo(null) }] : []),
    ...(replyTopic && canWrite
      ? [
          { key: "pasar", label: "Pasar este tema a…", disabled: topicMutation.isPending, onSelect: () => setPassing(replyTopic) },
          { key: "resuelto", label: "Marcar resuelto", disabled: topicMutation.isPending, onSelect: () => topicMutation.mutate({ topicId: replyTopic.id, path: "resolve" as const }) },
        ]
      : []),
  ]

  return (
    <div className="elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      {detailQuery.isError ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <p className="text-xs text-destructive" role="alert">
            No se pudo actualizar el hilo; se conserva la conversación cargada.
          </p>
          <Button variant="link" size="sm" onClick={() => void detailQuery.refetch()}>
            Reintentar solo el hilo
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        {showBack && (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Volver">
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <div className="min-w-[12rem] flex-1">
          {/* El nombre lleva a la página de la persona (ADR 0029): también para odontología, que la ve sin el CRM si es paciente. */}
          {canOpenPeople && (canSeeNonPatients || detail.contact.isPatient) ? (
            <Link
              to="/people/$personId"
              params={{ personId: detail.contact.id }}
              className="block truncate text-[15px] font-bold hover:underline"
            >
              {detail.contact.displayName}
            </Link>
          ) : (
            <span className="block truncate text-[15px] font-bold">{detail.contact.displayName}</span>
          )}
          <div className="flex min-w-0 items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">
              {multiChannel ? channelsWords(personChannels.map((item) => item.channel)) : channelLabel(detail.connection.channel)}
            </span>
            {conv.isTest ? <Badge variant="secondary" title="Prueba del chat web: no se cobra ni cuenta, y se borra a los 7 días">Prueba · no se cobra</Badge> : null}
            {words && topics.length === 0 ? <StateLabel words={words} className="min-w-0" /> : null}
            {detail.contact.isActive === false && <Badge variant="secondary">Archivado</Badge>}
          </div>
        </div>
        {/* Un botón principal por estado vive en el tema (ADR 0050); aquí solo lo de la conversación. */}
        <div className="flex flex-wrap items-center gap-1.5">
        {onToggleContext && !showBack && (
          <Button
            variant={contextOpen ? "secondary" : "outline"}
            size="sm"
            className="min-h-11 sm:min-h-8"
            aria-pressed={contextOpen}
            onClick={onToggleContext}
            title="Mostrar el contexto del contacto (persona, oportunidades, agente)"
          >
            <PanelRight className="size-4" />
            Contexto
          </Button>
        )}
        {canWrite || canRegister || onToggleContext || topics.length > 0 || threadAttention?.handoffPriority ? (
          <RowActions
            label="Más acciones de la conversación"
            items={[
              // En el celular «Contexto» no cabe junto al nombre: va primero en «…».
              ...(onToggleContext && showBack ? [{ key: "contexto", label: "Contexto", onSelect: onToggleContext }] : []),
              ...(topics.length > 0 || threadAttention?.handoffPriority
                ? [{ key: "resumen", label: "Resumen del caso", onSelect: () => setBriefFor(conv.id) }]
                : []),
              // Quien ya tiene su ficha no se registra otra vez: su enlace es para un familiar.
              ...(canRegister
                ? [{
                    key: "enlace",
                    label: detail.contact.isPatient ? "Enviar enlace de registro" : "Enviarle su enlace",
                    disabled: registrationMutation.isPending,
                    // El enlace ya preparado en esta conversación se vuelve a usar: tocar dos veces no crea otro.
                    onSelect: () =>
                      registrationLink ? pasteRegistrationLink(registrationLink.url) : registrationMutation.mutate(detail.contact.id),
                  }]
                : []),
              // Una prueba del chat web se borra entera (fase 6 del pulido).
              ...(canWrite && conv.isTest ? [{ key: "borrar-prueba", label: "Borrar esta prueba", onSelect: () => setConfirming("deleteTest") }] : []),
              ...(!canWrite
                ? []
                : closed
                  ? [{ key: "reabrir", label: "Reabrir", disabled: busy, onSelect: () => actionMutation.mutate({ path: "/reopen" }) }]
                  : [{
                      key: "cerrar",
                      label: "Cerrar sin resolver",
                      disabled: busy,
                      onSelect: () => {
                        actionMutation.reset()
                        setConfirming("close")
                      },
                    }]),
              // Spam y Bloquear (ADR 0054): nunca para un paciente; Bloquear va al final y en rojo.
              ...(canWrite && screenView && screenView.screen === null && !screenView.isPatient
                ? [{
                    key: "spam",
                    label: "Es spam",
                    disabled: screenActions.spam.isPending,
                    onSelect: () => screenActions.spam.mutate(conversationTarget(id, name)),
                  }]
                : []),
              ...(canRegister && screenView && screenView.screen !== "blocked" && !screenView.isPatient
                ? [{
                    key: "bloquear",
                    label: "Bloquear a esta persona…",
                    tone: "danger" as const,
                    onSelect: () => setBlocking(true),
                  }]
                : []),
            ]}
          />
        ) : null}
        </div>
        {actionError && confirming === null ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {actionError}
          </p>
        ) : null}
      </div>
      <ContactScreenBanner
        target={conversationTarget(id, name)}
        view={screenView}
        canWrite={canWrite}
        canBlock={canRegister}
      />
      <BlockPersonDialog
        target={blocking ? conversationTarget(id, name) : null}
        onClose={() => setBlocking(false)}
      />
      <ConfirmDialog
        open={confirming === "deleteTest"}
        title="¿Borrar esta prueba?"
        description="Se borra la conversación de prueba con todo lo que dejó: sus mensajes y sus temas. No se puede deshacer."
        confirmLabel="Borrar esta prueba"
        variant="destructive"
        pending={busy}
        onClose={() => setConfirming(null)}
        onConfirm={() =>
          actionMutation.mutate(
            { path: "/delete-test" },
            {
              onSuccess: () => {
                toast.success("Prueba borrada.")
                onBack()
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={confirming === "close"}
        title="¿Cerrar sin resolver?"
        description={closeWithoutResolvingWords(name, receptionName)}
        confirmLabel="Cerrar sin resolver"
        variant="default"
        pending={busy}
        // Cerrar no le escribe nada: si no se pudo consultar qué más se cierra, se dice y se deja cerrar.
        confirmDisabled={!preview && !previewError}
        onClose={() => setConfirming(null)}
        onConfirm={() => actionMutation.mutate({ path: "/close" })}
      >
        {closeAlso.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {closeAlso.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {!preview && !previewError ? (
          <p className="text-sm text-muted-foreground" role="status">
            Consultando qué más se cierra…
          </p>
        ) : null}
        {previewError || (confirming === "close" && actionError) ? (
          <p role="alert" className="text-sm text-destructive">
            {confirming === "close" && actionError ? actionError : previewError}
          </p>
        ) : null}
      </ConfirmDialog>

      {otherTopics.map((item) => (
        <div
          key={item.conversationId}
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-warning-soft/40 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1">
            {item.topics === 1 ? "Tiene un tema por responder" : `Tiene ${item.topics} temas por responder`} en{" "}
            {channelLabel(item.channel)}: se responde por ahí.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 px-2 py-1 text-xs font-semibold text-primary sm:min-h-0"
            onClick={() => switchTo(item.conversationId)}
          >
            Responder por {channelLabel(item.channel)}
          </Button>
        </div>
      ))}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        {/* El historial conserva siempre un alto útil: la zona de escritura no puede dejarlo en cero. */}
        <MessageScroller className="min-h-32 flex-1 basis-1/2">
          <MessageScrollerViewport preserveScrollOnPrepend className="bg-canvas/60 p-4">
            {(olderCursor ?? detail.messagesCursor) && (
              <Button variant="ghost" size="sm" className="mb-2 w-fit" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? (
                  <>
                    <Spinner className="size-4" aria-hidden />
                    Cargar anteriores
                  </>
                ) : (
                  "Cargar anteriores"
                )}
              </Button>
            )}
            <MessageScrollerContent className="gap-2">
              {timeline.map((entry) => {
                if (entry.kind === "day") {
                  return (
                    <MessageScrollerItem key={`dia-${entry.key}`} messageId={`dia-${entry.key}`}>
                      <div className="flex justify-center py-1">
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{entry.words}</span>
                      </div>
                    </MessageScrollerItem>
                  )
                }
                if (entry.kind === "card") {
                  return (
                    <MessageScrollerItem key={`accion-${entry.item.id}`} messageId={`accion-${entry.item.id}`}>
                      <AgentActionCard item={entry.item} personName={name} onOpen={onOpenContext} />
                    </MessageScrollerItem>
                  )
                }
                if (entry.kind === "lines") {
                  return (
                    <MessageScrollerItem key={`acciones-${entry.items[0]?.id}`} messageId={`acciones-${entry.items[0]?.id}`}>
                      <AgentActionLines items={entry.items} />
                    </MessageScrollerItem>
                  )
                }
                return (
                  <MessageScrollerItem key={entry.msg.id} messageId={entry.msg.id}>
                    <div id={`mensaje-${entry.msg.id}`}>
                      <MessageBubble
                        msg={entry.msg}
                        conversationId={entry.msg.conversationId ?? id}
                        channel={multiChannel ? channelOf(entry.msg.conversationId) : null}
                        orgSlug={orgSlug}
                        highlight={topicMessageIds.has(entry.msg.id) ? (focusTopic?.urgent ? "urgent" : "topic") : undefined}
                        quote={quoteOf(entry.msg, messages, jumpTo)}
                        senderName={entry.msg.senderUserId ? (members.find((member) => member.userId === entry.msg.senderUserId)?.user.name ?? null) : null}
                        personFirstName={firstName}
                        onShowTrace={traceByMessage.has(entry.msg.id) ? () => setOpenTrace(traceByMessage.get(entry.msg.id) ?? null) : undefined}
                      />
                    </div>
                  </MessageScrollerItem>
                )
              })}
            </MessageScrollerContent>
            {screenView?.screen === "spam" ? (
              <div className="mt-3 flex justify-center">
                <p className="rounded-full border border-dashed bg-card px-3 py-1 text-center text-xs font-medium text-muted-foreground">
                  {receptionName} no respondió: spam
                </p>
              </div>
            ) : null}
            {closure ? (
              <div className="mt-3 flex justify-center">
                <p className="rounded-full border bg-card px-3 py-1 text-center text-xs font-medium text-muted-foreground">
                  {closureBand(closure, receptionName)}
                </p>
              </div>
            ) : null}
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      <CaseBriefDrawer
        conversationId={briefFor === conv.id ? conv.id : null}
        name={detail.contact.displayName}
        canTake={canTakeCase}
        inConversation
        onClose={() => setBriefFor(null)}
        onClaimed={() => void detailQuery.refetch()}
      />
      <AnswerTraceDrawer
        trace={openTrace}
        onClose={() => setOpenTrace(null)}
        canMark={canCorrectAgent}
        onOpenLesson={
          canManageAgent
            ? (lesson) => {
                setOpenTrace(null)
                setLessonId(lesson)
              }
            : undefined
        }
        onCorrect={
          canCorrectAgent
            ? (trace) => {
                // La pregunta es el último mensaje del interlocutor antes de esa respuesta.
                const at = messages.findIndex((item) => item.id === trace.messageId)
                const asked = at > 0 ? [...messages.slice(0, at)].reverse().find((item) => item.direction === "in") : undefined
                setOpenTrace(null)
                setCorrecting({ traceId: trace.id, question: trace.question ?? asked?.body ?? "", reply: trace.replyText, teamReply: null, basis: trace.basis })
              }
            : undefined
        }
      />
      <CorrectDrawer target={correcting} onClose={() => setCorrecting(null)} />
      <LessonDrawer lessonId={lessonId} canWrite={canManageAgent} onClose={() => setLessonId(null)} />
      <PassTopicDialog
        topic={passing}
        members={conversers}
        myUserId={myUserId}
        pending={topicMutation.isPending}
        onClose={() => setPassing(null)}
        onPass={(topic, userId) => {
          setPassing(null)
          if (userId === myUserId) topicMutation.mutate({ topicId: topic.id, path: "take" })
          else topicMutation.mutate({ topicId: topic.id, path: "take", body: { toUserId: userId } })
        }}
      />
      {/* Con su propio desplazamiento y un tope: lo de escribir nunca se come el historial. */}
      <ScrollArea className="flex max-h-[60%] min-h-0 flex-col border-t [&_[data-slot=scroll-area-viewport]]:h-auto [&_[data-slot=scroll-area-viewport]]:min-h-0 [&_[data-slot=scroll-area-viewport]]:flex-1">
        <div className="flex flex-col gap-1.5 p-3">
          {/* Un solo aviso a la vez, el más importante; un error siempre se ve. */}
          {registrationError ? (
            <p className="text-sm text-destructive" role="alert">
              {registrationError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className={`flex min-w-0 items-start gap-1.5 text-xs ${notice.warn ? "text-warning" : "text-muted-foreground"}`}>
              {notice.agent ? <Bot className="size-3.5 shrink-0" aria-hidden /> : null}
              <span className="min-w-0">{notice.text}</span>
            </p>
          ) : null}
          {registrationLink && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={registrationLink.url}>
                {detail.contact.isPatient ? "Enlace de registro" : "Su enlace"} listo para revisar antes de enviar: {registrationLink.url}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(registrationLink.url)
                    setCopied(true)
                  } catch {
                    setRegistrationError("No se pudo copiar el enlace; selecciónalo y cópialo manualmente")
                  }
                }}
              >
                <Copy className="size-3.5" />
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
          )}
          {doneTopic ? (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success-soft px-3 py-2 text-sm">
              <CheckCircle2 className="size-4 text-success" aria-hidden />
              <span className="min-w-0 flex-1">Tema resuelto. {receptionName} sigue con lo demás.</span>
              {onNextTopic ? (
                <Button size="sm" className="min-h-11 sm:min-h-8" onClick={onNextTopic}>
                  Siguiente tema por atender
                </Button>
              ) : null}
            </div>
          ) : null}
          {!canWrite ? (
            <p className="rounded-2xl bg-input/50 px-3 py-3 text-sm text-muted-foreground">Tu rol puede leer esta conversación, pero no escribir en ella.</p>
          ) : blocked ? (
            // A una persona bloqueada no le escribe nadie: se desbloquea desde el aviso de arriba.
            <p className="rounded-2xl bg-input/50 px-3 py-3 text-sm text-muted-foreground">No puedes escribirle mientras esté bloqueada.</p>
          ) : windowShut && !holdReply ? (
            <div className="flex flex-col gap-1.5">
              {defaultTopic?.source ? (
                // Hay una pregunta sin responder: se le puede responder igual y le llega con «Ver respuesta» (R1).
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 w-fit sm:min-h-8"
                  onClick={() => {
                    setUseApproved(false)
                    setReplyTo(defaultTopic.source?.id ?? null)
                  }}
                >
                  Responder su pregunta
                </Button>
              ) : null}
              <InboxApprovedMessages
                // Otra conversación es otra elección: no arrastra lo elegido ni el error de la anterior.
                key={id}
                conversationId={id}
                contactName={detail.contact.displayName}
                lastInboundAt={detail.whatsappWindow?.lastInboundAt}
                draft={composer}
                onSent={invalidate}
              />
            </div>
          ) : metaShut && !viaWhatsapp ? (
            // Instagram y Messenger pasadas las 24 horas: no dejan escribirle; si tiene WhatsApp, por ahí (tablero 4b).
            <div className="flex flex-col gap-2 rounded-2xl bg-input/50 px-3 py-3 text-sm">
              <p>
                Pasaron 24 horas desde que {firstName} escribió por {metaChannel}. {metaChannel} no deja escribirle hasta que vuelva a escribir.
              </p>
              {sentToWhatsapp ? (
                <p role="status" className="flex flex-wrap items-center gap-x-2">
                  <CheckCircle2 className="size-4 text-success" aria-hidden />
                  Tu respuesta salió por su WhatsApp.
                  <Button type="button" variant="link" size="sm" className="h-auto min-h-11 p-0 font-semibold sm:min-h-0" onClick={() => switchTo(sentToWhatsapp)}>
                    Seguir por WhatsApp
                  </Button>
                </p>
              ) : null}
              {metaWindow?.whatsapp ? (
                <Button type="button" size="sm" className="min-h-11 w-fit sm:min-h-8" onClick={() => setViaWhatsapp(true)}>
                  Escribirle por WhatsApp
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {holdReply ? (
                <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1">
                    {detail.lateReply?.answerReady === false
                      ? `Pasaron 24 horas desde su último mensaje: tu respuesta queda guardada y le llega cuando Meta apruebe «Ver respuesta» o cuando ${firstName} vuelva a escribir.`
                      : `Pasaron 24 horas desde su último mensaje: tu respuesta queda por entregar y le llega a ${firstName} con «Ver respuesta».`}
                  </span>
                  <Button type="button" variant="ghost" size="sm" className="h-auto min-h-11 px-2 py-1 text-xs font-semibold text-primary sm:min-h-0" onClick={() => setUseApproved(true)}>
                    Enviar un mensaje aprobado
                  </Button>
                </div>
              ) : null}
              {viaWhatsapp ? (
                <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1">
                    {metaWindow?.whatsappOpen
                      ? `Le llega a su WhatsApp: ${firstName} escribió por ahí en las últimas 24 horas.`
                      : `Le llega a su WhatsApp con «Ver respuesta»: ${firstName} lo toca y ve tu respuesta.`}
                  </span>
                  <Button type="button" variant="ghost" size="sm" className="h-auto min-h-11 px-2 py-1 text-xs font-semibold text-primary sm:min-h-0" onClick={() => setViaWhatsapp(false)}>
                    Cancelar
                  </Button>
                </div>
              ) : null}
              <PromptInput
                accept="image/jpeg,image/png,image/webp,application/pdf,audio/ogg,audio/mpeg"
                multiple
                className="h-auto min-h-10 items-end bg-background"
                onSubmit={handleComposerSubmit}
              >
                {multiChannel && !blocked ? (
                  <PromptInputHeader className="w-full flex-nowrap pb-0 text-xs">
                    <span className="shrink-0">Responder por:</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Responder por ${activeChannel ? channelName(activeChannel) : channelLabel(detail.connection.channel)}, ${replyWindowWords(activeChannel?.replyWindow ?? null)}. Cambiar de canal`}
                        className="flex min-h-11 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                      >
                        {activeChannel ? channelName(activeChannel) : channelLabel(detail.connection.channel)}
                        <span className="font-normal text-muted-foreground">· {replyWindowWords(activeChannel?.replyWindow ?? null)}</span>
                        <ChevronDown className="size-3.5" aria-hidden />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-auto">
                        {/* Base UI: el elemento del menú responde a `onClick`. */}
                        {personChannels.map((item) => (
                          <DropdownMenuItem key={item.conversationId} onClick={() => switchTo(item.conversationId)}>
                            <span className="whitespace-nowrap">
                              <span className="font-medium">{channelName(item)}</span>
                              <span className="text-muted-foreground">
                                {" "}· {replyWindowWords(item.replyWindow)}
                                {item.topics > 0 ? " · tema por responder" : ""}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </PromptInputHeader>
                ) : null}
                {effectiveReplyTo !== null || topics.length > 0 ? (
                  <PromptInputHeader className="w-full flex-nowrap pb-0 pr-1 text-[13px] font-normal text-foreground">
                    <section aria-label="Lo que te toca contestar" className="flex min-w-0 flex-1 items-center gap-2">
                      {replyTopic ? (
                        <span
                          aria-hidden
                          className={replyTopic.urgent ? "size-2 shrink-0 rounded-full bg-destructive" : replyTopicMine ? "size-2 shrink-0 rounded-[2px] bg-warning" : "size-2 shrink-0 rounded-[2px] bg-muted-foreground"}
                        />
                      ) : null}
                      <span className={`shrink-0 font-semibold ${replyTopic?.urgent ? "text-destructive" : replyTopic && replyTopicMine ? "text-warning" : "text-muted-foreground"}`}>
                        {replyTopic ? topicHead(replyTopic) : effectiveReplyTo !== null ? "Respondiendo a:" : "Mensaje nuevo, sin tema"}
                      </span>
                      {effectiveReplyTo !== null && replyText ? <span className="min-w-0 flex-1 truncate">«{replyText}»</span> : <span className="flex-1" />}
                    </section>
                    {replyTopic && !replyTopicMine ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto min-h-11 shrink-0 px-1.5 py-1 text-[13px] font-semibold text-primary sm:min-h-0"
                        disabled={topicMutation.isPending || switching}
                        onClick={() => topicMutation.mutate({ topicId: replyTopic.id, path: "take" })}
                      >
                        <Hand className="size-3.5" aria-hidden />
                        Tomar este tema
                      </Button>
                    ) : null}
                    <RowActions label="Más acciones del tema" items={topicMenu} />
                  </PromptInputHeader>
                ) : null}
                <PromptInputBody>
                  <PromptInputAttachmentsRow />
                  <PromptInputTextarea
                    aria-label="Mensaje"
                    rows={1}
                    className="max-sm:min-h-10"
                    placeholder={replyTopic ? "Escribe tu respuesta… (Enter envía y resuelve)" : "Escribe un mensaje… (Enter para enviar)"}
                    value={composer}
                    onChange={(e) => {
                      setComposer(e.target.value)
                      if (sendError) setSendError(null)
                    }}
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools className="min-w-0 flex-1">
                    {/* Una respuesta por entregar es solo texto: un adjunto no espera a «Ver respuesta». */}
                    {holdReply || viaWhatsapp ? null : (
                      <PromptInputActionMenu>
                        <PromptInputActionMenuTrigger aria-label="Adjuntar archivo" />
                        <PromptInputActionMenuContent>
                          <PromptInputActionAddAttachments label="Adjuntar archivo" />
                        </PromptInputActionMenuContent>
                      </PromptInputActionMenu>
                    )}
                    <SpeechInput
                      lang={activeOrgLocale() ?? "es"}
                      size="icon-sm"
                      aria-label="Dictar"
                      onTranscriptionChange={(text) => setComposer((previous) => (previous ? `${previous} ` : "") + text)}
                    />
                    {canRegister && detail.missingData && !linkPasted && detail.whatsappWindow?.open !== false && !windowClosed ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto min-h-11 min-w-0 shrink justify-start px-1.5 py-1 text-xs font-normal text-muted-foreground sm:min-h-8"
                        disabled={ownLinkMutation.isPending}
                        onClick={() => {
                          if (detail.missingData) ownLinkMutation.mutate({ contactId: detail.contact.id, patientId: detail.missingData.patientId })
                        }}
                      >
                        <span className="min-w-0 truncate">
                          Le falta: {filiationGapsText(detail.missingData.missing).toLowerCase()} · <span className="font-semibold text-primary">Pegar su enlace</span>
                        </span>
                      </Button>
                    ) : null}
                  </PromptInputTools>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {replyTopic ? (
                      <Button
                        type="submit"
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-8"
                        disabled={sendMutation.isPending || uploading || switching}
                        onClick={() => {
                          keepPendingRef.current = true
                        }}
                      >
                        Enviar, sigue pendiente
                      </Button>
                    ) : null}
                    {replyTopic ? (
                      <PromptInputSubmit
                        size="sm"
                        className="min-h-11 sm:min-h-8"
                        aria-label="Enviar y resolver"
                        title="Enviar y resolver (Enter)"
                        disabled={sendMutation.isPending || uploading || switching}
                      >
                        Enviar y resolver
                        <CornerDownLeft className="size-4" aria-hidden />
                      </PromptInputSubmit>
                    ) : (
                      <PromptInputSubmit aria-label="Enviar" title="Enviar (Enter)" disabled={sendMutation.isPending || uploading || switching} />
                    )}
                  </div>
                </PromptInputFooter>
              </PromptInput>
              {sendError && (
                <p className="text-sm text-destructive" role="alert">
                  {sendError}
                </p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/** «Pasar este tema a…»: con muchas personas en el equipo se busca, sin llenar el menú del tema. */
function PassTopicDialog({
  topic,
  members,
  myUserId,
  pending,
  onClose,
  onPass,
}: {
  topic: InboxTopic | null
  members: Member[]
  myUserId: string
  pending: boolean
  onClose: () => void
  onPass: (topic: InboxTopic, userId: string) => void
}) {
  const [query, setQuery] = useState("")
  const text = query.trim().toLowerCase()
  const options = topic
    ? members
        // Caja solo recibe pagos (decisión 3); el servidor también lo exige.
        .filter((member) => member.userId !== topic.assigneeUserId && (member.role !== "cashier" || topic.kind === "pago"))
        .filter((member) => member.user.name.toLowerCase().includes(text))
    : []
  return (
    <Dialog
      open={topic !== null}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("")
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pasar este tema a…</DialogTitle>
          {topic ? <DialogDescription>«{topicQuote(topic, 120)}»</DialogDescription> : null}
        </DialogHeader>
        <Input aria-label="Buscar en el equipo" placeholder="Buscar en el equipo" value={query} onChange={(event) => setQuery(event.target.value)} />
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {options.map((member) => (
            <li key={member.userId}>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 w-full justify-start sm:min-h-9"
                disabled={pending}
                onClick={() => {
                  setQuery("")
                  if (topic) onPass(topic, member.userId)
                }}
              >
                {member.userId === myUserId ? "Pasármelo" : member.user.name}
              </Button>
            </li>
          ))}
          {options.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">Nadie coincide con la búsqueda.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** La cita de un mensaje que responde a otro: su texto y cómo llegar a él, o que ya no está cargado. */
function quoteOf(
  msg: ChatMessage,
  messages: ChatMessage[],
  onJump: (messageId: string) => void,
): { text: string; onJump: () => void } | "missing" | undefined {
  if (!msg.replyToMessageId) return undefined
  const quoted = messages.find((item) => item.id === msg.replyToMessageId)
  if (!quoted) return "missing"
  return { text: (quoted.body ?? attachmentWords({ contentType: quoted.contentType, mimeType: quoted.attachments[0]?.mimeType })).replace(/\s+/g, " ").slice(0, 140), onJump: () => onJump(quoted.id) }
}

function PromptInputAttachmentsRow() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <Attachments variant="inline">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove label="Quitar" />
        </Attachment>
      ))}
    </Attachments>
  )
}
