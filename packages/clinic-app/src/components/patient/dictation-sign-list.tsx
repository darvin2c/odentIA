import { Button, Checkbox } from "@odentia/ui"
import { CLINICAL_NAME } from "../../lib/agent-names"
import { productUi } from "../../product/product-ui"
import { changesWritten, proposedWords, reread, signOrder } from "./clio-form-proposals"
import {
  confirmableAtSign,
  DICTATION_KIND_LABEL,
  type DictationSession,
  type DictationSuggestion,
  dictationErrorText,
  markedByDefault,
  suggestionText,
} from "./dictation-session"
import { AppointmentChoices, BudgetLines } from "./dictation-suggestions"

/**
 * Lo que quien firma cambió de como venía: `toggled` guarda solo lo que difiere de `byDefault`.
 * Lo usan lo dictado y las fichas del cierre.
 */
export const isOn = (byDefault: boolean, toggled: readonly string[], id: string): boolean => byDefault !== toggled.includes(id)
export function setFromDefault(toggled: readonly string[], id: string, byDefault: boolean, value: boolean): string[] {
  const rest = toggled.filter((other) => other !== id)
  return byDefault === value ? rest : [...rest, id]
}

/**
 * Lo dictado que entra con la firma, en el orden de la ficha: lo que se puede confirmar y viene
 * marcado, salvo que se haya tocado. `toggled`: lo que quien firma cambió de como venía (desmarcó lo
 * marcado, o marcó lo que cambia lo escrito, que viene desmarcado).
 */
export function markedAtSign(session: DictationSession, toggled: readonly string[]): string[] {
  return signOrder(session.suggestions)
    .filter((item) => confirmableAtSign(item) && isOn(markedByDefault(item), toggled, item.id))
    .map((item) => item.id)
}

/** Las respuestas de ficha que dependen de esta (`dependsOn`): sin ella, no se escriben. */
const dependentsOf = (items: readonly DictationSuggestion[], item: DictationSuggestion) =>
  item.kind === "ficha"
    ? items.filter(
        (other) =>
          other.kind === "ficha" &&
          other.payload["responseId"] === item.payload["responseId"] &&
          (other.payload["dependsOn"] as { fieldId?: string } | undefined)?.fieldId === item.payload["fieldId"],
      )
    : []

/** La respuesta de ficha de la que depende esta, si también espera. */
const parentOf = (items: readonly DictationSuggestion[], item: DictationSuggestion) => {
  const fieldId = (item.payload["dependsOn"] as { fieldId?: string } | undefined)?.fieldId
  return item.kind === "ficha" && fieldId
    ? items.find((other) => other.kind === "ficha" && other.payload["responseId"] === item.payload["responseId"] && other.payload["fieldId"] === fieldId)
    : undefined
}

/**
 * Lo dictado sin confirmar, dentro del cierre de siempre (un solo diálogo, QA
 * del 14 nov): viene marcado y firmar confirma lo marcado; lo que se desmarca
 * no entra. Lo que falta de una sugerencia (la cara, la pieza) se completa ahí
 * mismo con un toque, y si no, entra por definir. Lo de una ficha se lee como
 * lo que propuso Clío, con lo que dijo; lo que queda por revisar se abre en su
 * ficha. Desmarcar la pregunta de la que depende otra desmarca también esa.
 */
