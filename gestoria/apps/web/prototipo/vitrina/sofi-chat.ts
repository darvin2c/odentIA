import type { Dato, Producto, Rubro } from "../datos"
import { autoUnit, floorUnit, key, money } from "../precio"
import { responder, type Usado } from "../sofi"
import { art, type Compra, cuando, cuentas, HR, lid, lineaTexto, type Msg, plan, pron, variantIn } from "./compra"

/**
 * Lo que contesta Sofi en la prueba, con las mismas reglas que en una conversación real: primero el
 * valor y lo que queda en su talla; una sola oferta por conversación, del margen y con plazo real;
 * el carrito de la vitrina es el mismo del chat; después del pago, un solo mensaje que confirma y
 * ofrece sumar algo antes de que salga. Nunca baja del mínimo.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
const has = (t: string, re: RegExp) => re.test(norm(t))

export interface Ctx {
  p: Producto
  R: Rubro
  tpl: Dato[]
  all: Producto[]
}

type Res = { c: Compra; so: Msg[] }

const usadosPrecio = (x: Ctx, c: Compra): Usado[] => {
  const l = c.items[0]
  const col = x.p.colors.find((k) => k.id === l?.color)
  const out: Usado[] = []
  if (l) {
    const [auto] = autoUnit(x.p, l.color, l.size, l.qty)
    out.push({ label: `Precio ${col?.name ?? ""} ${l.size !== "Única" ? l.size : ""}: ${money(auto)}`.replace(/\s+/g, " "), target: "variantes" })
    out.push({ label: x.p.min != null ? `Mínimo ${money(x.p.min)}` : "Sin mínimo: no negocia", target: "campo-minimo" })
    out.push({ label: `Stock ${l.size !== "Única" ? `${l.size} ` : ""}${col?.name ?? ""}: ${x.p.stock[key(l.color, l.size)] ?? 0}`, target: "variantes" })
  }
  return out
}

export function saludo(x: Ctx, c: Compra) {
  return c.msgs.some((m) => m.who === "so") ? "" : `¡Hola! Soy Sofi, de ${x.R.store.name}. `
}

function carritoMsg(x: Ctx, c: Compra, text: string, btn = "Ver y pagar"): Msg {
  return { who: "so", text, card: "carrito", btns: [{ k: "ver-carrito", label: btn }] }
}

/** Agrega una línea al carrito (o suma una unidad). */
export function agregar(c: Compra, p: Producto, color: string, size: string): Compra {
  const ya = c.items.find((l) => l.pid === p.id && l.color === color && l.size === size && !l.fijo)
  const items = ya ? c.items.map((l) => (l === ya ? { ...l, qty: l.qty + 1 } : l)) : [...c.items, { id: lid(), pid: p.id, color, size, qty: 1 }]
  return { ...c, items, sel: { color, size } }
}

/** El pago (simulado en la prueba): el pedido queda firme y Sofi escribe una sola vez antes de que salga. */
export function pagar(x: Ctx, c: Compra, method: string): Compra {
  const { total } = cuentas(x.all, c)
  const num = "0165"
  const sale = new Date()
  sale.setDate(sale.getDate() + 1)
  sale.setHours(10, 0, 0, 0)
  const otro = x.all.find((q) => q.id === (x.p.combo.con[0] ?? x.p.parecido[0]))
  const conStock = otro && Object.values(otro.stock).some((v) => v > 0)
  const up = otro && conStock ? { pid: otro.id, price: otro.min ?? Math.round(otro.list * 0.9), regular: otro.list, state: "ofrecido" as const } : undefined
  const order = { num, total, at: Date.now(), method, up }
  const N = `Tu pedido ${num} sale ${cuando(sale.getTime())}.`
  const so: Msg = up
    ? {
        who: "so",
        text: `¡Pago recibido! ${N} Antes de que salga, ¿te sumo ${art(otro!)} ${otro!.name.toLowerCase()}? Va en el mismo envío, sin pagar envío otra vez, y te ${pron(otro!)} dejo en ${money(up.price)} en vez de ${money(up.regular)}.`,
        img: otro!.media.find((m) => m.kind === "foto")?.src,
        btns: [
          { k: "up-si", label: `Sí, súma${pron(otro!)}` },
          { k: "up-no", label: "No, gracias" },
        ],
      }
    : { who: "so", text: `¡Pago recibido! ${N} Te aviso cuando salga.` }
  return {
    ...c,
    order,
    items: [],
    hold: null,
    sheet: "pedido",
    msgs: [...c.msgs, { who: "dia", text: `Pagó con ${method} · prueba, no se cobró` }, so],
    uso: {
      usados: [
        { label: `Pagado ${money(total)} con ${method} (prueba)`, target: "precio" },
        ...(otro && up ? [{ label: `Venta cruzada: ${otro.name} a su mínimo ${money(up.price)}`, target: "cruzada" }] : []),
      ],
      faltan: otro ? [] : [{ label: "Algo para ofrecer después del pago (venta cruzada)", target: "cruzada" }],
    },
  }
}

