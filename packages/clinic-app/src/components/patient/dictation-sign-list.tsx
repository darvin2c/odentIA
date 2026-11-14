import { Button, Checkbox } from "@odentia/ui"
import { CLINICAL_NAME } from "../../lib/agent-names"
import { productUi } from "../../product/product-ui"
import { inFormOrder } from "./clio-form-proposals"
import { confirmableAtSign, DICTATION_KIND_LABEL, type DictationSession, type DictationSuggestion, dictationErrorText, suggestionText } from "./dictation-session"
import { AppointmentChoices, BudgetLines } from "./dictation-suggestions"

/** Lo dictado que entra con la firma: lo que se puede confirmar y nadie desmarcó, en el orden de la ficha. */
export function markedAtSign(session: DictationSession, unmarked: readonly string[]): string[] {
  return inFormOrder(session.suggestions)
    .filter((item) => confirmableAtSign(item) && !unmarked.includes(item.id))
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
  unmarked,
  onUnmarkedChange,
  onComplete,
  onOpenForm,
}: {
  session: DictationSession
  busy: boolean
  unmarked: string[]
  onUnmarkedChange: (next: string[]) => void
  /** Abre una sugerencia que no se puede confirmar tal cual, para completarla. */
  onComplete: (id: string) => void
  /** «Abrir la ficha»: la respuesta por revisar se elige en su pregunta. */
  onOpenForm: (responseId: string) => void
}) {
  const items = inFormOrder(session.suggestions)
  const marked = markedAtSign(session, unmarked)
  const Choices = productUi().dictation?.SuggestionChoices
  const confirmError = dictationErrorText(session.confirmMany.error, "No pude confirmar alguna. Revísala y vuelve a firmar.")
  // La que no se pudo confirmar lleva el aviso en su fila; lo demás, al pie del cierre.
  const failedId = confirmError ? (session.confirmManyFailed?.id ?? null) : null
  if (items.length === 0) return null
  const toggle = (item: DictationSuggestion, value: boolean) => {
    if (value) {
      // Marcar la que depende de otra marca también esa: sin ella, no se escribe.
      const parent = parentOf(items, item)
      onUnmarkedChange(unmarked.filter((id) => id !== item.id && id !== parent?.id))
    } else {
      onUnmarkedChange([...new Set([...unmarked, item.id, ...dependentsOf(items, item).map((other) => other.id)])])
    }
  }
  return (
    <section aria-labelledby="firmar-dictado" className="flex flex-col gap-2">
      <div>
        <h3 id="firmar-dictado" className="font-medium">
          Lo dictado sin confirmar
        </h3>
        <p className="text-xs text-muted-foreground">Lo marcado entra con la firma. Desmarca lo que no va.</p>
      </div>
      <ul aria-label="Lo dictado sin confirmar" className="flex flex-col gap-2">
        {items.map((item) => {
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
                    {form && can ? `${CLINICAL_NAME} propuso: ${title}` : title}
                  </label>
                  <span className="text-muted-foreground [overflow-wrap:anywhere]">
                    {/* Una respuesta de ficha dice de cuál ficha es (puede haber dos) y lo que se dijo. */}
                    {form && typeof item.payload["formTitle"] === "string" ? item.payload["formTitle"] : DICTATION_KIND_LABEL[item.kind]}
                    {form && item.sourceText ? ` · dijiste «${item.sourceText}»` : ""}
                    {can && !checked ? " · desmarcada: no entra" : ""}
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
    </section>
  )
}

/** El botón del cierre con lo dictado: dice cuántas entran. */
export const signWithDictationLabel = (marked: number) =>
  marked === 0 ? "Firmar sin lo dictado" : marked === 1 ? "Firmar con 1 marcada" : `Firmar con ${marked} marcadas`
