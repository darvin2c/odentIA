import { Badge, cn, useIsMobile } from "@odentia/ui"
import { KpiCard, PageHeader, PageShell } from "@odentia/ui-patterns"
import { BellRing, Bike, CreditCard, Megaphone, PackageCheck, Smartphone } from "lucide-react"
import { RUBROS } from "../datos"
import { ir, useRuta } from "../ruta"
import { useTienda } from "../tienda"
import { TeTocaLista } from "./tarjeta"
import { cuentas, money, type Pedido, teToca, usePedidos } from "./modelo"
import { ConRouter } from "./router"

/** Los avisos que llegan al celular de quien atiende: pocos, y solo los que sirven. */
function AvisosCelular({ list }: { list: Pedido[] }) {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const urgente = list.find((p) => p.toca?.urgente)
  const pagos = list.filter((p) =>
    p.pagos.some((g) => g.medio === "link" && g.cuando.startsWith("Hoy")),
  )
  const items = [
    ...(urgente ? [{ I: Bike, t: "Ahora", d: urgente.toca!.texto, id: urgente.id }] : []),
    ...pagos.map((p) => ({
      id: p.id,
      I: CreditCard,
      t: "Ahora",
      d: `${p.clienta.split(" ")[0]} pagó ${money(cuentas(p).confirmado)} · pedido ${p.id}`,
    })),
    {
      I: CreditCard,
      t: "8:06 a. m.",
      d: "Milagros pagó con su link · pedido 0162 · campaña «Vuelven las sandalias»",
      id: "0162",
    },
    {
      I: Smartphone,
      t: "9:12 a. m.",
      d: "Llegó un Yape de Carla para confirmar · pedido 0164",
      id: "0164",
    },
    {
      I: PackageCheck,
      t: "8:00 a. m.",
      d: "No hay repartidor libre para Fiorella (Los Olivos, 2 a 6 p. m.) · pedido 0161",
      id: "0161",
    },
  ]
  return (
    <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <BellRing className="size-4" aria-hidden />
        Avisos a tu celular
      </h2>
      <ul className="flex flex-col gap-2">
        {items.slice(0, 4).map((x, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => ir(`/pedidos/${x.id}`)}
              className="flex w-full items-start gap-3 rounded-xl bg-muted/60 p-2.5 text-left text-sm hover:bg-muted"
            >
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white"
              style={{ background: R.store.color }}
            >
              <x.I className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>gestorIA · {R.store.name}</span>
                <span>{x.t}</span>
              </span>
              <span className="block leading-snug">{x.d}</span>
            </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Solo lo que pide a una persona o una venta pagada. Lo que avanza solo no suena. Se eligen en
        Configuración › Avisos.
      </p>
    </section>
  )
}

function Inicio() {
  const { rubro } = useRuta()
  const all = usePedidos(rubro)
  const owner = useTienda((s) => s.rol === "dueno")
  const isMobile = useIsMobile()
  const R = RUBROS[rubro]
  const vendido = all
    .filter((p) => p.paso !== "anulado" && p.creado.startsWith("Jue 27"))
    .reduce((a, p) => a + cuentas(p).total, 0)
  const cobrado = all
    .flatMap((p) => p.pagos)
    .filter(
      (g) =>
        g.estado === "confirmado" && (g.cuando.startsWith("Jue 27") || g.cuando.startsWith("Hoy")),
    )
    .reduce((a, g) => a + g.monto, 0)
  const salen = all.filter(
    (p) => p.entrega.dia === "Hoy" && ["preparando", "por_salir", "en_camino"].includes(p.paso),
  ).length
  const campana = all.filter((p) => p.origen.k === "campana" && p.paso !== "anulado")
  const toca = teToca(all).length
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Inicio" subtitle={`Jueves 27 · ${R.store.name}`} />
      <p className={cn("text-sm", toca ? "" : "text-muted-foreground")}>
        {toca ? (
          <>
            <b>{toca === 1 ? "Una cosa te necesita." : `${toca} cosas te necesitan.`}</b> Lo demás
            lo mueven solos Sofi, gestorIA, la pasarela y los repartidores. A ti solo te queda empacar, confirmar capturas de Yape o Plin, aprobar los cambios y devoluciones que deja listos Sofi, revisar lo que vuelve y los casos raros.
          </>
        ) : (
          "Nada te espera. Todo avanza solo."
        )}
      </p>
      <section aria-labelledby="toca-h" className="flex flex-col gap-3">
        <h2 id="toca-h" className="flex items-center gap-2 text-sm font-semibold">
          Te toca
          {toca ? <Badge variant="warning">{toca}</Badge> : null}
        </h2>
        <TeTocaLista list={all} className="md:grid-cols-2 xl:grid-cols-3" />
      </section>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {owner ? (
          <KpiCard
            title="Vendido hoy"
            value={money(vendido)}
            description={isMobile ? undefined : "Pedidos de hoy, sin anulados"}
          />
        ) : null}
        {owner ? (
          <KpiCard
            title="Cobrado hoy"
            value={money(cobrado)}
            description={isMobile ? undefined : "Confirmado por la pasarela, Kevin o tu equipo"}
          />
        ) : null}
        <KpiCard
          title="Salen hoy"
          value={salen}
          description={isMobile ? undefined : "Preparando, por salir y en camino"}
        />
        <KpiCard
          title="Te toca"
          value={toca}
          description={isMobile ? undefined : "Lo que espera a una persona"}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <AvisosCelular list={all} />
        {owner && campana.length ? (
          <section className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Megaphone className="size-4" aria-hidden />
              Campaña «Vuelven las sandalias»
              <Badge variant="soft">Argos</Badge>
            </h2>
            <p className="text-sm">
              Argos eligió a 14 clientas que compraron sandalias y no vuelven hace meses. Sofi les
              escribió: <b>{campana.length} compraron</b> por{" "}
              {money(campana.reduce((a, p) => a + cuentas(p).total, 0))}.
            </p>
            <ul className="flex flex-col divide-y rounded-xl border text-sm">
              {campana.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50"
                    onClick={() => ir(`/pedidos/${p.id}`)}
                  >
                    <span>
                      {p.id} · {p.clienta}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {money(cuentas(p).total)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </PageShell>
  )
}

export function InicioPage() {
  return (
    <ConRouter>
      <Inicio />
    </ConRouter>
  )
}
