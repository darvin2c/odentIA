import { Badge, Button, cn, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { AgentMark, DetailDrawer } from "@odentia/ui-patterns"
import {
  Bike,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  CreditCard,
  ExternalLink,
  Link2,
  Megaphone,
  MessageCircle,
  Package,
  Smartphone,
  Sparkles,
  Store,
  Truck,
  UserRound,
} from "lucide-react"
import { useState } from "react"
import { foto, RUBROS } from "../datos"
import { ir, useRuta } from "../ruta"
import { AccionDrawer } from "./acciones"
import {
  type Accion,
  type Actor,
  avisar,
  CAMINO,
  CONFIRMA,
  cuentas,
  entregaTexto,
  MEDIO,
  money,
  mover,
  origenTexto,
  PASO,
  type Paso,
  type Pedido,
  trasPagar,
  usePedido,
} from "./modelo"

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
  if (p.toca) return { texto: p.toca.texto, persona: true }
  switch (p.paso) {
    case "por_pagar":
      return p.cobro === "link"
        ? {
            texto: `Espera que ${n} pague su link. Está separado hasta ${p.separadoHasta?.toLowerCase() ?? "mañana"}; si no paga, se libera y se anula solo.`,
            persona: false,
          }
        : { texto: `Espera el pago de ${n}.`, persona: false }
    case "por_confirmar":
      return { texto: `${n} mandó una captura: la confirma una persona.`, persona: true }
    case "pagado":
      return {
        texto: `Pagado. Pasa solo a «Preparando» el ${p.entrega.dia?.toLowerCase() ?? "día de entrega"}, a las 8 a. m.`,
        persona: false,
      }
    case "preparando":
      return p.entrega.repartidor
        ? {
            texto: `Sale hoy de ${p.entrega.franja} con ${p.entrega.repartidor}. Empácalo: pasa a «Por salir» cuando se lo des.`,
            persona: true,
          }
        : { texto: "Sale hoy y no tiene repartidor.", persona: true }
    case "por_salir":
      return {
        texto: `Espera que ${p.entrega.repartidor ?? "el repartidor"} toque «Salí» en su app.${k.falta ? ` Cobra ${money(k.falta)} en la puerta.` : ""}`,
        persona: false,
      }
    case "en_camino":
      return p.entrega.tipo === "agencia"
        ? {
            texto: `Va por ${p.entrega.agencia}, N.º ${p.entrega.numero}. Se cierra cuando ${n} lo recoge.`,
            persona: false,
          }
        : {
            texto: `${p.entrega.repartidor} lo lleva.${k.falta ? ` Cobra ${money(k.falta)}: sin pago confirmado no entrega.` : " Está pagado: lo entrega con un toque."}`,
            persona: false,
          }
    case "entregado":
      return {
        texto: p.cambioEn
          ? `Entregado. Tiene un cambio en el pedido ${p.cambioEn}.`
          : "Entregado. Si pide un cambio, va en un pedido nuevo, enlazado a este.",
        persona: false,
      }
    case "anulado":
      return {
        texto:
          "Anulado. Si escribe otra vez, Sofi vuelve a cotizar con el precio y el stock del momento.",
        persona: false,
      }
  }
}

/** Los botones según el estado: el principal primero, uno solo. */
export function acciones(p: Pedido): { principal?: [Accion, string]; otras: [Accion, string][] } {
  const k = cuentas(p)
  const toca: [Accion, string] | undefined = p.toca ? [p.toca.accion, p.toca.boton] : undefined
  const noSalio = ["por_pagar", "por_confirmar", "pagado", "preparando", "por_salir"].includes(
    p.paso,
  )
  const otras: [Accion, string][] = []
  let principal = toca
  switch (p.paso) {
    case "por_pagar":
      principal ??= p.cobro === "link" ? ["link", "Recordarle el link"] : undefined
      otras.push(["cambiar", "Cambiar"], ["anular", "Anular…"])
      break
    case "por_confirmar":
      principal ??= ["confirmar", "Ver y confirmar"]
      otras.push(["cambiar", "Cambiar"])
      break
    case "pagado":
      principal ??= ["pasar", "Pasar a…"]
      otras.push(["cambiar", "Cambiar"])
      break
    case "preparando":
      principal ??= p.entrega.repartidor
        ? ["asignar", `Listo: se lo di a ${p.entrega.repartidor}`]
        : ["asignar", "Asignar"]
      otras.push(["cambiar", "Cambiar"], ["pasar", "Pasar a…"])
      break
    case "por_salir":
      principal ??= ["pasar", "Pasar a…"]
      otras.push(["cambiar", "Cambiar"])
      break
    case "en_camino":
      principal ??= ["cobrar", k.falta ? "Cobrar y entregar" : "Entregado"]
      otras.push(["no_entregado", "No se entregó"])
      break
    case "entregado":
      principal ??= p.cambioEn ? undefined : ["cambio", "Cambio o devolución"]
      break
  }
  return {
    principal,
    otras: otras.filter(([a]) => a !== principal?.[0] && (noSalio || a !== "cambiar")),
  }
}

