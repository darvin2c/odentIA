import { Badge, Button, cn, useIsMobile } from "@odentia/ui"
import { AgentMark, DetailSection, PageHeader, PageShell } from "@odentia/ui-patterns"
import {
  ArrowLeft,
  Ban,
  Bike,
  Bot,
  CalendarClock,
  Check,
  Clock3,
  CreditCard,
  ExternalLink,
  Link2,
  Megaphone,
  MessageCircle,
  Package,
  PencilLine,
  RotateCcw,
  Send,
  Smartphone,
  Sparkles,
  Store,
  Truck,
  UserRound,
} from "lucide-react"
import { useState } from "react"
import { foto, RUBROS } from "../datos"
import { href, ir, useRuta } from "../ruta"
import { abrirCajon } from "./cajon"
import { Ampliable, FotoMarcada, ImagenPago } from "./ejemplos"
import {
  type Accion,
  type Actor,
  asignarSolo,
  avisar,
  CAMINO,
  CANAL,
  CONFIRMA,
  cuentas,
  entregaTexto,
  loQueFalta,
  MEDIO,
  money,
  mover,
  origenTexto,
  PASO,
  type Paso,
  type Pedido,
  tocaDe,
  todoElChat,
  trasPagar,
  tresHorasAntes,
  usePedido,
  usePedidos,
} from "./modelo"
import { saldoAFavor, vueltaSigue } from "./vuelta"
import { SimularVuelta, VueltaBloque } from "./vuelta-ui"

export const ACTOR: Record<Actor, { label: string; Icon: typeof Bot; tono: string }> = {
  sofi: { label: "Sofi", Icon: Sparkles, tono: "bg-primary-soft text-primary-soft-foreground" },
  argos: { label: "Argos", Icon: Megaphone, tono: "bg-primary-soft text-primary-soft-foreground" },
  pasarela: { label: "La pasarela", Icon: CreditCard, tono: "bg-success-soft text-success" },
  repartidor: { label: "Repartidor", Icon: Bike, tono: "bg-secondary text-secondary-foreground" },
  persona: { label: "Una persona", Icon: UserRound, tono: "bg-warning-soft text-warning" },
  clienta: { label: "La clienta", Icon: MessageCircle, tono: "bg-muted text-muted-foreground" },
  gestoria: { label: "gestorIA", Icon: Bot, tono: "bg-muted text-muted-foreground" },
}

/** Qué pasa ahora y quién lo mueve: una frase, siempre. */
export function queSigue(p: Pedido): { texto: string; persona: boolean } {
  const k = cuentas(p)
  const n = p.clienta.split(" ")[0]
  const toca = tocaDe(p)
  if (toca) return { texto: toca.texto, persona: true }
  switch (p.paso) {
    case "por_pagar":
      return p.cobro === "link"
        ? {
            texto: `espera que ${n} pague su link. Sofi se lo recuerda el ${tresHorasAntes(p.separadoHasta ?? "").toLowerCase()}; si no paga hasta el ${p.separadoHasta?.toLowerCase() ?? "vencimiento"}, se libera y se anula solo.`,
            persona: false,
          }
        : { texto: `espera el pago de ${n}.`, persona: false }
    case "por_confirmar":
      return { texto: `espera la captura de ${n}.`, persona: false }
    case "pagado":
      return {
        texto:
          p.entrega.tipo === "agencia"
            ? `pagado. Sale por ${p.entrega.agencia ?? "agencia"} el ${p.entrega.dia?.toLowerCase() ?? "día de envío"}.`
            : `pagado. ${p.entrega.dia === "Hoy" ? "Hoy" : `El ${p.entrega.dia?.toLowerCase() ?? "día de entrega"}`} a las 8 a. m. pasa a Preparando${p.entrega.repartidor ? ` con ${p.entrega.repartidor}` : " y gestorIA le asigna repartidor"}.`,
        persona: false,
      }
    case "preparando":
      return { texto: "sale hoy.", persona: false }
    case "por_salir":
      return {
        texto: `espera que ${p.entrega.repartidor ?? "el repartidor"} toque «Salí» en su app.${k.falta ? ` Cobra ${money(k.falta)} en la puerta.` : ""}`,
        persona: false,
      }
    case "en_camino":
      return p.entrega.tipo === "agencia"
        ? {
            texto: `va por ${p.entrega.agencia}, N.º ${p.entrega.numero}. Se cierra cuando ${n} lo recoge.`,
            persona: false,
          }
        : {
            texto: `${p.entrega.repartidor} lo lleva.${k.falta ? ` Cobra ${money(k.falta)}: sin pago confirmado no entrega.` : " Está pagado: lo entrega con un toque."}`,
            persona: false,
          }
    case "entregado":
      if (p.vuelta) return { texto: vueltaSigue(p) ?? "entregado.", persona: false }
      return {
        texto: p.cambioEn
          ? `entregado. Tiene un cambio en el pedido ${p.cambioEn}.`
          : "entregado. Si pide un cambio o una devolución, Sofi lo atiende según tu política.",
        persona: false,
      }
    case "anulado":
      return {
        texto:
          "anulado. Si escribe otra vez, Sofi vuelve a cotizar con el precio y el stock del momento.",
        persona: false,
      }
  }
}

