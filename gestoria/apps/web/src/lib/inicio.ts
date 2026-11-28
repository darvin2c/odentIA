import type { MyStore } from "./api"
import { CONFIG_PATH } from "./configuracion"

/**
 * Lo que la pantalla sabe de Inicio (lienzo «gestorIA como odentIA», tableros 5 y 16): lo arma el
 * servidor (`apps/api/src/inicio.ts`) con la hora de la tienda y los permisos de quien lo abre.
 * Aquí solo se dice con palabras: ninguna cifra se calcula en la pantalla.
 */

export type ToDoItem =
  | {
      kind: "pago"
      when: "ahora"
      orderId: string
      number: string
      customer: string
      amountCents: number
      method: string
      byLink: boolean
      at: string
    }
  | {
      kind: "no_entregado"
      when: "ahora"
      orderId: string
      number: string
      customer: string
      reason: string
      missedAt: string
      deliverOn: string | null
    }
  | {
      kind: "misma"
      when: "hoy"
      reason: "telefono" | "nombre"
      a: { id: string; name: string }
      b: { id: string; name: string }
      more: number
    }
  | {
      kind: "efectivo"
      when: "hoy"
      courierId: string | null
      /** null: cobrado en la tienda, sin repartidor. */
      courier: string | null
      cents: number
      payments: number
    }
  | { kind: "stock"; when: "hoy"; orderId: string; number: string; customer: string }
  | {
      kind: "reponer"
      when: "sin_apuro"
      productId: string
      product: string
      variant: string
      people: number
    }

export type SetupStep = "datos" | "catalogo" | "pagos" | "entregas" | "chats" | "sofi" | "equipo"
export type SetupStepState = "hecho" | "falta" | "saltado" | "pronto"

export interface SetupFacts {
  country: string | null
  productsWithStock: number
  payments: string[]
  deliveries: string[]
  chats: boolean | null
  triedSofi: boolean
  members: number
  invitations: number
}

export interface StoreHome {
  today: string
  figures: {
    /** Null: quien lo ve no ve los totales del día. */
    collected: { cents: number; payments: number } | null
    toConfirm: { payments: number; cents: number | null }
    due: { orders: number; cents: number } | null
    leaves: { orders: number; missed: number }
  }
  toDo: ToDoItem[]
  /** Lo que espera a pantallas que todavía no existen (la Bandeja): no se dibuja. */
  waiting: { chats: unknown[] }
  /** Null: ya quedó lista, o quien lo ve no configura la tienda. */
  setup: {
    steps: { step: SetupStep; state: SetupStepState; skippable: boolean; sells: boolean }[]
    facts: SetupFacts
  } | null
}

export const HOME_KEY = (storeId: string) => ["inicio", storeId]

/** «?desde=inicio»: el apartado que se abrió desde los primeros pasos ofrece volver. */
export const FROM_HOME = { desde: "inicio" } as const

/** «Buenos días», «Buenas tardes» o «Buenas noches», con la hora de la tienda. */
export function greeting(timeZone: string, now = new Date()): string {
  let hour = now.getHours()
  try {
    hour =
      Number(
        new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
          .formatToParts(now)
          .find((p) => p.type === "hour")?.value,
      ) % 24
  } catch {
    // Una zona que el navegador no conoce: la hora de este equipo.
  }
  if (hour >= 5 && hour < 12) return "Buenos días"
  if (hour >= 12 && hour < 19) return "Buenas tardes"
  return "Buenas noches"
}