function Bloque({
  title,
  extra,
  children,
}: {
  title: string
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  )
}

/** Los pasos del pedido en una línea: lo hecho, lo de ahora y lo que falta. */
export function Pasos({ p, compacto }: { p: Pedido; compacto?: boolean }) {
  const camino = CAMINO.filter(
    (s) =>
      s !== "por_confirmar" ||
      p.cobro === "captura" ||
      p.pagos.some((x) => x.medio === "yape" || x.medio === "plin"),
  ).filter(
    (s) =>
      !(p.cobro === "al_recibir" && !p.pagos.length && (s === "pagado" || s === "por_confirmar")),
  )
  const at = p.paso === "anulado" ? -1 : camino.indexOf(p.paso)
  const hechos = new Set(p.eventos.map((e) => e.paso).filter(Boolean) as Paso[])
  return (
    <ol
      className={cn("flex w-full items-start", compacto ? "gap-0.5" : "gap-1")}
      aria-label="Pasos del pedido"
    >
      {camino.map((s, i) => {
        const done = i < at || (p.paso === "entregado" && i <= at)
        const now = i === at && p.paso !== "entregado"
        const ev = [...p.eventos].reverse().find((e) => e.paso === s)
        return (
          <li
            key={s}
            className="flex min-w-0 flex-1 flex-col gap-1"
            aria-current={now ? "step" : undefined}
          >
            <span
              className={cn(
                "h-1.5 rounded-full",
                done ? "bg-success" : now ? "bg-primary" : "bg-muted",
              )}
            />
            {compacto ? null : (
              <span
                className={cn(
                  "truncate text-[11px] leading-tight",
                  now
                    ? "font-semibold text-foreground"
                    : done || hechos.has(s)
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {PASO[s].corto}
                {ev && (done || now) ? (
                  <span className="block truncate text-muted-foreground">
                    {ev.cuando.split(" · ")[1] ?? ev.cuando}
                  </span>
                ) : null}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Carrito({ p }: { p: Pedido }) {
  const k = cuentas(p)
  return (
    <Bloque title="El carrito">
      <ul className="flex flex-col divide-y rounded-xl border">
        {p.lineas.map((l) => (
          <li key={l.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
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
        <li className="flex items-center justify-between px-3 py-2 text-sm">
          <span className="text-muted-foreground">Envío · {p.entrega.zona}</span>
          <span className="tabular-nums">
            {p.entrega.envio ? money(p.entrega.envio) : "Gratis"}
          </span>
        </li>
        <li className="flex items-center justify-between px-3 py-2 text-sm font-semibold">
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

function Saldo({
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
          <Badge variant="warning">Falta cobrar {money(k.falta)}</Badge>
        ) : (
          <Badge variant="warning">Por confirmar {money(k.porConfirmar)}</Badge>
        )
      }
    >
      {p.pagos.length ? (
        <ul className="flex flex-col divide-y rounded-xl border">
          {p.pagos.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {MEDIO[g.medio]} · {money(g.monto)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {g.estado === "confirmado"
                    ? `Confirmó ${g.quien ?? "—"} · ${g.cuando}`
                    : g.estado === "por_confirmar"
                      ? `Llegó la captura · ${g.cuando} · la confirma una persona`
                      : g.estado === "no_coincide"
                        ? `No coincide: ${g.motivo?.toLowerCase()}`
                        : `Deshecho: ${g.motivo}`}
                </span>
              </span>
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
              {g.estado === "por_confirmar" ? (
                <Button size="sm" onClick={() => onAccion("confirmar")}>
                  Ver y confirmar
                </Button>
              ) : g.estado === "confirmado" &&
                (g.medio === "yape" || g.medio === "plin") &&
                p.paso !== "entregado" ? (
                <Button size="sm" variant="ghost" onClick={() => onAccion("deshacer", g.id)}>
                  Deshacer
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="grid grid-cols-3 gap-2 text-center text-sm">
        {[
          ["Total", money(k.total)],
          ["Cobrado", money(k.confirmado)],
          [k.alRecibir && k.falta ? "Falta · al recibir" : "Falta cobrar", money(k.falta)],
        ].map(([a, b]) => (
          <div key={a} className="rounded-xl bg-muted/60 px-2 py-2">
            <dt className="text-[11px] text-muted-foreground">{a}</dt>
            <dd className="font-semibold tabular-nums">{b}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {p.cobro === "link"
          ? `Paga en su link: ${CONFIRMA.link.toLowerCase()}.`
          : p.cobro === "captura"
            ? `Yape o Plin al número de la tienda: ${CONFIRMA.yape.toLowerCase()}.`
            : "Paga al recibir: lo confirma el repartidor (efectivo, o POS con la foto del voucher)."}{" "}
        Sin pago confirmado no se entrega.
      </p>
    </Bloque>
  )
}

function EntregaB({ p }: { p: Pedido }) {
  const e = p.entrega
  return (
    <Bloque
      title="La entrega"
      extra={
        <Button size="sm" variant="ghost" onClick={() => ir("/clienta", { extra: `p=${p.id}` })}>
          <Link2 aria-hidden />
          Ver su link
        </Button>
      }
    >
      <div className="flex items-start gap-3 rounded-xl border p-3 text-sm">
        {e.tipo === "agencia" ? (
          <Truck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Bike className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{entregaTexto(e)}</span>
          <span className="text-muted-foreground">{e.direccion}</span>
          {e.tipo === "agencia" ? (
            <span className="inline-flex items-center gap-1 text-primary">
              Ver en {e.agencia} <ExternalLink className="size-3" aria-hidden />
            </span>
          ) : null}
          {p.noEntregado ? (
            <span className="mt-1 inline-flex items-center gap-1.5 text-warning">
              <CircleAlert className="size-3.5" aria-hidden />
              {p.noEntregado}
            </span>
          ) : null}
        </span>
      </div>
    </Bloque>
  )
}

function OrigenB({ p }: { p: Pedido }) {
  const o = p.origen
  return (
    <Bloque title="De dónde vino">
      <div className="flex items-start gap-3 rounded-xl border p-3 text-sm">
        {o.k === "campana" ? (
          <Megaphone className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        ) : o.k === "equipo" ? (
          <UserRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : o.k === "catalogo" ? (
          <Store className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            {o.k === "campana" ? `Venta de la campaña «${o.nombre}»` : origenTexto(o, p.canal)}
          </span>
          {o.k === "campana" ? (
            <span className="text-muted-foreground">
              Argos la eligió: {o.motivo.charAt(0).toLowerCase() + o.motivo.slice(1)} Sofi le
              escribió.
            </span>
          ) : null}
          {o.k === "sofi" ? (
            <span className="text-muted-foreground">
              Sofi la atendió y cerró la venta en el chat.
            </span>
          ) : null}
          {o.k === "catalogo" ? (
            <span className="text-muted-foreground">
              Armó su carrito sola en el catálogo de la tienda.
            </span>
          ) : null}
          {o.k === "equipo" ? (
            <span className="text-muted-foreground">
              Lo anotó {o.quien} a mano{p.cambioDe ? `: es el cambio del ${p.cambioDe}` : ""}.
            </span>
          ) : null}
          <span className="mt-1 text-xs text-muted-foreground">
            {p.unoPorCiento
              ? "Lo generó gestorIA: cuenta para el 1 %."
              : "Lo vendió tu equipo: no cuenta para el 1 %."}
          </span>
        </span>
      </div>
      {p.cambioDe || p.cambioEn ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => ir("/pedidos", { extra: `p=${p.cambioDe ?? p.cambioEn}` })}
        >
          {p.cambioDe ? `Es el cambio del ${p.cambioDe}` : `Ver el cambio ${p.cambioEn}`}
        </Button>
      ) : null}
    </Bloque>
  )
}

export function Historia({ p }: { p: Pedido }) {
  return (
    <ol
      className="relative flex flex-col gap-4 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border"
      aria-label="Historia del pedido"
    >
      {[...p.eventos].reverse().map((e) => {
        const A = ACTOR[e.actor]
        return (
          <li key={e.id} className="relative flex gap-3">
            <span
              className={cn(
                "z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card",
                A.tono,
              )}
            >
              <A.Icon className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 pt-0.5 text-sm">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <b>{e.quien}</b>
                <span className="text-xs text-muted-foreground">{e.cuando}</span>
                {e.paso ? <Badge variant={PASO[e.paso].tono}>{PASO[e.paso].corto}</Badge> : null}
              </span>
              <span>{e.texto}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Chat({ p }: { p: Pedido }) {
  if (!p.chat.length)
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
      {p.chat.map((m, i) => (
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

const CLAVE = {
  pagado: "Pagado",
  salio: "Salió",
  entregado: "Entregado",
  falla: "Si algo falla",
  link: "Su carrito",
  cambio: "Un cambio",
} as const

function Avisos({ p }: { p: Pedido }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Sofi le escribe solo en los momentos clave: pagado, salió, entregado y si algo falla. Lo
        demás lo ve en su link, sin preguntar.
      </p>
      {p.avisos.length ? (
        <ul className="flex flex-col divide-y rounded-xl border">
          {[...p.avisos].reverse().map((a) => (
            <li key={a.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                <Badge variant={a.clave === "falla" ? "warning" : "secondary"}>
                  {CLAVE[a.clave]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {a.cuando} · {a.estado === "enviado" ? "por WhatsApp" : "sin enviar"}
                </span>
              </span>
              <span>«{a.texto}»</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border p-3 text-sm text-muted-foreground">
          Todavía no se le avisó nada.
        </p>
      )}
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
        "Pasan 24 horas sin pago",
        () =>
          mover(rubro, p.id, (x) => ((x.paso = "anulado"), (x.toca = undefined)), {
            actor: "gestoria",
            quien: "gestorIA",
            texto:
              "Pasaron 24 horas sin pago: liberó el producto y anuló el pedido solo. Quedó en «Te toca» como aviso, sin botón.",
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
          (x) => (
            (x.paso = "preparando"),
            (x.entrega.dia = "Hoy"),
            (x.toca = x.entrega.repartidor
              ? undefined
              : { texto: "Sale hoy y no tiene repartidor.", boton: "Asignar", accion: "asignar" })
          ),
          {
            actor: "gestoria",
            quien: "gestorIA",
            texto: "Llegó su día: pasó a Preparando.",
            paso: "preparando",
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

/** El pedido de punta a punta, en su detalle. */
export function PedidoDrawer({ pid, onClose }: { pid: string; onClose: () => void }) {
  const { rubro } = useRuta()
  const p = usePedido(rubro, pid)
  const [accion, setAccion] = useState<{ a: Accion | "deshacer"; pago?: string } | null>(null)
  const [tab, setTab] = useState("pedido")
  if (!p) return null
  const k = cuentas(p)
  const s = queSigue(p)
  const { principal, otras } = acciones(p)
  const R = RUBROS[rubro]
  return (
    <>
      <DetailDrawer
        open
        onClose={onClose}
        size="lg"
        title={`Pedido ${p.id} · ${p.clienta}`}
        description={`${origenTexto(p.origen, p.canal)} · ${p.creado}`}
        footer={
          principal || otras.length ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {otras.map(([a, l]) => (
                <Button key={a + l} variant="outline" onClick={() => setAccion({ a })}>
                  {l}
                </Button>
              ))}
              {principal ? (
                <Button onClick={() => setAccion({ a: principal[0] })}>{principal[1]}</Button>
              ) : null}
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={PASO[p.paso].tono}>{PASO[p.paso].label}</Badge>
            {k.pagado ? (
              <Badge variant="success">Pagado</Badge>
            ) : k.falta && !["anulado", "por_pagar"].includes(p.paso) ? (
              <Badge variant="warning">Falta cobrar {money(k.falta)}</Badge>
            ) : null}
            {p.origen.k === "campana" ? <Badge variant="soft">Campaña</Badge> : null}
            <span className="ml-auto text-sm font-semibold tabular-nums">{money(k.total)}</span>
          </div>
          {p.paso !== "anulado" ? <Pasos p={p} /> : null}
          <p
            className={cn(
              "flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm",
              s.persona ? "bg-warning-soft text-foreground" : "bg-muted/60",
            )}
          >
            {s.persona ? (
              <UserRound className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            ) : (
              <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            )}
            <span>
              <b>{s.persona ? "Te toca: " : "Sigue solo: "}</b>
              {s.texto}
            </span>
          </p>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="pedido">Pedido</TabsTrigger>
            <TabsTrigger value="historia">Historia</TabsTrigger>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="avisos">
              Avisos{" "}
              {p.avisos.length ? (
                <span className="text-muted-foreground tabular-nums">{p.avisos.length}</span>
              ) : null}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pedido" className="flex flex-col gap-5">
            <Carrito p={p} />
            {p.paso !== "anulado" ? (
              <Saldo p={p} onAccion={(a, pago) => setAccion({ a, pago })} />
            ) : null}
            <EntregaB p={p} />
            <OrigenB p={p} />
            <Simular p={p} />
          </TabsContent>
          <TabsContent value="historia">
            <Historia p={p} />
          </TabsContent>
          <TabsContent value="chat">
            <Chat p={p} />
          </TabsContent>
          <TabsContent value="avisos">
            <Avisos p={p} />
          </TabsContent>
        </Tabs>
        {p.entrega.repartidor && ["por_salir", "en_camino"].includes(p.paso) ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => ir("/reparto")}>
            <Smartphone aria-hidden />
            Ver la app de {p.entrega.repartidor}
          </Button>
        ) : null}
        <span className="sr-only">{R.store.name}</span>
      </DetailDrawer>
      {accion ? (
        <AccionDrawer
          p={p}
          accion={accion.a}
          pagoId={accion.pago}
          onClose={() => setAccion(null)}
        />
      ) : null}
    </>
  )
}