export function DictationSignList({
  session,
  busy,
  toggled,
  onToggledChange,
  onComplete,
  onOpenForm,
  onReviewHealth,
  responseId,
}: {
  session: DictationSession
  busy: boolean
  /** Lo que quien firma cambió de como venía (`markedAtSign`). */
  toggled: string[]
  onToggledChange: (next: string[]) => void
  /** Abre una sugerencia que no se puede confirmar tal cual, para completarla. */
  onComplete: (id: string) => void
  /** «Abrir la ficha»: la respuesta por revisar se elige en su pregunta. */
  onOpenForm: (responseId: string) => void
  /** «Revisarlo»: lleva al aviso de su salud de la atención, donde se revisa con la persona. */
  onReviewHealth?: () => void
  /**
   * Solo lo de esa ficha, dentro de su bloque de la firma (`FormsAtSign`). Sin ella, lo de la
   * consulta: lo de cada ficha va en su bloque.
   */
  responseId?: string
}) {
  const all = signOrder(session.suggestions)
  const items = all.filter((item) => (responseId ? item.kind === "ficha" && item.payload["responseId"] === responseId : item.kind !== "ficha"))
  const marked = markedAtSign(session, toggled)
  const Choices = productUi().dictation?.SuggestionChoices
  const confirmError = dictationErrorText(session.confirmMany.error, "No pude confirmar alguna. Revísala y vuelve a firmar.")
  // La que no se pudo confirmar lleva el aviso en su fila; lo demás, al pie del cierre.
  const failedId = confirmError ? (session.confirmManyFailed?.id ?? null) : null
  if (items.length === 0) return null
  const toggle = (item: DictationSuggestion, value: boolean) => {
    // Marcar la que depende de otra marca también esa; desmarcarla desmarca las que dependen de ella.
    const parent = parentOf(all, item)
    const also = value ? (parent ? [parent] : []) : dependentsOf(all, item)
    onToggledChange([item, ...also].reduce((next, one) => setFromDefault(next, one.id, markedByDefault(one), value), toggled))
  }
  const list = (
      <ul aria-label={responseId ? `Lo que propone ${CLINICAL_NAME} en esta ficha` : `Lo que propone ${CLINICAL_NAME}`} className="flex flex-col gap-2">
        {items.map((item) => {
          // Lo que dijo de su salud no se completa ni entra con la firma: se revisa con la persona en su
          // aviso. No frena la firma, y firmada sigue avisándose hasta que alguien lo revise (A3).
          if (item.kind === "salud") return <SaidHealthAtSign key={item.id} item={item} busy={busy} onReview={onReviewHealth} />
          const { title } = suggestionText(item)
          const can = confirmableAtSign(item)
          const checked = marked.includes(item.id)
          const form = item.kind === "ficha"
          const why =
            item.kind === "receta"
              ? "Se emite con «Emitir receta»; si firmas sin emitirla, no entra."
              : item.kind === "descanso"
                ? "Se emite con su formulario; si firmas sin emitirlo, no entra."
                : form && !can
                  ? `${item.note ?? "Falta elegir la respuesta."} Se responde en la ficha, que sigue a medias: también después de firmar.`
                  : !can
                    ? (item.note ?? "Falta completarla para que entre.")
                    : null
          const failed = item.id === failedId
          return (
            <li key={item.id} className={`flex flex-col gap-2 rounded-xl border p-3 text-sm ${failed ? "border-destructive" : ""}`}>
              <div className="flex items-start gap-3">
                <Checkbox
                  id={`firmar-${item.id}`}
                  checked={checked}
                  disabled={!can || busy}
                  aria-invalid={failed || undefined}
                  aria-describedby={failed ? `firmar-${item.id}-error` : undefined}
                  onCheckedChange={(value) => toggle(item, value === true)}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <label htmlFor={`firmar-${item.id}`} className={`font-medium ${checked ? "" : "text-muted-foreground"}`}>
                    {form && changesWritten(item)
                      ? `${CLINICAL_NAME} propone cambiar a ${proposedWords(item)}: ${String(item.payload["label"] ?? title)}`
                      : form && can
                        ? `${CLINICAL_NAME} propone: ${title}`
                        : title}
                  </label>
                  <span className="text-muted-foreground [overflow-wrap:anywhere]">
                    {/* Una respuesta de ficha dice de cuál ficha es (puede haber dos) y lo que se dijo. */}
                    {form && typeof item.payload["formTitle"] === "string" ? item.payload["formTitle"] : DICTATION_KIND_LABEL[item.kind]}
                    {form && item.sourceText ? ` · dijiste «${item.sourceText}»` : ""}
                    {can && !checked ? (changesWritten(item) ? " · cambia lo que ya escribiste: márcala solo si va" : reread(item) ? " · por revisar: márcala solo si va" : " · desmarcada: no entra") : ""}
                  </span>
                  {can && checked && session.noteAddsTo(item) ? <span className="text-muted-foreground">{session.noteAddsTo(item)}</span> : null}
                  {can && item.note ? <span className="text-warning">{item.note}</span> : null}
                  {why ? <span className="text-warning">{why}</span> : null}
                  {failed ? (
                    <span id={`firmar-${item.id}-error`} role="alert" className="text-destructive">
                      {confirmError}
                    </span>
                  ) : null}
                </span>
              </div>
              {Choices && can ? <Choices session={session} item={item} busy={busy} /> : null}
              {/* La cita lleva sus huecos (por si el elegido se ocupó) y el presupuesto, lo que lleva. */}
              {item.kind === "cita" ? <AppointmentChoices session={session} item={item} busy={busy} /> : null}
              {item.kind === "presupuesto" && can ? <BudgetLines item={item} /> : null}
              {form && !can ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 self-start sm:ml-7 sm:min-h-8"
                  disabled={busy}
                  onClick={() => onOpenForm(String(item.payload["responseId"]))}
                >
                  Abrir la ficha
                </Button>
              ) : null}
              {!can && item.kind !== "receta" && item.kind !== "descanso" && !form ? (
                <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:ml-7 sm:min-h-8" disabled={busy} onClick={() => onComplete(item.id)}>
                  Completar
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
  )
  // Dentro del bloque de su ficha, sin otro título: la ficha ya lo dice.
  if (responseId) return list
  return (
    <section aria-labelledby="firmar-dictado" className="flex flex-col gap-2">
      <div>
        <h3 id="firmar-dictado" className="font-medium">
          Lo que propone {CLINICAL_NAME}
        </h3>
        <p className="text-xs text-muted-foreground">Lo marcado entra con la firma. Desmarca lo que no va.</p>
      </div>
      {list}
    </section>
  )
}

/**
 * «Lo que dijo de su salud, sin revisar» en la firma (revisión del 21 nov, A3): lo que es, no «Falta
 * completarla» con un cajón vacío. Lleva al aviso de la atención; firmar no lo pierde: sigue en la
 * franja con su fecha hasta que alguien lo revise o diga que no lo registra.
 */
function SaidHealthAtSign({ item, busy, onReview }: { item: DictationSuggestion; busy: boolean; onReview: (() => void) | undefined }) {
  const rows = (item.healthRows ?? []).map((row) => `${row.label}: ${row.value}`)
  return (
    <li className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">Lo que dijo de su salud, sin revisar</span>
        {rows.length ? <span className="text-muted-foreground [overflow-wrap:anywhere]">{rows.join(" · ")}</span> : null}
        <span className="text-muted-foreground">No entra con la firma: se revisa con la persona. Si firmas, sigue avisándose hasta que alguien lo revise.</span>
      </span>
      {onReview ? (
        <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" disabled={busy} onClick={onReview}>
          Revisarlo ahora
        </Button>
      ) : null}
    </li>
  )
}

/** El botón del cierre con lo dictado: dice cuántas entran. */
export const signWithDictationLabel = (marked: number) =>
  marked === 0 ? "Firmar sin lo dictado" : marked === 1 ? "Firmar con 1 marcada" : `Firmar con ${marked} marcadas`
