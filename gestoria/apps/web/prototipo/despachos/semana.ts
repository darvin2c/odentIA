import { addDays, formatDateLong, formatDayShort, weekDates } from "@odentia/ui-patterns"
import { foto as _foto, RUBROS, type RubroId } from "../datos"
import { alRecibirPara, COBRO_TIENDA, pagoAntes, vueltoDe } from "../pedidos/cobros"
import { vueltaToca } from "../pedidos/vuelta"
import {
  cuentas,
  type Linea,
  MAS_PEDIDOS,
  money,
  nuevoId,
  PASO,
  type Paso,
  type Pedido,
} from "../pedidos/modelo"

/**
 * Despachos del prototipo: las entregas de la semana salen de los mismos pedidos de ejemplo
 * (`pedidos/modelo.ts`), así que lo que se toca aquí cambia el pedido y al revés. Aquí se suma el
 * resto de la semana (otros días, Jhon, la agencia) y lo que solo sabe Despachos: los días en
 * fecha, las franjas con su cupo, el feriado y el orden de cada repartidor.
 *
 * Los pedidos dicen «Mié 26», «Hoy» (jueves 27) y «Vie 28»: el calendario es el de 2025, en el que
 * el 27 de noviembre cae jueves. El año no se muestra en ninguna parte.
 */

export const HOY = "2025-11-27"
const WD = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]

