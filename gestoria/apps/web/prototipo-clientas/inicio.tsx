import { Badge, Button, toast } from "@odentia/ui"
import { KpiCard, PageHeader, PageShell } from "@odentia/ui-patterns"
import type { ReactNode } from "react"
import { totales } from "./argos"
import { HIST, plural, RUBROS, soles } from "./datos"
import { cambiar, planOf, useDb } from "./estado"
import { DeArgos, Tarjeta } from "./piezas"
import { ir, useRuta } from "./ruta"

function Linea({ tag, children, action }: { tag: string; children: ReactNode; action: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-t px-4 py-3 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <Badge variant="outline" className="self-start">
          {tag}
        </Badge>
        <span className="text-sm">{children}</span>
      </span>
      {action}
    </li>
  )
}

/** Inicio: «Te toca» trae solo lo que necesita a una persona; lo demás lo hizo Argos. */
export function InicioPage() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const owner = !ruta.ventas
  const t = totales(planOf(ruta.rubro), d)
  const mariela = d.cl.find((c) => c.id === "c1")
  const lineas: ReactNode[] = []
  if (ruta.rubro && d.chat.rocio >= 4 && !d.paid)
    lineas.push(
      <Linea
        key="pago"
        tag="Pago"
        action={
          <Button size="sm" onClick={() => ir("/conversaciones")}>
            Ver y confirmar
          </Button>
        }
      >
        <b>Rocío Vega</b> envió su Yape de {soles(R.nuevo.price)} · pedido 0161, que armó Argos
      </Linea>,
    )
  if (owner && t.espera)
    lineas.push(
      <Linea
        key="meta"
        tag="Argos"
        action={
          <Button
            size="sm"
            onClick={() => {
              cambiar(ruta.rubro, (x) => {
                x.budgetOk = true
              })
              toast.success("Listo: salen hoy, dentro del horario.")
            }}
          >
            Dejar que salgan
          </Button>
        }
      >
        {plural(t.espera, "mensaje pasa", "mensajes pasan")} el presupuesto de Meta del mes (
        {soles(d.budget)}). Lo demás sale solo, a su hora.
      </Linea>,
    )
  if (mariela && !d.merged && !d.distinct)
    lineas.push(
      <Linea
        key="misma"
        tag="Clienta"
        action={
          <Button size="sm" variant="secondary" onClick={() => ir("/clientes/c1")}>
            Comparar
          </Button>
        }
      >
        ¿Las dos fichas de <b>Mariela Ríos</b> son la misma clienta? Argos lo sugiere; lo decide una
        persona.
      </Linea>,
    )
  const vendio = Object.values(d.extra).reduce((s, e) => s + (e?.v ?? 0), 0)
  const anotados = d.cl.reduce(
    (n, c) => n + Object.values(c.datos).filter((x) => x?.quien === "Argos").length,
    0,
  )
  const mes = Object.values(HIST).reduce((s, h) => s + h[4], 0) + vendio
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={`Buenos días, ${(owner ? R.store.owner : R.store.ventas).split(" ")[0]}`}
        subtitle="Viernes 27 de noviembre"
      />
      <section className="flex flex-col gap-3" aria-label="Te toca">
        <h2 className="text-lg font-semibold">Te toca</h2>
        {lineas.length ? (
          <ul className="elevated overflow-hidden rounded-xl border bg-card">{lineas}</ul>
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nada que espere a una persona. Argos sigue solo.
          </p>
        )}
      </section>
      <Tarjeta
        title="Lo que hizo Argos"
        subtitle={<DeArgos>Sin pedirte nada, dentro del tope y del presupuesto.</DeArgos>}
        action={
          <Button variant="outline" size="sm" onClick={() => ir("/argos")}>
            Ver todo
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard
            title="Vendió en 4 semanas"
            value={soles(mes)}
            description="pedidos pagados después de un mensaje"
          />
          <KpiCard
            title="Hoy sale solo"
            value={t.msgs}
            description={`a ${plural(t.ppl, "clienta", "clientas")}`}
          />
          <KpiCard
            title="Datos que anotó"
            value={anotados}
            description="tallas, distritos, cumpleaños…"
          />
          <KpiCard
            title="Gastó en Meta"
            value={soles(d.used)}
            description={`de ${soles(d.budget)} este mes`}
            meter={{ value: d.used, total: d.budget }}
          />
        </div>
      </Tarjeta>
    </PageShell>
  )
}
