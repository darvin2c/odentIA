import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@odentia/ui"
import { SubmitButton, submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { apiFetchBytes } from "../../../lib/api"
import { budgetPdfUrl, deliverBudgetApi, PLAN_QUERY_KEYS } from "../../../lib/budgets"
import { RecommendedLine } from "./budget-recommended"
import { BudgetSendButton } from "./budget-send"
import { AnswerInPersonButton, BudgetAnswerDrawer } from "./next-step-action"

/**
 * «Mostrar a {nombre}» e «Imprimir y entregar» del presupuesto en borrador, sin
 * salir de la atención. Mostrar abre el mismo PDF que recibirá a pantalla completa
 * y no entrega nada: sigue en borrador. Desde ahí, lo principal es anotar qué
 * respondió (queda entregado en consulta, sin enviarle nada); imprimir lo entrega,
 * como en el Plan; enviar, como siempre, con su botón.
 */
export function BudgetShowActions({
  patientId,
  budgetId,
  patientName,
  beforeWrite,
  menu = false,
}: {
  patientId: string
  budgetId: string
  patientName: string
  beforeWrite: () => Promise<void>
  /**
   * En la atención, «Anotar su respuesta» es el botón principal y esto va en un
   * menú «Mostrar · Imprimir · Enviar». Enviar abre lo mismo que se le muestra,
   * con «Enviar» y a quién le llega, para ver antes qué recibe.
   */
  menu?: boolean
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pdf, setPdf] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const [answering, setAnswering] = useState(false)
  const firstName = patientName.split(" ")[0] || patientName
  // Lo escrito se guarda antes de leer el PDF; la función cambia en cada render y no debe volver a pedirlo.
  const save = useRef(beforeWrite)
  save.current = beforeWrite

  useEffect(() => {
    if (!open) return
    let alive = true
    let made: string | null = null
    setError(null)
    void (async () => {
      try {
        await save.current()
        const bytes = await apiFetchBytes(budgetPdfUrl(patientId, budgetId))
        made = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
        if (alive) setPdf(made)
      } catch (err) {
        if (alive) setError(submitErrorMessage(err))
      }
    })()
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
      setPdf(null)
    }
  }, [open, patientId, budgetId])

  /** Imprimir es entregarlo: el PDF se genera antes; si falla, no queda entregado. */
  const print = async () => {
    if (printing) return
    // La pestaña se abre dentro del clic (después, el navegador la bloquea).
    const win = window.open("", "_blank")
    if (win) win.opener = null
    setPrinting(true)
    setError(null)
    try {
      await beforeWrite()
      await apiFetchBytes(budgetPdfUrl(patientId, budgetId))
      await deliverBudgetApi(patientId, budgetId)
      const url = URL.createObjectURL(
        new Blob([await apiFetchBytes(budgetPdfUrl(patientId, budgetId))], {
          type: "application/pdf",
        }),
      )
      if (win && !win.closed) win.location.href = url
      else window.open(url, "_blank", "noopener")
      setOpen(false)
      await Promise.all(
        PLAN_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })),
      )
    } catch (err) {
      if (win && !win.closed) win.close()
      setError(submitErrorMessage(err))
    } finally {
      setPrinting(false)
    }
  }

  return (
    <>
      {menu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" />
            }
          >
            Mostrar · Imprimir · Enviar
            <ChevronDown aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setOpen(true)}>Mostrar a {firstName}</DropdownMenuItem>
            <DropdownMenuItem disabled={printing} onClick={() => void print()}>
              Imprimir y entregar
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setOpen(true)}>Enviar…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {menu ? null : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={() => setOpen(true)}
          >
            Mostrar a {firstName}
          </Button>
          {/* Lo que sigue a mostrárselo: anotar lo que respondió, sin imprimir ni enviar. */}
          <AnswerInPersonButton
            patientId={patientId}
            budgetId={budgetId}
            beforeOpen={beforeWrite}
          />
          <SubmitButton
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-8"
            pending={printing}
            onClick={() => void print()}
          >
            Imprimir y entregar
          </SubmitButton>
        </div>
      )}
      {error && !open ? (
        <p role="alert" className="basis-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[92dvh] w-[96vw] max-w-5xl flex-col gap-3 sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Presupuesto para {patientName}</DialogTitle>
            <DialogDescription>
              Lo mismo que recibirá en su PDF. Mostrarlo no le envía nada. Si anotas su respuesta, queda entregado en
              consulta.
            </DialogDescription>
            <RecommendedLine patientId={patientId} budgetId={budgetId} className="text-sm" />
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/30">
            {pdf ? (
              <iframe title={`Presupuesto para ${patientName}`} src={pdf} className="size-full" />
            ) : error ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">Preparando el presupuesto…</p>
            )}
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cerrar
            </Button>
            <SubmitButton
              type="button"
              variant="outline"
              pending={printing}
              onClick={() => void print()}
            >
              Imprimir y entregar
            </SubmitButton>
            <BudgetSendButton
              patientId={patientId}
              budgetId={budgetId}
              beforeSend={beforeWrite}
              onSent={() => setOpen(false)}
              variant="outline"
              reviewable
            />
            <AnswerInPersonButton
              patientId={patientId}
              budgetId={budgetId}
              size="default"
              variant="default"
              beforeOpen={beforeWrite}
              onOpen={() => {
                setOpen(false)
                setAnswering(true)
              }}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {answering ? (
        <BudgetAnswerDrawer patientId={patientId} budgetId={budgetId} inPerson onClose={() => setAnswering(false)} />
      ) : null}
    </>
  )
}
