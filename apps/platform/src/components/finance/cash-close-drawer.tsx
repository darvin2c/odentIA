/**
 * Cierre de caja: cuenta solo el efectivo, retiene base y entrega el resto.
 * La diferencia avisa a administración. La hoja es imprimible y firmable.
 * Un cierre no se edita: lo posterior queda como movimiento del día en que se
 * corrige.
 *
 * El cierre devuelve el turno, no la hoja: quien cierra relee la lista y abre
 * la hoja nueva. Dinero con el módulo compartido `@odentia/clinical`; moneda,
 * locale y zona siempre del perfil (props requeridas, nada fijo).
 */
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { usePermission } from "../../lib/crm"
import { collectErrorMessage } from "../../lib/finance"
import {
  createClosureApi,
  formatDateTimeShortLocale,
  type ClosureSheetEnvelope,
  type ShiftDetailBody,
} from "../../lib/finance-collect"

/** Lectura de formulario: null si el texto no es un importe válido. */
function parseOrNull(raw: string, currency: string, locale: string): number | null {
  try {
    return parseMoney(raw, currency, locale)
  } catch {
    return null
  }
}

export function CashCloseDrawer({
  branchId,
  branchName,
  currency,
  locale,
  timeZone,
  detalle,
  open,
  onClose,
  onClosed,
}: {
  branchId: string
  branchName: string
  currency: string
  locale: string
  timeZone?: string
  /** Ventana abierta con su arqueo en vivo; null si la sede aún no tiene caja. */
  detalle: ShiftDetailBody | null
  open: boolean
  onClose: () => void
  onClosed: () => void
}): React.JSX.Element {
  const canClose = usePermission("finance.close")
  const [counted, setCounted] = useState("")
  const [retained, setRetained] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!open) return
    setCounted("")
    setRetained(detalle ? formatMoneyInput(detalle.shift.openingCents, currency, locale) : "")
    setNotes("")
    setError(null)
    setDirty(false)
  }, [open, detalle, currency, locale])

  const countedCents = parseOrNull(counted, currency, locale) ?? 0
  const retainedCents = parseOrNull(retained, currency, locale) ?? 0
  const countedValid = parseOrNull(counted, currency, locale) !== null
  const retainedValid = parseOrNull(retained, currency, locale) !== null
  const deliveredCents = countedCents - retainedCents
  const difference = detalle ? countedCents - detalle.esperadoCents : 0

  const closeMutation = useMutation({
    mutationFn: () =>
      createClosureApi({
        branchId,
        currency,
        countedCents,
        retainedCents,
        deliveredCents,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: () => {
      setDirty(false)
      onClosed()
      onClose()
    },
    onError: (err) => setError(collectErrorMessage(err)),
  })

  return (
    <FormDrawer
      open={open}
      title={`Cerrar caja · ${branchName}`}
      description="Cuenta solo el efectivo. Los demás medios no se cuentan y quedan listados."
      error={error}
      isSubmitting={closeMutation.isPending}
      isLoading={detalle === null}
      isDirty={dirty}
      submitLabel="Cerrar caja"
      submitDisabled={!canClose || detalle === null}
      onClose={() => {
        if (!closeMutation.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!canClose) {
          setError("Solo quien cobra o administración puede cerrar la caja.")
          return
        }
        if (!detalle) return
        if (!countedValid) {
          setError("Indica el efectivo que contaste (0 si está vacía).")
          return
        }
        if (!retainedValid || retainedCents > countedCents) {
          setError("Lo que dejas no puede superar lo contado.")
          return
        }
        setError(null)
        closeMutation.mutate()
      }}
    >
      {!detalle ? (
        <EmptyState
          title="Sin caja abierta"
          description="La sede aún no tiene caja: cobra o registra un gasto para abrirla."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
            <div className="flex justify-between gap-2">
              <dt>Quedó del cierre anterior</dt>
              <dd className="tabular-nums">
                {formatMoney(detalle.shift.openingCents, currency, locale)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Cobros en efectivo</dt>
              <dd className="tabular-nums">{formatMoney(detalle.ingresosCents, currency, locale)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Gastos pagados con la caja</dt>
              <dd className="tabular-nums">−{formatMoney(detalle.egresosCents, currency, locale)}</dd>
            </div>
            <div className="flex justify-between gap-2 font-semibold">
              <dt>Debe haber</dt>
              <dd className="tabular-nums">{formatMoney(detalle.esperadoCents, currency, locale)}</dd>
            </div>
          </dl>
          <Field>
            <FieldLabel htmlFor="cierre-counted">1. Efectivo que contaste</FieldLabel>
            <Input
              id="cierre-counted"
              inputMode="decimal"
              placeholder="0.00"
              value={counted}
              onChange={(event) => {
                setCounted(event.target.value)
                setDirty(true)
              }}
            />
          </Field>
          {counted.trim() !== "" && countedValid && difference !== 0 ? (
            <p role="status" className="text-sm text-destructive">
              {difference > 0
                ? `Sobran ${formatMoney(difference, currency, locale)}.`
                : `Faltan ${formatMoney(-difference, currency, locale)}.`}{" "}
              Puedes cerrar igual; administración recibirá un aviso.
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="cierre-retained">2. Dejas para mañana</FieldLabel>
            <Input
              id="cierre-retained"
              inputMode="decimal"
              placeholder="0.00"
              value={retained}
              onChange={(event) => {
                setRetained(event.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between gap-2 font-semibold">
              <dt>Entregas</dt>
              <dd className="tabular-nums">{formatMoney(Math.max(0, deliveredCents), currency, locale)}</dd>
            </div>
          </dl>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            <p>Otros medios, no se cuentan:</p>
            {detalle.movements.filter((row) => row.kind === "cobro" && row.methodTypeCode !== "10").length === 0 ? (
              <p>—</p>
            ) : (
              detalle.movements
                .filter((row) => row.kind === "cobro" && row.methodTypeCode !== "10")
                .map((row) => (
                  <p key={row.id}>
                    {row.method ?? "Otro"} · {formatMoney(row.amountCents, currency, locale)}
                  </p>
                ))
            )}
          </div>
          <Field>
            <FieldLabel htmlFor="cierre-notes">Notas (opcional)</FieldLabel>
            <Textarea
              id="cierre-notes"
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value)
                setDirty(true)
              }}
            />
          </Field>
        </div>
      )}
    </FormDrawer>
  )
}

export function CashClosureSheet({
  sheet,
  locale,
  timeZone,
  orgName,
}: {
  sheet: ClosureSheetEnvelope
  locale: string
  timeZone?: string
  orgName?: string
}): React.JSX.Element {
  const nodeId = `cierre-${sheet.closure.id}`
  const closure = sheet.closure
  const unknown = "—"
  return (
    <div className="flex flex-col gap-3">
      <div id={nodeId} className="flex flex-col gap-1 rounded-md border bg-card p-4 text-sm">
        {orgName ? <p className="text-center font-semibold">{orgName}</p> : null}
        {sheet.branch ? <p className="text-center text-muted-foreground">{sheet.branch.name}</p> : null}
        <p className="text-center font-heading text-base font-semibold">CIERRE DE CAJA</p>
        {sheet.legacy ? (
          <p className="text-center text-xs text-muted-foreground">Cierre anterior (turno sin hoja completa)</p>
        ) : null}
        <p className="text-center text-muted-foreground">
          {formatDateTimeShortLocale(closure.closedAt, locale, timeZone)} · Cerró: {sheet.closedByName ?? "—"}
        </p>
        <p className="text-center text-muted-foreground">
          Desde: {formatDateTimeShortLocale(closure.windowFrom, locale, timeZone)}
        </p>
        <dl className="mt-2 flex flex-col gap-1">
          <div className="flex justify-between gap-2">
            <dt>Quedó del cierre anterior</dt>
            <dd className="tabular-nums">
              {formatMoney(closure.openingRetainedCents, closure.currency, locale)}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Cobros en efectivo</dt>
            <dd className="tabular-nums">
              {closure.cashCollectedCents === null
                ? unknown
                : formatMoney(closure.cashCollectedCents, closure.currency, locale)}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Gastos</dt>
            <dd className="tabular-nums">−{formatMoney(closure.expenseCashCents, closure.currency, locale)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Debe haber</dt>
            <dd className="tabular-nums">{formatMoney(closure.expectedCents, closure.currency, locale)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Contado</dt>
            <dd className="tabular-nums">{formatMoney(closure.countedCents, closure.currency, locale)}</dd>
          </div>
          <div className="flex justify-between gap-2 font-semibold">
            <dt>Diferencia</dt>
            <dd className="tabular-nums">{formatMoney(closure.differenceCents, closure.currency, locale)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Queda en caja</dt>
            <dd className="tabular-nums">
              {closure.retainedCents === null ? unknown : formatMoney(closure.retainedCents, closure.currency, locale)}
            </dd>
          </div>
          <div className="flex justify-between gap-2 font-semibold">
            <dt>ENTREGA</dt>
            <dd className="tabular-nums">
              {closure.deliveredCents === null ? unknown : formatMoney(closure.deliveredCents, closure.currency, locale)}
            </dd>
          </div>
          {(sheet.totalsByMethod ?? []).map((row) => (
            <div key={row.name} className="flex justify-between gap-2 text-muted-foreground">
              <dt>
                {row.name} ({row.count})
              </dt>
              <dd className="tabular-nums">{formatMoney(row.amountCents, closure.currency, locale)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs text-muted-foreground">
          <p>Entrega: ____________________</p>
          <p>Recibe: ____________________</p>
        </div>
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const node = document.getElementById(nodeId)
            if (!node) return
            const style = document.createElement("style")
            style.textContent = `@media print {
              body * { visibility: hidden; }
              #${nodeId}, #${nodeId} * { visibility: visible; }
              #${nodeId} { position: absolute; inset: 0 0 auto 0; }
            }`
            document.head.append(style)
            const cleanup = () => {
              style.remove()
              window.removeEventListener("afterprint", cleanup)
            }
            window.addEventListener("afterprint", cleanup)
            window.print()
          }}
        >
          Imprimir
        </Button>
      </div>
    </div>
  )
}
