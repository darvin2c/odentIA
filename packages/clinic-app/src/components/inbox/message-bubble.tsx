import { Button } from "@odentia/ui"
import {
  Attachment,
  type AttachmentData,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
} from "@odentia/ui/components/ai-elements/attachments"
import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerDurationDisplay,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerTimeRange,
} from "@odentia/ui/components/ai-elements/audio-player"
import { Message, MessageContent } from "@odentia/ui/components/ai-elements/message"
import { Link } from "@tanstack/react-router"
import { AlertCircle, Bot, Check, CheckCheck, Clock, MapPin } from "lucide-react"
import { useReceptionName } from "../../lib/agent-names"
import { API_URL } from "../../lib/auth-client"
import { channelLabel } from "../../lib/channels"
import { clockWords, fullWhenWords } from "../../lib/conversation-state"
import { type ChatMessage, usePermission } from "../../lib/crm"

/** Una marca enviado, dos entregado: «enviado» nunca afirma que llegó. Siempre con su nombre, no solo con el color. */
function statusIcon(status: string) {
  if (status === "read") return <CheckCheck role="img" aria-label="Leído" className="size-3.5 text-primary" />
  if (status === "delivered") return <CheckCheck role="img" aria-label="Entregado" className="size-3.5 text-muted-foreground" />
  if (status === "sent") return <Check role="img" aria-label="Enviado" className="size-3.5 text-muted-foreground" />
  if (status === "unknown") return <AlertCircle role="img" aria-label="No se sabe si salió" className="size-3.5 text-warning" />
  if (status === "failed") return <AlertCircle role="img" aria-label="No salió" className="size-3.5 text-destructive" />
  return <Clock role="img" aria-label="En cola" className="size-3.5 text-muted-foreground" />
}

function MessageAttachments({
  msg,
  conversationId,
  orgSlug,
}: {
  msg: ChatMessage
  conversationId: string
  orgSlug: string
}) {
  if (msg.attachments.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {msg.attachments.map((att, index) => {
        // `?org=` porque <img>/<audio>/<a> no pueden enviar el header de tenant.
        const url = `${API_URL}/api/conversations/${conversationId}/messages/${msg.id}/attachments/${index}?org=${encodeURIComponent(orgSlug)}`
        if (att.mimeType.startsWith("image/")) {
          return (
            <a key={index} href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={att.filename} className="max-w-64 rounded-md" />
            </a>
          )
        }
        if (att.mimeType.startsWith("audio/")) {
          return (
            <AudioPlayer key={index} className="w-64">
              <AudioPlayerElement src={url} />
              <AudioPlayerControlBar>
                <AudioPlayerPlayButton />
                <AudioPlayerTimeRange className="flex-1" />
                <AudioPlayerDurationDisplay />
                <AudioPlayerMuteButton />
              </AudioPlayerControlBar>
            </AudioPlayer>
          )
        }
        if (att.mimeType.startsWith("video/")) {
          return (
            // biome-ignore lint/a11y/useMediaCaption: el video lo manda la persona; no trae subtítulos.
            <video key={index} src={url} controls preload="metadata" className="max-h-80 max-w-64 rounded-md bg-black" />
          )
        }
        const data: AttachmentData = {
          id: `${msg.id}-${index}`,
          type: "file",
          url,
          mediaType: att.mimeType,
          filename: att.filename,
        }
        return (
          <a key={index} href={url} target="_blank" rel="noreferrer">
            <Attachments variant="list">
              <Attachment data={data}>
                <AttachmentPreview />
                <AttachmentInfo showMediaType />
              </Attachment>
            </Attachments>
          </a>
        )
      })}
    </div>
  )
}