/**
 * Los botones según el estado. El principal aparece solo cuando de verdad toca a una persona;
 * las correcciones a mano van en el menú ⋯ de la página.
 */
export function acciones(p: Pedido): { principal?: [Accion, string]; otras: [Accion, string][] } {
  const toca = tocaDe(p)
  const principal: [Accion, string] | undefined = toca ? [toca.accion, toca.boton] : undefined
  const otras: [Accion, string][] = []
  const noSalio = ["por_pagar", "por_confirmar", "pagado", "preparando", "por_salir"].includes(
    p.paso,
  )
  if (noSalio) otras.push(["cambiar", "Cambiar"], ["pasar", "Pasar a…"])
  if (["pagado", "preparando", "por_salir"].includes(p.paso) && p.entrega.tipo === "moto")
    otras.push(["asignar", "Cambiar repartidor"])
  if (p.paso === "en_camino") otras.push(["cobrar", "Marcar entregado"], ["no_entregado", "No se entregó"])
  if (p.paso === "entregado" && !p.cambioEn && !p.vuelta) otras.push(["cambio", "Cambio o devolución"])
  if (noSalio) otras.push(["anular", "Anular…"])
  return { principal, otras: otras.filter(([a]) => a !== principal?.[0]) }
}

/** Una sección de la columna lateral, con su borde: la pieza de detalle de la app. */
export function Bloque({
  title,
  extra,
  children,
}: {
  title: string
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <DetailSection title={title} actions={extra} className="elevated rounded-xl border bg-card p-4">
      {children}
    </DetailSection>
  )
}

/** El primer nombre, para los textos. */
const nombre = (p: Pedido) => p.clienta.split(" ")[0]!

/** Los pasos que ve este pedido: sin «Pago por confirmar» si no hubo captura. */
function caminoDe(p: Pedido): Paso[] {
  return CAMINO.filter(
    (s) =>
      s !== "por_confirmar" ||
      p.cobro === "captura" ||
      p.pagos.some((x) => x.medio === "yape" || x.medio === "plin"),
  ).filter(
    (s) =>
      !(p.cobro === "al_recibir" && !p.pagos.length && (s === "pagado" || s === "por_confirmar")),
  )
}

/**
 * Los 7 pasos a lo ancho: el hecho, con quién y a qué hora; el que falta, con quién lo va a
 * mover y cuándo. Las salidas (no se entregó, anulado, cambio) se ven si ocurrieron.
 */