/** Una respuesta de un botón del mensaje. */
export function boton(x: Ctx, c: Compra, k: string, now = Date.now()): Res {
  const { p } = x
  const strip = (cc: Compra) => ({ ...cc, msgs: cc.msgs.map((m) => (m.btns ? { ...m, btns: undefined } : m)) })
  if (k === "envio" || k === "soles") {
    const pl = plan(p, x.all, c)
    const hold = { kind: k === "envio" ? ("envio" as const) : ("descuento" as const), amount: k === "envio" ? pl.envio : pl.soles, until: c.hold?.until ?? now + 24 * HR }
    const c2 = { ...strip(c), hold }
    const t = cuentas(x.all, c2, now).total
    const me: Msg = { who: "me", text: k === "envio" ? "Envío gratis" : `${money(pl.soles)} menos` }
    return {
      c: { ...c2, msgs: [...c2.msgs, me] },
      so: [carritoMsg(x, c2, `¡Listo! ${k === "envio" ? "Envío gratis" : `${money(pl.soles)} menos`}: quedas en ${money(t)} con todo. Vence ${cuando(hold.until, now)}.`)],
    }
  }
  if (k === "up-si" && c.order?.up) {
    const q = x.all.find((y) => y.id === c.order!.up!.pid)!
    const c2 = strip(c)
    const order = { ...c.order, up: { ...c.order.up, state: "sumado" as const } }
    return {
      c: { ...c2, order, msgs: [...c2.msgs, { who: "me", text: `Sí, súma${pron(q)}` }] },
      so: [{ who: "so", text: `Listo: te ${pron(q)} sumé a tu pedido ${order.num}. Pága${pron(q)} aquí y sale con tu pedido, sin envío.`, btns: [{ k: "up-pagar", label: `Pagar ${money(order.up.price)}` }] }],
    }
  }
  if (k === "up-pagar" && c.order?.up) {
    const c2 = strip(c)
    return { c: { ...c2, order: { ...c.order, up: { ...c.order.up, state: "pagado" } } }, so: [{ who: "so", text: `¡Pagado! Sale todo junto, en el mismo envío.` }] }
  }
  if (k === "up-no" && c.order) {
    const c2 = strip(c)
    return { c: { ...c2, order: { ...c.order, up: c.order.up ? { ...c.order.up, state: "no" } : undefined }, msgs: [...c2.msgs, { who: "me", text: "No, gracias" }] }, so: [{ who: "so", text: "Dale. Tu pedido sale tal cual. Te aviso cuando salga." }] }
  }
  return { c, so: [] }
}

