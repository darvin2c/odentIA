import { EmptyState } from "@odentia/ui-patterns"
import { ActionForm, Field, QueryState, Section, cents, date, iso, money, optional, text, useClinical, useClinicalMutation } from "./shared"
import type { Account } from "./types"

export function AccountPanel({ patientId }: { patientId: string }) {
  const path = `/patients/${patientId}`
  const query = useClinical<Account>(`${path}/account`)
  const mutation = useClinicalMutation()
  const send = (suffix: string, body: unknown) => mutation.mutateAsync({ path: path + suffix, body })
  const account = query.data?.data
  if (!account) return <QueryState query={query} />
  const activeCharges = account.charges.filter(c => !c.voidedAt)
  const activePayments = account.payments.filter(p => !p.voidedAt)
  return <div className="space-y-5"><Section title="Cuenta del paciente">
    {!account.byCurrency.length && <EmptyState title="Sin movimientos económicos" description="Aceptar una propuesta no genera cargos. Registra un cargo o un anticipo cuando corresponda." />}
    {account.byCurrency.map(unit => <div key={unit.currency}><h3 className="font-medium">{unit.currency}</h3><dl className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">{([
      ["Acordado", unit.agreedCents], ["Cargado", unit.chargedCents], ["Pagado", unit.paidCents], ["Aplicado", unit.appliedCents], ["Devuelto", unit.refundedCents], ["Por cobrar", unit.outstandingCents], ["Anticipo disponible", unit.availableCreditCents],
    ] as const).map(([label,value]) => <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-xl font-semibold tabular-nums">{money(value,unit.currency)}</dd></div>)}</dl></div>)}
  </Section>
  <ActionForm title="Registrar pago o anticipo" submit="Registrar pago" onSubmit={form => send("/payments", { amountCents: cents(text(form,"amount")), currency: text(form,"currency"), paidAt: iso(text(form,"paidAt")), method: text(form,"method"), reference: optional(form,"reference") })}>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Importe" name="amount" /><Field label="Moneda" name="currency" defaultValue="PEN"><option>PEN</option><option>USD</option></Field><Field label="Fecha del pago" name="paidAt" type="datetime-local" defaultValue={new Date().toISOString().slice(0,16)} /><Field label="Medio de pago" name="method"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option><option value="yape">Yape</option><option value="plin">Plin</option><option value="otro">Otro</option></Field><Field label="Referencia" name="reference" required={false} /></div>
  </ActionForm>
  <ActionForm title="Aplicar pago a cargo" submit="Aplicar pago" onSubmit={form => send(`/payments/${text(form,"paymentId")}/applications`, {chargeId:text(form,"chargeId"),amountCents:cents(text(form,"amount"))})}>
    <Field label="Pago disponible" name="paymentId">{activePayments.map(p => <option value={p.id} key={p.id}>{date(p.paidAt)} · {money(p.amountCents,p.currency)}</option>)}</Field><Field label="Cargo" name="chargeId">{activeCharges.map(c => <option value={c.id} key={c.id}>{c.description} · {money(c.amountCents,c.currency)}</option>)}</Field><Field label="Importe a aplicar" name="amount" />
  </ActionForm>
  <Section title="Cargos">{account.charges.map(c => <div key={c.id} className="space-y-2 border-b py-3"><p>{c.description} · {money(c.amountCents,c.currency)} {c.voidedAt ? "· Anulado" : ""}</p>{!c.voidedAt && <ActionForm title="Anular cargo" onSubmit={form => send(`/charges/${c.id}/void`,{reason:text(form,"reason")})}><Field label="Motivo de anulación" name="reason" /></ActionForm>}</div>)}</Section>
  <Section title="Aplicaciones">{account.applications.map(a => <div key={a.id} className="space-y-2 border-b py-3"><p>{account.charges.find(c => c.id === a.chargeId)?.description} · {money(a.amountCents,account.payments.find(p => p.id === a.paymentId)?.currency)} {a.voidedAt ? "· Anulada" : ""}</p>{!a.voidedAt && <ActionForm title="Anular aplicación" onSubmit={form => send(`/payment-applications/${a.id}/void`,{reason:text(form,"reason")})}><Field label="Motivo de anulación" name="reason" /></ActionForm>}</div>)}</Section>
  <ActionForm title="Devolver excedente no aplicado" submit="Registrar devolución" onSubmit={form => send(`/payments/${text(form,"paymentId")}/refunds`,{amountCents:cents(text(form,"amount")),reason:text(form,"reason")})}><Field label="Pago" name="paymentId">{activePayments.map(p => <option key={p.id} value={p.id}>{date(p.paidAt)} · {money(p.amountCents,p.currency)}</option>)}</Field><Field label="Importe a devolver" name="amount" /><Field label="Motivo de devolución" name="reason" /><p className="text-sm text-muted-foreground">Para devolver un importe aplicado, anula primero su aplicación.</p></ActionForm>
  <ActionForm title="Registrar cargo manual" onSubmit={form => send("/charges",{description:text(form,"description"),amountCents:cents(text(form,"amount")),currency:text(form,"currency")})}><Field label="Concepto del cargo" name="description" /><Field label="Importe del cargo" name="amount" /><Field label="Moneda del cargo" name="currency" defaultValue="PEN"><option>PEN</option><option>USD</option></Field></ActionForm>
  <Section title="Pagos y devoluciones">{account.payments.map(p => <div key={p.id} className="space-y-2 border-b py-3"><p>{date(p.paidAt)} · {money(p.amountCents,p.currency)} · {p.method} {p.voidedAt ? "· Anulado" : ""}</p>{!p.voidedAt && <ActionForm title="Anular pago sin movimientos" onSubmit={form => send(`/payments/${p.id}/void`,{reason:text(form,"reason")})}><Field label="Motivo" name="reason" /></ActionForm>}</div>)}{account.refunds.map(r => <p key={r.id}>Devuelto: {money(r.amountCents,account.payments.find(p => p.id===r.paymentId)?.currency)} · {r.reason}</p>)}</Section>
  </div>
}
