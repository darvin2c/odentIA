import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@odentia/ui"
import { SubmitButton, submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { apiFetchBytes } from "../../../lib/api"
import { budgetPdfUrl, deliverBudgetApi, PLAN_QUERY_KEYS } from "../../../lib/budgets"
import { BudgetSendButton } from "./budget-send"

/**
 * «Mostrar a {nombre}» e «Imprimir» del presupuesto en borrador, sin salir de
 * la atención (issue 109, paso 2). Mostrar abre el mismo PDF que recibirá a
 * pantalla completa y no entrega nada: sigue en borrador. Imprimir lo entrega,
 * como «Imprimir y entregar» del Plan; enviar, como siempre, con su botón.
 */
export function BudgetShowActions({
  patientId,
  budgetId,
  patientName,
  beforeWrite,
}: {
  patientId: string
  budgetId: string
  patientName: string
  beforeWrite: () => Promise<void>
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pdf, setPdf] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
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
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-8"
          onClick={() => setOpen(true)}
        >
          Mostrar a {firstName}
        </Button>
        <SubmitButton
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-8"
          pending={printing}
          onClick={() => void print()}
        >
          Imprimir
        </SubmitButton>
      </div>
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
              Lo mismo que recibirá en su PDF. Mostrarlo no le envía nada: sigue en borrador.
            </DialogDescription>
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
              Imprimir
            </SubmitButton>
            <BudgetSendButton
              patientId={patientId}
              budgetId={budgetId}
              beforeSend={beforeWrite}
              onSent={() => setOpen(false)}
              reviewable
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