/** Lo que escribe la clienta (o toca en las sugerencias). */
export function escribe(x: Ctx, c0: Compra, text: string, now = Date.now()): Res {
  const { p, R, tpl } = x
  let c: Compra = { ...c0, msgs: [...c0.msgs.map((m) => (m.btns ? { ...m, btns: undefined } : m)), { who: "me", text }] }
  const hi = saludo(x, c0)
  const v = variantIn(p, text)

  // 1. La quiere: al carrito, el mismo de la vitrina.
  if (has(text, /\b(quiero|me llevo|separa|dame|me la|me lo|lo compro|la compro)\b/) && !has(text, /precio|barat/)) {
    const color = v.color?.id ?? c.sel.color
    const size = v.size ?? (R.col ? c.sel.size : "Única") ?? null
    if (!size) {
      const hay = p.sizes.filter((z) => (p.stock[key(color, z)] ?? 0) > 0)
      return { c: { ...c, quick: hay.slice(0, 6).map((z) => `Quiero la ${z}`) }, so: [{ who: "so", text: `${hi}¿De qué ${R.col?.toLowerCase() ?? "talla"}? En ${p.colors.find((k) => k.id === color)?.name} tengo ${hay.join(", ")}.` }] }
    }
    const n = p.stock[key(color, size)] ?? 0
    if (n === 0) {
      const otro = p.colors.find((k) => k.id !== color && (p.stock[key(k.id, size)] ?? 0) > 0)
      return {
        c: { ...c, uso: { usados: [{ label: `Stock ${size}: sin stock en ${p.colors.find((k) => k.id === color)?.name}`, target: "variantes" }], faltan: [] }, quick: otro ? [`Quiero la ${otro.name} en ${size}`] : [] },
        so: [{ who: "so", text: `${hi}De la ${size} en ${p.colors.find((k) => k.id === color)?.name} no me queda.${otro ? ` En ${otro.name} sí la tengo. ¿Te la separo?` : " ¿Te aviso cuando vuelva?"}`, img: otro ? p.media.find((m) => m.color === otro.id && m.kind === "foto")?.src : undefined }],
      }
    }
    c = agregar(c, p, color, size)
    const l = c.items.at(-1)!
    const [auto] = autoUnit(p, color, size, 1)
    return {
      c: { ...c, quick: ["¿Me haces precio?", "Lo voy a pensar", "Pago con Yape"], uso: { usados: usadosPrecio(x, c), faltan: [] } },
      so: [carritoMsg(x, c, `${hi}Listo: te separo ${art(p)} ${lineaTexto(p, l, R).toLowerCase()} (${money(auto)}).${n <= 3 ? ` ${n === 1 ? "Es la última" : `Me quedan ${n}`} en tu ${R.col?.toLowerCase() ?? "talla"}.` : ""} Aquí tu carrito: lo pagas con Yape o tarjeta.`)],
    }
  }

  // 2. Precio: primero el valor; la oferta, una sola vez y con plazo.
  const pidePrecio = has(text, /precio|barat|descuento|rebaja|dejas|menos|cuanto (cuesta|esta|sale)/)
  const duda = has(text, /pensar|mas barata|otro lado|vi una|caro/)
  if (pidePrecio || duda) {
    if (!c.items.length) {
      const z = v.size ?? p.sizes[Math.min(3, p.sizes.length - 1)]!
      c = agregar(c, p, v.color?.id ?? c.sel.color, z)
    }
    const l = c.items[0]!
    const [auto] = autoUnit(p, l.color, l.size, l.qty)
    if (c.offered) {
      const h = c.hold && now < c.hold.until ? c.hold : null
      return {
        c,
        so: [{ who: "so", text: h ? `Ya te dejé ${h.kind === "envio" ? "el envío gratis" : h.kind === "descuento" ? `${money(h.amount)} menos` : `${pron(p)} separado`} hasta ${cuando(h.until, now)}: es lo mejor que tengo.` : "Lo acordado ya venció. Hoy queda a su precio; si quieres, te lo separo 24 horas." }],
      }
    }
    if (!c.priced && !duda) {
      const datos = responder(p, R, tpl, "material calza ancho").partes.filter((s) => !s.startsWith("Eso no") && !s.startsWith("Lo demás")).slice(0, 2).join(" ")
      const n = p.stock[key(l.color, l.size)] ?? 0
      return {
        c: { ...c, priced: true, quick: ["Lo voy a pensar", "Vi una más barata"], uso: { usados: [...usadosPrecio(x, c), { label: "Primero el valor: datos del rubro", target: "datos" }], faltan: p.min == null ? [{ label: "Precio mínimo (sin él, Sofi no negocia)", target: "campo-minimo" }] : [] } },
        so: [{ who: "so", text: `${hi}Está a ${money(auto)}. ${(p.texto.split(".")[0] ?? p.name).trim()}. ${datos}${n <= 5 ? ` De la ${l.size} me ${n === 1 ? "queda 1" : `quedan ${n}`}.` : ""}`.replace(/\s+/g, " ").trim() }],
      }
    }
    const pl = plan(p, x.all, c)
    const until = now + 24 * HR
    const usados = [...usadosPrecio(x, c), { label: `Margen ${money(pl.M)} · una sola oferta, con plazo`, target: "campo-minimo" }]
    if (pl.kind === "separo") {
      return {
        c: { ...c, offered: true, hold: { kind: "separo", amount: 0, until }, quick: ["Pago con Yape"], uso: { usados, faltan: p.min == null ? [{ label: "Precio mínimo (sin él, Sofi no negocia)", target: "campo-minimo" }] : [] } },
        so: [carritoMsg(x, c, `${hi}Te entiendo. Ya está en su mejor precio, ${money(floorUnit(p, auto))}: te ${pron(p)} dejo separad${pron(p) === "la" ? "a" : "o"} hasta ${cuando(until, now)}. Después vuelve a la venta.`)],
      }
    }
    const opts = [pl.envio ? "el envío gratis" : "", pl.soles ? `${money(pl.soles)} menos` : ""].filter(Boolean)
    return {
      c: { ...c, offered: true, hold: { kind: "separo", amount: 0, until }, quick: [], uso: { usados: [...usados, ...(p.ofertas.regalo ? [{ label: `Regalo permitido: ${p.ofertas.regalo}`, target: "ofertas" }] : [])], faltan: [] } },
      so: [
        {
          who: "so",
          text: `${hi}${duda ? "Claro, piénsalo." : "Te entiendo."} Mira: si lo pagas hasta ${cuando(until, now)}, te consigo ${opts.join(" o ")}${opts.length > 1 ? ", tú eliges" : ""}. Te ${pron(p)} separo mientras tanto.`,
          btns: [...(pl.envio ? [{ k: "envio", label: "Envío gratis" }] : []), ...(pl.soles ? [{ k: "soles", label: `${money(pl.soles)} menos` }] : [])],
        },
      ],
    }
  }

  // 3. Pagar.
  if (has(text, /\b(pago|pagar|yape|plin|tarjeta)\b/)) {
    if (!c.items.length) return { c, so: [{ who: "so", text: `${hi}¿Qué te separo? Dime el color y la ${R.col?.toLowerCase() ?? "talla"}.` }] }
    const until = c.hold?.until ?? now + 24 * HR
    return {
      c: { ...c, hold: c.hold ?? { kind: "separo", amount: 0, until }, quick: [] },
      so: [carritoMsg(x, c, `${hi}Aquí está tu carrito para pagar con Yape o tarjeta. Te ${pron(p)} separo hasta ${cuando(until, now)}; apenas se confirme el pago, te aviso por aquí.`, "Pagar ahora")],
    }
  }

  // 4. Lo demás: lo que dice la ficha (se vuelve a calcular si la ficha cambia).
  const r = responder(p, R, tpl, text)
  return {
    c: { ...c, quick: c.items.length ? ["¿Me haces precio?", "Pago con Yape"] : [`Quiero la ${p.colors.at(-1)?.name ?? ""} en ${p.sizes[3] ?? p.sizes[0]}`, "¿Me haces precio?"], uso: { usados: r.usados, faltan: r.faltan } },
    so: [{ who: "so", text: "", q: text, first: !!hi }],
  }
}

/** El texto de una respuesta de información, calculado con la ficha de ahora. */
export function info(x: Ctx, q: string, first: boolean) {
  const r = responder(x.p, x.R, x.tpl, q)
  return { ...r, text: `${first ? `¡Hola! Soy Sofi, de ${x.R.store.name}. ` : ""}${r.partes.join(" ")}` }
}
