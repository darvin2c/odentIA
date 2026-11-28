import { useSyncExternalStore } from "react"
import type { RubroId } from "../datos"
import { avisar, cuentas, money, mover, nuevoId, type Pedido, pedidosDe } from "./modelo"

/**
 * El pago contra entrega («al recibir»), según la política de cobros de la tienda. En la app vive en
 * Configuración › Cobros; en el prototipo es un dato de la tienda con su pantalla
 * (`/configuracion/cobros`), como la política de cambios. Sofi lo ofrece o no según esta política y
 * lo explica con la regla de la tienda: nunca lo decide por su cuenta.
 */
export interface PoliticaCobro {
  /** Si la tienda acepta pagar al recibir. */
  alRecibir: boolean
  /** Los distritos donde no lo acepta. */
  sinZonas: string[]
  /** El monto máximo de un pedido al recibir, en soles. "0": sin tope. Va como texto, el del selector. */
  montoMax: string
  /** Si pide adelantar algo con el link antes de que salga. */
  adelanto: "nada" | "envio" | "mitad"
  /** Solo para clientas con compras anteriores. */
  soloConCompras: boolean
  /** Si no quiso recibir o no pagó en la puerta: quién paga el viaje. */
  viaje: "tienda" | "clienta"
}

/** Los distritos que reparte la tienda: los de siempre y los lejanos. */
export const ZONAS_LIMA = [
  "Miraflores",
  "Surco",
  "San Isidro",
  "San Borja",
  "Barranco",
  "Surquillo",
  "Lince",
  "La Molina",
  "La Victoria",
  "Rímac",
  "Ate",
  "Los Olivos",
  "Independencia",
  "San Martín de Porres",
  "Comas",
  "Callao",
  "Carabayllo",
  "Ventanilla",
  "Pachacámac",
] as const

export const ADELANTO: Record<PoliticaCobro["adelanto"], string> = {
  nada: "Nada: todo en la puerta",
  envio: "El envío, con su link",
  mitad: "La mitad, con su link",
}
export const VIAJE: Record<PoliticaCobro["viaje"], string> = {
  tienda: "La tienda",
  clienta: "La clienta, en su siguiente viaje",
}

/** La política de la tienda de ejemplo (Pasos, calzado): acepta al recibir, salvo lo más lejano. */
export const COBRO_TIENDA: PoliticaCobro = {
  alRecibir: true,
  sinZonas: ["Carabayllo", "Ventanilla", "Pachacámac"],
  montoMax: "400",
  adelanto: "nada",
  soloConCompras: false,
  viaje: "clienta",
}

const POL: Partial<Record<RubroId, PoliticaCobro>> = {}
let ver = 0
const subs = new Set<() => void>()
const avisarCambio = () => {
  ver++
  for (const f of subs) f()
}

export function cobroDe(r: RubroId): PoliticaCobro {
  return POL[r] ?? COBRO_TIENDA
}
export function useCobro(r: RubroId): PoliticaCobro {
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => ver,
  )
  return cobroDe(r)
}
export function guardarCobro(r: RubroId, pol: PoliticaCobro) {
  POL[r] = { ...pol, sinZonas: [...pol.sinZonas] }
  avisarCambio()
}

/** Lo que Sofi necesita saber para ofrecer, o no, el pago al recibir. */
export interface CasoCobro {
  nombre: string
  zona: string
  monto: number
  envio: number
  /** Compras anteriores de la clienta. */
  compras: number
}

/**
 * ¿Se puede pagar al recibir? Responde con la regla de la tienda que aplica y lo que diría Sofi,
 * con sus palabras. Si no se puede, Sofi ofrece el link: nunca se queda sin una forma de pagar.
 */
