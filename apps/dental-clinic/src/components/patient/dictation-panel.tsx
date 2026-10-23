import { Button, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { AgentMark, AgentSurface, ListeningIndicator, SubmitButton, useListeningStatus, useMicLevel } from "@odentia/ui-patterns"
import { CircleAlert, Mic, Pause, Play, Square, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { activeOrgLocale } from "../../lib/locale"
import { dictationClock, dictationErrorText, type DictationSession, type FailedSegment, highlightTranscript } from "./dictation-session"

export type { DictationKind, DictationSuggestion } from "./dictation-session"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const confirmReadyLabel = (ready: number) => (ready === 1 ? "Confirmar 1 lista" : `Confirmar las ${ready} listas`)

/**
 * Qué se puede dictar, con una frase de ejemplo por bloque (issue 109). Solo lo
 * que de verdad hace: lo que llega después va en «Más adelante».
 */
const EXAMPLES: Array<{ block: string; say: string }> = [
  { block: "Consulta", say: "«Viene por dolor en la muela de abajo hace tres días»" },
  { block: "Odontograma", say: "«La 36 con caries oclusal en dentina, la 46 ausente»" },
  { block: "Plan", say: "«Resina en la 36, o si no una corona»" },
  { block: "Receta", say: "«Amoxicilina de 500, una cápsula cada 8 horas por 7 días»" },
  { block: "Control", say: "«Control en un mes»" },
  { block: "Corregir", say: "«No, es la veintiséis» · «Quita la endodoncia»" },
]

function DictationExamples() {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {EXAMPLES.map((example) => (
        <div key={example.block} className="contents">
          <dt className="font-semibold text-muted-foreground">{example.block}</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">{example.say}</dd>
        </div>
      ))}
    </dl>
  )
}

/** «5 listas y 1 por revisar · 1 quitada por voz», con lo que haya. */
function readiness(session: DictationSession): string {
  // La receta no se confirma con las demás: tiene su «Emitir receta».
  const prescription = session.suggestions.some((item) => item.kind === "receta")
  const review = session.suggestions.filter((item) => item.kind !== "receta" && item.status !== "lista").length
  const counts = [
    session.ready > 0 ? plural(session.ready, "lista", "listas") : "",
    review > 0 ? `${review} por revisar` : "",
    prescription ? "1 receta por emitir" : "",
  ]
    .filter(Boolean)
    .join(" y ")
  const removed = session.removedByVoice.length
  return [counts, removed > 0 ? plural(removed, "quitada por voz", "quitadas por voz") : ""].filter(Boolean).join(" · ")
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
  const { mode, pending, ready } = session
  const listening = mode === "listening"
  // El reconocimiento del navegador no expone su flujo de audio: el nivel se
  // mide en un getUserMedia paralelo de solo-nivel, solo mientras se escucha.
  // Sin permiso o sin micrófono el indicador queda quieto: no finge volumen.
  const metering = useMicLevel({ active: session.enabled && listening, acquire: true })
  // El «No te oigo» con la misma regla que todo lo que escucha (Bandeja incluida).
  const { silent: silentNotice } = useListeningStatus(listening, metering)
  if (!session.enabled) return null

  const status = (
    <>
      {session.micError ? (
        <p role="alert" className="text-sm text-destructive">
          {session.micError}
        </p>
      ) : null}
      <UnusedNotice session={session} />
      {session.failed.map((segment) => (
        <FailedSegmentCard key={segment.id} session={session} segment={segment} />
      ))}
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
          {/* La onda entre corchetes de la marca (lienzo del dictado, opción A). */}
          <ListeningIndicator state={listening ? "listening" : "paused"} level={metering.level} size="md" />
          <div className="min-w-0 flex-1 basis-40">
            <h2 className="font-heading text-base font-semibold">
              {listening ? "Escuchando" : "En pausa"}{" "}
              <span className="font-medium text-muted-foreground tabular-nums">{dictationClock(session.seconds)}</span>
            </h2>
            {silentNotice ? (
              // En el lugar de la explicación: no suma otra línea.
              <p role="status" className="mt-0.5 inline-flex rounded-full bg-warning-soft px-2.5 py-0.5 text-sm font-semibold text-warning">
                No te oigo; revisa el micrófono
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {listening ? (
                  <>
                    <span className="max-sm:hidden">Lo que dictas aparece abajo como sugerencias. </span>Nada entra a la historia hasta que confirmes.
                  </>
                ) : (
                  "El micrófono está apagado."
                )}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant={listening ? "outline" : "default"}
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
          <Button type="button" variant={listening ? "default" : "outline"} className="min-h-11 max-sm:hidden sm:min-h-9" onClick={onFinish}>
            <Square className="size-4" aria-hidden /> Terminar dictado
          </Button>
        </div>
        <p role="status" className="text-sm">
          {pending === 0 && !session.organizing ? "Aún no hay sugerencias." : null}
          {pending > 0 ? plural(pending, "sugerencia", "sugerencias") : null}
          {session.organizing ? (pending > 0 ? " y ordenando lo último que dijiste" : "Ordenando lo que dijiste…") : null}
        </p>
        {session.interim ? (
          <p className="border-l-[3px] border-primary py-0.5 pl-2.5 text-sm [overflow-wrap:anywhere]">
            <span className="block text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Lo último que oí</span>
            «…{session.interim}
            <span aria-hidden className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-primary align-[-2px] motion-reduce:animate-none" />»
          </p>
        ) : null}
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
              "Habla como le contarías a un colega. Lo que dictas aparece como sugerencias dentro de cada bloque. Nada entra a la historia hasta que confirmes."
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

      {/* Antes de la primera sugerencia, qué se puede decir; después está en «Lo dictado». */}
      {pending === 0 && session.removedByVoice.length === 0 && !session.transcript ? (
        <div className="flex flex-col gap-2 rounded-xl bg-background p-3">
          <p className="text-sm font-semibold">Por ejemplo</p>
          <DictationExamples />
        </div>
      ) : null}
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

/** Cuántas frases no usadas se muestran en el aviso; el resto sigue marcado en «Lo dictado». */
const UNUSED_SHOWN = 3

/**
 * «No pude usar esto»: lo que el asistente no pudo ordenar de lo dictado, con
 * la frase tal cual (issue 135). Se queda hasta «Entendido»; lo de las pausas
 * siguientes se suma.
 */
function UnusedNotice({ session }: { session: DictationSession }) {
  const { phrases, unnamed } = session.unused
  if (phrases.length === 0 && !unnamed) return null
  const rest = phrases.length - UNUSED_SHOWN
  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm">
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold text-warning">
            {phrases.length ? "No pude usar esto de lo que dictaste" : "No pude usar una parte de lo que dictaste"}
          </p>
          {phrases.slice(0, UNUSED_SHOWN).map((phrase) => (
            <p key={phrase} className="[overflow-wrap:anywhere]">
              «{phrase}»
            </p>
          ))}
          {rest > 0 ? <p className="text-muted-foreground">y {plural(rest, "frase más", "frases más")}</p> : null}
          <p className="text-warning">Dilo de nuevo o regístralo a mano. {phrases.length ? "Sigue marcado en «Lo dictado»." : "Sigue en «Lo dictado»."}</p>
        </div>
      </div>
      <Button type="button" variant="secondary" size="sm" className="min-h-11 self-start sm:ml-6 sm:min-h-8" onClick={session.dismissUnused}>
        Entendido
      </Button>
    </div>
  )
}

/** Una parte que no se pudo ordenar ni al reintentar: queda aparte y lo demás sigue (issue 135). */
function FailedSegmentCard({ session, segment }: { session: DictationSession; segment: FailedSegment }) {
  const hour = segment.at.toLocaleTimeString(activeOrgLocale() ?? "es", { hour: "2-digit", minute: "2-digit" })
  const words = segment.text.length > 90 ? `${segment.text.slice(0, 90).trimEnd()}…` : segment.text
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-background p-3 text-sm">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold text-warning">No pude ordenar una parte ({hour})</p>
          <p className="[overflow-wrap:anywhere]">«{words}»</p>
          <p className="text-muted-foreground">{segment.message} Lo que dictes después se sigue ordenando. Esta parte sigue en «Lo dictado».</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:ml-6">
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => session.retryFailed(segment.id)}>
          Reintentar
        </Button>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={() => session.discardFailed(segment.id)}>
          Descartar esta parte
        </Button>
      </div>
    </div>
  )
}

/**
 * «Lo dictado»: el respaldo del odontólogo mientras dicta. Vive solo en esta
 * pantalla (el servidor no guarda el dictado); lo resaltado dio lugar a una
 * sugerencia y lo subrayado no se pudo usar.
 */
export function DictationTranscript({ session }: { session: DictationSession }) {
  const parts = highlightTranscript(session.transcript, session.highlights, session.unused.phrases)
  const marked = parts.some((part) => part.mark === "used")
  const unusedShown = parts.some((part) => part.mark === "unused")
  return (
    <div className="flex flex-col gap-4 text-sm">
      {session.transcript ? (
        <p className="whitespace-pre-wrap leading-relaxed">
          {parts.map((part, index) =>
            part.mark === "used" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
              <mark key={index} className="rounded bg-primary-soft px-0.5 text-primary-soft-foreground">
                {part.text}
              </mark>
            ) : part.mark === "unused" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
              <span key={index}>
                <span className="underline decoration-warning decoration-wavy underline-offset-4">{part.text}</span>{" "}
                <span className="whitespace-nowrap rounded-full bg-warning-soft px-2 text-xs font-semibold text-warning">No lo usé</span>
              </span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
              <span key={index}>{part.text}</span>
            ),
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">Todavía no hay nada dictado.</p>
      )}
      {unusedShown ? (
        <p className="text-xs text-muted-foreground">
          Lo resaltado dio una sugerencia; lo subrayado con «No lo usé» no se pudo usar: dilo de nuevo o regístralo a mano.
        </p>
      ) : null}
      {session.transcript && !marked && session.pending > 0 ? (
        <p className="text-xs text-muted-foreground">No pude ubicar en el texto qué frase originó cada sugerencia; ábrela para ver lo que dijiste.</p>
      ) : null}
      {session.mode === "listening" ? (
        <p role="status" className="text-muted-foreground">
          Escuchando…{session.interim ? ` «${session.interim}»` : ""}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
        <p className="font-semibold">Qué puedo decir</p>
        <DictationExamples />
        <p className="text-muted-foreground">
          «No, es la veintiséis» cambia la última sugerencia y «Quita la endodoncia» la quita; las dos se deshacen. También puedes tocar cualquier sugerencia y
          editarla a mano.
        </p>
        <p className="text-muted-foreground">Más adelante: consentimientos, imágenes y preguntas sobre la historia.</p>
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
