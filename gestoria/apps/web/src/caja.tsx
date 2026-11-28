import { Button, FieldGroup, toast } from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Banknote, ChevronLeft, ChevronRight } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import { api } from "./lib/api"
import { CASH_KEY, type CashBox, fromWhom } from "./lib/caja"
import { DISPATCH_KEY } from "./lib/despachos"
import { HOME_KEY } from "./lib/inicio"
import { dayName, nextDay, storeToday, when } from "./lib/pedidos"
import { money, moneyInput, readMoney } from "./lib/tienda"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Caja (entrega 3 del lienzo «gestorIA como odentIA», tableros 4, 6 y 23): solo la caja del día,
 * sin turnos ni cierres. Lo cobrado por medio, lo que falta cobrar en las entregas del día y el
 * efectivo que trae cada repartidor, que se recibe con «Recibí». Las cifras son las mismas de
 * Reportes y de Despachos: las calcula el servidor en un solo lugar.
 */

function previousDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export function CashPage() {
  const { store } = useStoreContext()
  const [day, setDay] = useState<string | null>(null)
  const box = useQuery({
    queryKey: [...CASH_KEY(store.id), day ?? "hoy"],
    queryFn: () => api<CashBox>(`/api/tiendas/${store.id}/caja${day ? `?dia=${day}` : ""}`),
    refetchInterval: 60_000,
  })
  const today = box.data?.today ?? storeToday(store.timeZone)
  const chosen = box.data?.day ?? day ?? today
  const data = box.data
  const cur = store.currency
  return (
    <>
      <StoreHeader title="Caja" subtitle="Lo cobrado del día y el efectivo de cada repartidor." />
      <nav aria-label="Día de la caja" className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Día anterior"
          onClick={() => setDay(previousDay(chosen))}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-24 text-center text-sm font-semibold">{dayName(chosen, today)}</span>
        <Button
          variant="outline"
          size="icon"
          aria-label="Día siguiente"
          disabled={chosen >= today}
          onClick={() => setDay(nextDay(chosen) === today ? null : nextDay(chosen))}
        >
          <ChevronRight aria-hidden />
        </Button>
        {chosen !== today ? (
          <Button variant="ghost" onClick={() => setDay(null)}>
            Volver a hoy
          </Button>
        ) : null}
      </nav>
      {box.isPending ? <p className="text-sm text-muted-foreground">Cargando la caja…</p> : null}
      {box.isError ? <ErrorState error={box.error} onRetry={() => void box.refetch()} /> : null}
      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title={chosen === today ? "Cobrado hoy" : "Cobrado ese día"}>
              <p className="text-2xl font-semibold tabular-nums">
                {money(data.collected.cents, cur)}
              </p>
              {data.collected.byMethod.length ? (
                <ul className="flex flex-col gap-1 text-sm">
                  {data.collected.byMethod.map((m) => (
                    <li key={`${m.name}-${m.typeCode}`} className="flex justify-between gap-2">
                      <span>{m.name}</span>
                      <span className="tabular-nums">{money(m.cents, cur)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Todavía no se confirmó ningún pago.</p>
              )}
            </Card>
            <Card title="Falta cobrar en las entregas del día">
              <p className="text-2xl font-semibold tabular-nums">{money(data.due.cents, cur)}</p>
              <p className="text-sm text-muted-foreground">
                {data.due.orders === 0
                  ? "Nada: lo que sale está pagado."
                  : data.due.orders === 1
                    ? "En 1 entrega, la misma cifra que dice «Cobrar» en Despachos."
                    : `En ${data.due.orders} entregas, la misma cifra que dice «Cobrar» en Despachos.`}
              </p>
            </Card>
          </div>

          <section className="flex flex-col gap-2" aria-labelledby="por-recibir">
            <h2 id="por-recibir" className="text-sm font-semibold">
              Efectivo por recibir
            </h2>
            {data.toReceive.length === 0 ? (
              <EmptyState
                icon={Banknote}
                title="Nada por recibir"
                description="El efectivo que se cobra en la puerta aparece aquí, a nombre de quien llevó el pedido, hasta que alguien lo recibe."
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {data.toReceive.map((group) => (
                  <CashGroup key={group.courierId ?? "tienda"} group={group} />
                ))}
              </ul>
            )}
          </section>

          {data.received.length ? (
            <section className="flex flex-col gap-2" aria-labelledby="recibido">
              <h2 id="recibido" className="text-sm font-semibold">
                Recibido
              </h2>
              <ul className="elevated flex flex-col divide-y rounded-xl border bg-card">
                {data.received.map((r) => (
                  <li key={r.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
                    <span className="flex justify-between gap-2">
                      <span className="font-medium">{fromWhom(r.courierName)}</span>
                      <span className="tabular-nums">{money(r.receivedCents, cur)}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.differenceCents === 0
                        ? "Cuadró"
                        : r.differenceCents < 0
                          ? `Faltó ${money(-r.differenceCents, cur)} de ${money(r.expectedCents, cur)}`
                          : `Sobró ${money(r.differenceCents, cur)} de ${money(r.expectedCents, cur)}`}
                      {r.note ? ` · «${r.note}»` : ""} · recibió{" "}
                      {r.receivedByName ?? "alguien del equipo"} · {when(r.receivedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4"
    >
      <h2 id={id} className="text-sm font-semibold text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** El efectivo de un repartidor (o el de la tienda), con «Recibí». */
function CashGroup({ group }: { group: CashBox["toReceive"][number] }) {
  const { store } = useStoreContext()
  const cur = store.currency
  const [receiving, setReceiving] = useState(false)
  return (
    <li className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {fromWhom(group.name)} · te entrega {money(group.cents, cur)}
        </span>
        <Button onClick={() => setReceiving(true)}>Recibí {money(group.cents, cur)}</Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {group.payments.map((p) => (
          <li key={p.id} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">
              {p.number} · {p.customerName} · {when(p.at)}
            </span>
            <span className="tabular-nums">{money(p.amountCents, cur)}</span>
          </li>
        ))}
      </ul>
      {receiving ? <ReceiveDialog group={group} onClose={() => setReceiving(false)} /> : null}
    </li>
  )
}

/**
 * «Recibí»: lo que cuadra, o la diferencia con lo que pasó. Queda quién lo recibió y cuándo. Va
 * siempre en un cajón aparte (`dock={false}`): lo recibido solo se agrega, no se deshace.
 */
function ReceiveDialog({
  group,
  onClose,
}: {
  group: CashBox["toReceive"][number]
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const cur = store.currency
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (body: { receivedCents: number; note: string }) =>
      api(`/api/tiendas/${store.id}/caja/recibi`, {
        method: "POST",
        body: {
          courierId: group.courierId,
          paymentIds: group.payments.map((p) => p.id),
          ...body,
        },
      }),
  })
  // Lo escrito en «¿Cuánto recibiste?», para el botón y para preguntar por qué no cuadra.
  const [amount, setAmount] = useState(moneyInput(group.cents, cur))
  const received = readMoney(amount, cur)
  const differs = received !== null && received !== group.cents
  const form = useAppForm({
    defaultValues: { amount: moneyInput(group.cents, cur), note: "" },
    validators: {
      onSubmit: z.object({ amount: z.string(), note: z.string() }).superRefine((value, ctx) => {
        const cents = readMoney(value.amount, cur)
        if (cents === null)
          ctx.addIssue({
            code: "custom",
            path: ["amount"],
            message: "Escribe cuánto recibiste, como 169 o 169.50",
          })
        else if (cents !== group.cents && value.note.trim().length < 3)
          ctx.addIssue({ code: "custom", path: ["note"], message: "Escribe por qué no cuadra" })
      }),
    },
    onSubmit: async ({ value }) => {
      const cents = readMoney(value.amount, cur) ?? 0
      const differ = cents !== group.cents
      await save.mutateAsync({ receivedCents: cents, note: differ ? value.note : "" })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CASH_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: DISPATCH_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: HOME_KEY(store.id) }),
      ])
      toast.success(differ ? "Recibido, con la diferencia anotada" : "Recibido: cuadra")
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { receivedCents: "amount" } })
  return (
    <FormDrawer
      {...surface}
      open
      dock={false}
      title={`Recibí de ${fromWhom(group.name)}`}
      description={`Debía entregar ${money(group.cents, cur)} en efectivo. Queda a tu nombre, con la hora.`}
      submitLabel={received === null ? "Recibí" : `Recibí ${money(received, cur)}`}
      cancelLabel="Volver"
      onClose={onClose}
    >
      <FieldGroup className="gap-5">
        <form.AppField name="amount" listeners={{ onChange: ({ value }) => setAmount(value) }}>
          {(field) => (
            <field.Control label="¿Cuánto recibiste?">
              {(control) => (
                <MoneyInput
                  control={control}
                  currency={cur}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {differs ? (
          <form.AppField name="note">
            {(field) => (
              <field.TextField
                label="¿Por qué no cuadra?"
                maxLength={300}
                description={
                  received < group.cents
                    ? `Faltan ${money(group.cents - received, cur)}.`
                    : `Sobran ${money(received - group.cents, cur)}.`
                }
              />
            )}
          </form.AppField>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}
