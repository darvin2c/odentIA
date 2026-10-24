import { Button, buttonVariants, cn } from "@odentia/ui"
import { Check, ExternalLink } from "lucide-react"
import { useEffect, useRef } from "react"
import { META_ACCOUNT_URL } from "../../../lib/whatsapp"
import { Note } from "./note"

/**
 * Lo que se dice al terminar de conectar WhatsApp, por cualquiera de los dos
 * caminos: con qué cuenta quedó, que ya recibe mensajes, cuántos mensajes se
 * enviaron a revisión y que WhatsApp pide una forma de pago para enviar los
 * aprobados. No afirma nada que el servidor no haya dicho: sin número de
 * mensajes pedidos, no lo inventa.
 */
export function ConnectedNotice({
  account,
  firstMessage,
  requested,
  inReview,
  messagesProblem,
  onSeeMessages,
}: {
  /** El número y el nombre de la cuenta. */
  account: string
  /** Hace cuánto llegó el primer mensaje, si ya llegó uno. */
  firstMessage: string | null
  /** Mensajes pedidos a WhatsApp al conectar, si se sabe. */
  requested: number | null
  /** Mensajes que hoy están en revisión, si el servidor lo dice. */
  inReview: number | null
  /** Por qué no se pudieron pedir los mensajes, con las palabras del servidor. */
  messagesProblem: string | null
  onSeeMessages: () => void
}) {
  const region = useRef<HTMLElement>(null)
  // Aparece sin que la persona lo pida: el foco va al aviso para que se lea, salvo que esté
  // escribiendo en otra parte (el alta termina sola, quizá mientras edita un mensaje).
  useEffect(() => {
    const active = document.activeElement
    const writing = active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']")
    if (!writing) region.current?.focus()
  }, [])
  const sent = requested && requested > 0 ? requested : null
  const waiting = sent === null && inReview && inReview > 0 ? inReview : null

  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label="WhatsApp quedó conectado"
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 outline-none sm:p-5"
    >
      <Note tone="ok" title="Conectado">
        <span>{account}</span>
      </Note>
      <ul className="flex flex-col gap-2 text-sm">
        <li className="flex gap-2.5">
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-soft-foreground" />
          <span>
            <strong className="font-semibold">Ya recibe mensajes.</strong> Lo que escriban a ese número llega a la Bandeja.
            {firstMessage ? ` El primero llegó ${firstMessage}.` : ""}
          </span>
        </li>
        {sent !== null ? (
          <li className="flex gap-2.5">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-soft-foreground" />
            <span>
              <strong className="font-semibold">
                {sent === 1 ? "Enviamos tu mensaje a revisión de WhatsApp." : `Enviamos tus ${sent} mensajes a revisión de WhatsApp, todos de una vez.`}
              </strong>{" "}
              Puede tardar hasta un día. Te avisamos de cada uno: aprobado o rechazado, con su motivo.
            </span>
          </li>
        ) : waiting !== null ? (
          <li className="flex gap-2.5">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-soft-foreground" />
            <span>
              <strong className="font-semibold">
                {waiting === 1 ? "1 mensaje está en revisión de WhatsApp." : `${waiting} mensajes están en revisión de WhatsApp.`}
              </strong>{" "}
              Puede tardar hasta un día. Te avisamos de cada uno: aprobado o rechazado, con su motivo.
            </span>
          </li>
        ) : null}
      </ul>
      {messagesProblem ? (
        <Note tone="waiting" title="Faltan los mensajes">
          <span>{messagesProblem}</span>
        </Note>
      ) : null}
      <Note tone="waiting" title="WhatsApp pide una forma de pago en tu cuenta para enviar mensajes aprobados">
        <span>Sin ella no deja enviar recordatorios ni avisos. Responder a quien escribe sí funciona.</span>
        <a
          href={META_ACCOUNT_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: "outline" }), "mt-1 min-h-11 self-start bg-card text-foreground sm:min-h-9")}
        >
          Abrir mi cuenta de Meta
          <ExternalLink aria-hidden />
          <span className="sr-only"> (se abre en otra pestaña)</span>
        </a>
      </Note>
      <div className="flex flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 text-sm">
        <strong className="font-semibold">Mientras WhatsApp revisa</strong>
        <span className="text-muted-foreground">
          La Bandeja recibe y responde. Lo automático sale como respuesta o por correo hasta que su mensaje esté aprobado.
        </span>
      </div>
      <Button type="button" className="h-11 self-start px-5" onClick={onSeeMessages}>
        Ver mis mensajes
      </Button>
    </section>
  )
}
