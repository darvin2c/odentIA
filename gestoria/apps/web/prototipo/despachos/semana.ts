import { addDays, formatDateLong, formatDayShort, weekDates } from "@odentia/ui-patterns"
import { foto as _foto, RUBROS, type RubroId } from "../datos"
import {
  cuentas,
  type Linea,
  MAS_PEDIDOS,
  money,
  nuevoId,
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
    if (agencia)
      p.toca = {
        texto: "Sale hoy por Olva a Trujillo: falta el número de envío.",
        boton: "Anotar el N.º de Olva",
        accion: "asignar",
      }
    return p
  })
}
MAS_PEDIDOS.push(semana)

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

export interface Ent {
  p: Pedido
  fecha: string
  estado: Estado
  /** El único botón cuando necesita a una persona. */
  boton?: { texto: string; tipo: "listo" | "confirmar" | "asignar" | "numero" | "pasar" }
  /** «Pagado», «Falta S/ 169 · al recibir», «Pago por confirmar». */
  cobro: { texto: string; tono: "ok" | "falta" | "espera" }
  falta: number
}

export function entregaDe(p: Pedido): Ent | null {
  const fecha = fechaDe(p.entrega.dia)
  if (!fecha || p.paso === "anulado" || p.entrega.tipo === "recojo") return null
  const k = cuentas(p)
  let estado: Estado
  let boton: Ent["boton"]
  if (p.paso === "por_confirmar") {
    estado = "no_sale"
    boton = { texto: "Ver y confirmar", tipo: "confirmar" }
  } else if (p.paso === "por_pagar") estado = fecha === HOY ? "no_sale" : "espera_pago"
  else if (p.paso === "pagado") estado = "pagado"
  else if (p.paso === "preparando") {
    if (p.entrega.tipo === "agencia" && !p.entrega.numero) {
      estado = "agencia_numero"
      boton = { texto: "Anotar el N.º de Olva", tipo: "numero" }
    } else if (!p.entrega.repartidor && p.entrega.tipo !== "agencia") {
      estado = "sin_repartidor"
      boton = { texto: "Elegir cómo sale", tipo: "asignar" }
    } else {
      estado = "empacar"
      boton = {
        texto:
          p.entrega.tipo === "agencia"
            ? `Listo: lo dejé en ${p.entrega.agencia ?? "la agencia"}`
            : `Listo: se lo di a ${p.entrega.repartidor}`,
        tipo: "listo",
      }
    }
  } else if (p.paso === "por_salir") estado = p.noEntregado ? "no_entregado" : "por_salir"
  else if (p.paso === "en_camino") estado = "en_camino"
  else estado = "entregado"
  // Quedó en un feriado (se anotó antes de marcarlo): lo decide una persona.
  if (FERIADOS[fecha] && !boton && !["entregado", "en_camino"].includes(estado))
    boton = { texto: "Pasar a otro día", tipo: "pasar" }
  const cobro: Ent["cobro"] =
    k.porConfirmar > 0
      ? { texto: "Pago por confirmar", tono: "espera" }
      : k.falta > 0
        ? {
            texto: `Falta ${money(k.falta)}${k.alRecibir ? " · al recibir" : ""}`,
            tono: "falta",
          }
        : { texto: "Pagado", tono: "ok" }
  return { p, fecha, estado, boton, cobro, falta: k.falta }
}

export function entregasDe(list: Pedido[]): Ent[] {
  return list.map(entregaDe).filter((x): x is Ent => !!x)
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
  const cobrado = hoy
    .flatMap((e) => e.p.pagos)
    .filter(
      (g) =>
        g.estado === "confirmado" &&
        g.medio === "efectivo" &&
        g.quien === rep &&
        g.cuando.startsWith("Hoy"),
    )
    .reduce((a, g) => a + g.monto, 0)
  const porCobrar = hoy
    .filter((e) => e.estado !== "entregado" && e.p.cobro === "al_recibir")
    .reduce((a, e) => a + e.falta, 0)
  return { cobrado, porCobrar, entregas: hoy }
}

export const foto = _foto