export function Pasos({ p, compacto }: { p: Pedido; compacto?: boolean }) {
  const camino = caminoDe(p)
  const at = camino.indexOf(p.paso)
  const falta = loQueFalta(p)
  const anulado = p.paso === "anulado"
  if (compacto)
    return (
      <ol className="flex w-full items-start gap-0.5" aria-label="Pasos del pedido">
        {camino.map((s, i) => (
          <li key={s} className="flex min-w-0 flex-1">
            <span
              className={cn(
                "h-1.5 w-full rounded-full",
                i < at || (p.paso === "entregado" && i <= at)
                  ? "bg-success"
                  : i === at
                    ? "bg-primary"
                    : "bg-muted",
              )}
            />
          </li>
        ))}
      </ol>
    )
  return (
    <div className="flex flex-col gap-2">
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <ol
          className="grid gap-1.5"
          style={{
            gridTemplateColumns: `repeat(${camino.length}, minmax(0, 1fr))`,
            minWidth: `${camino.length * 8.5}rem`,
          }}
          aria-label="Pasos del pedido"
        >
          {camino.map((s, i) => {
            const ev = [...p.eventos].reverse().find((e) => e.paso === s)
            const done = anulado ? !!ev : i < at || (p.paso === "entregado" && i <= at)
            const now = !anulado && i === at && p.paso !== "entregado"
            const sig = falta.find((f) => f.paso === s)
            return (
              <li
                key={s}
                className={cn(
                  "flex min-w-0 flex-col gap-1.5 rounded-xl border p-2.5 text-xs",
                  now && "border-primary bg-primary-soft/40",
                  !done && !now && "border-dashed",
                )}
                aria-current={now ? "step" : undefined}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                      done
                        ? "bg-success text-white"
                        : now
                          ? "bg-primary text-primary-foreground"
                          : "border text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "text-[13px] leading-tight font-semibold",
                      !done && !now && "font-medium text-muted-foreground",
                    )}
                  >
                    {PASO[s].corto}
                  </span>
                </span>
                {(done || now) && ev ? (
                  <span className="leading-snug text-muted-foreground">
                    <b className="font-medium text-foreground">{ev.quien}</b>
                    <span className="block">{ev.cuando}</span>
                    {now ? <span className="block font-medium text-primary">Ahora</span> : null}
                  </span>
                ) : done && ev ? (
                  <span className="leading-snug text-muted-foreground">
                    <b className="font-medium text-foreground">{ev.quien}</b>
                    <span className="block">{ev.cuando}</span>
                  </span>
                ) : sig ? (
                  <span className="leading-snug text-muted-foreground">
                    {now ? "Ahora: " : "Falta: "}
                    <b className="font-medium text-foreground">{sig.quien}</b>
                    <span className="block">{sig.cuando}</span>
                  </span>
                ) : now ? (
                  <span className="leading-snug text-muted-foreground">Ahora</span>
                ) : (
                  <span className="leading-snug text-muted-foreground">
                    {anulado ? "No llegó" : "—"}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
      {anulado || p.noEntregado || p.cambioDe || p.cambioEn ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {anulado ? (
            <Badge variant="outline">
              <Ban aria-hidden /> Anulado
            </Badge>
          ) : null}
          {p.noEntregado ? (
            <Badge variant="warning">
              <RotateCcw aria-hidden /> No se entregó: {p.noEntregado.toLowerCase()}
            </Badge>
          ) : null}
          {p.cambioDe ? (
            <a href={href(`/pedidos/${p.cambioDe}`)} className="rounded-full">
              <Badge variant="soft">
                <RotateCcw aria-hidden /> Es el cambio del {p.cambioDe}
              </Badge>
            </a>
          ) : null}
          {p.cambioEn ? (
            <a href={href(`/pedidos/${p.cambioEn}`)} className="rounded-full">
              <Badge variant="soft">
                <RotateCcw aria-hidden /> Cambio en el {p.cambioEn}
              </Badge>
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function Carrito({ p }: { p: Pedido }) {
  const k = cuentas(p)
  return (
    <Bloque title="El carrito">
      <ul className="-my-1 flex flex-col divide-y">
        {p.lineas.map((l) => (
          <li key={l.id} className="flex items-center gap-3 py-2.5 text-sm">
            {l.foto ? (
              <img
                src={foto(l.foto)}
                alt=""
                className="size-11 shrink-0 rounded-lg bg-muted object-cover"
              />
            ) : (
              <Package className="size-5 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {l.vuelve ? `Vuelve: ${l.nombre}` : l.nombre}
              </span>
              <span className="block truncate text-muted-foreground">
                {l.variante} · × {l.qty}
              </span>
            </span>
            <span className="tabular-nums">
              {l.vuelve ? `− ${money(l.precio * l.qty)}` : money(l.precio * l.qty)}
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between py-2 text-sm">
          <span className="text-muted-foreground">Envío · {p.entrega.zona}</span>
          <span className="tabular-nums">
            {p.entrega.envio ? money(p.entrega.envio) : "Gratis"}
          </span>
        </li>
        <li className="flex items-center justify-between py-2 text-sm font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{money(k.total)}</span>
        </li>
      </ul>
      {p.cedido ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {p.cedido}
        </p>
      ) : null}
    </Bloque>
  )
}

export function Saldo({
  p,
  onAccion,
}: {
  p: Pedido
  onAccion: (a: Accion | "deshacer", pagoId?: string) => void
}) {
  const k = cuentas(p)
  return (
    <Bloque
      title="El saldo y los pagos"
      extra={
        k.pagado ? (
          <Badge variant="success">Pagado</Badge>
        ) : k.falta ? (
          <Badge variant="warning">Falta {money(k.falta)}</Badge>
        ) : (
          <Badge variant="warning">Por confirmar {money(k.porConfirmar)}</Badge>
        )
      }
    >
      <dl className="grid grid-cols-3 gap-2 text-center text-sm">
        {[
          ["Total", money(k.total)],
          ["Cobrado", money(k.confirmado)],
          [k.alRecibir && k.falta ? "Falta · al recibir" : "Falta", money(k.falta)],
        ].map(([a, b]) => (
          <div key={a} className="rounded-xl bg-muted/60 px-2 py-2">
            <dt className="text-[11px] text-muted-foreground">{a}</dt>
            <dd className="font-semibold tabular-nums">{b}</dd>
          </div>
        ))}
      </dl>
      {p.pagos.length ? (
        <ul className="flex flex-col divide-y">
          {p.pagos.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {MEDIO[g.medio]} · {money(g.monto)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {g.estado === "confirmado"
                    ? `Confirmó ${g.quien ?? "—"} · ${g.cuando}`
                    : g.estado === "por_confirmar"
                      ? `Llegó la captura · ${g.cuando}`
                      : g.estado === "no_coincide"
                        ? `No coincide: ${g.motivo?.toLowerCase()}`
                        : `Deshecho: ${g.motivo}`}
                </span>
              </span>
              {g.estado === "confirmado" &&
              (g.medio === "yape" || g.medio === "plin") &&
              p.paso !== "entregado" ? (
                <Button size="sm" variant="ghost" onClick={() => onAccion("deshacer", g.id)}>
                  Deshacer
                </Button>
              ) : (
                <Badge
                  variant={
                    g.estado === "confirmado"
                      ? "success"
                      : g.estado === "por_confirmar"
                        ? "warning"
                        : "outline"
                  }
                >
                  {g.estado === "confirmado"
                    ? "Confirmado"
                    : g.estado === "por_confirmar"
                      ? "Por confirmar"
                      : g.estado === "no_coincide"
                        ? "No coincide"
                        : "Deshecho"}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {p.cobro === "link"
          ? `Paga en su link: ${CONFIRMA.link.toLowerCase()}.`
          : p.cobro === "captura"
            ? `Yape o Plin al número de la tienda: ${CONFIRMA.yape.toLowerCase()}. Si falta algo, Sofi lo cobra con su link.`
            : "Paga al recibir: lo confirma el repartidor (efectivo, o POS con la foto del voucher)."}{" "}
        Sin pago confirmado no se entrega.
      </p>
    </Bloque>
  )
}

export function EntregaB({ p }: { p: Pedido }) {
  const e = p.entrega
  return (
    <Bloque
      title="La entrega"
      extra={
        <Button size="sm" variant="ghost" onClick={() => ir("/clienta", { extra: `p=${p.id}` })}>
          <Link2 aria-hidden />
          Su link
        </Button>
      }
    >
      <div className="flex items-start gap-3 text-sm">
        {e.tipo === "agencia" ? (
          <Truck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Bike className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            {e.tipo === "agencia"
              ? entregaTexto(e)
              : [
                  e.repartidor ?? "Sin repartidor todavía",
                  e.dia,
                  e.franja,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
          <span className="text-muted-foreground">{e.direccion}</span>
          {e.tipo === "agencia" ? (
            <span className="inline-flex items-center gap-1 text-primary">
              Ver en {e.agencia} <ExternalLink className="size-3" aria-hidden />
            </span>
          ) : !e.repartidor ? (
            <span className="text-xs text-muted-foreground">
              gestorIA asigna al repartidor de siempre de {e.zona} cuando llegue su día.
            </span>
          ) : null}
        </span>
      </div>
      {e.repartidor && ["por_salir", "en_camino"].includes(p.paso) ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => ir("/reparto")}>
          <Smartphone aria-hidden />
          Ver la app de {e.repartidor}
        </Button>
      ) : null}
    </Bloque>
  )
}

function Clienta({ p }: { p: Pedido }) {
  const saldo = saldoAFavor(usePedidos(useRuta().rubro), p.clienta)
  return (
    <Bloque
      title="La clienta"
      extra={
        <Button size="sm" variant="ghost" onClick={() => ir("/clientes")}>
          <UserRound aria-hidden />
          Su ficha
        </Button>
      }
    >
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium">{p.clienta}</span>
        <span className="text-muted-foreground">
          {p.telefono} · escribe por {CANAL[p.canal]}
        </span>
        {saldo ? (
          <span className="mt-1.5 rounded-lg bg-success-soft px-2.5 py-1.5 text-[13px]">
            <b>{money(saldo)} a su favor.</b> Es suyo y se usa solo en su próxima compra: Sofi se lo
            recuerda al venderle. Sale en su ficha y en Caja.
          </span>
        ) : null}
      </div>
    </Bloque>
  )
}

export function OrigenB({ p }: { p: Pedido }) {
  const o = p.origen
  const I =
    o.k === "campana" ? Megaphone : o.k === "equipo" ? UserRound : o.k === "catalogo" ? Store : Sparkles
  return (
    <Bloque title="De dónde vino">
      <div className="flex items-start gap-3 text-sm">
        <I
          className={cn(
            "mt-0.5 size-4 shrink-0",
            o.k === "campana" || o.k === "sofi" ? "text-primary" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            {o.k === "campana" ? `Campaña «${o.nombre}»` : origenTexto(o, p.canal)}
          </span>
          <span className="text-muted-foreground">
            {o.k === "campana"
              ? `Argos la eligió: ${o.motivo.charAt(0).toLowerCase() + o.motivo.slice(1)} Sofi le escribió.`
              : o.k === "sofi"
                ? "Sofi la atendió y cerró la venta en el chat."
                : o.k === "catalogo"
                  ? "Armó su carrito sola en el catálogo de la tienda."
                  : `Lo anotó ${o.quien} a mano.`}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            {p.unoPorCiento
              ? "Lo generó gestorIA: cuenta para el 1 %."
              : "Lo vendió tu equipo: no cuenta para el 1 %."}
          </span>
        </span>
      </div>
    </Bloque>
  )
}

/** Un círculo con el ícono de quién lo hizo. */
function Punto({ actor, futuro, Icon }: { actor: Actor; futuro?: boolean; Icon?: typeof Bot }) {
  const A = ACTOR[actor]
  const I = Icon ?? A.Icon
  return (
    <span
      className={cn(
        "z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card",
        futuro ? "border border-dashed bg-card text-muted-foreground" : A.tono,
      )}
    >
      <I className="size-4" aria-hidden />
    </span>
  )
}

/** La foto que acompaña al paso: la captura del Yape o el voucher del POS. */
/** La foto del paso: la captura, el voucher, la falla o el recojo. Se amplía al tocarla. */
function Adjunto({ k, p }: { k: "captura" | "voucher" | "recojo" | "falla"; p: Pedido }) {
  const { rubro } = useRuta()
  if (k === "recojo" || k === "falla") {
    const l = p.vuelta?.vuelven[0]
    if (!l) return null
    const pie = k === "recojo" ? "Foto al recoger: cómo estaba" : "Foto de la falla: la mandó por WhatsApp"
    return (
      <Ampliable titulo={pie} className="mt-1 w-52">
        <FotoMarcada src={l.foto} tipo={k} pie={pie} />
      </Ampliable>
    )
  }
  const g =
    k === "captura"
      ? p.pagos.find((x) => x.captura)
      : [...p.pagos].reverse().find((x) => x.medio === "pos")
  if (!g) return null
  return (
    <Ampliable titulo={k === "captura" ? "La captura" : "El voucher del POS"} className="mt-1 w-32">
      <ImagenPago p={p} g={g} tienda={RUBROS[rubro].store.name} />
    </Ampliable>
  )
}

const CLAVE = {
  pagado: "Pagado",
  salio: "Salió",
  entregado: "Entregado",
  falla: "Si algo falla",
  link: "Su carrito",
  cambio: "Un cambio",
} as const

/**
 * El seguimiento completo, siempre a la vista: cada cosa que pasó, en orden, con quién y cuándo;
 * cada aviso que recibió la clienta, con su texto; y lo que falta, con quién lo va a mover.
 */
function Seguimiento({ p, onChat }: { p: Pedido; onChat: () => void }) {
  type Item =
    | { t: "ev"; e: Pedido["eventos"][number] }
    | { t: "av"; a: Pedido["avisos"][number] }
  const items: Item[] = p.eventos.map((e) => ({ t: "ev", e }))
  for (const a of p.avisos) {
    // Va después de lo que lo causó: lo que hizo Sofi a esa hora, o lo último a esa hora.
    let i = -1
    let sofi = -1
    items.forEach((x, j) => {
      if (x.t !== "ev" || x.e.cuando !== a.cuando) return
      i = j
      if (x.e.actor === "sofi") sofi = j
    })
    if (sofi >= 0) i = sofi
    items.splice(i < 0 ? items.length : i + 1, 0, { t: "av", a })
  }
  const falta = loQueFalta(p)
  const s = queSigue(p)
  const n = nombre(p)
  return (
    <section
      aria-labelledby="seg-h"
      className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 md:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="seg-h" className="font-heading text-base font-semibold">
          El seguimiento
        </h2>
        <span className="text-xs text-muted-foreground">
          {p.eventos.length} cosas pasaron · {p.avisos.length}{" "}
          {p.avisos.length === 1 ? "aviso" : "avisos"} a {n}
        </span>
        {todoElChat(p).length ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={onChat}>
            <MessageCircle aria-hidden />
            Ver toda la conversación
          </Button>
        ) : null}
      </div>
      <ol className="relative flex flex-col gap-4 before:absolute before:top-3 before:bottom-3 before:left-[15px] before:w-px before:bg-border">
        {items.map((x) =>
          x.t === "ev" ? (
            <li key={x.e.id} className="relative flex gap-3">
              <Punto actor={x.e.actor} />
              <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5 text-sm">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <b>{x.e.quien}</b>
                  <span className="text-xs text-muted-foreground">{x.e.cuando}</span>
                  {x.e.paso ? (
                    <Badge variant={PASO[x.e.paso].tono}>{PASO[x.e.paso].corto}</Badge>
                  ) : null}
                </span>
                <span>{x.e.texto}</span>
                {x.e.cita ? (
                  <span className="mt-0.5 flex items-start gap-1.5 self-start rounded-2xl rounded-tl-sm bg-muted px-3 py-1.5 text-[13px]">
                    <MessageCircle
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span>
                      <span className="sr-only">En el chat, {n} escribió: </span>«{x.e.cita}»
                    </span>
                  </span>
                ) : null}
                {x.e.adjunto ? <Adjunto k={x.e.adjunto} p={p} /> : null}
              </span>
            </li>
          ) : (
            <li key={x.a.id} className="relative flex gap-3">
              <Punto actor="sofi" Icon={Send} />
              <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5 text-sm">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <b>Aviso a {n}</b>
                  <span className="text-xs text-muted-foreground">
                    {x.a.cuando} · {x.a.estado === "enviado" ? "Sofi, por WhatsApp" : "sin enviar"}
                  </span>
                  <Badge variant={x.a.clave === "falla" ? "warning" : "outline"}>
                    {CLAVE[x.a.clave]}
                  </Badge>
                </span>
                <span className="self-start rounded-2xl rounded-tl-sm bg-primary-soft px-3 py-1.5 text-[13px] text-primary-soft-foreground">
                  {x.a.texto}
                </span>
              </span>
            </li>
          ),
        )}
        <li className="relative flex gap-3" aria-label="Ahora">
          <span
            className={cn(
              "z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card",
              s.persona ? "bg-warning text-white" : "bg-primary text-primary-foreground",
            )}
          >
            {s.persona ? (
              <UserRound className="size-4" aria-hidden />
            ) : (
              <Clock3 className="size-4" aria-hidden />
            )}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 pt-1 text-sm">
            <b>Ahora</b>
            <span className="text-muted-foreground">
              {s.persona ? "Te toca: " : "Sigue solo: "}
              {s.texto.split(/\. (?=[A-ZÁÉÍÓÚ])/)[0]?.replace(/\.$/, "")}.
            </span>
          </span>
        </li>
        {falta.length ? (
          <li className="relative pl-11 text-xs font-semibold text-muted-foreground">
            Lo que falta
          </li>
        ) : null}
        {falta.map((f, i) => (
          <li key={i} className="relative flex gap-3 text-muted-foreground">
            <Punto actor={f.actor} futuro />
            <span className="flex min-w-0 flex-col gap-0.5 pt-0.5 text-sm">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <b className="text-foreground">{f.quien}</b>
                <span className="inline-flex items-center gap-1 text-xs">
                  <CalendarClock className="size-3" aria-hidden />
                  {f.cuando}
                </span>
              </span>
              <span>{f.texto}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Chat({ p }: { p: Pedido }) {
  const chat = todoElChat(p)
  if (!chat.length)
    return (
      <p className="rounded-xl border p-4 text-sm text-muted-foreground">
        {p.origen.k === "catalogo"
          ? "Compró sola en el catálogo: no hubo conversación."
          : p.origen.k === "equipo"
            ? "Lo atendió una persona desde el celular de la tienda."
            : "Sin mensajes todavía."}
      </p>
    )
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3">
      {chat.map((m, i) => (
        <div
          key={i}
          className={cn(
            "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-xs",
            m.de === "clienta"
              ? "self-end bg-card"
              : "self-start bg-primary-soft text-primary-soft-foreground",
          )}
        >
          {m.de === "sofi" ? (
            <span className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold">
              <AgentMark className="size-3" /> Sofi
            </span>
          ) : null}
          {m.texto}
          <span className="mt-0.5 block text-right text-[10px] opacity-70">{m.hora}</span>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="self-center"
        onClick={() => ir("/conversaciones")}
      >
        Abrir la conversación
      </Button>
    </div>
  )
}

/** Solo en el prototipo: lo que haría la clienta o el tiempo, para ver cómo sigue solo. */
function Simular({ p }: { p: Pedido }) {
  const { rubro } = useRuta()
  const k = cuentas(p)
  const n = p.clienta.split(" ")[0]
  const opts: [string, () => void][] = []
  if (p.paso === "por_pagar" && p.cobro === "link")
    opts.push(
      [
        `${n} paga su link`,
        () =>
          mover(
            rubro,
            p.id,
            (x) => {
              x.pagos.push({
                id: `pg${Date.now()}`,
                medio: "link",
                monto: k.total,
                estado: "confirmado",
                cuando: "Hoy · ahora",
                quien: "la pasarela",
              })
              x.paso = trasPagar(x)
              x.toca = undefined
              avisar(
                x,
                "pagado",
                `¡Pago recibido, ${n}! Sale el ${x.entrega.dia?.toLowerCase()} entre ${x.entrega.franja}. ¿Le sumas algo al mismo envío?`,
              )
            },
            {
              actor: "pasarela",
              quien: "La pasarela",
              texto: `Confirmó el pago de ${money(k.total)} con Yape dentro del link. Nadie revisó nada.`,
              paso: "pagado",
            },
          ),
      ],
      [
        "Faltan 3 horas: Sofi le recuerda",
        () =>
          mover(
            rubro,
            p.id,
            (x) =>
              avisar(
                x,
                "link",
                `${n}, tu carrito vence hoy a las ${x.separadoHasta?.split(" · ")[1] ?? "11 p. m."}. Lo pagas aquí con Yape o tarjeta.`,
              ),
            {
              actor: "sofi",
              quien: "Sofi",
              texto: "Le recordó el link, una sola vez, 3 horas antes de que venza.",
            },
          ),
      ],
      [
        "Pasan 24 horas sin pago",
        () =>
          mover(rubro, p.id, (x) => ((x.paso = "anulado"), (x.toca = undefined)), {
            actor: "gestoria",
            quien: "gestorIA",
            texto:
              "Pasaron 24 horas sin pago: liberó el producto y anuló el pedido solo.",
            paso: "anulado",
          }),
      ],
    )
  if (p.paso === "pagado")
    opts.push([
      "Llega su día (8 a. m.)",
      () =>
        mover(
          rubro,
          p.id,
          (x) => {
            x.paso = "preparando"
            x.entrega.dia = "Hoy"
            x.toca = undefined
            const a = asignarSolo(x)
            x.eventos.push({
              id: `e${Date.now()}`,
              cuando: "Hoy · 8:00 a. m.",
              actor: "gestoria",
              quien: "gestorIA",
              texto: `Llegó su día: pasó a Preparando.${a ? ` ${a}` : ""}`,
              paso: "preparando",
            })
          },
        ),
    ])
  if (p.paso === "por_salir" && p.entrega.repartidor)
    opts.push([
      `${p.entrega.repartidor} toca «Salí»`,
      () =>
        mover(
          rubro,
          p.id,
          (x) => (
            (x.paso = "en_camino"),
            avisar(
              x,
              "salio",
              `Tu pedido salió: llega hoy entre ${x.entrega.franja} con ${x.entrega.repartidor}.`,
            )
          ),
          {
            actor: "repartidor",
            quien: p.entrega.repartidor!,
            texto: "Tocó «Salí» en su app.",
            paso: "en_camino",
          },
        ),
    ])
  if (!opts.length) return null
  return (
    <div className="propuesta flex flex-col gap-2 rounded-xl border p-3">
      <span className="text-xs font-semibold text-muted-foreground">
        Prototipo · simular lo que pasa sin la tienda
      </span>
      <div className="flex flex-wrap gap-2">
        {opts.map(([l, f]) => (
          <Button key={l} size="sm" variant="outline" onClick={f}>
            <Clock3 aria-hidden />
            {l}
          </Button>
        ))}
      </div>
    </div>
  )
}


/** La línea de qué pasa ahora: «Sigue solo…» o, si toca a una persona, qué y con su único botón. */
function Ahora({ p, onAccion }: { p: Pedido; onAccion: (a: Accion) => void }) {
  const s = queSigue(p)
  const { principal } = acciones(p)
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl px-4 py-3 text-sm sm:flex-row sm:items-center",
        s.persona ? "bg-warning-soft" : "bg-success-soft/60",
      )}
      role="status"
    >
      <span className="flex min-w-0 flex-1 items-start gap-2.5">
        {s.persona ? (
          <UserRound className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        ) : (
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        )}
        <span>
          <b>{s.persona ? "Te toca: " : "Sigue solo: "}</b>
          {s.texto}
        </span>
      </span>
      {principal ? (
        <Button className="shrink-0 self-start sm:self-auto" onClick={() => onAccion(principal[0])}>
          {principal[1]}
        </Button>
      ) : null}
    </div>
  )
}

/** El pedido en su propia página: los pasos a lo ancho y el seguimiento siempre a la vista. */
export function PedidoPage({ pid }: { pid: string }) {
  const { rubro } = useRuta()
  const p = usePedido(rubro, pid)
  const isMobile = useIsMobile()
  const [chat, setChat] = useState(false)
  const volver = (
    <a
      href={href("/pedidos")}
      className="inline-flex items-center gap-1 self-start rounded-md text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Volver a Pedidos
    </a>
  )
  if (!p)
    return (
      <PageShell className="flex flex-col gap-4">
        {volver}
        <PageHeader title="Pedido no encontrado" />
      </PageShell>
    )
  const k = cuentas(p)
  const { otras } = acciones(p)
  // Todo lo que cambia algo se confirma en el cajón «pedido + lo que toca».
  const hacer = (a: Accion) => abrirCajon(p.id, a)
  const ICON: Partial<Record<Accion, typeof Bot>> = {
    cambiar: PencilLine,
    pasar: CalendarClock,
    asignar: Bike,
    anular: Ban,
    no_entregado: RotateCcw,
    cambio: RotateCcw,
    cobrar: Check,
  }
  // El pedido es lo principal: el carrito, el saldo y la entrega van a la izquierda.
  const pedido = (
    <>
      <VueltaBloque p={p} />
      <Carrito p={p} />
      {p.paso !== "anulado" ? (
        <Saldo p={p} onAccion={(a, pago) => abrirCajon(p.id, a, { pago })} />
      ) : null}
      <EntregaB p={p} />
    </>
  )
  const extras = (
    <>
      <Clienta p={p} />
      <OrigenB p={p} />
    </>
  )
  const seguimiento = (
    <div className="flex min-w-0 flex-col gap-4">
      <Seguimiento p={p} onChat={() => setChat((v) => !v)} />
      {chat ? (
        <section
          aria-label="Toda la conversación"
          className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4"
        >
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Toda la conversación</h2>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setChat(false)}>
              Cerrar
            </Button>
          </div>
          <Chat p={p} />
        </section>
      ) : null}
    </div>
  )
  return (
    <PageShell className="flex min-w-0 flex-col gap-4">
      {volver}
      <div className="flex min-w-0 flex-col gap-1.5">
        <PageHeader
          title={`Pedido ${p.id} · ${p.clienta}`}
          menu={[
            ...otras.map(([a, l]) => {
              const I = ICON[a] ?? PencilLine
              return { label: l, icon: <I aria-hidden />, onSelect: () => hacer(a) }
            }),
            {
              label: "Ver lo que ve la clienta",
              icon: <Link2 aria-hidden />,
              onSelect: () => ir("/clienta", { extra: `p=${p.id}` }),
            },
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
          <span>
            {CANAL[p.canal]} · {p.creado}
          </span>
          <Badge variant={PASO[p.paso].tono}>{PASO[p.paso].label}</Badge>
          {k.pagado ? (
            <Badge variant="success">Pagado</Badge>
          ) : k.falta && !["anulado", "por_pagar"].includes(p.paso) ? (
            <Badge variant="warning">Falta cobrar {money(k.falta)}</Badge>
          ) : null}
          {p.origen.k === "campana" ? <Badge variant="soft">Campaña</Badge> : null}
          <span className="font-semibold text-foreground tabular-nums">{money(k.total)}</span>
        </div>
      </div>
      <Ahora p={p} onAccion={hacer} />
      <section aria-label="Los pasos" className="elevated min-w-0 rounded-xl border bg-card p-3 md:p-4">
        <Pasos p={p} />
      </section>
      {isMobile ? (
        <div className="flex min-w-0 flex-col gap-4">
          {pedido}
          {seguimiento}
          {extras}
          <Simular p={p} />
          <SimularVuelta p={p} />
        </div>
      ) : (
        // A la derecha, el seguimiento y los extras, con más ancho que una columna lateral.
        <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
          <div className="flex min-w-0 flex-col gap-4">
            {pedido}
            <Simular p={p} />
            <SimularVuelta p={p} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {seguimiento}
            {extras}
          </div>
        </div>
      )}
    </PageShell>
  )
}
