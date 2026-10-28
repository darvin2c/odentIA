import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  ScrollArea,
} from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { type ReactNode, useEffect, useState } from "react"
import { productUi } from "../../product/product-ui"
import { confirmable, DICTATION_KIND_LABEL, type DictationSession, dictationErrorText, suggestionText } from "./dictation-session"
import { AppointmentChoices, BudgetLines } from "./dictation-suggestions"

/**
 * Firmar con lo dictado sin confirmar: la lista viene marcada y firmar
 * confirma lo marcado; lo que se desmarca no entra. Lo que falta de una
 * sugerencia (la cara, la pieza) se completa ahí mismo con un toque, sin salir,
 * y si no, entra por definir. Solo lo que no se puede confirmar tal cual (una
 * prestación que no está en tus servicios, la receta, que se emite aparte)
 * queda fuera y lo dice. La firma y la hora de fin son las de siempre (`children`).
 */
export function DictationSignDialog({
  open,
  session,
  signing,
  children,
  onClose,
  onComplete,
  onSign,
}: {
  open: boolean
  session: DictationSession
  signing: boolean
  /** Con quién se firma y la hora de fin: lo mismo que al firmar sin sugerencias. */
  children: ReactNode
  onClose: () => void
  /** Abre una sugerencia que no se puede confirmar tal cual, para completarla. */
  onComplete: (id: string) => void
  /** Firma con las marcadas confirmadas; las demás se descartan. */
  onSign: (ids: string[]) => void
}) {
  const items = session.suggestions
  const [unmarked, setUnmarked] = useState<string[]>([])
  // Cada vez que se abre, todo lo que se puede confirmar viene marcado.
  useEffect(() => {
    if (open) setUnmarked([])
  }, [open])
  const marked = items.filter((item) => confirmable(item) && !unmarked.includes(item.id)).map((item) => item.id)
  const Choices = productUi().dictation?.SuggestionChoices
  const busy = signing || session.confirmMany.isPending
  const error = dictationErrorText(session.confirmMany.error, "No pude confirmar alguna. Revísala y vuelve a firmar.")
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      {/* Ancho de siempre: la lista y «Firmar con N marcadas» caben sin cortarse. */}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Firmar la atención</AlertDialogTitle>
          <AlertDialogDescription>Lo que dictaste y está marcado entra con la firma. Desmarca lo que no va.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3">
          {children}
          <ScrollArea className="flex max-h-[45vh] flex-col">
            <ul aria-label="Lo dictado sin confirmar" className="flex flex-col gap-2">
              {items.map((item) => {
                const { title } = suggestionText(item)
                const can = confirmable(item)
                const checked = marked.includes(item.id)
                const why =
                  item.kind === "receta"
                    ? "Se emite con «Emitir receta»; si firmas sin emitirla, no entra."
                    : item.kind === "descanso"
                      ? "Se emite con su formulario; si firmas sin emitirlo, no entra."
                      : !can
                        ? (item.note ?? "Falta completarla para que entre.")
                        : null
                return (
                  <li key={item.id} className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`firmar-${item.id}`}
                        checked={checked}
                        disabled={!can || busy}
                        onCheckedChange={(value) =>
                          setUnmarked((current) => (value === true ? current.filter((id) => id !== item.id) : [...current, item.id]))
                        }
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <label htmlFor={`firmar-${item.id}`} className={`font-medium ${checked ? "" : "text-muted-foreground"}`}>
                          {title}
                        </label>
                        <span className="text-muted-foreground">
                          {DICTATION_KIND_LABEL[item.kind]}
                          {can && !checked ? " · desmarcada: no entra" : ""}
                        </span>
                        {can && item.note ? <span className="text-warning">{item.note}</span> : null}
                        {why ? <span className="text-warning">{why}</span> : null}
                      </span>
                    </div>
                    {Choices && can ? <Choices session={session} item={item} busy={busy} /> : null}
                    {/* La cita lleva sus huecos (por si el elegido se ocupó) y el presupuesto, lo que lleva. */}
                    {item.kind === "cita" ? <AppointmentChoices session={session} item={item} busy={busy} /> : null}
                    {item.kind === "presupuesto" && can ? <BudgetLines item={item} /> : null}
                    {!can && item.kind !== "receta" && item.kind !== "descanso" ? (
                      <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:ml-7 sm:min-h-8" disabled={busy} onClick={() => onComplete(item.id)}>
                        Completar
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Volver
          </Button>
          <SubmitButton type="button" pending={busy} onClick={() => onSign(marked)}>
            {marked.length === 0 ? "Firmar sin lo dictado" : marked.length === 1 ? "Firmar con 1 marcada" : `Firmar con ${marked.length} marcadas`}
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
