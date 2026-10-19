import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { useEffect, useState } from "react"
import { API_URL } from "../../lib/auth-client"
import { centsToMajor, formatPlanMoney, majorToCents } from "./money"

export interface ReceiptCharge {
  id: string
  planName: string
  amountCents: number
  currency: string
  paidCents: number
  status: string
}

export interface ReceiptMethod {
  code: string
  name: string
  instructions: string | null
}

const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf"
const MAX_BYTES = 10 * 1024 * 1024

/** Registra un comprobante (multipart a /api/account/billing/receipts). Disponible en restricción. */
export function ReceiptForm({
  orgId,
  charges,
  methods,
  onDone,
}: {
  orgId: string
  charges: ReceiptCharge[]
  methods: ReceiptMethod[]
  onDone: () => void
}) {
  const open = charges.filter((charge) => charge.status === "pendiente" || charge.status === "parcial")
  const [chargeId, setChargeId] = useState(open[0]?.id ?? "")
  const [methodCode, setMethodCode] = useState(methods[0]?.code ?? "")
  const [amount, setAmount] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  // Clave estable por intento: se conserva al reintentar un error ambiguo y
  // rota al cambiar de cargo o al confirmar (nunca un UUID nuevo por clic).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID())
  }, [chargeId])

  const selected = open.find((charge) => charge.id === chargeId) ?? null
  const outstanding = selected ? selected.amountCents - selected.paidCents : 0

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!selected || !methodCode || !file) {
      setError("Elige el cargo, el medio y el archivo del comprobante.")
      return
    }
    const amountCents = majorToCents(amount, selected.currency)
    if (amountCents === null) {
      setError("El importe debe ser un número mayor que cero.")
      return
    }
    if (amountCents > outstanding) {
      setError(`El importe supera el saldo del cargo (${formatPlanMoney(outstanding, selected.currency)}).`)
      return
    }
    if (file.size > MAX_BYTES || file.size === 0) {
      setError("El archivo debe pesar entre 1 B y 10 MB.")
      return
    }
    setSending(true)
    try {
      const form = new FormData()
      form.append("orgId", orgId)
      form.append("chargeId", selected.id)
      form.append("methodCode", methodCode)
      form.append("amountCents", String(amountCents))
      form.append("idempotencyKey", idempotencyKey)
      form.append("file", file, file.name)
      const response = await fetch(`${API_URL}/api/account/billing/receipts`, {
        method: "POST",
        credentials: "include",
        body: form,
      })
      if (!response.ok) {
        let message = `Error ${response.status}`
        try {
          const body: unknown = await response.json()
          if (typeof body === "object" && body !== null && "error" in body) {
            const errorNode: unknown = body.error
            if (typeof errorNode === "object" && errorNode !== null && "message" in errorNode) {
              const text: unknown = errorNode.message
              if (typeof text === "string" && text) message = text
            }
          }
        } catch {
          // respuesta no-JSON: mensaje por estado
        }
        setError(message)
        return
      }
      setIdempotencyKey(crypto.randomUUID())
      setSent(true)
      onDone()
    } finally {
      setSending(false)
    }
  }

  if (open.length === 0) {
    return <p className="text-sm text-muted-foreground">No tienes cargos pendientes.</p>
  }
  if (methods.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay medios de pago configurados. Escribe a soporte para registrar tu comprobante.
      </p>
    )
  }
  if (sent) {
    return (
      <p className="text-sm">
        Comprobante registrado: queda pendiente de confirmación y te avisaremos al confirmarlo.
      </p>
    )
  }

  const method = methods.find((item) => item.code === methodCode) ?? null

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="receipt-charge">Cargo</Label>
        <Select value={chargeId} items={Object.fromEntries(open.map(charge => [charge.id, `${charge.planName} · saldo ${formatPlanMoney(charge.amountCents - charge.paidCents, charge.currency)}`]))} onValueChange={(value) => { if (value) setChargeId(value) }}>
          <SelectTrigger id="receipt-charge">
            <SelectValue placeholder="Elige el cargo" />
          </SelectTrigger>
          <SelectContent>
            {open.map((charge) => (
              <SelectItem key={charge.id} value={charge.id}>
                {charge.planName} · saldo {formatPlanMoney(charge.amountCents - charge.paidCents, charge.currency)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="receipt-method">Medio usado</Label>
          <Select value={methodCode} items={Object.fromEntries(methods.map(method => [method.code, method.name]))} onValueChange={(value) => { if (value) setMethodCode(value) }}>
            <SelectTrigger id="receipt-method">
              <SelectValue placeholder="Elige el medio" />
            </SelectTrigger>
            <SelectContent>
              {methods.map((item) => (
                <SelectItem key={item.code} value={item.code}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="receipt-amount">Importe{selected ? ` (${selected.currency})` : ""}</Label>
          <Input
            id="receipt-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={selected ? centsToMajor(outstanding, selected.currency) : ""}
          />
        </div>
      </div>
      {method?.instructions ? (
        <p className="text-xs text-muted-foreground">{method.instructions}</p>
      ) : null}
      <div className="flex flex-col gap-1">
        <Label htmlFor="receipt-file">Comprobante (PNG, JPG, WebP o PDF, máx. 10 MB)</Label>
        <Input
          id="receipt-file"
          type="file"
          accept={ACCEPT}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={sending}>
        {sending ? "Enviando…" : "Registrar comprobante"}
      </Button>
    </form>
  )
}