export function alRecibirPara(
  pol: PoliticaCobro,
  c: CasoCobro,
): { ok: boolean; regla: string; sofi: string; adelanto: number } {
  const link = "Te dejo tu link de pago: pagas con Yape, Plin o tarjeta y tu pedido sale igual en su día."
  if (!pol.alRecibir)
    return {
      ok: false,
      regla: "La tienda no acepta pago al recibir.",
      sofi: `${c.nombre}, por ahora la tienda no cobra al recibir. ${link}`,
      adelanto: 0,
    }
  const zona = c.zona.split(",")[0] ?? c.zona
  if (c.zona.includes("agencia"))
    return {
      ok: false,
      regla: "Por agencia no hay pago al recibir: la agencia no cobra por la tienda.",
      sofi: `${c.nombre}, los envíos por agencia se pagan antes de salir. ${link}`,
      adelanto: 0,
    }
  if (pol.sinZonas.includes(zona))
    return {
      ok: false,
      regla: `En ${zona} la tienda no acepta pago al recibir.`,
      sofi: `${c.nombre}, en ${zona} la tienda no cobra al recibir. ${link}`,
      adelanto: 0,
    }
  const max = Number(pol.montoMax)
  if (max && c.monto > max)
    return {
      ok: false,
      regla: `Al recibir, hasta ${money(max)}.`,
      sofi: `${c.nombre}, al recibir la tienda cobra pedidos de hasta ${money(max)}, y el tuyo es de ${money(c.monto)}. ${link}`,
      adelanto: 0,
    }
  if (pol.soloConCompras && c.compras === 0)
    return {
      ok: false,
      regla: "Al recibir, solo para clientas que ya compraron.",
      sofi: `${c.nombre}, el pago al recibir es para clientas que ya compraron antes. Esta primera vez, ${link.charAt(0).toLowerCase()}${link.slice(1)}`,
      adelanto: 0,
    }
  const adelanto = pol.adelanto === "envio" ? c.envio : pol.adelanto === "mitad" ? Math.ceil(c.monto / 2) : 0
  return {
    ok: true,
    regla:
      adelanto > 0
        ? `Al recibir, adelantando ${pol.adelanto === "envio" ? "el envío" : "la mitad"} con el link.`
        : "Al recibir, todo en la puerta.",
    sofi:
      adelanto > 0
        ? `Sí, ${c.nombre}: puedes pagar al recibir. La tienda pide adelantar ${money(adelanto)} con tu link; el resto (${money(c.monto - adelanto)}) lo pagas en la puerta en efectivo, Yape o tarjeta. ¿Con cuánto vas a pagar, para que el repartidor lleve tu vuelto?`
        : `Sí, ${c.nombre}: puedes pagar al recibir, en efectivo, Yape o tarjeta. ¿Con cuánto vas a pagar, para que el repartidor lleve tu vuelto?`,
    adelanto,
  }
}

/** El vuelto que lleva el repartidor: lo que dijo la clienta («pago con 200») menos lo que falta. */
export function vueltoDe(p: Pedido): number {
  const k = cuentas(p)
  if (!k.alRecibir || !p.pagaCon || !k.falta) return 0
  return Math.max(0, p.pagaCon - k.falta)
}

/** Pagó antes con su link un pedido que era al recibir: ya no espera el vuelto. */
export const pagoAntes = (p: Pedido) =>
  p.cobro === "al_recibir" && p.pagos.some((g) => g.medio === "link" && g.estado === "confirmado")

/** Los motivos de «No se entregó» en la app del repartidor. */
export const MOTIVOS_NO = [
  "No estaba: nadie abrió",
  "No quiso recibirlo",
  "No pagó en la puerta",
] as const
export type MotivoNo = (typeof MOTIVOS_NO)[number]

/**
 * No quiso recibirlo o no pagó en la puerta: el producto vuelve a la tienda y Sofi le pregunta si lo
 * quiere otro día. Si la política dice que el viaje lo paga la clienta, queda como cargo en el saldo
 * del pedido (propuesto: hoy no existe ese cargo en el saldo).
 */
export function noRecibio(r: RubroId, p: Pedido, quien: string, motivo: string, dijo?: string) {
  const pol = cobroDe(r)
  const n = p.clienta.split(" ")[0]
  mover(
    r,
    p.id,
    (x) => {
      x.rechazo = { motivo, quien, cuando: "Hoy · ahora", dijo }
      if (pol.viaje === "clienta")
        x.cargos = [
          ...(x.cargos ?? []),
          { id: nuevoId("cg"), concepto: "El viaje que no se entregó", monto: x.entrega.envio, propuesto: true },
        ]
      avisar(
        x,
        "falla",
        pol.viaje === "clienta"
          ? `${n}, ${quien} no pudo dejarte tu pedido y vuelve a la tienda. Si lo quieres otro día, te lo llevamos: el viaje de hoy (${money(x.entrega.envio)}) se suma a tu saldo, como dice la política de la tienda.`
          : `${n}, ${quien} no pudo dejarte tu pedido y vuelve a la tienda. Si lo quieres otro día, dime cuándo y te lo llevamos.`,
      )
    },
    {
      actor: "repartidor",
      quien,
      texto: `«No se entregó»: ${motivo.toLowerCase()}${dijo ? ` («${dijo}»)` : ""}. Lo trae de vuelta a la tienda.`,
    },
  )
}

/** Lo que trae de vuelta cada repartidor hoy: los que no se recibieron. */
export function vuelvenCon(r: RubroId, rep: string): Pedido[] {
  return pedidosDe(r).filter((p) => p.rechazo && p.entrega.repartidor === rep && !p.rechazo.enTienda)
}

/** Caja recibió al repartidor: lo que trajo de vuelta queda en la tienda. */
export function llegaronATienda(r: RubroId, rep: string) {
  for (const p of vuelvenCon(r, rep))
    mover(
      r,
      p.id,
      (x) => {
        if (x.rechazo) x.rechazo.enTienda = true
      },
      { actor: "persona", quien: "Caja", texto: `Volvió a la tienda con ${rep}.` },
    )
}