export function MessageBubble({
  msg,
  conversationId,
  channel,
  orgSlug,
  onShowTrace,
  highlight,
  quote,
  senderName,
  personFirstName,
}: {
  msg: ChatMessage
  conversationId: string
  /** Por qué canal llegó o salió, cuando la persona escribe por varios (fase 4 del pulido). */
  channel?: string | null
  orgSlug: string
  /** Presente solo si el mensaje tiene traza: abre «En qué se basó». */
  onShowTrace?: () => void
  /** Es del tema que hay que contestar: se resalta, y en rojo solo si es «Ahora». */
  highlight?: "topic" | "urgent"
  /** El mensaje al que responde, citado como en WhatsApp. */
  quote?: { text: string; onJump: () => void } | "missing"
  /** Quién del equipo lo escribió. */
  senderName?: string | null
  /** El nombre de pila de la persona, para decir de quién es la reacción. */
  personFirstName?: string
}) {
  const out = msg.direction === "out"
  const byAgent = msg.senderKind === "agent"
  const receptionName = useReceptionName()
  // La línea de Argos solo la abre quien puede ver el agente.
  const canOpenLine = usePermission("agent.read")
  return (
    <Message from={out ? "user" : "assistant"}>
      <MessageContent
        className={
          !out
            ? `gap-0.5 rounded-2xl rounded-bl-md border bg-card px-3.5 py-2 ${highlight === "urgent" ? "ring-2 ring-inset ring-destructive" : highlight ? "ring-2 ring-inset ring-warning" : ""}`
            : byAgent
              ? "gap-0.5 group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:border group-[.is-user]:border-agent-border group-[.is-user]:bg-agent-soft group-[.is-user]:px-3.5 group-[.is-user]:py-2"
              : "gap-0.5 group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:px-3.5 group-[.is-user]:py-2"
        }
      >
        {byAgent && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold text-primary-soft-foreground">
            <span className="flex items-center gap-1">
              <Bot className="size-3.5" aria-hidden />{" "}
              {msg.automatic
                ? `Automático · ${msg.automatic.name}`
                : msg.contentType === "template"
                  ? "Mensaje automático"
                  : receptionName}
            </span>
            {/* Un mensaje automático no es una respuesta de la conversación: dice de qué línea salió. */}
            {msg.automatic && canOpenLine ? (
              <Link to="/agent/administrador" search={{ linea: msg.automatic.key }} className="font-normal underline-offset-2 hover:underline">
                Por qué salió
              </Link>
            ) : null}
          </div>
        )}
        {out && !byAgent && senderName ? <span className="text-xs font-semibold text-muted-foreground">{senderName}</span> : null}
        {/* Coexistencia: lo respondió alguien del equipo desde la app del celular. */}
        {out && !byAgent && !senderName && msg.fromBusinessApp ? (
          <span className="text-xs font-semibold text-muted-foreground">Desde el celular</span>
        ) : null}
        {/* Reenviado: no lo escribió la persona (fase 7). */}
        {msg.forwarded ? <span className="text-xs italic text-muted-foreground">Reenviado</span> : null}
        {quote === "missing" ? (
          <span className="rounded-md border-l-2 border-muted-foreground/40 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
            Respondió a un mensaje anterior que no está cargado
          </span>
        ) : quote ? (
          <button
            type="button"
            onClick={quote.onJump}
            className="rounded-md border-l-2 border-primary bg-background/70 px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
          >
            «{quote.text}»
          </button>
        ) : null}
        {/* WhatsApp muestra la media arriba y el texto (caption o transcripción) abajo. */}
        <MessageAttachments msg={msg} conversationId={conversationId} orgSlug={orgSlug} />
        {msg.contentType === "template" ? (
          // Con el texto armado se ve lo que la persona recibió; los anteriores a eso no lo guardaron.
          msg.body ? (
            <p className="whitespace-pre-wrap">{msg.body}</p>
          ) : (
            <span className="italic opacity-80">
              Mensaje aprobado por WhatsApp{(msg.templateParams ?? []).length > 0 ? `: ${(msg.templateParams ?? []).join(" · ")}` : ""}
            </span>
          )
        ) : msg.redactedAt ? (
          <span className="italic text-muted-foreground">Mensaje de spam borrado a los 90 días</span>
        ) : msg.location ? (
          <LocationCard location={msg.location} />
        ) : (
          msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>
        )}
        <div
          className={`flex items-center gap-1 text-xs text-muted-foreground ${out ? "justify-end" : ""}`}
        >
          {onShowTrace ? (
            <Button type="button" variant="link" size="sm" className="mr-1 h-auto min-h-11 p-0 text-xs font-semibold sm:min-h-0" onClick={onShowTrace}>
              En qué se basó
            </Button>
          ) : null}
          {channel ? <span>{channelLabel(channel)} ·</span> : null}
          {/* Fecha cuando no es de hoy y siempre en la zona de la clínica; el título la dice completa. */}
          <time dateTime={msg.createdAt} title={fullWhenWords(msg.createdAt)}>
            {clockWords(msg.createdAt)}
          </time>
          {/* Respuesta pasadas las 24 horas (R1): espera a que la persona toque «Ver respuesta». */}
          {out && msg.status === "held" ? <span className="font-semibold">· Por entregar</span> : null}
          {out && msg.held && msg.status !== "held" && msg.sentAt ? <span>· Entregada {clockWords(msg.sentAt)}</span> : null}
          {out && statusIcon(msg.status)}
        </div>
        {/* Lo que no salió se dice en palabras, no solo con el icono. */}
        {out && msg.deliveryNote ? (
          <p className={`text-xs ${msg.status === "failed" ? "text-destructive" : "text-warning"} text-right`}>
            {msg.deliveryNote}
          </p>
        ) : null}
      </MessageContent>
      {/* La reacción de la persona, pegada al mensaje: no confirma nada (decisión 7). */}
      {msg.contactReaction ? (
        <span
          className={`-mt-1 w-fit rounded-full border bg-card px-2 py-0.5 text-xs ${out ? "self-end" : "self-start"}`}
          title={`${personFirstName ?? "La persona"} reaccionó con ${msg.contactReaction}`}
        >
          {msg.contactReaction} {personFirstName}
        </span>
      ) : null}
    </Message>
  )
}

/** Una ubicación que mandó la persona: lo que dice y el enlace al mapa (sin servicio de mapas en la página). */
function LocationCard({ location }: { location: NonNullable<ChatMessage["location"]> }) {
  const named = [location.name, location.address].filter(Boolean).join(", ")
  const query = `${location.latitude},${location.longitude}`
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-semibold">
        <MapPin className="size-4 shrink-0" aria-hidden />
        Ubicación
      </span>
      {named ? <span>{named}</span> : null}
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-sm font-medium text-primary underline-offset-2 hover:underline"
      >
        Ver en el mapa
      </a>
    </span>
  )
}

