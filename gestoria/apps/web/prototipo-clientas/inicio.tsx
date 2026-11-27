import { Badge, Button, toast } from "@odentia/ui"
import { KpiCard, PageHeader, PageShell, PersonAvatar } from "@odentia/ui-patterns"
import type { ReactNode } from "react"
import { totales } from "./argos"
import { cifrasDe, enviosDe } from "./campanas"
import { ACC, ACCIONES, plural, RUBROS, soles } from "./datos"
import { cambiar, planOf, useDb } from "./estado"
import { DeArgos, Tarjeta } from "./piezas"
import { href, ir, useRuta } from "./ruta"

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

/**
 * Inicio: «Te toca» trae solo lo que le toca resolver a quien entra; lo demás lo hacen Argos y
 * Sofi. Ventas no ve costos ni presupuesto.
 */
export function InicioPage() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const owner = !ruta.ventas
  const plan = planOf(ruta.rubro)
  const t = totales(plan, d)
  const hoy = enviosDe(d, R, plan).filter(
    (e) => e.cuandoTipo === "hara" && e.resTexto.startsWith("Sofi") && !d.pausa[e.a],
  )
  const lineas: ReactNode[] = []
  if (d.chat.rocio >= 4 && !d.paid)
    lineas.push(
      <Linea
        key="pago"
        tag="Pago"
        action={
          <Button size="sm" onClick={() => ir("/conversaciones/rocio")}>
            Ver y confirmar
          </Button>
        }
      >
        <b>Rocío Vega</b> envió su Yape de {soles(R.nuevo.price)} · pedido 0161, de la campaña «
        {ACC.despertar.t(R)}»
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
              toast.success("Listo: Sofi les escribe hoy, dentro del horario.")
            }}
          >
            Dejar que salgan
          </Button>
        }
      >
        {plural(t.espera, "encargo a Sofi pasa", "encargos a Sofi pasan")} el presupuesto de Meta
        del mes ({soles(d.budget)}). Lo demás sale solo.
      </Linea>,
    )
  if (!d.merged && !d.distinct)
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
  const vendio = ACCIONES.reduce((s, a) => s + cifrasDe(a.id, d).vendido, 0)
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={`Buenos días, ${(owner ? R.store.owner : R.store.ventas).split(" ")[0]}`}
        subtitle="Viernes 27 de noviembre"
      />
      {lineas.length ? (
        <section className="flex flex-col gap-3" aria-label="Te toca">
          <h2 className="text-lg font-semibold">Te toca</h2>
          <ul className="elevated overflow-hidden rounded-xl border bg-card">{lineas}</ul>
        </section>
      ) : null}
      {owner ? (
        <section aria-label="Lo que vendió Argos" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard
            title="Vendió con campañas"
            value={soles(vendio)}
            description="en 4 semanas, pedidos pagados"
          />
          <KpiCard
            title="Hoy, encargos a Sofi"
            value={t.msgs}
            description={`a ${plural(t.ppl, "clienta", "clientas")}`}
          />
          <KpiCard
            title="Datos que anotó Argos"
            value={d.cl.reduce(
              (n, c) => n + Object.values(c.datos).filter((x) => x?.quien === "Argos").length,
              0,
            )}
            description="tallas, distritos, cumpleaños…"
          />
          <KpiCard
            title="Gastó en Meta"
            value={soles(d.used)}
            description={`de ${soles(d.budget)} este mes`}
            meter={{ value: d.used, total: d.budget }}
          />
        </section>
      ) : null}
      {hoy.length ? (
        <Tarjeta
          title={`Hoy, Sofi les escribe a ${plural(hoy.length, "clienta", "clientas")} por encargo de Argos`}
          subtitle={
            <DeArgos>
              Cada una por una campaña y un motivo. Si responden, Sofi sigue la conversación.
            </DeArgos>
          }
          action={
            owner ? (
              <Button variant="outline" size="sm" onClick={() => ir("/argos/hara")}>
                Ver lo que hará
              </Button>
            ) : null
          }
        >
          <ul className="flex flex-col divide-y">
            {hoy.map((e) => (
              <li
                key={`${e.a}-${e.c.id}`}
                className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <PersonAvatar name={e.c.name} className="size-8" decorative />
                <span className="flex min-w-0 flex-1 flex-col text-sm">
                  <a href={href(`/clientes/${e.c.id}`)} className="font-medium hover:underline">
                    {e.c.name}
                  </a>
                  <span className="text-muted-foreground">
                    «{ACC[e.a].t(R)}» · porque {e.motivo}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{ACC[e.a].when}</span>
              </li>
            ))}
          </ul>
        </Tarjeta>
      ) : null}
    </PageShell>
  )
}
