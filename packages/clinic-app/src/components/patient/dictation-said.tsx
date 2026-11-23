import { kinSaid } from "@odentia/clinical"
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@odentia/ui"
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@odentia/ui/components/dropdown-menu"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { DetailDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { CLINICAL_NAME } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { useMemberName, usePermission } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { upperFirst } from "../../lib/product-words"
import { productUi } from "../../product/product-ui"
import { useClioFormProposals } from "./clio-form-proposals"
import {
  DICTATION_SPEAKERS,
  type DictationSaidSegment,
  type DictationSession,
  type DictationSpeaker,
  type DictationTurn,
  dictationErrorText,
  dictationSaidKey,
  markSaid,
  type SaidReply,
  type SaidMark,
  type UnusedSaid,
  unusedOfSaid,
} from "./dictation-session"
import { useOpenWide } from "./wide-section"

/** Lo que el panel lee de la sesión del dictado. */
export type SaidSession = Pick<
  DictationSession,
  | "said"
  | "saidUsed"
  | "unsent"
  | "saidLoading"
  | "saidError"
  | "refreshSaid"
  | "suggestions"
  | "highlights"
  | "mode"
  | "interim"
  | "base"
  | "retryUnused"
  | "blocked"
  | "organizing"
>

/** Cómo se nombra a quien habló en un turno; quien atiende, con su nombre. */
export function speakerWords(turn: Pick<DictationTurn, "quien" | "vinculo">, professional: string): string {
  if (turn.quien === "dra") return professional
  if (turn.quien === "paciente") return "Paciente"
  // Una clave interna («no_se_sabe») o cómo se le habla («señora») no es un parentesco: nunca se muestra (QA del 21 nov).
  const kin = kinSaid(turn.vinculo)
  if (turn.quien === "acompanante") return kin ? `Acompañante (${kin})` : "Acompañante"
  return "No se sabe"
}

const SPEAKER_CHOICE: Record<DictationSpeaker, string> = {
  dra: "Quien atiende",
  paciente: "Paciente",
  acompanante: "Acompañante",
  no_se_sabe: "No se sabe",
}

/** La hora de un tramo, en el formato y la zona de la clínica: «10:38». */
const hourOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(activeOrgLocale() ?? "es", { hour: "2-digit", minute: "2-digit", timeZone: activeOrgTimeZone() })

/** Por qué no se usó, en palabras de la pantalla. */
function unusedWhy(item: UnusedSaid): string {
  // El motivo guardado con la frase es el mismo que dio el aviso de la pausa (QA del 22 nov, H6/UX-5).
  if (item.detail) return item.detail
  if (item.why === "ya_confirmada") return "ya estaba confirmado: cámbialo a mano"
  if (item.why === "no_propuesta") return "no se pudo proponer"
  return "no supe dónde va"
}

/**
 * Una frase que parece de su salud (una medicina, una enfermedad, una alergia): solo para ofrecer
 * «Llevar a su salud», que abre sus antecedentes. No decide nada ni propone nada.
 */
// El borde es de letras Unicode: `\b` no ve la «ó» de «tomó» ni la «á» de «átomo» como letras.
export const LOOKS_LIKE_HEALTH =
  /(?<![\p{L}\p{N}])(?:tom[oaó]|pastilla|medic|alerg|diab[eé]t|presi[oó]n|asma|coraz[oó]n|anestesi|embaraz|operad|operaci|hospital|tiroides|enfermedad|aspirina|insulina|epilep|hipertens|hepatitis|c[aá]ncer|sangr)/iu