/** «Miércoles 26 de noviembre», del día de la tienda («2026-11-26»). */
export function longDay(day: string): string {
  const date = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8)))
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("es-PE", { ...options, timeZone: "UTC" }).format(date)
  const weekday = part({ weekday: "long" })
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${part({ day: "numeric" })} de ${part({ month: "long" }).toLowerCase()}`
}

/** El primer nombre de la persona, para saludarla. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ""
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** «Yape, Plin y Efectivo al recibir». */
export function listText(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

export interface StepView {
  title: string
  /** Cómo va, con lo que ya está guardado. */
  detail: string
  /** Su botón: abre el apartado donde se hace. Sin él, todavía no se puede. */
  action: { label: string; path: string } | null
}

/** Lo que dice cada paso y a dónde lleva, con lo guardado. */
export function stepView(
  step: SetupStep,
  state: SetupStepState,
  facts: SetupFacts,
  store: Pick<MyStore, "name" | "timeZone">,
): StepView {
  const done = state === "hecho"
  const go = (label: string, path: string) => ({ label: done ? "Revisar" : label, path })
  switch (step) {
    case "datos":
      return {
        title: "Datos de la tienda",
        detail: facts.country
          ? `${store.name} · ${countryName(facts.country)} · hora de ${(store.timeZone.split("/").at(-1) ?? store.timeZone).replaceAll("_", " ")}`
          : "El país de tu tienda y su hora, con la que se cuenta «hoy».",
        action: go("Completar", `${CONFIG_PATH}/datos`),
      }
    case "catalogo":
      return {
        title: "Tu catálogo",
        detail: done
          ? `${plural(facts.productsWithStock, "producto", "productos")} con su stock.`
          : "Tus productos con su stock: Sofi vende lo que tienes. También se suben de una vez con «Subir una hoja».",
        action: go("Agregar productos", "/catalogo"),
      }
    case "pagos":
      return {
        title: "Medios de pago",
        detail: done
          ? listText(facts.payments)
          : "Cómo te pagan: Yape, Plin, transferencia o al recibir.",
        action: go("Agregar un medio", `${CONFIG_PATH}/medios-de-pago`),
      }
    case "entregas":
      return {
        title: "Entregas y zonas",
        detail: done
          ? listText(facts.deliveries)
          : "Tu reparto, el recojo en la tienda o la agencia, con su precio por zona.",
        action: go("Agregar una forma", `${CONFIG_PATH}/entregas`),
      }
    case "chats":
      return {
        title: "Conectar los chats",
        detail:
          state === "pronto"
            ? "WhatsApp, Instagram y Messenger en gestorIA. Muy pronto: mientras tanto, vende con tu celular y anota los pedidos aquí."
            : done
              ? "Tus chats llegan a gestorIA."
              : "WhatsApp, Instagram y Messenger en gestorIA.",
        action: null,
      }
    case "sofi":
      return {
        title: "Probar a Sofi",
        detail:
          state === "saltado"
            ? "Lo saltaste: vendes sin Sofi."
            : done
              ? "Ya le escribiste como una clienta."
              : "Escríbele como una clienta y mira cómo vende con tus precios y tu stock.",
        action: go("Probar a Sofi", `${CONFIG_PATH}/sofi`),
      }
    case "equipo":
      return {
        title: "Invitar al equipo",
        detail:
          state === "saltado"
            ? "Lo saltaste: atiendes tú."
            : done
              ? facts.members > 1
                ? `${plural(facts.members, "persona", "personas")} en tu equipo${facts.invitations ? `, y ${plural(facts.invitations, "invitación", "invitaciones")} por aceptar` : ""}.`
                : `${plural(facts.invitations, "invitación", "invitaciones")} por aceptar.`
              : "Quien atiende contigo, con su rol. Si trabajas sola, sáltalo.",
        action: go("Invitar", `${CONFIG_PATH}/equipo`),
      }
  }
}

export const WHEN_TITLES = { ahora: "Ahora", hoy: "Hoy", sin_apuro: "Sin apuro" } as const

/** «Te toca» en sus tres tiempos, en orden, sin los que quedan vacíos. */
export function byWhen(items: ToDoItem[]): { when: ToDoItem["when"]; items: ToDoItem[] }[] {
  return (["ahora", "hoy", "sin_apuro"] as const)
    .map((when) => ({ when, items: items.filter((item) => item.when === when) }))
    .filter((group) => group.items.length > 0)
}

/** La pregunta de «¿Es la misma clienta?», con lo que las parece iguales. */
export function sameText(item: Extract<ToDoItem, { kind: "misma" }>): string {
  const more =
    item.more > 0 ? ` Hay ${plural(item.more, "pareja más", "parejas más")} por mirar.` : ""
  return item.reason === "nombre" && item.a.name === item.b.name
    ? `¿Las dos fichas de ${item.a.name} son la misma clienta?${more}`
    : `¿${item.b.name} es la misma clienta que ${item.a.name}? Tienen ${item.reason === "telefono" ? "el mismo teléfono" : "el mismo nombre"}.${more}`
}