/** «Hoy», «Vie 28», «Lun 1»: como los pedidos escriben su día. */
export function etiqueta(iso: string): string {
  if (iso === HOY) return "Hoy"
  const d = new Date(`${iso}T12:00:00Z`)
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()}`
}

/** De «Vie 28» o «Hoy» a la fecha. Del 15 en adelante es noviembre; antes, diciembre. */
export function fechaDe(dia: string | null): string | null {
  if (!dia) return null
  if (dia === "Hoy") return HOY
  const n = Number(dia.split(" ")[1])
  if (!n) return null
  return n >= 15 ? `2025-11-${String(n).padStart(2, "0")}` : `2025-12-${String(n).padStart(2, "0")}`
}

/** «jueves 27 de noviembre», sin el año. */
export function largo(iso: string): string {
  return formatDateLong(iso)
    .replace(/ de \d{4}$/, "")
    .toLowerCase()
}
export const corto = (iso: string) => formatDayShort(iso)
export const semanaDe = (iso: string) => weekDates(iso)
export const sumar = addDays

export const FRANJAS = ["9 a 1 p. m.", "2 a 6 p. m."] as const
export const FRANJA_NOMBRE: Record<string, string> = {
  "9 a 1 p. m.": "Mañana · 9 a 1",
  "2 a 6 p. m.": "Tarde · 2 a 6",
}
export const REPARTIDORES = ["Kevin", "Jhon"] as const
/** Cuántas entregas lleva un repartidor en una franja. Es un supuesto, por confirmar. */
export const CUPO = 4
/** Cuántos repartidores salen cada día (sin contar a quien falta). */
export const FERIADOS: Record<string, string> = { "2025-12-08": "Inmaculada Concepción" }
/** Quién no viene, por día (lo marca la tienda en el caso del repartidor que falta). */
export type Faltas = Record<string, string[]>

/* ---------- El resto de la semana: pedidos de ejemplo que solo pide Despachos ---------- */

type Fila = [
  id: string,
  clienta: string,
  zona: string,
  dia: string,
  franja: string | null,
  rep: string | null,
  paso: Paso,
  cobro: Pedido["cobro"],
  prod: number,
]

const FILAS: Fila[] = [
  // Lunes 24 a miércoles 26: ya entregados.
  ["0131", "Gabriela Soto", "Miraflores", "Lun 24", "9 a 1 p. m.", "Kevin", "entregado", "link", 2],
  ["0132", "Patricia León", "Surco", "Lun 24", "2 a 6 p. m.", "Jhon", "entregado", "al_recibir", 4],
  ["0134", "Ruth Cárdenas", "La Molina", "Lun 24", "2 a 6 p. m.", "Kevin", "entregado", "link", 1],
  ["0136", "Sandra Vega", "Callao", "Mar 25", "9 a 1 p. m.", "Jhon", "entregado", "captura", 3],
  ["0138", "Elena Prado", "San Borja", "Mar 25", "2 a 6 p. m.", "Jhon", "entregado", "link", 5],
  ["0141", "Nadia Ruiz", "Lince", "Mié 26", "2 a 6 p. m.", "Jhon", "entregado", "al_recibir", 2],
  // Hoy, jueves 27.
  [
    "0150",
    "Claudia Ramos",
    "Miraflores",
    "Hoy",
    "9 a 1 p. m.",
    "Kevin",
    "entregado",
    "al_recibir",
    2,
  ],
  [
    "0151",
    "Melissa Vargas",
    "Barranco",
    "Hoy",
    "9 a 1 p. m.",
    "Jhon",
    "en_camino",
    "al_recibir",
    3,
  ],
  ["0152", "Karina Flores", "San Borja", "Hoy", "9 a 1 p. m.", "Jhon", "en_camino", "link", 4],
  [
    "0154",
    "Yesenia Ccori",
    "Surquillo",
    "Hoy",
    "9 a 1 p. m.",
    "Jhon",
    "entregado",
    "al_recibir",
    1,
  ],
  ["0155", "Lorena Díaz", "Ate", "Hoy", "2 a 6 p. m.", "Kevin", "por_salir", "al_recibir", 5],
  ["0156", "Pamela Quiroz", "La Victoria", "Hoy", "2 a 6 p. m.", "Kevin", "preparando", "link", 2],
  ["0157", "Mónica Salas", "Comas", "Hoy", "2 a 6 p. m.", "Jhon", "por_salir", "al_recibir", 3],
  [
    "0168",
    "Teresa Huertas",
    "San Martín de Porres",
    "Hoy",
    "2 a 6 p. m.",
    "Jhon",
    "preparando",
    "link",
    4,
  ],
  [
    "0169",
    "Brenda Choque",
    "Independencia",
    "Hoy",
    "2 a 6 p. m.",
    "Jhon",
    "preparando",
    "al_recibir",
    1,
  ],
  ["0186", "Lucía Fernández", "Rímac", "Hoy", "2 a 6 p. m.", "Jhon", "por_salir", "link", 2],
  // Pagó al recibir con la tarjeta, en el POS de Jhon.
  ["0189", "Gloria Núñez", "Surquillo", "Hoy", "9 a 1 p. m.", "Jhon", "entregado", "al_recibir", 2],
  ["0170", "Sofía Medina", "Trujillo, por agencia", "Hoy", null, null, "preparando", "link", 0],
  // Viernes 28 y sábado 29.
  ["0171", "Ana Lucía Torres", "Surco", "Vie 28", "9 a 1 p. m.", "Kevin", "pagado", "link", 3],
  [
    "0172",
    "Rosario Inga",
    "Miraflores",
    "Vie 28",
    "9 a 1 p. m.",
    "Kevin",
    "pagado",
    "al_recibir",
    1,
  ],
  ["0173", "Katherine Paz", "Callao", "Vie 28", "2 a 6 p. m.", "Jhon", "pagado", "link", 5],
  ["0174", "Fátima Rojas", "Surquillo", "Vie 28", "2 a 6 p. m.", "Kevin", "por_pagar", "link", 2],
  // Pidió pagar al recibir en Carabayllo, donde la tienda no lo acepta: Sofi le dejó su link.
  ["0187", "Pilar Huamán", "Carabayllo", "Vie 28", "2 a 6 p. m.", "Kevin", "por_pagar", "link", 3],
  ["0175", "Liliana Chávez", "San Isidro", "Sáb 29", "9 a 1 p. m.", "Kevin", "pagado", "link", 4],
  [
    "0176",
    "Erika Mamani",
    "Los Olivos",
    "Sáb 29",
    "9 a 1 p. m.",
    "Jhon",
    "pagado",
    "al_recibir",
    0,
  ],
  ["0177", "Vanessa Cruz", "Ate", "Sáb 29", "2 a 6 p. m.", "Jhon", "pagado", "link", 3],
  // La semana siguiente.
  ["0178", "Giuliana Paredes", "Surco", "Lun 1", "9 a 1 p. m.", "Kevin", "pagado", "link", 1],
  ["0179", "Roxana Tello", "Miraflores", "Lun 1", "2 a 6 p. m.", "Jhon", "pagado", "al_recibir", 2],
  ["0180", "Inés Salazar", "Lince", "Mar 2", "9 a 1 p. m.", "Kevin", "pagado", "link", 5],
  ["0181", "Daniela Ortiz", "Barranco", "Mié 3", "2 a 6 p. m.", "Kevin", "pagado", "link", 4],
  ["0182", "Silvia Ramos", "San Borja", "Vie 5", "9 a 1 p. m.", "Jhon", "por_pagar", "link", 0],
  ["0183", "Noelia Campos", "Callao", "Sáb 6", "9 a 1 p. m.", "Kevin", "pagado", "al_recibir", 3],
  // La del feriado: Sofi no ofrece ese día, pero esta se anotó antes de marcarlo.
  ["0184", "Carolina Ugarte", "Surco", "Lun 8", "9 a 1 p. m.", "Kevin", "pagado", "link", 2],
  ["0185", "Mirella Soto", "Miraflores", "Mar 9", "2 a 6 p. m.", "Jhon", "pagado", "link", 1],
]

const ENVIO: Record<string, number> = { "Trujillo, por agencia": 18 }
const DIRECCION = (zona: string, i: number) =>
  zona.includes("agencia")
    ? "Agencia Olva · Av. España 1840, Trujillo"
    : `${["Av. Primavera", "Jr. Huáscar", "Calle Los Pinos", "Av. Las Flores", "Jr. Ica"][i % 5]} ${120 + i * 37}, ${zona}`

function lineaDe(rubro: RubroId, i: number): Linea {
  const P = RUBROS[rubro].products()
  const p = P[i % P.length]
  const m = p?.media.find((x) => x.kind === "foto") ?? p?.media[0]
  const src = m ? (m.kind === "video" ? (m.poster ?? "") : m.src) : ""
  const c = p?.colors[0]
  const s = p?.sizes.length ? p.sizes[Math.min(2, p.sizes.length - 1)] : undefined
  return {
    id: nuevoId("l"),
    pid: p?.id ?? "",
    nombre: p?.name ?? "Producto",
    variante: [c?.name, s].filter(Boolean).join(" · "),
    qty: 1,
    precio: p?.list ?? 99,
    foto: src,
  }
}

function semana(rubro: RubroId): Pedido[] {
  return FILAS.map(([id, clienta, zona, dia, franja, rep, paso, cobro, prod], i) => {
    const agencia = zona.includes("agencia")
    const p: Pedido = {
      id,
      clienta,
      telefono: `9${String(10 + i).padStart(2, "0")} *** ${String(300 + i * 7).slice(-3)}`,
      canal: i % 3 === 0 ? "instagram" : i % 5 === 0 ? "catalogo" : "whatsapp",
      origen: i % 5 === 0 ? { k: "catalogo" } : { k: "sofi" },
      paso,
      creado: "Esta semana",
      lineas: [lineaDe(rubro, prod)],
      entrega: {
        tipo: agencia ? "agencia" : "moto",
        zona,
        envio: ENVIO[zona] ?? 10,
        dia,
        franja,
        repartidor: rep,
        ...(agencia ? { agencia: "Olva Courier" } : {}),
        direccion: DIRECCION(zona, i),
      },
      cobro,
      pagos: [],
      eventos: [
        {
          id: nuevoId("e"),
          cuando: "Esta semana",
          actor: "sofi",
          quien: "Sofi",
          texto: "Armó el pedido y le mandó su carrito.",
          paso: "por_pagar",
        },
      ],
      avisos: [],
      chat: [],
      unoPorCiento: true,
    }
    const total = cuentas(p).total
    const cobrado =
      cobro === "link" && paso !== "por_pagar"
        ? "link"
        : cobro === "al_recibir" && paso === "entregado"
          ? "efectivo"
          : cobro === "captura" && paso === "entregado"
            ? "yape"
            : null
    if (cobrado)
      p.pagos.push({
        id: nuevoId("pg"),
        medio: cobrado,
        monto: total,
        estado: "confirmado",
        cuando: dia === "Hoy" ? "Hoy · 11:40 a. m." : dia,
        quien: cobrado === "efectivo" ? (rep ?? "") : cobrado === "link" ? "la pasarela" : "Rosa",
      })
    contraEntrega(p)
    if (agencia)
      p.toca = {
        texto: "Sale hoy por Olva a Trujillo: falta el número de envío.",
        boton: "Anotar el N.º de Olva",
        accion: "numero",
      }
    return p
  })
}
MAS_PEDIDOS.push(semana)

const msg = (de: "clienta" | "sofi", texto: string, hora: string) => ({ de, texto, hora })

/**
 * Los casos del pago contra entrega, sobre los mismos pedidos de la semana:
 * 1. Lorena (0155) paga en efectivo con S/ 200: Kevin lleva el vuelto.
 * 2. Brenda (0169) era al recibir y pagó antes con su link, tras el recordatorio de Sofi.
 * 3. Melissa (0151) no quiso recibirlo: vuelve a la tienda con Jhon y el viaje va a su saldo.
 * 4. Jhon cierra su día con S/ 10 menos (`CIERRE_DECLARADO`).
 * 5. Pilar (0187) pidió pagar al recibir en Carabayllo, donde la tienda no lo acepta.
 * Además, el día de la entrega Sofi recuerda el monto a cada clienta que paga al recibir.
 */
function contraEntrega(p: Pedido) {
  const n = p.clienta.split(" ")[0]!
  const k = cuentas(p)
  const pol = COBRO_TIENDA
  const regla = alRecibirPara(pol, { nombre: n, zona: p.entrega.zona, monto: k.total, envio: p.entrega.envio, compras: 1 })
  if (p.id === "0155") {
    p.origen = { k: "sofi" }
    p.canal = "whatsapp"
    p.pagaCon = Math.ceil((k.falta + 1) / 100) * 100
    p.chat.push(
      msg("clienta", "¿Lo puedo pagar cuando llegue?", "Ayer · 7:40 p. m."),
      msg("sofi", regla.sofi, "Ayer · 7:40 p. m."),
      msg("clienta", `Con un billete de ${p.pagaCon}`, "Ayer · 7:42 p. m."),
      msg(
        "sofi",
        `Listo, ${n}: Kevin lleva vuelto de ${money(p.pagaCon - k.falta)}. Llega hoy de 2 a 6 p. m.`,
        "Ayer · 7:42 p. m.",
      ),
    )
  }
  if (p.id === "0169") {
    p.chat.push(
      msg(
        "sofi",
        `Hola, ${n}: hoy llega tu pedido de 2 a 6 p. m. Son ${money(k.total)} al recibir, en efectivo, Yape o tarjeta. Si prefieres, paga ya con tu link y así no esperas el vuelto.`,
        "Hoy · 8:00 a. m.",
      ),
      msg("clienta", "Mejor lo pago ya 👍", "Hoy · 8:14 a. m."),
    )
    p.pagos.push({
      id: nuevoId("pg"),
      medio: "link",
      monto: k.total,
      estado: "confirmado",
      cuando: "Hoy · 8:15 a. m.",
      quien: "la pasarela",
    })
    p.eventos.push({
      id: nuevoId("e"),
      cuando: "Hoy · 8:15 a. m.",
      actor: "pasarela",
      quien: "La pasarela",
      texto: "Pagó antes con su link, tras el recordatorio de Sofi. Ya no es al recibir.",
    })
  }
  if (p.id === "0151") {
    p.rechazo = {
      motivo: "No quiso recibirlo",
      quien: "Jhon",
      cuando: "Hoy · 11:55 a. m.",
      dijo: "Ya no lo necesito, me lo regalaron",
    }
    if (pol.viaje === "clienta")
      p.cargos = [{ id: nuevoId("cg"), concepto: "El viaje que no se entregó", monto: p.entrega.envio, propuesto: true }]
    p.eventos.push({
      id: nuevoId("e"),
      cuando: "Hoy · 11:55 a. m.",
      actor: "repartidor",
      quien: "Jhon",
      texto: "«No se entregó»: no quiso recibirlo («Ya no lo necesito, me lo regalaron»). Lo trae de vuelta a la tienda.",
    })
    p.avisos.push({
      id: nuevoId("a"),
      cuando: "Hoy · 11:56 a. m.",
      clave: "falla",
      estado: "enviado",
      texto: `${n}, Jhon no pudo dejarte tu pedido y vuelve a la tienda. Si lo quieres otro día, te lo llevamos: el viaje de hoy (${money(p.entrega.envio)}) se suma a tu saldo, como dice la política de la tienda.`,
    })
    p.chat.push(
      msg(
        "sofi",
        `${n}, Jhon no pudo dejarte tu pedido y vuelve a la tienda. Si lo quieres otro día, te lo llevamos: el viaje de hoy (${money(p.entrega.envio)}) se suma a tu saldo, como dice la política de la tienda.`,
        "Hoy · 11:56 a. m.",
      ),
    )
  }
  if (p.id === "0189" && p.pagos[0]) {
    p.pagos[0].medio = "pos"
    p.pagos[0].quien = "Jhon"
  }
  if (p.id === "0187") {
    const no = alRecibirPara(pol, { nombre: n, zona: p.entrega.zona, monto: k.total, envio: p.entrega.envio, compras: 0 })
    p.reglaCobro = no.regla
    p.separadoHasta = "Vie 28 · 9:30 a. m."
    p.chat.push(
      msg("clienta", "Hola, ¿puedo pagar al recibir? Vivo en Carabayllo", "Hoy · 9:30 a. m."),
      msg("sofi", no.sofi, "Hoy · 9:30 a. m."),
    )
  }
  // El día de la entrega, Sofi le recuerda el monto y le ofrece pagar ya con su link.
  if (p.cobro === "al_recibir" && p.entrega.dia === "Hoy" && !p.rechazo && ["preparando", "por_salir", "en_camino"].includes(p.paso))
    p.avisos.push({
      id: nuevoId("a"),
      cuando: "Hoy · 8:00 a. m.",
      clave: "link",
      estado: "enviado",
      texto: `Hoy llega tu pedido. Son ${money(pagoAntes(p) ? cuentas(p).total : cuentas(p).falta)} al recibir${vueltoDe(p) ? ` (pagas con ${money(p.pagaCon!)}: el repartidor lleva tu vuelto)` : ""}. Si prefieres, paga ya con tu link y así no esperas el vuelto.`,
    })
}

/**
 * Lo que cada repartidor dice que entrega al cerrar su día, frente a lo que cobró en efectivo. Jhon
 * entrega S/ 10 menos y dice por qué (caso 4 del pago contra entrega).
 */
export const CIERRE_DECLARADO: Record<string, { delta: number; motivo: string }> = {
  Jhon: { delta: -10, motivo: "Di S/ 10 de vuelto de más en la 0154 (Yesenia)." },
}

/* ---------- Los recojos: salen de los cambios y devoluciones de Pedidos ---------- */

/**
 * Lo que hay que recoger en la casa de la clienta. No es un dato aparte: sale del cambio o la
 * devolución del pedido (`p.vuelta`, en `pedidos/vuelta.ts`), que arma Sofi según la política de
 * la tienda. En Despachos es una parada más del día, con la etapa «Por recoger»:
 * - en el mismo viaje (`recojo_mismo`), la parada es el pedido de cambio enlazado («lleva una y
 *   recoge otra»), o el caso mismo mientras falta aprobarlo;
 * - en un viaje solo para recoger (`recojo_solo`), la parada es el caso, en su día y su franja.
 */
export interface Recojo {
  tipo: "cambio" | "devolucion"
  /** El pedido original, el entregado. */
  de: string
  /** Por qué, en palabras de la clienta. */
  motivo: string
  /** Qué se recoge. */
  recoge: string
  /** Qué se lleva a cambio, en el mismo viaje. */
  lleva?: string
  /** Qué hace el repartidor en la puerta. */
  puerta: string
  /** Cuánto se le devuelve por su medio, si es devolución. */
  devuelve?: number
  aprobo?: string
}

const talla = (variante: string) => variante.split(" · ").at(-1) ?? variante

function recojoDe(orig: Pedido, cambio?: Pedido): Recojo | undefined {
  const v = orig.vuelta
  if (!v || !v.como.startsWith("recojo")) return undefined
  const va = cambio?.lineas.find((l) => !l.vuelve) ?? (v.como === "recojo_mismo" ? v.sale : undefined)
  const ap = v.hechos.aprobado
  return {
    tipo: v.tipo,
    de: orig.id,
    motivo: v.dice,
    recoge: v.vuelven.map((l) => `${l.nombre} · ${l.variante}`).join(", "),
    lleva: va ? `${va.nombre} · ${va.variante}` : undefined,
    puerta: va
      ? `Le da la ${talla(va.variante)} para que se la pruebe. Si le queda, recoge la otra en su caja y le toma una foto.`
      : "Revisa cómo está, le toma una foto y lo trae a la tienda. «Recogí» se activa con la foto.",
    devuelve: v.arm.dinero === "medio" && v.arm.monto ? v.arm.monto : undefined,
    aprobo: ap ? `${ap.quien}, ${ap.cuando.toLowerCase()}` : undefined,
  }
}

/* ---------- Las entregas, como las ve Despachos ---------- */

export type Estado =
  | "no_sale"
  | "espera_pago"
  | "pagado"
  | "empacar"
  | "sin_repartidor"
  | "agencia_numero"
  | "por_salir"
  | "en_camino"
  | "entregado"
  | "no_entregado"

export const ESTADO: Record<
  Estado,
  { label: string; tono: "success" | "warning" | "soft" | "outline" | "destructive" }
> = {
  no_sale: { label: "No sale: falta confirmar el pago", tono: "destructive" },
  espera_pago: { label: "Espera su pago", tono: "outline" },
  pagado: { label: "Programada", tono: "outline" },
  empacar: { label: "Por empacar", tono: "warning" },
  sin_repartidor: { label: "Sin repartidor", tono: "warning" },
  agencia_numero: { label: "Falta el N.º de envío", tono: "warning" },
  por_salir: { label: "Por salir", tono: "soft" },
  en_camino: { label: "En camino", tono: "soft" },
  entregado: { label: "Entregado", tono: "success" },
  no_entregado: { label: "No se entregó", tono: "destructive" },
}

/**
 * La etapa del pedido, con el mismo nombre y color que en Pedidos (`PASO`), más las salidas y el
 * recojo. Es lo que se ve en cada tarjeta; el cobro va aparte.
 */
export type Etapa = Paso | "no_entregado" | "vuelve_tienda" | "en_tienda" | "por_recoger" | "recogido"
export type Tono =
  | "warning"
  | "soft"
  | "success"
  | "secondary"
  | "outline"
  | "destructive"
  | "default"
export const ETAPA: Record<Etapa, { label: string; corto: string; tono: Tono }> = {
  ...PASO,
  no_entregado: { label: "No se entregó", corto: "No se entregó", tono: "destructive" },
  vuelve_tienda: { label: "Vuelve a la tienda", corto: "Vuelve", tono: "destructive" },
  en_tienda: { label: "De vuelta en la tienda", corto: "En la tienda", tono: "secondary" },
  por_recoger: { label: "Por recoger", corto: "Por recoger", tono: "default" },
  recogido: { label: "Recogido", corto: "Recogido", tono: "success" },
}
/** El orden de la tira de etapas: el camino y después las salidas y los recojos. */
export const ORDEN_ETAPAS: Etapa[] = [
  "por_pagar",
  "por_confirmar",
  "pagado",
  "preparando",
  "por_salir",
  "en_camino",
  "entregado",
  "no_entregado",
  "vuelve_tienda",
  "en_tienda",
  "por_recoger",
  "recogido",
  "anulado",
]
/** El punto de color de cada etapa: el de su Badge. */
export const PUNTO: Record<Tono, string> = {
  warning: "bg-warning",
  soft: "bg-primary/60",
  success: "bg-success",
  secondary: "bg-muted-foreground/50",
  outline: "border border-foreground/60",
  destructive: "bg-destructive",
  default: "bg-primary ring-2 ring-primary/30",
}

export type Boton = "listo" | "confirmar" | "asignar" | "numero" | "pasar" | "vuelta"

export interface Ent {
  /** El del pedido; la parada de un recojo lleva «-r», porque su pedido también tiene su entrega. */
  id: string
  p: Pedido
  fecha: string
  estado: Estado
  etapa: Etapa
  /** La segunda fila: lo que hay que hacer, o lo que pasa solo. */
  toca: { texto: string; persona: boolean }
  /** El único botón cuando necesita a una persona. Siempre abre el cajón del pedido. */
  boton?: { texto: string; tipo: Boton }
  /** «Pagado», «Falta S/ 169», «Al recibir S/ 169», «S/ 74 por confirmar». Aparte de la etapa. */
  cobro: { texto: string; tono: "ok" | "falta" | "espera" }
  falta: number
  /** Al recibir en efectivo: el vuelto que lleva el repartidor. */
  vuelto: number
  recojo?: Recojo
}

const DE_FRANJA: Record<string, string> = {
  "9 a 1 p. m.": "de 9 a 1",
  "2 a 6 p. m.": "de 2 a 6 p. m.",
}
const deFranja = (f: string | null) => (f ? (DE_FRANJA[f] ?? f) : "hoy")

/** La frase de la segunda fila: qué hay que hacer, o qué pasa solo. */
function tocaDe(p: Pedido, estado: Estado, fecha: string, recojo?: Recojo): Ent["toca"] {
  const x = p.entrega
  const rep = x.repartidor ?? "el repartidor"
  const k = cuentas(p)
  const n = p.clienta.split(" ")[0]
  if (FERIADOS[fecha] && !["entregado", "en_camino"].includes(estado))
    return { texto: "Quedó en un feriado: pásalo a otro día.", persona: true }
  if (p.rechazo) {
    const cargo = (p.cargos ?? []).reduce((a, c) => a + c.monto, 0)
    return p.rechazo.enTienda
      ? {
          texto: `Volvió a la tienda. Sofi espera si ${n} lo quiere otro día${cargo ? `: el viaje (${money(cargo)}) va a su saldo` : ""}.`,
          persona: false,
        }
      : {
          texto: `${p.rechazo.motivo}${p.rechazo.dijo ? `: «${p.rechazo.dijo}»` : ""}. ${p.rechazo.quien} lo trae de vuelta; Sofi le preguntó si lo quiere otro día.`,
          persona: false,
        }
  }
  if (recojo) {
    if (p.paso === "entregado") return { texto: `${rep} lo recogió y trajo la foto.`, persona: false }
    if (p.paso === "preparando" && recojo.lleva)
      return {
        texto: `Empaca la talla nueva y dásela a ${rep}: lleva una y recoge otra.`,
        persona: true,
      }
    return {
      texto: `Sigue solo: ${rep} lo recoge ${deFranja(x.franja)} y toma la foto.`,
      persona: false,
    }
  }
  switch (estado) {
    case "no_sale": {
      const g = p.pagos.find((y) => y.estado === "por_confirmar")
      return g
        ? {
            texto: `Confirma el Yape: dice ${money(g.captura?.monto ?? g.monto)} de ${money(k.total)}.`,
            persona: true,
          }
        : { texto: "Sigue solo: Sofi le recuerda el link. Sin pago no sale.", persona: false }
    }
    case "espera_pago":
      return { texto: `Sigue solo: espera el pago de ${n}; Sofi le recuerda el link.`, persona: false }
    case "pagado":
      return {
        texto: `Sigue solo: pasa a «Preparando» el ${largo(fecha).split(" ").slice(0, 2).join(" ")}, a las 8 a. m.`,
        persona: false,
      }
    case "empacar":
      return x.tipo === "agencia"
        ? { texto: `Empácalo y déjalo en ${x.agencia ?? "la agencia"}.`, persona: true }
        : { texto: `Empácalo y dáselo a ${rep}. Sale ${deFranja(x.franja)}.`, persona: true }
    case "sin_repartidor":
      return { texto: `Nadie libre ${deFranja(x.franja)}: elige cómo sale.`, persona: true }
    case "agencia_numero":
      return {
        texto: `Déjalo en ${x.agencia ?? "la agencia"} y anota el N.º de envío.`,
        persona: true,
      }
    case "por_salir":
      return {
        texto: `Sigue solo: ${rep} lo recoge y toca «Salí».${k.falta && k.alRecibir ? ` Cobra ${money(k.falta)} en la puerta${vueltoDe(p) ? ` y lleva vuelto de ${money(vueltoDe(p))}` : ""}.` : pagoAntes(p) ? ` ${n} pagó antes con su link: no cobra en la puerta.` : ""}`,
        persona: false,
      }
    case "en_camino":
      return x.tipo === "agencia"
        ? { texto: `Sigue solo: va por ${x.agencia}, N.º ${x.numero}.`, persona: false }
        : { texto: `Sigue solo: ${rep} lo lleva ${deFranja(x.franja)}.`, persona: false }
    case "entregado":
      return { texto: `Entregado por ${x.repartidor ?? x.agencia ?? "la tienda"}.`, persona: false }
    case "no_entregado":
      return {
        texto: `${(p.noEntregado ?? "No se entregó").replace(/\.$/, "")}. Vuelve con ${rep}; sigue solo.`,
        persona: false,
      }
  }
}

export function entregaDe(p: Pedido, recojo?: Recojo): Ent | null {
  const fecha = fechaDe(p.entrega.dia)
  if (!fecha || p.paso === "anulado" || p.entrega.tipo === "recojo") return null
  const k = cuentas(p)
  let estado: Estado
  let boton: Ent["boton"]
  if (p.paso === "por_confirmar") {
    estado = "no_sale"
    boton = { texto: "Ver el Yape", tipo: "confirmar" }
  } else if (p.paso === "por_pagar") estado = fecha === HOY ? "no_sale" : "espera_pago"
  else if (p.paso === "pagado") estado = "pagado"
  else if (p.paso === "preparando") {
    if (p.entrega.tipo === "agencia" && !p.entrega.numero) {
      estado = "agencia_numero"
      boton = { texto: "Anotar el N.º", tipo: "numero" }
    } else if (!p.entrega.repartidor && p.entrega.tipo !== "agencia") {
      estado = "sin_repartidor"
      boton = { texto: "Elegir cómo sale", tipo: "asignar" }
    } else {
      estado = "empacar"
      boton = { texto: "Empacar", tipo: "listo" }
    }
  } else if (p.paso === "por_salir") estado = p.noEntregado ? "no_entregado" : "por_salir"
  else if (p.paso === "en_camino") estado = "en_camino"
  else estado = "entregado"
  // No quiso recibirlo o no pagó: no sale otra vez sola, vuelve a la tienda.
  if (p.rechazo) {
    estado = "no_entregado"
    boton = undefined
  }
  // Quedó en un feriado (se anotó antes de marcarlo): lo decide una persona.
  if (FERIADOS[fecha] && !boton && !["entregado", "en_camino"].includes(estado))
    boton = { texto: "Pasar a otro día", tipo: "pasar" }
  const cargo = k.cargos
  const cobro: Ent["cobro"] = p.rechazo
    ? cargo
      ? { texto: `Viaje ${money(cargo)} a su saldo`, tono: "espera" }
      : { texto: "Sin cobro", tono: "ok" }
    : recojo?.devuelve
    ? { texto: `Devolver ${money(recojo.devuelve)}`, tono: "espera" }
    : recojo
      ? { texto: "Sin cobro", tono: "ok" }
      : k.porConfirmar > 0
        ? { texto: `Falta ${money(k.total - k.confirmado)}`, tono: "espera" }
        : k.falta > 0
          ? {
              texto: k.alRecibir ? `Al recibir ${money(k.falta)}` : `Falta ${money(k.falta)}`,
              tono: "falta",
            }
          : { texto: "Pagado", tono: "ok" }
  const etapa: Etapa = p.rechazo
    ? p.rechazo.enTienda
      ? "en_tienda"
      : "vuelve_tienda"
    : recojo
    ? p.paso === "entregado"
      ? "recogido"
      : "por_recoger"
    : estado === "no_entregado"
      ? "no_entregado"
      : p.paso
  return {
    id: p.id,
    p,
    fecha,
    estado,
    etapa,
    boton,
    toca: (({ texto, persona }) => ({ texto: texto.replace(/\.\.+/g, "."), persona }))(
      tocaDe(p, estado, fecha, recojo),
    ),
    cobro,
    falta: k.falta,
    vuelto: vueltoDe(p),
    recojo,
  }
}

export function entregasDe(list: Pedido[]): Ent[] {
  const porId = new Map(list.map((p) => [p.id, p]))
  const out: Ent[] = []
  for (const p of list) {
    const orig = p.cambioDe && p.lineas.some((l) => l.vuelve) ? porId.get(p.cambioDe) : undefined
    const e = entregaDe(p, orig ? recojoDe(orig, p) : undefined)
    if (e) out.push(e)
    const r = paradaDeVuelta(p)
    if (r) out.push(r)
  }
  return out
}

/**
 * La parada de un caso de vuelta: mientras falta aprobarlo (con el botón de Pedidos: «Aprobar»,
 * «Decidir») o, si es un viaje solo para recoger, hasta que se recoge. Lo aprobado en el mismo
 * viaje ya va en el pedido de cambio enlazado.
 */
export function paradaDeVuelta(p: Pedido): Ent | null {
  const v = p.vuelta
  if (!v || !v.como.startsWith("recojo") || p.paso !== "entregado") return null
  const t = vueltaToca(p)
  const porAprobar = v.estado === "solicitado" && t
  const solo = v.como === "recojo_solo" && v.estado !== "solicitado" && v.estado !== "rechazado"
  if (!porAprobar && !solo) return null
  const hecho = ["recibido", "revisado", "cerrado"].includes(v.estado)
  const rep = v.repartidor ?? p.entrega.repartidor ?? "Kevin"
  const q: Pedido = {
    ...p,
    paso: hecho ? "entregado" : "por_salir",
    entrega: {
      ...p.entrega,
      tipo: "moto",
      dia: v.dia ?? "Vie 28",
      franja: v.franja ?? "2 a 6 p. m.",
      repartidor: rep,
    },
  }
  const fecha = fechaDe(q.entrega.dia)
  if (!fecha) return null
  const recojo = recojoDe(p)!
  return {
    id: `${p.id}-r`,
    p: q,
    fecha,
    estado: hecho ? "entregado" : "por_salir",
    etapa: hecho ? "recogido" : "por_recoger",
    boton: porAprobar ? { texto: t.boton, tipo: "vuelta" } : undefined,
    toca: porAprobar
      ? { texto: t.texto, persona: true }
      : hecho
        ? { texto: `${rep} lo recogió y trajo la foto.`, persona: false }
        : { texto: `Sigue solo: ${rep} lo recoge ${deFranja(q.entrega.franja)} y toma la foto.`, persona: false },
    cobro: recojo.devuelve
      ? { texto: `Devolver ${money(recojo.devuelve)}`, tono: "espera" }
      : { texto: "Sin cobro", tono: "ok" },
    falta: 0,
    vuelto: 0,
    recojo,
  }
}

/** Primero lo que no se entregó, después el orden del reparto: franja, zona y número. */
export function ordenar(list: Ent[]): Ent[] {
  const f = (e: Ent) => (e.p.entrega.franja ? FRANJAS.indexOf(e.p.entrega.franja as never) : 9)
  return [...list].sort(
    (a, b) =>
      Number(b.estado === "no_entregado") - Number(a.estado === "no_entregado") ||
      f(a) - f(b) ||
      a.p.entrega.zona.localeCompare(b.p.entrega.zona) ||
      a.p.id.localeCompare(b.p.id),
  )
}

/** Lo que necesita a una persona: con su único botón. */
export const necesita = (e: Ent) => !!e.boton

/** Cuántas lleva un repartidor en una franja de un día. */
export function ocupadas(list: Ent[], fecha: string, franja: string | null, rep: string | null) {
  return list.filter(
    (e) =>
      e.fecha === fecha &&
      e.p.entrega.franja === franja &&
      e.p.entrega.repartidor === rep &&
      e.estado !== "entregado",
  ).length
}

/** ¿Hay sitio en esa franja? Llena cuando todos los que salen ese día ya tienen su cupo. */
export function llena(list: Ent[], fecha: string, franja: string, faltas: Faltas) {
  const salen = REPARTIDORES.filter((r) => !(faltas[fecha] ?? []).includes(r))
  return salen.every((r) => ocupadas(list, fecha, franja, r) >= CUPO)
}

/** El efectivo que un repartidor cobró hoy y lo que le falta cobrar en la puerta. */
export function plataDe(list: Ent[], rep: string) {
  const hoy = list.filter((e) => e.fecha === HOY && e.p.entrega.repartidor === rep)
  const cobros = hoy
    .flatMap((e) => e.p.pagos)
    .filter((g) => g.estado === "confirmado" && g.quien === rep && g.cuando.startsWith("Hoy"))
  const de = (m: string[]) => cobros.filter((g) => m.includes(g.medio)).reduce((a, g) => a + g.monto, 0)
  const cobrado = de(["efectivo"])
  const porCobrar = hoy
    .filter((e) => e.estado !== "entregado" && !e.p.rechazo && e.p.cobro === "al_recibir")
    .reduce((a, e) => a + e.falta, 0)
  const vuelto = hoy.filter((e) => e.estado !== "entregado").reduce((a, e) => a + e.vuelto, 0)
  const cierre = CIERRE_DECLARADO[rep]
  return {
    /** El efectivo: lo que entrega a Caja. */
    cobrado,
    pos: de(["pos"]),
    yape: de(["yape", "plin"]),
    porCobrar,
    vuelto,
    /** Lo que dice que entrega al cerrar su día; si no declaró nada, lo que cobró. */
    entrega: cierre ? cobrado + cierre.delta : cobrado,
    motivo: cierre?.motivo,
    vuelven: hoy.filter((e) => e.p.rechazo && !e.p.rechazo.enTienda),
    entregas: hoy,
  }
}

export const foto = _foto
