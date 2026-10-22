import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  ScrollArea,
} from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { CircleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { DICTATION_KIND_LABEL, type DictationSession, suggestionMissing, suggestionText } from "./dictation-session"

/**
 * Firmar con sugerencias del dictado sin revisar. Las nombra una por una —qué
 * es, de qué bloque y qué le falta— y dice cuántas ya entraron a la atención.
 * Lo que no se confirma no entra a la historia: o se revisa ahora, o se
 * descarta al firmar. La firma y la hora de fin son las de siempre (`children`).
 */
export function DictationSignDialog({
  open,
  session,
  signing,
  children,
  onClose,
  onReview,
  onDiscardAndSign,
}: {
  open: boolean
  session: DictationSession
  signing: boolean
  /** Con quién se firma y la hora de fin: lo mismo que al firmar sin sugerencias. */
  children: ReactNode
  onClose: () => void
  onReview: () => void
  onDiscardAndSign: () => void
}) {
  const left = session.pending
  const one = left === 1
  const done = session.confirmed
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !signing) onClose()
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{one ? "Queda 1 sugerencia sin revisar" : `Quedan ${left} sugerencias sin revisar`}</AlertDialogTitle>
          <AlertDialogDescription>
            Lo que no confirmes no entra a la historia. Decide qué hacer con {one ? "ella" : "ellas"} antes de firmar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3">
          <ScrollArea className="flex max-h-48 flex-col">
            <ul aria-label="Sugerencias sin revisar" className="flex flex-col gap-2">
              {session.suggestions.map((item) => (
                <li key={item.id} className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-medium">{suggestionText(item).title}</span>
                    <span className="block">
                      {DICTATION_KIND_LABEL[item.kind]} · {suggestionMissing(item)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
          {done > 0 ? (
            <p className="text-sm text-muted-foreground">
              {done === 1 ? "La otra ya está confirmada y se firma con la atención." : `Las otras ${done} ya están confirmadas y se firman con la atención.`}
            </p>
          ) : null}
          {children}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={signing}>Cancelar</AlertDialogCancel>
          <SubmitButton type="button" variant="outline" pending={signing} onClick={onDiscardAndSign}>
            {one ? "Descartarla y firmar" : "Descartarlas y firmar"}
          </SubmitButton>
          <Button type="button" disabled={signing} onClick={onReview}>
            Revisar ahora
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