/** Lo resaltado: de la consulta (azul), de su salud (ámbar); la charla, sin resaltar. */
function Marked({ text, sources }: { text: string; sources: { consulta: string[]; salud: string[] } }) {
  return (
    <>
      {markSaid(text, sources).map((part, index) =>
        part.mark ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
          <mark key={index} className={MARK_CLASS[part.mark]}>
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no se reordenan
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

const MARK_CLASS: Record<SaidMark, string> = {
  consulta: "rounded bg-primary-soft px-0.5 text-primary-soft-foreground",
  salud: "rounded bg-warning-soft px-0.5 text-foreground",
}

/**
 * «Lo que se dijo» (mesa del 20 nov 2026; antes «Lo dictado — Tu respaldo»): cada tramo de la
 * atención, guardado en el servidor, así que sigue igual al recargar o al volver otro día. Dos
 * vistas: «Conversación», con quién habló en cada turno (la arma el repaso al terminar; tocar el
 * nombre lo cambia), y «Tal cual se oyó», cada pausa con su hora, sin editar. Arriba, «No lo usé»
 * con su motivo. Lo resaltado está en una propuesta de la consulta o de su salud; la charla, no.
 * No es historia clínica: no se firma ni va en la copia.
 */
export function DictationSaid({
  session,
  readOnly = false,
}: {
  session: SaidSession
  /** La atención firmada, anulada o de otra persona: se lee, sin cambiar quién habló ni volver a intentar. */
  readOnly?: boolean
}) {
  const memberName = useMemberName()
  const segments = session.said
  const talked = segments.some((segment) => segment.turns !== null)
  const [view, setView] = useState<"conversacion" | "tal-cual">(talked ? "conversacion" : "tal-cual")
  // Al llegar el repaso con el panel abierto, se pasa a la conversación.
  const [wasTalked, setWasTalked] = useState(talked)
  useEffect(() => {
    if (talked && !wasTalked) setView("conversacion")
    setWasTalked(talked)
  }, [talked, wasTalked])
  const hintId = useId()
  // Lo que dio una propuesta: lo de su salud (y sus alergias) en ámbar, lo demás de la consulta en azul.
  const healthKinds = new Set(["salud", "alergia"])
  // Del servidor (pendientes y confirmadas, sigue al recargar y ya firmada) y lo de esta pestaña.
  const used = [...session.saidUsed, ...session.suggestions.map((item) => ({ kind: item.kind, said: item.sourceText }))]
  const sources = {
    salud: used.filter((item) => healthKinds.has(item.kind)).map((item) => item.said),
    consulta: [...used.filter((item) => !healthKinds.has(item.kind)).map((item) => item.said), ...session.highlights],
  }
  const turn = useMutation({
    retry: false,
    mutationFn: (input: { segmentId: string; index: number; quien: DictationSpeaker; vinculo?: string }) =>
      apiFetch(`${session.base}/said/${encodeURIComponent(input.segmentId)}/turns/${input.index}`, {
        method: "PATCH",
        body: JSON.stringify({ quien: input.quien, ...(input.quien === "acompanante" && input.vinculo ? { vinculo: input.vinculo } : {}) }),
      }),
    onSettled: () => void session.refreshSaid(),
  })
  const professional = (segment: DictationSaidSegment) => memberName(segment.createdBy).split(" ").slice(0, 2).join(" ")

  if (session.saidLoading) return <LoadingState message="Cargando lo que se dijo…" />
  if (session.saidError) return <ErrorState message="No pude cargar lo que se dijo" onRetry={() => void session.refreshSaid()} />
  return (
    <div className="flex flex-col gap-4 text-sm">
      <UnusedSaidList session={session} readOnly={readOnly} />
      {segments.length === 0 ? (
        session.unsent ? null : <p className="text-muted-foreground">Todavía no se dijo nada en esta atención.</p>
      ) : (
        <Tabs value={view} onValueChange={(next) => setView(next as typeof view)} className="min-w-0">
          <TabsList aria-label="Cómo ver lo que se dijo" className="w-full max-w-full">
            <TabsTrigger value="conversacion" disabled={!talked} aria-describedby={talked ? undefined : hintId} className="min-h-11 min-w-0 sm:min-h-9">
              Conversación
            </TabsTrigger>
            <TabsTrigger value="tal-cual" className="min-h-11 min-w-0 sm:min-h-9">
              Tal cual se oyó
            </TabsTrigger>
          </TabsList>
          {talked ? null : (
            <p id={hintId} className="text-xs text-muted-foreground">
              «Conversación» se arma al terminar de dictar.
            </p>
          )}
          <TabsContent value="conversacion" className="flex flex-col gap-3">
            {turn.isError ? (
              <p role="alert" className="text-destructive">
                {dictationErrorText(turn.error, "No pude cambiar quién habló. Inténtalo otra vez.")}
              </p>
            ) : null}
            {segments.map((segment) =>
              segment.turns ? (
                <div key={segment.segmentId} className="flex flex-col gap-2">
                  {segment.turns.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: el turno es su posición en el tramo
                    <p key={index} className="leading-relaxed [overflow-wrap:anywhere]">
                      <SpeakerChoice
                        readOnly={readOnly}
                        turn={item}
                        professional={professional(segment)}
                        busy={turn.isPending}
                        onChoose={(quien) => turn.mutate({ segmentId: segment.segmentId, index, quien, ...(item.vinculo ? { vinculo: item.vinculo } : {}) })}
                      />{" "}
                      <Marked text={item.texto} sources={sources} />
                    </p>
                  ))}
                </div>
              ) : (
                // Lo que se dijo después del último repaso: tal cual, hasta el próximo.
                <p key={segment.segmentId} className="leading-relaxed [overflow-wrap:anywhere]">
                  <span className="font-semibold text-muted-foreground">Sin repasar ({hourOf(segment.saidAt)}):</span>{" "}
                  <Marked text={segment.transcript} sources={sources} />
                </p>
              ),
            )}
            {readOnly ? null : <p className="text-xs text-muted-foreground">Toca el nombre de un turno para cambiar quién habló.</p>}
          </TabsContent>
          <TabsContent value="tal-cual">
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {segments.map((segment, index) => (
                <li key={segment.segmentId} className="flex flex-col gap-0.5">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Pausa {index + 1} · {hourOf(segment.saidAt)}
                    {segment.organized ? "" : " · sin ordenar"}
                  </p>
                  <p className="whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
                    <Marked text={segment.transcript} sources={sources} />
                  </p>
                </li>
              ))}
            </ol>
          </TabsContent>
        </Tabs>
      )}
      {session.unsent ? (
        // Lo que se está oyendo y aún no se mandó a ordenar (llega con la pausa): no se pierde.
        <p className="leading-relaxed [overflow-wrap:anywhere]">
          <span className="font-semibold text-muted-foreground">Sin ordenar todavía:</span> {session.unsent}
        </p>
      ) : null}
      {segments.length > 0 ? (
        <ul aria-label="Qué marca cada color" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
          <li>
            <span className={MARK_CLASS.consulta}>Azul</span>: está en una propuesta de la consulta
          </li>
          <li>
            <span className={MARK_CLASS.salud}>Ámbar</span>: está en lo de su salud
          </li>
          <li>Sin resaltar: charla o ya decidido</li>
        </ul>
      ) : null}
      {session.organizing ? <p className="text-muted-foreground">Ordenando lo último que se dijo…</p> : null}
      {session.mode === "listening" ? (
        <p role="status" className="text-muted-foreground">
          Escuchando…{session.interim ? ` «${session.interim}»` : ""}
        </p>
      ) : null}
      {readOnly ? null : (
      <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
        <p className="font-semibold">Qué puedo decir</p>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {(productUi().dictation?.examples ?? []).map((example) => (
            <div key={example.block} className="contents">
              <dt className="font-semibold text-muted-foreground">{example.block}</dt>
              <dd className="m-0 [overflow-wrap:anywhere]">{example.say}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">
          «{upperFirst(productUi().dictation?.corrections.change ?? "")}» cambia la última sugerencia y «
          {upperFirst(productUi().dictation?.corrections.remove ?? "")}» la quita; las dos se deshacen. También puedes tocar cualquier sugerencia y
          editarla a mano.
        </p>
        <p className="text-muted-foreground">
          Lo de una ficha entra si ya la empezaste: {CLINICAL_NAME} lo propone en sus preguntas y lo confirmas ahí.
        </p>
      </div>
      )}
    </div>
  )
}

/** Quién habló, con un toque: un menú con las cuatro opciones. */
function SpeakerChoice({
  turn,
  professional,
  busy,
  onChoose,
  readOnly,
}: {
  turn: DictationTurn
  professional: string
  busy: boolean
  onChoose: (quien: DictationSpeaker) => void
  readOnly: boolean
}) {
  const name = speakerWords(turn, professional)
  if (readOnly) return <span className="font-semibold">{name}:</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 gap-1 px-1.5 py-0.5 align-baseline font-semibold sm:min-h-7"
            aria-label={`Habló: ${name}. Cambiar quién habló`}
            disabled={busy}
          />
        }
      >
        {name}:
        <ChevronDown className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuRadioGroup value={turn.quien} onValueChange={(value) => value !== turn.quien && onChoose(value as DictationSpeaker)}>
          {DICTATION_SPEAKERS.map((speaker) => (
            <DropdownMenuRadioItem key={speaker} value={speaker} closeOnClick>
              {speaker === "dra" ? professional : SPEAKER_CHOICE[speaker]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * «No lo usé (n)»: lo que Clío no supo dónde poner, guardado con cada tramo, con su motivo. Se
 * queda al recargar. Lo de una ficha lleva «Usar en…»; lo que parece de su salud, «Llevar a su
 * salud» (abre sus antecedentes); lo que no supo dónde va, «Intentar otra vez» (otra pausa).
 */
function UnusedSaidList({ session, readOnly }: { session: SaidSession; readOnly: boolean }) {
  const clio = useClioFormProposals()
  const openWide = useOpenWide()
  const titleId = useId()
  const items = unusedOfSaid(session.said)
  if (items.length === 0) return null
  // Otra pausa solo si Clío escucha en esta atención.
  const canRetry = !session.blocked
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning-soft p-3">
      <h3 id={titleId} className="font-semibold text-warning">
        No lo usé ({items.length})
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item, index) => {
          const phrase = item.said
          const targets = clio && phrase ? (item.targets ?? []) : []
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: la lista no se reordena
            <li key={`${item.segmentId}:${index}`} className="flex flex-col gap-1 border-t border-warning/20 pt-2 first:border-t-0 first:pt-0">
              <p className="[overflow-wrap:anywhere]">
                {phrase ? `«${phrase}»` : "Una parte que no supe citar"}
                <span className="text-muted-foreground">
                  {" "}
                  · {hourOf(item.saidAt)} · {unusedWhy(item)}
                </span>
              </p>
              {phrase && !readOnly ? (
                <div className="flex flex-wrap gap-2">
                  {targets.map((target) => (
                    <Button
                      key={`${target.responseId}:${target.fieldId}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-11 whitespace-normal text-left sm:min-h-8"
                      aria-label={`Usar «${phrase}» en «${target.label}»`}
                      onClick={() => clio?.openAt({ ...target, said: phrase })}
                    >
                      Usar en {target.label.replace(/\s*\([^)]*\)/g, "").trim() || target.label}
                    </Button>
                  ))}
                  {openWide && LOOKS_LIKE_HEALTH.test(phrase) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-label={`Llevar a su salud: «${phrase}»`}
                      onClick={() => openWide({ id: "antecedentes", review: true })}
                    >
                      Llevar a su salud
                    </Button>
                  ) : null}
                  {canRetry && item.why === "sin_lugar" && targets.length === 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-label={`Intentar otra vez: «${phrase}»`}
                      disabled={session.organizing}
                      onClick={() => session.retryUnused(item.segmentId, phrase)}
                    >
                      Intentar otra vez
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {readOnly ? "" : "O anótalo a mano. "}La charla no se lista: queda sin resaltar en lo que se dijo.
      </p>
    </section>
  )
}

/**
 * «Lo que se dijo» de una atención firmada, anulada o que lleva otra persona: solo para leer, con el
 * mismo permiso que ver la atención (clínico). No se cambia quién habló ni se vuelve a intentar nada.
 * Sin nada dicho, no se muestra.
 */
export function EncounterSaidLink({ patientId, encounterId }: { patientId: string; encounterId: string }) {
  const canRead = usePermission("clinical.read")
  const [open, setOpen] = useState(false)
  const base = `/api/patients/${patientId}/encounters/${encounterId}/dictation`
  const query = useQuery({
    queryKey: dictationSaidKey(patientId, encounterId),
    queryFn: () => apiFetch<SaidReply>(`${base}/said`),
    enabled: canRead,
    retry: false,
  })
  const segments = query.data?.data.segments ?? []
  // Si no se pudo cargar, se dice: esconderlo haría creer que no se dijo nada (revisión del 21 nov).
  if (canRead && query.isError)
    return (
      <section aria-label="Lo que se dijo" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4 text-sm">
        <p role="alert" className="min-w-0 text-muted-foreground">
          No pude cargar lo que se dijo en esta atención.
        </p>
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>
          Intentar otra vez
        </Button>
      </section>
    )
  if (!canRead || segments.length === 0) return null
  const session: SaidSession = {
    said: segments,
    saidUsed: query.data?.data.used ?? [],
    unsent: "",
    saidLoading: false,
    saidError: query.isError,
    refreshSaid: async () => {
      await query.refetch()
    },
    suggestions: [],
    highlights: [],
    mode: "off",
    interim: "",
    base,
    retryUnused: () => {},
    blocked: null,
    organizing: false,
  }
  return (
    <section aria-label="Lo que se dijo" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4 text-sm">
      <p className="min-w-0 text-muted-foreground">
        {segments.length === 1 ? "1 pausa" : `${segments.length} pausas`} de lo que se dijo. No es parte de la historia firmada.
      </p>
      <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setOpen(true)}>
        Lo que se dijo
      </Button>
      <DetailDrawer
        open={open}
        title="Lo que se dijo"
        description="Guardado con la atención. Solo para leer: no es parte de la historia firmada."
        onClose={() => setOpen(false)}
      >
        <DictationSaid session={session} readOnly />
      </DetailDrawer>
    </section>
  )
}
