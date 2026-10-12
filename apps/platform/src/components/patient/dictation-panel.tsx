import { Button, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { AgentMark, AgentSurface, SubmitButton } from "@odentia/ui-patterns"
import { Mic, Pause, Play, Square } from "lucide-react"
import { useState } from "react"
import { dictationClock, dictationErrorText, type DictationSession, highlightTranscript } from "./dictation-session"

export type { DictationKind, DictationSuggestion } from "./dictation-session"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const confirmReadyLabel = (ready: number) => (ready === 1 ? "Confirmar 1 lista" : `Confirmar las ${ready} listas`)

/** «5 listas y 1 por revisar», con lo que haya. */
function readiness(session: DictationSession): string {
  const review = session.pending - session.ready
  return [session.ready > 0 ? plural(session.ready, "lista", "listas") : "", review > 0 ? `${review} por revisar` : ""].filter(Boolean).join(" y ")
}

/**
 * Barra del dictado del asistente clínico, encima de los bloques de la
 * atención. Mientras se dicta dice cuánto lleva y deja pausar o terminar; al
 * terminar resume las sugerencias, que viven dentro de cada bloque. Nada entra
 * a la historia hasta que el odontólogo confirma. No se muestra si la clínica
 * no encendió el asistente.
 */
export function DictationPanel({
  session,
  onStart,
  onFinish,
  onShowTranscript,
}: {
  session: DictationSession
  /** Empieza o se reanuda el dictado: la pantalla despeja lo que tape la atención. */
  onStart: () => void
  onFinish: () => void
  onShowTranscript: () => void
}) {
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState("")
  if (!session.enabled) return null
  const { mode, pending, ready } = session
  const listening = mode === "listening"

  const status = (
    <>
      {session.micError ? (
        <p role="alert" className="text-sm text-destructive">
          {session.micError}
        </p>
      ) : null}
      {session.organizeError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <p className="min-w-0 flex-1 basis-48">{session.organizeError}</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void session.retryOrganize()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      {session.confirmReady.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {dictationErrorText(session.confirmReady.error, "Alguna no se pudo confirmar. Revisa las que siguen en su bloque.")}
        </p>
      ) : null}
      {session.demo ? (
        <p className="text-xs text-muted-foreground">
          Modelo de demostración: reconoce solo unas pocas frases y no dice cómo entendería un dictado un proveedor real.
        </p>
      ) : null}
    </>
  )

  if (session.dictating) {
    return (
      <AgentSurface aria-label="Dictado en curso" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
            <Mic className="size-5" />
          </span>
          <div className="min-w-0 flex-1 basis-48">
            <h2 className="font-heading text-base font-semibold">
              {listening ? "Escuchando" : "En pausa"} <span className="tabular-nums">{dictationClock(session.seconds)}</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              <span className="max-sm:hidden">Lo que dictas aparece abajo como sugerencias. </span>Nada entra a la historia hasta que confirmes.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 max-sm:size-11 sm:min-h-9"
            aria-label={listening ? "Pausar el dictado" : "Reanudar el dictado"}
            onClick={() => {
              if (listening) session.pause()
              else {
                onStart()
                session.resume()
              }
            }}
          >
            {listening ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            <span className="max-sm:hidden">{listening ? "Pausar" : "Reanudar"}</span>
          </Button>
          <Button type="button" className="min-h-11 max-sm:hidden sm:min-h-9" onClick={onFinish}>
            <Square className="size-4" aria-hidden /> Terminar dictado
          </Button>
        </div>
        <p role="status" className="text-sm">
          {pending === 0 && !session.organizing ? "Aún no hay sugerencias." : null}
          {pending > 0 ? plural(pending, "sugerencia", "sugerencias") : null}
          {session.organizing ? (pending > 0 ? " y ordenando lo último que dijiste" : "Ordenando lo que dijiste…") : null}
        </p>
        {session.interim ? <p className="rounded-lg border border-dashed border-agent-border px-3 py-2 text-sm text-muted-foreground">Escuchando: «…{session.interim}»</p> : null}
        <p className="text-xs text-muted-foreground sm:hidden">Para corregir, dilo: «no, es la veintiséis» o «quita la endodoncia».</p>
        {status}
      </AgentSurface>
    )
  }

  return (
    <AgentSurface aria-label={pending > 0 ? "Sugerencias por revisar" : "Dictado de la atención"} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <AgentMark />
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="font-heading text-base font-semibold">
            {pending > 0 ? `Dictado terminado: ${plural(pending, "sugerencia", "sugerencias")}` : "Dictar la atención"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {pending > 0 ? (
              <>
                {readiness(session)}. Todavía no hay nada en la historia.<span className="sm:hidden"> Toca una sugerencia para editarla.</span>
              </>
            ) : (
              "Lo que dictas aparece como sugerencias dentro de cada bloque. Nada entra a la historia hasta que confirmes."
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.canListen ? (
            <Button
              type="button"
              variant={pending > 0 ? "outline" : "default"}
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                setTyping(false)
                onStart()
                session.start()
              }}
            >
              <Mic className="size-4" aria-hidden /> {pending > 0 ? "Seguir dictando" : "Dictar"}
            </Button>
          ) : null}
          {!typing ? (
            <Button type="button" variant={session.canListen ? "ghost" : "outline"} className="min-h-11 sm:min-h-9" onClick={() => setTyping(true)}>
              Escribir lo dictado
            </Button>
          ) : null}
          {session.transcript ? (
            <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" onClick={onShowTranscript}>
              Ver lo dictado
            </Button>
          ) : null}
          {ready > 0 ? (
            <SubmitButton type="button" className="min-h-11 max-sm:hidden sm:min-h-9" pending={session.confirmReady.isPending} onClick={() => session.confirmReady.mutate()}>
              {confirmReadyLabel(ready)}
            </SubmitButton>
          ) : null}
        </div>
      </div>

      {typing ? (
        <div className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="dictado-escrito">Escribe lo dictado</FieldLabel>
            <Textarea
              id="dictado-escrito"
              rows={4}
              maxLength={12_000}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="En la dieciséis hay caries en dentina, le ponemos una resina en la cara oclusal…"
            />
            <FieldDescription>
              {session.canListen
                ? "Si prefieres no usar el micrófono, escribe o pega aquí lo que dictarías."
                : "Este navegador no reconoce la voz: escribe o pega aquí lo dictado."}
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              type="button"
              className="min-h-11 sm:min-h-9"
              pending={session.organizing}
              disabled={typed.trim().length < 3}
              onClick={() => {
                session.submitTyped(typed)
                setTyped("")
                setTyping(false)
              }}
            >
              Ordenar lo dictado
            </SubmitButton>
            <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" onClick={() => setTyping(false)}>
              Cerrar
            </Button>
          </div>
        </div>
      ) : null}
      {session.organizing ? (
        <p role="status" className="text-sm text-muted-foreground">
          Ordenando lo dictado…
        </p>
      ) : null}
      {status}
    </AgentSurface>
  )
}

/**
 * «Lo dictado»: el respaldo del odontólogo mientras dicta. Vive solo en esta
 * pantalla (el servidor no guarda el dictado); lo resaltado dio lugar a una
 * sugerencia.
 */
export function DictationTranscript({ session }: { session: DictationSession }) {
  const parts = highlightTranscript(session.transcript, session.highlights)
  const marked = parts.some((part) => part.marked)
  return (
    <div className="flex flex-col gap-4 text-sm">
      {session.transcript ? (
        <p className="whitespace-pre-wrap leading-relaxed">
          {parts.map((part, index) =>
            part.marked ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
              <mark key={index} className="rounded bg-primary-soft px-0.5 text-primary-soft-foreground">
                {part.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
              <span key={index}>{part.text}</span>
            ),
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">Todavía no hay nada dictado.</p>
      )}
      {session.transcript && !marked && session.pending > 0 ? (
        <p className="text-xs text-muted-foreground">No pude ubicar en el texto qué frase originó cada sugerencia; ábrela para ver lo que dijiste.</p>
      ) : null}
      {session.mode === "listening" ? (
        <p role="status" className="text-muted-foreground">
          Escuchando…{session.interim ? ` «${session.interim}»` : ""}
        </p>
      ) : null}
      <div className="flex flex-col gap-1 rounded-xl border bg-muted/40 p-3">
        <p className="font-semibold">Para corregir, dilo</p>
        <p>«No, es la veintiséis» cambia la última sugerencia.</p>
        <p>«Quita la endodoncia» la descarta.</p>
        <p className="text-muted-foreground">También puedes tocar cualquier sugerencia y editarla a mano.</p>
      </div>
    </div>
  )
}

/** ¿Hay barra fija al pie en teléfono? La pantalla deja sitio para que no tape el final. */
export function dictationMobileBarVisible(session: DictationSession): boolean {
  return session.enabled && (session.dictating || session.pending > 0)
}

/**
 * En teléfono, las acciones del dictado quedan fijas al pie: mientras se dicta,
 * ver el respaldo y terminar; al revisar, firmar y confirmar lo que está listo.
 */
export function DictationMobileBar({
  session,
  onShowTranscript,
  onFinish,
  onSign,
}: {
  session: DictationSession
  onShowTranscript: () => void
  onFinish: () => void
  onSign: () => void
}) {
  if (!dictationMobileBarVisible(session)) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 flex gap-2 border-t bg-canvas px-4 py-3 sm:hidden">
      {session.dictating ? (
        <>
          <Button type="button" variant="outline" className="h-12 min-w-0 flex-1" onClick={onShowTranscript}>
            Ver lo dictado
          </Button>
          <Button type="button" className="h-12 min-w-0 flex-1" onClick={onFinish}>
            Terminar dictado
          </Button>
        </>
      ) : (
        <>
          <Button type="button" variant="outline" className="h-12 min-w-0 flex-1" disabled={session.busy} onClick={onSign}>
            Firmar
          </Button>
          {session.ready > 0 ? (
            <SubmitButton type="button" className="h-12 min-w-0 flex-[2]" pending={session.confirmReady.isPending} onClick={() => session.confirmReady.mutate()}>
              {confirmReadyLabel(session.ready)}
            </SubmitButton>
          ) : null}
        </>
      )}
    </div>
  )
}
