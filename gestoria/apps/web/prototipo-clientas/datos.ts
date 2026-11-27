import { RUBROS as BASE, type RubroId } from "../prototipo/datos"

/**
 * Los datos de ejemplo del prototipo de clientas y Argos: cinco tiendas, sus clientas y lo que
 * Argos anota, calcula y manda. Todo en memoria; las cifras salen de cuentas fijas, como en la app.
 */

export { foto } from "../prototipo/datos"
export type { RubroId }
export const RUBRO_IDS: RubroId[] = ["calzado", "ropa", "cosmetica", "tecnologia", "hogar"]

/** Perú, mensaje de promoción, desde el 1 de octubre de 2026 (la hoja de Meta en PEN). */
export const META = 0.2339

export interface Prod {
  name: string
  cat: string
  color: string
  pl: string
  photo: string
  price: number
  /** «Dura unos … días»: lo que se acaba y se vuelve a comprar. */
  dura?: number
}

export interface RubroC {
  label: string
  store: (typeof BASE)["calzado"]["store"]
  /** Cómo se llama lo que identifica su talla en este rubro. */
  field: string
  fit: (s: string) => string
  fitT: string
  sizes: string[]
  /** Lo que dijo en el chat cuando dudó entre dos. */
  cita: (a: string, b: string) => string
  gusto: [string, string]
  P: Prod[]
  nuevo: Prod
  extra: { name: string; price: number }
  liq: Prod & { before: number }
}

const p = (
  name: string,
  cat: string,
  color: string,
  pl: string,
  photo: string,
  price: number,
  dura?: number,
): Prod => ({ name, cat, color, pl, photo, price, dura })

export const RUBROS: Record<RubroId, RubroC> = {
  calzado: {
    label: "Calzado",
    store: BASE.calzado.store,
    field: "Talla de calzado",
    fit: (s) => `en talla ${s}`,
    fitT: "en su talla",
    sizes: ["35", "36", "37", "38", "39", "40"],
    cita: (a, b) => `calzo ${a}, a veces ${b}`,
    gusto: ["blancas y sin taco", "«algo blanco y sin taco, porfa»"],
    P: [
      p("Zapatilla de lona", "Zapatillas", "blanca", "blancas", "blanca1", 129),
      p("Zapatilla de lona", "Zapatillas", "negra", "negras", "negra1", 119),
      p("Mocasín", "Mocasines", "marrón", "marrones", "mocasin1", 159),
      p("Sandalia de tiras", "Sandalias", "dorada", "doradas", "dorada1", 89),
      p("Botín con pasador", "Botines", "negro", "negros", "botin2", 219),
      p("Bailarina", "Bailarinas", "blanca", "blancas", "bailarina2", 99),
    ],
    nuevo: p("Sandalia de plataforma", "Sandalias", "blanca", "blancas", "plataforma1", 139),
    extra: { name: "el limpiador de zapatillas", price: 19 },
    liq: { ...p("Botas de lluvia", "Botas", "fucsia", "fucsias", "lluvia1", 79), before: 119 },
  },
  ropa: {
    label: "Ropa",
    store: BASE.ropa.store,
    field: "Talla de ropa",
    fit: (s) => `en talla ${s}`,
    fitT: "en su talla",
    sizes: ["XS", "S", "M", "M", "L", "XL"],
    cita: (a, b) => `soy ${a}, a veces ${b}`,
    gusto: ["colores claros, de algodón", "«me gusta lo clarito y de algodón»"],
    P: [
      p("Polo piqué", "Polos", "azul", "azules", "polo_azul", 59),
      p("Polo piqué", "Polos", "negro", "negros", "polo_negro", 59),
      p("Jean recto", "Jeans", "celeste", "celestes", "jean1", 139),
      p("Vestido estampado", "Vestidos", "estampado", "estampados", "vestido1", 119),
      p("Polo piqué", "Polos", "coral", "corales", "polo_coral", 59),
      p("Jean recto", "Jeans", "azul", "azules", "jean2", 139),
    ],
    nuevo: p("Vestido de verano", "Vestidos", "floreado", "floreados", "vestido1", 129),
    extra: { name: "la correa de cuero", price: 45 },
    liq: { ...p("Jean recto", "Jeans", "azul", "azules", "jean2", 99), before: 139 },
  },
  cosmetica: {
    label: "Cosmética",
    store: BASE.cosmetica.store,
    field: "Tono de piel",
    fit: (s) => `en tono ${s}`,
    fitT: "en su tono",
    sizes: ["claro", "claro", "medio", "medio", "trigueño", "oscuro"],
    cita: (a, b) => `mi tono es ${a}, en verano ${b}`,
    gusto: ["acabado mate, tonos nude", "«me gusta mate, nada brillante»"],
    P: [
      p("Labial mate", "Labiales", "rojo", "rojos", "labial_rojo", 45),
      p("Labial mate", "Labiales", "nude", "nude", "labial_nude", 45),
      p("Base líquida", "Bases", "", "", "", 79, 45),
      p("Labial mate", "Labiales", "nude", "nude", "labial_nude", 45),
      p("Estuche de labiales", "Sets", "", "", "labial_estuche", 89),
      p("Desmaquillante bifásico", "Cuidado", "", "", "", 39, 60),
    ],
    nuevo: p("Labial líquido de larga duración", "Labiales", "cereza", "cereza", "labial_rojo", 55),
    extra: { name: "el delineador de labios", price: 29 },
    liq: { ...p("Estuche de labiales", "Sets", "", "", "labial_estuche", 59), before: 89 },
  },
  tecnologia: {
    label: "Tecnología",
    store: BASE.tecnologia.store,
    field: "Su celular",
    fit: (s) => `para tu ${s}`,
    fitT: "para su celular",
    sizes: ["iPhone 13", "Galaxy A54", "Redmi Note 13", "iPhone 15", "Galaxy A15", "Moto G84"],
    cita: (a, b) => `tengo un ${a}, y mi hija un ${b}`,
    gusto: ["inalámbrico y en negro", "«que sea inalámbrico, en negro»"],
    P: [
      p("Audífonos inalámbricos", "Audio", "negro", "negros", "audif1", 149),
      p("Funda de celular", "Fundas", "negra", "negras", "funda1", 39),
      p("Cargador rápido 20 W", "Cargadores", "", "", "", 59),
      p("Audífonos con estuche", "Audio", "blanco", "blancos", "audif2", 199),
      p("Audífonos de diadema", "Audio", "negro", "negros", "audif3", 249),
      p("Funda transparente", "Fundas", "", "", "funda1", 29),
    ],
    nuevo: p("Audífonos deportivos", "Audio", "negros", "negros", "audif3", 179),
    extra: { name: "el protector de pantalla", price: 25 },
    liq: { ...p("Funda de celular", "Fundas", "negra", "negras", "funda1", 19), before: 39 },
  },
  hogar: {
    label: "Hogar",
    store: BASE.hogar.store,
    field: "Estilo que le gusta",
    fit: (s) => `en estilo ${s}`,
    fitT: "a su estilo",
    sizes: ["nórdico", "rústico", "moderno", "nórdico", "boho", "clásico"],
    cita: (a, b) => `me gusta lo ${a}, o algo ${b}`,
    gusto: ["tonos tierra, telas naturales", "«nada de plástico, todo natural»"],
    P: [
      p("Cojín decorativo", "Cojines", "batik", "batik", "cojin1", 49),
      p("Lámpara de mesa", "Lámparas", "madera", "de madera", "lampara1", 129),
      p("Taza de cerámica", "Cocina", "blanca", "blancas", "taza1", 25),
      p("Manta tejida", "Mantas", "crema", "crema", "manta1", 119),
      p("Cojín decorativo", "Cojines", "batik", "batik", "cojin1", 49),
      p("Taza de cerámica", "Cocina", "blanca", "blancas", "taza1", 25),
    ],
    nuevo: p("Manta de lana", "Mantas", "gris", "grises", "manta1", 139),
    extra: { name: "la funda de cojín", price: 29 },
    liq: { ...p("Taza de cerámica", "Cocina", "blanca", "blancas", "taza1", 15), before: 25 },
  },
}

/* ------------------------------------------------------------------------- utilidades */

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
export const soles = (n: number) => {
  const c = Math.round(n * 100)
  const ent = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return c % 100 ? `S/ ${ent},${String(c % 100).padStart(2, "0")}` : `S/ ${ent}`
}
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"]
/** Hoy en el prototipo: viernes 27 de noviembre de 2026, en la hora de Lima. */
const HOY = Date.UTC(2026, 10, 27, 15, 0)
export const fecha = (d: number) => {
  const x = new Date(HOY - d * 864e5 - 5 * 36e5)
  return `${x.getUTCDate()} ${MES[x.getUTCMonth()]}${x.getUTCFullYear() !== 2026 ? ` ${x.getUTCFullYear()}` : ""}`
}
export const nombre = (c: { name: string }) => c.name.split(" ")[0] ?? c.name
export const cap = (x: string) => (x ? x[0]!.toUpperCase() + x.slice(1) : x)

/* --------------------------------------------------------------------------- grupos */

export type Seg = "vip" | "frecuente" | "nueva" | "riesgo" | "dormida" | "perdida" | "sin"
export const SEG: Record<Seg, { label: string; className: string; regla: string }> = {
  vip: {
    label: "VIP",
    className: "bg-[#f1e8ff] text-[#6d28d9] dark:bg-[#2e2148] dark:text-[#c4b5fd]",
    regla: "5 compras o más en el año, y compró en los últimos 90 días",
  },
  frecuente: {
    label: "Frecuente",
    className: "bg-success-soft text-success",
    regla: "2 compras o más, al día con su ritmo",
  },
  nueva: {
    label: "Nueva",
    className: "bg-[#e3ecff] text-[#1d4ed8] dark:bg-[#1c2a4a] dark:text-[#93b4ff]",
    regla: "Su primera compra, hace 90 días o menos",
  },
  riesgo: {
    label: "En riesgo",
    className: "bg-warning-soft text-warning",
    regla: "Ya pasó vez y media su ritmo (o 45 días) sin comprar",
  },
  dormida: {
    label: "Dormida",
    className: "bg-secondary text-secondary-foreground",
    regla: "Entre 91 días y un año sin comprar",
  },
  perdida: {
    label: "Perdida",
    className: "bg-danger-soft text-destructive",
    regla: "Más de un año sin comprar: Argos no le escribe",
  },
  sin: {
    label: "Sin compras",
    className: "border border-border text-muted-foreground",
    regla: "Preguntó, pero todavía no compra",
  },
}
export const SEG_IDS: Seg[] = ["vip", "frecuente", "nueva", "riesgo", "dormida", "perdida", "sin"]

/* ------------------------------------------------------------------------- clientas */

export type AccionId =
  | "cart"
  | "cruzada"
  | "recompra"
  | "cumple"
  | "vip"
  | "recuperar"
  | "despertar"
  | "nuevo"
  | "liq"
export type DatoKey = "talla" | "distrito" | "cumple" | "canal" | "ig" | "gustos"
export type Fuente = "chat" | "pedido" | "respuesta" | "equipo"

export interface Paso {
  cuando: string
  quien: string
  valor: string
  nota: string
}
export interface Dato {
  valor: string
  fuente: Fuente
  /** Lo que dijo, tal cual, cuando sale del chat. */
  cita?: string
  /** De dónde: «el chat del 20 nov», «el pedido 0156». */
  de: string
  cuando: string
  quien: string
  /** La tienda lo corrigió: Argos no lo vuelve a pisar. */
  fijo?: boolean
  /** Argos no lo tiene claro: usa el primero y lo marca «por confirmar». No frena nada. */
  dudas?: string[]
  hist: Paso[]
}
export interface Compra {
  d: number
  p: Prod
  size: string
  price: number
  reb: boolean
  liq: boolean
  /** La vendió Sofi por una campaña de Argos: cuál, por qué y el pedido. */
  argos?: AccionId
  motivo?: string
  pedido?: string
}

/** Lo que Sofi ya le escribió esta semana por encargo de Argos, y cómo terminó. */
export interface Semana {
  a: AccionId
  dia: string
  motivo: string
  res: "Compró" | "Respondió" | "Sin respuesta"
  conv: string
  v?: number
  pedido?: string
}
export interface Clienta {
  id: string
  name: string
  dist: string
  ch: ("wa" | "ig")[]
  phone: string
  ig?: string
  s: number
  buys: Compra[]
  delivered?: number
  cart?: { h: number; slot: number }
  consent: { estado: "si" | "nopreg" | "baja"; nota: string }
  lastH: number
  datos: Partial<Record<DatoKey, Dato>>
  asked: { d: number; text: string; why: string }[]
  hist: [number, AccionId, string, number?][]
  sentWeek?: AccionId
  semana?: Semana
  cumpleIn?: number
  tags: string[]
  /** La ficha que podría ser la misma clienta: Argos lo sugiere, lo decide una persona. */
  parecida?: string
  oculta?: boolean
}

type Seed = {
  id: string
  name: string
  dist: string
  ch: ("wa" | "ig")[]
  phone: string
  ig?: string
  s: number
  buys: [number, number, number?, number?][]
  delivered?: number
  cart?: { h: number; slot: number }
  consent: Clienta["consent"]
  lastH: number
  asked?: [number, number][]
  hist?: [number, AccionId, string, number?][]
  sentWeek?: AccionId
  /** Lo que Sofi le escribió esta semana por encargo de Argos; `compra`, el pedido que salió. */
  semana?: Omit<Semana, "motivo" | "conv"> & {
    motivo: (R: RubroC, size: string) => string
    conv: (R: RubroC, size: string) => string
    compra?: { d: number; slot: number | "nuevo" | "extra"; price?: number }
  }
  cumpleIn?: number
  cumple?: string
  tags?: string[]
  parecida?: string
}

const SEEDS: Seed[] = [
  {
    id: "c1",
    name: "Mariela Ríos",
    dist: "Surco",
    ch: ["wa"],
    phone: "987 654 321",
    s: 3,
    buys: [
      [12, 0],
      [48, 4],
      [83, 3],
      [125, 2],
      [180, 0],
      [236, 4],
    ],
    consent: { estado: "si", nota: "Dijo «sí, avísame» en el chat del 10 oct" },
    lastH: 30,
    hist: [
      [45, "cruzada", "Compró", 25],
      [99, "nuevo", "Respondió"],
      [152, "vip", "Compró", 219],
    ],
    cumple: "15 de diciembre",
    tags: ["Compra para regalar"],
    parecida: "c17",
  },
  {
    id: "c2",
    name: "Valeria Soto",
    dist: "Surco",
    ch: ["wa"],
    phone: "955 210 778",
    s: 3,
    buys: [
      [9, 0, 1],
      [44, 0, 1],
      [83, 0, 1],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra (2 set)" },
    lastH: 200,
    asked: [[24, 4]],
    hist: [
      [60, "liq", "Compró", 99],
      [30, "nuevo", "Sin respuesta"],
    ],
  },
  {
    id: "c3",
    name: "Andrea Castillo",
    dist: "San Isidro",
    ch: ["wa", "ig"],
    phone: "912 004 551",
    ig: "@andre.castillo",
    s: 2,
    buys: [
      [62, 0],
      [102, 0],
      [142, 0],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra (16 jul)" },
    lastH: 900,
    tags: ["Oficina en San Isidro"],
  },
  {
    id: "c4",
    name: "Diana Flores",
    dist: "Miraflores",
    ch: ["wa"],
    phone: "944 118 230",
    s: 2,
    buys: [
      [70, 1],
      [100, 0],
      [130, 2],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 20 jul" },
    lastH: 900,
    hist: [[75, "cruzada", "Sin respuesta"]],
  },
  {
    id: "c5",
    name: "Rocío Vega",
    dist: "Surco",
    ch: ["wa"],
    phone: "933 551 209",
    s: 2,
    buys: [
      [140, 3],
      [200, 3],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 8 may" },
    lastH: 72,
    sentWeek: "despertar",
  },
  {
    id: "c6",
    name: "Carla Mendoza",
    dist: "Callao",
    ch: ["wa"],
    phone: "966 300 441",
    s: 4,
    buys: [[400, 1]],
    consent: { estado: "si", nota: "Aceptó en 2025" },
    lastH: 9000,
    hist: [[300, "recuperar", "Sin respuesta"]],
  },
  {
    id: "c7",
    name: "Lucero Torres",
    dist: "Miraflores",
    ch: ["wa", "ig"],
    phone: "987 220 114",
    ig: "@lucero.t",
    s: 2,
    buys: [
      [20, 5],
      [55, 0],
    ],
    cart: { h: 3, slot: 1 },
    consent: { estado: "si", nota: "Aceptó en su primera compra" },
    lastH: 3,
    hist: [[19, "cruzada", "Respondió"]],
  },
  {
    id: "c8",
    name: "Fiorella Quispe",
    dist: "Los Olivos",
    ch: ["wa"],
    phone: "977 019 332",
    s: 1,
    buys: [
      [25, 3],
      [60, 3],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra" },
    lastH: 72,
    sentWeek: "nuevo",
  },
  {
    id: "c9",
    name: "Milagros Huamán",
    dist: "Surco",
    ch: ["wa"],
    phone: "921 667 808",
    s: 4,
    buys: [
      [30, 0],
      [38, 2],
      [90, 4],
      [150, 0],
      [210, 5],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 3 jun" },
    lastH: 400,
    hist: [
      [31, "vip", "Compró", 129],
      [91, "nuevo", "Compró", 219],
    ],
    tags: ["Recomienda a sus amigas"],
  },
  {
    id: "c10",
    name: "Jimena Paredes",
    dist: "San Miguel",
    ch: ["wa"],
    phone: "913 448 120",
    s: 2,
    buys: [],
    asked: [[2, 3]],
    consent: {
      estado: "nopreg",
      nota: "Todavía no compra: Sofi se lo pregunta en su primera compra",
    },
    lastH: 40,
  },
  {
    id: "c11",
    name: "Paola Chávez",
    dist: "Comas",
    ch: ["wa"],
    phone: "990 245 773",
    s: 1,
    buys: [
      [65, 0, 0, 1],
      [95, 1, 0, 1],
      [125, 5],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 1 ago" },
    lastH: 1500,
    hist: [[66, "liq", "Compró", 79]],
  },
  {
    id: "c12",
    name: "Gabriela Rojas",
    dist: "La Molina",
    ch: ["wa"],
    phone: "958 776 102",
    s: 4,
    buys: [
      [30, 1],
      [70, 0],
    ],
    cumpleIn: 2,
    cumple: "29 de noviembre",
    consent: { estado: "si", nota: "Aceptó en el chat del 14 set" },
    lastH: 700,
  },
  {
    id: "c13",
    name: "Sandra Llanos",
    dist: "Lince",
    ch: ["ig"],
    phone: "",
    ig: "@sandrall",
    s: 3,
    buys: [[160, 0]],
    consent: { estado: "si", nota: "Aceptó en el chat de Instagram" },
    lastH: 3800,
  },
  {
    id: "c14",
    name: "Karen Salazar",
    dist: "Breña",
    ch: ["wa"],
    phone: "940 202 377",
    s: 0,
    buys: [[20, 5]],
    consent: { estado: "nopreg", nota: "Compró anotada por el equipo: nadie le preguntó todavía" },
    lastH: 470,
  },
  {
    id: "c15",
    name: "Patricia Núñez",
    dist: "Surco",
    ch: ["wa"],
    phone: "981 330 554",
    s: 3,
    buys: [
      [18, 3],
      [52, 3],
      [88, 0],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra" },
    lastH: 350,
    hist: [[53, "nuevo", "Compró", 89]],
  },
  {
    id: "c16",
    name: "Rosa María Díaz",
    dist: "Chorrillos",
    ch: ["wa"],
    phone: "962 870 115",
    s: 5,
    buys: [
      [6, 1, 0, 1],
      [47, 5, 1],
      [80, 0, 0, 1],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 30 jul" },
    lastH: 260,
    delivered: 4,
    hist: [[16, "liq", "Compró", 79]],
  },
  {
    id: "c18",
    name: "Natalia Gómez",
    dist: "Surco",
    ch: ["wa"],
    phone: "984 112 650",
    s: 3,
    buys: [
      [9, 0],
      [40, 0],
      [75, 0],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra" },
    lastH: 70,
    sentWeek: "cruzada",
    semana: {
      a: "cruzada",
      dia: "Mar 24",
      res: "Compró",
      pedido: "0158",
      motivo: (R) => `recibió su ${R.P[0]!.name.toLowerCase()} el sábado`,
      conv: (R) =>
        `Preguntó cómo se usa ${R.extra.name}; Sofi se lo explicó y lo sumó a su próximo envío.`,
      compra: { d: 3, slot: "extra" },
    },
  },
  {
    id: "c19",
    name: "Cecilia Ramos",
    dist: "Miraflores",
    ch: ["wa"],
    phone: "945 330 187",
    s: 2,
    buys: [
      [120, 3],
      [180, 3],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 2 jun" },
    lastH: 90,
    sentWeek: "despertar",
    semana: {
      a: "despertar",
      dia: "Lun 23",
      res: "Respondió",
      motivo: (R, size) =>
        `no compra hace 120 días y compraba ${R.P[3]!.cat.toLowerCase()} ${size} · dormida`,
      conv: () =>
        "Pidió fotos; Sofi le mandó dos y le ofreció la rebaja con plazo. Dijo «lo pienso» y Sofi no insistió.",
    },
  },
  {
    id: "c20",
    name: "Lorena Vargas",
    dist: "San Borja",
    ch: ["wa"],
    phone: "967 554 031",
    s: 4,
    buys: [
      [75, 0],
      [115, 0],
    ],
    consent: { estado: "si", nota: "Aceptó en el chat del 12 ago" },
    lastH: 90,
    sentWeek: "recuperar",
    semana: {
      a: "recuperar",
      dia: "Lun 23",
      res: "Compró",
      pedido: "0159",
      motivo: (R) =>
        `compró ${R.P[0]!.cat.toLowerCase()} ${R.P[0]!.pl} hace 71 días y su ritmo es cada 40 · en riesgo`,
      conv: (R, size) =>
        `Respondió «sí, mándame»; Sofi le mostró ${R.nuevo.name.toLowerCase()} ${R.fit(size)} y le dejó la rebaja pagando ese día. Pagó por link.`,
      compra: { d: 4, slot: "nuevo", price: -10 },
    },
  },
  {
    id: "c21",
    name: "Daniela Cruz",
    dist: "Lince",
    ch: ["wa"],
    phone: "952 008 413",
    s: 1,
    buys: [
      [28, 3],
      [64, 3],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra" },
    lastH: 400,
    sentWeek: "nuevo",
    semana: {
      a: "nuevo",
      dia: "Mar 24",
      res: "Sin respuesta",
      motivo: (R, size) =>
        `compró ${R.P[3]!.cat.toLowerCase()} 2 veces y llegó ${R.nuevo.name.toLowerCase()} ${R.fit(size)}`,
      conv: () => "No respondió. Sofi no volvió a escribir: la campaña cierra sola el domingo.",
    },
  },
  {
    id: "c22",
    name: "Teresa Huerta",
    dist: "Barranco",
    ch: ["wa"],
    phone: "936 771 205",
    s: 3,
    buys: [
      [30, 0],
      [70, 5],
    ],
    consent: { estado: "si", nota: "Aceptó en su primera compra" },
    lastH: 50,
    sentWeek: "cart",
    semana: {
      a: "cart",
      dia: "Mié 25",
      res: "Compró",
      pedido: "0160",
      motivo: (R, size) =>
        `dejó en su carrito ${R.P[1]!.name.toLowerCase()} ${R.P[1]!.color} ${size} hace 3 horas`,
      conv: () => "Volvió al carrito desde el mensaje de Sofi y tocó «Pagar ahora».",
      compra: { d: 2, slot: 1 },
    },
  },
  {
    id: "c17",
    name: "Mariela Ríos",
    dist: "Surco",
    ch: ["ig"],
    phone: "",
    ig: "@mariela.r",
    s: 3,
    buys: [[98, 0]],
    consent: { estado: "nopreg", nota: "Escribió solo por Instagram" },
    lastH: 2300,
    parecida: "c1",
  },
]

const paso = (cuando: string, quien: string, valor: string, nota: string): Paso => ({
  cuando,
  quien,
  valor,
  nota,
})

/** Lo que Argos anotó de cada clienta: de sus pedidos y de lo que dijo en el chat. */
function datosDe(sd: Seed, R: RubroC, buys: Compra[]): Clienta["datos"] {
  const size = R.sizes[sd.s] ?? R.sizes[0]!
  const last = buys[0]
  const d: Clienta["datos"] = {}
  if (last) {
    d.talla = {
      valor: size,
      fuente: "pedido",
      de: `sus ${plural(buys.length, "compra", "compras")}`,
      cuando: fecha(last.d),
      quien: "Argos",
      hist: [paso(fecha(last.d), "Argos", size, "De sus compras")],
    }
    d.distrito = {
      valor: sd.dist,
      fuente: "pedido",
      de: `la entrega del ${fecha(last.d)}`,
      cuando: fecha(last.d),
      quien: "Argos",
      hist: [paso(fecha(last.d), "Argos", sd.dist, "De la dirección de entrega")],
    }
  }
  d.canal = {
    valor: sd.ch[0] === "ig" ? "Instagram" : "WhatsApp",
    fuente: "respuesta",
    de: "por donde escribe y responde",
    cuando: "27 nov",
    quien: "Argos",
    hist: [
      paso("27 nov", "Argos", sd.ch[0] === "ig" ? "Instagram" : "WhatsApp", "Por donde responde"),
    ],
  }
  if (sd.ig)
    d.ig = {
      valor: sd.ig,
      fuente: "chat",
      de: "su perfil de Instagram",
      cuando: fecha(last?.d ?? 30),
      quien: "Argos",
      hist: [paso(fecha(last?.d ?? 30), "Argos", sd.ig, "Llegó por Instagram")],
    }
  if (sd.cumple && sd.id === "c12")
    d.cumple = {
      valor: sd.cumple,
      fuente: "respuesta",
      cita: "el 29 de noviembre 🎂",
      de: "su respuesta del 14 set",
      cuando: "14 set",
      quien: "Argos",
      hist: [paso("14 set", "Argos", sd.cumple, "Respondió a «¿cuándo es tu cumple?»")],
    }
  if (sd.id === "c1") {
    const a = R.sizes[3]!
    const b = R.sizes[4]!
    d.talla = {
      valor: a,
      fuente: "chat",
      cita: R.cita(a, b),
      de: "el chat del 20 nov",
      cuando: "20 nov",
      quien: "Argos",
      dudas: [a, b],
      hist: [
        paso("20 nov", "Argos", a, `Del chat: «${R.cita(a, b)}». Usa ${a}, la que más compra`),
        paso(fecha(236), "Argos", a, "De sus compras"),
      ],
    }
    d.cumple = {
      valor: "15 de diciembre",
      fuente: "chat",
      cita: "es para mi cumple, el 15 de dic",
      de: "el chat del 20 nov",
      cuando: "20 nov",
      quien: "Argos",
      hist: [
        paso("20 nov", "Argos", "15 de diciembre", "Del chat: «es para mi cumple, el 15 de dic»"),
      ],
    }
    d.gustos = {
      valor: R.gusto[0],
      fuente: "chat",
      cita: R.gusto[1].replace(/[«»]/g, ""),
      de: "el chat del 3 nov",
      cuando: "3 nov",
      quien: "Argos",
      hist: [paso("3 nov", "Argos", R.gusto[0], `Del chat: ${R.gusto[1]}`)],
    }
  }
  if (sd.id === "c2")
    d.talla = {
      valor: size,
      fuente: "chat",
      cita: `¿hay en ${size}?`,
      de: "el chat del 3 nov",
      cuando: "3 nov",
      quien: "Argos",
      hist: [paso("3 nov", "Argos", size, `Del chat: «¿hay en ${size}?»`)],
    }
  if (sd.id === "c3")
    d.distrito = {
      valor: "San Isidro, su oficina",
      fuente: "equipo",
      de: "Lucía lo corrigió",
      cuando: "22 nov",
      quien: "Lucía Torres",
      fijo: true,
      hist: [
        paso(
          "22 nov",
          "Lucía Torres",
          "San Isidro, su oficina",
          "Lo corrigió: recibe en su oficina",
        ),
        paso("21 nov", "Argos", "Lince", "De la dirección del pedido 0147"),
      ],
    }
  if (sd.id === "c10")
    d.talla = {
      valor: size,
      fuente: "chat",
      cita: `¿hay en ${size}?`,
      de: "el chat del martes",
      cuando: "25 nov",
      quien: "Argos",
      hist: [paso("25 nov", "Argos", size, `Del chat: «¿hay en ${size}?»`)],
    }
  return d
}

export function clientasDe(r: RubroId): Clienta[] {
  const R = RUBROS[r]
  return SEEDS.map((sd) => {
    const size = R.sizes[sd.s] ?? R.sizes[0]!
    const buys: Compra[] = sd.buys.map(([d, slot, reb, liq]) => {
      const pr = R.P[slot]!
      return {
        d,
        p: pr,
        size,
        price: Math.round(pr.price * (reb ? 0.88 : liq ? 0.7 : 1)),
        reb: !!reb,
        liq: !!liq,
      }
    })
    const sem = sd.semana
    if (sem?.compra) {
      const cp = sem.compra
      const pr =
        cp.slot === "nuevo"
          ? R.nuevo
          : cp.slot === "extra"
            ? p(
                cap(R.extra.name.replace(/^(el|la|los|las) /, "")),
                "Cuidado",
                "",
                "",
                "",
                R.extra.price,
              )
            : R.P[cp.slot]!
      buys.unshift({
        d: cp.d,
        p: pr,
        size,
        price: pr.price + (cp.price ?? 0),
        reb: (cp.price ?? 0) < 0,
        liq: false,
        argos: sem.a,
        motivo: sem.motivo(R, size),
        pedido: sem.pedido,
      })
    }
    return {
      id: sd.id,
      name: sd.name,
      dist: sd.dist,
      ch: sd.ch,
      phone: sd.phone,
      ig: sd.ig,
      s: sd.s,
      buys,
      delivered: sd.delivered,
      cart: sd.cart,
      consent: { ...sd.consent },
      lastH: sd.lastH,
      datos: datosDe(sd, R, buys),
      asked: (sd.asked ?? []).map(([d, slot]) => {
        const pr = R.P[slot]!
        return {
          d,
          text: `${pr.name}${pr.color ? ` ${pr.color}` : ""} ${size}`,
          why: slot === 4 ? "estaba agotado" : "no cerró",
        }
      }),
      hist: sd.hist ?? [],
      sentWeek: sd.sentWeek,
      semana: sem
        ? {
            a: sem.a,
            dia: sem.dia,
            res: sem.res,
            pedido: sem.pedido,
            motivo: sem.motivo(R, size),
            conv: sem.conv(R, size),
            v: buys.find((b) => b.pedido && b.pedido === sem.pedido)?.price,
          }
        : undefined,
      cumpleIn: sd.cumpleIn,
      tags: sd.tags ?? [],
      parecida: sd.parecida,
    }
  })
}

/* ------------------------------------------------------------- lo que Argos calcula */

export interface Perfil {
  n: number
  total: number
  avg: number
  last: number | null
  ritmo: number | null
  seg: Seg
  why: string
  cats: [string, number][]
  colors: [string, number][]
  sizes: [string, number][]
  sens: string
  sensWhy: string
}

export function perfil(c: Clienta): Perfil {
  const b = [...c.buys].sort((x, y) => x.d - y.d)
  const n = b.length
  const o: Perfil = {
    n,
    total: 0,
    avg: 0,
    last: null,
    ritmo: null,
    seg: "sin",
    why: "Todavía no compra: solo preguntó.",
    cats: [],
    colors: [],
    sizes: [],
    sens: "",
    sensWhy: "",
  }
  if (!n) return o
  o.total = b.reduce((s, x) => s + x.price, 0)
  o.avg = o.total / n
  const last = b[0]!.d
  o.last = last
  const first = b[n - 1]!.d
  o.ritmo = n > 1 ? Math.round((first - last) / (n - 1)) : null
  const yr = b.filter((x) => x.d <= 365)
  const yt = yr.reduce((s, x) => s + x.price, 0)
  if (last > 365) {
    o.seg = "perdida"
    o.why = `No compra hace ${last} días, más de un año.`
  } else if (last > 90) {
    o.seg = "dormida"
    o.why = `${last} días sin comprar (más de 90).`
  } else if (yr.length >= 5) {
    o.seg = "vip"
    o.why = `${yr.length} compras, ${soles(yt)} en ${Math.max(1, Math.round(first / 30))} meses.`
  } else if (n >= 2 && last > Math.max(45, 1.5 * (o.ritmo ?? 0))) {
    o.seg = "riesgo"
    o.why = `Compraba cada ${o.ritmo} días y ya van ${last}.`
  } else if (n >= 2) {
    o.seg = "frecuente"
    o.why = `${n} compras, una cada ${o.ritmo} días.`
  } else {
    o.seg = "nueva"
    o.why =
      last === 0
        ? "Su primera compra fue hoy."
        : `Su primera compra fue hace ${last} ${last === 1 ? "día" : "días"}.`
  }
  const count = (f: (x: Compra) => string) => {
    const m = new Map<string, number>()
    for (const x of b) {
      const k = f(x)
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, z) => z[1] - a[1])
  }
  o.cats = count((x) => x.p.cat)
  o.colors = count((x) => x.p.color)
  o.sizes = count((x) => x.size)
  const reb = b.filter((x) => x.reb).length
  const liq = b.filter((x) => x.liq).length
  if (n >= 2 && (reb + liq) / n >= 0.5) {
    o.sens = reb >= liq ? "pide rebaja" : "compra en liquidación"
    o.sensWhy = `${reb + liq} de ${n} compras ${reb >= liq ? "con rebaja" : "en liquidación"}`
  }
  return o
}

export function quienEs(c: Clienta, k: Perfil, R: RubroC): string {
  if (!k.n)
    return `${SEG.sin.label} · preguntó por ${c.asked[0]?.text.toLowerCase() ?? "algo"} · ${c.dist}`
  const cat = k.cats[0]![0]
  const col = c.buys
    .filter((x) => x.p.cat === cat)
    .map((x) => x.p.pl)
    .filter(Boolean)[0]
  const size = c.datos.talla?.valor ?? k.sizes[0]?.[0]
  return [
    SEG[k.seg].label,
    `compra ${cat.toLowerCase()}${col ? ` ${col}` : ""}${size ? ` ${R.fit(size).replace("para tu", "para")}` : ""}`,
    c.datos.distrito?.valor.split(",")[0] ?? c.dist,
    k.sens,
  ]
    .filter(Boolean)
    .join(" · ")
}

/* ---------------------------------------------------------------- lo que Argos hace */

export interface Accion {
  id: AccionId
  t: (R: RubroC) => string
  who: (R: RubroC) => string
  when: string
  tpl: string | null
}
export const ACCIONES: Accion[] = [
  {
    id: "cart",
    t: () => "Carrito sin pagar",
    who: () => "Dejó su carrito sin pagar hace menos de 24 horas",
    when: "hoy, 13:00",
    tpl: null,
  },
  {
    id: "cruzada",
    t: () => "Lo que combina, después de la entrega",
    who: () => "Recibió su pedido hace 2 a 7 días",
    when: "hoy, 11:00",
    tpl: "¿Te llegó bien?",
  },
  {
    id: "recompra",
    t: () => "Recompra de lo que se acaba",
    who: () => "Lo que compró dura unos días y ya se le acaba",
    when: "mañana, 10:00",
    tpl: "Se te está acabando",
  },
  {
    id: "cumple",
    t: () => "Cumpleaños",
    who: () => "Cumple esta semana",
    when: "el día de su cumpleaños, 10:00",
    tpl: "Feliz cumpleaños",
  },
  {
    id: "vip",
    t: () => "Adelanto para VIP",
    who: () => "VIP: la liquidación un día antes",
    when: "hoy, 17:00",
    tpl: "Antes que nadie",
  },
  {
    id: "recuperar",
    t: () => "Recuperar en riesgo",
    who: () => "En riesgo: ya pasó su ritmo de compra",
    when: "hoy, 16:00",
    tpl: "Llegó algo para ti",
  },
  {
    id: "despertar",
    t: () => "Despertar a las dormidas",
    who: () => "Dormidas: más de 90 días sin comprar",
    when: "hoy, 16:30",
    tpl: "Volvió algo para ti",
  },
  {
    id: "nuevo",
    t: (R) => `Lo nuevo, ${R.fitT}`,
    who: (R) => `Compra ${R.nuevo.cat.toLowerCase()} y llegó ${R.nuevo.name.toLowerCase()}`,
    when: "hoy, 16:00",
    tpl: "Llegó algo nuevo",
  },
  {
    id: "liq",
    t: () => "Liquidación, a las que buscan precio",
    who: () => "Pide rebaja o compra en liquidación",
    when: "sábado 28, 10:00",
    tpl: "Liquidación",
  },
]
export const ACC = Object.fromEntries(ACCIONES.map((a) => [a.id, a])) as Record<AccionId, Accion>

/**
 * Lo que pasó en las últimas 4 semanas (ejemplo), con lo de esta semana: recibieron, de esos los
 * que cobró Meta, respondieron, conversaron con Sofi, compraron, vendido y bajas.
 */
export const HIST: Record<AccionId, [number, number, number, number, number, number, number]> = {
  cart: [11, 0, 7, 6, 5, 640, 0],
  cruzada: [18, 12, 8, 6, 5, 140, 0],
  recompra: [9, 6, 6, 5, 4, 316, 0],
  cumple: [3, 3, 2, 2, 1, 129, 0],
  vip: [6, 6, 4, 4, 3, 610, 0],
  recuperar: [8, 8, 4, 3, 2, 258, 0],
  despertar: [6, 6, 2, 2, 1, 129, 0],
  nuevo: [22, 20, 9, 7, 4, 520, 1],
  liq: [15, 15, 5, 4, 3, 237, 1],
}

export function bloqueo(c: Clienta, k: Perfil): string {
  if (c.consent.estado === "baja") return "Pidió que no le escriban"
  if (c.consent.estado !== "si") return "No aceptó promociones todavía"
  if (!c.ch.includes("wa"))
    return "Solo escribió por Instagram: ahí no se le puede escribir primero"
  if (k.seg === "perdida") return "Más de un año sin comprar: escribirle arriesga tu número en Meta"
  return ""
}

function entra(a: AccionId, c: Clienta, k: Perfil, R: RubroC): boolean {
  if (a === "cart") return !!c.cart && c.cart.h < 24
  if (a === "cruzada") return c.delivered != null && c.delivered >= 2 && c.delivered <= 7
  if (a === "recompra")
    return c.buys.some((x) => x.p.dura && x.d >= x.p.dura - 10 && x.d <= x.p.dura + 15)
  if (a === "cumple") return !!c.datos.cumple && c.cumpleIn != null && c.cumpleIn <= 6
  if (a === "vip") return k.seg === "vip"
  if (a === "recuperar") return k.seg === "riesgo"
  if (a === "despertar") return k.seg === "dormida"
  if (a === "nuevo") return c.buys.some((x) => x.p.cat === R.nuevo.cat)
  return !!k.sens
}

export function mensaje(a: AccionId, c: Clienta, R: RubroC): string {
  const n = nombre(c)
  const st = R.store.name
  const size = c.datos.talla?.valor ?? c.buys[0]?.size ?? R.sizes[c.s] ?? ""
  const fit = R.fit(size)
  if (a === "cart") {
    const pr = R.P[c.cart?.slot ?? 0]!
    return `Hola, ${n}. Tu carrito sigue aquí: ${pr.name.toLowerCase()} ${pr.color} ${fit.replace("para tu", "para")}, ${soles(pr.price)}. El precio vale hasta hoy a las 18:40. ¿Te ayudo a terminar?`
  }
  if (a === "cruzada") {
    const pr = c.buys[0]?.p ?? R.P[0]!
    return `Hola, ${n}. ¿Te llegó bien tu ${pr.name.toLowerCase()}? Va muy bien con ${R.extra.name} (${soles(R.extra.price)}). ¿Te lo mando con tu próximo pedido?`
  }
  if (a === "recompra") {
    const x = c.buys.find((b) => b.p.dura)
    return x
      ? `Hola, ${n}. Tu ${x.p.name.toLowerCase()} ya debe estar por acabarse: la compraste hace ${x.d} días. ¿Te mando otra? Cuesta ${soles(x.p.price)}.`
      : ""
  }
  if (a === "cumple")
    return `¡Feliz cumpleaños, ${n}! Esta semana tu envío va gratis en ${st}. ¿Te muestro lo nuevo?`
  if (a === "vip")
    return `Hola, ${n}. Por ser de nuestras mejores clientas, la liquidación empieza para ti un día antes: ${R.liq.name.toLowerCase()} a ${soles(R.liq.price)} (antes ${soles(R.liq.before)}). ¿Te lo separo ${fit}?`
  if (a === "recuperar") {
    const top = c.buys[0]?.p ?? R.P[0]!
    return `Hola, ${n}. ¿Qué tal tus ${top.cat.toLowerCase()}? Llegó ${R.nuevo.name.toLowerCase()} ${R.nuevo.color} y hay ${fit}. ¿Te mando fotos?`
  }
  if (a === "despertar")
    return `Hola, ${n}. Hace tiempo no te vemos por ${st}. Llegó ${R.nuevo.name.toLowerCase()} ${R.nuevo.color} y hay ${fit}. ¿Te mando fotos?`
  if (a === "nuevo")
    return `Hola, ${n}. Llegó ${R.nuevo.name.toLowerCase()} ${R.nuevo.color}, ${fit}. Cuesta ${soles(R.nuevo.price)}. ¿Te mando fotos?`
  return `Hola, ${n}. Empezó la liquidación: ${R.liq.name.toLowerCase()} a ${soles(R.liq.price)} (antes ${soles(R.liq.before)}), ${fit}, hasta el domingo. ¿Te lo separo?`
}

export const costo = (c: Clienta) => (c.lastH < 24 ? 0 : META)

export interface Envio {
  c: Clienta
  k: Perfil
  text: string
  cost: number
  /** Sale solo; espera el sí por pasar el presupuesto; espera el permiso que pidió la tienda. */
  estado: "sale" | "presupuesto" | "permiso"
}
export interface PlanAccion {
  to: Envio[]
  out: { c: Clienta; why: string }[]
  cost: number
  est: number
  rate: number
  sentWeek: Clienta[]
}

export interface Reglas {
  pausa: Partial<Record<AccionId, boolean>>
  permiso: Partial<Record<AccionId, boolean>>
  ok: Partial<Record<AccionId, boolean>>
  skip: Partial<Record<AccionId, string[]>>
  budget: number
  used: number
  budgetOk: boolean
  tope: number
}

/**
 * Lo que Argos hará esta semana: cada clienta entra en el primer trabajo que le toca (el orden de
 * `ACCIONES`), dentro del tope; lo que pasa el presupuesto de Meta espera el sí de una persona.
 */
export function planDe(cl: Clienta[], R: RubroC, g: Reglas): Record<AccionId, PlanAccion> {
  const out = Object.fromEntries(
    ACCIONES.map((a) => [
      a.id,
      { to: [], out: [], cost: 0, est: 0, rate: 0, sentWeek: [] } as PlanAccion,
    ]),
  ) as Record<AccionId, PlanAccion>
  const count: Record<string, number> = {}
  const got: Record<string, string> = {}
  for (const c of cl)
    if (c.sentWeek) {
      count[c.id] = 1
      got[c.id] = ACC[c.sentWeek].t(R)
    }
  let gasto = g.used
  for (const a of ACCIONES) {
    for (const c of cl) {
      if (c.oculta) continue
      const k = perfil(c)
      if (!entra(a.id, c, k, R)) continue
      const bl = bloqueo(c, k)
      if (bl) {
        out[a.id].out.push({ c, why: bl })
        continue
      }
      if (c.sentWeek === a.id) continue
      if ((count[c.id] ?? 0) >= g.tope) {
        out[a.id].out.push({ c, why: `Tope: ya recibe «${got[c.id]}» esta semana` })
        continue
      }
      if ((g.skip[a.id] ?? []).includes(c.id)) {
        out[a.id].out.push({ c, why: "La quitaste tú" })
        continue
      }
      const text = mensaje(a.id, c, R)
      if (!text) continue
      count[c.id] = (count[c.id] ?? 0) + 1
      got[c.id] = a.t(R)
      const cost = costo(c)
      let estado: Envio["estado"] = "sale"
      if (g.permiso[a.id] && !g.ok[a.id]) estado = "permiso"
      else if (!g.pausa[a.id] && cost) {
        if (gasto + cost > g.budget && !g.budgetOk) estado = "presupuesto"
        else gasto += cost
      }
      out[a.id].to.push({ c, k, text, cost, estado })
    }
  }
  for (const a of ACCIONES) {
    const pl = out[a.id]
    const h = HIST[a.id]
    pl.rate = h[0] ? h[3] / h[0] : 0
    pl.cost = pl.to.reduce((s, x) => s + x.cost, 0)
    pl.est = pl.to.reduce((s, x) => s + x.k.avg * pl.rate, 0)
    pl.sentWeek = cl.filter((c) => c.sentWeek === a.id)
  }
  return out
}

/* ----------------------------------------------------- el encargo de Argos a Sofi */

/** Lo que Argos le pasa a Sofi para cada clienta: con eso, Sofi escribe, conversa y vende. */
export interface Encargo {
  campana: string
  para: string
  porque: string
  ofrecer: string
  plazo: string
  noHacer: string[]
}

/** El precio más bajo que Sofi puede dar: el mínimo que dejó la tienda en el catálogo. */
export const minimo = (price: number) => Math.round(price * 0.93)

/** Por qué le toca esta campaña, con su dato. */
export function motivoDe(a: AccionId, c: Clienta, R: RubroC): string {
  const k = perfil(c)
  const size = c.datos.talla?.valor ?? k.sizes[0]?.[0] ?? ""
  const top = c.buys[0]
  const cat = (k.cats[0]?.[0] ?? "").toLowerCase()
  if (a === "cart") {
    const pr = R.P[c.cart?.slot ?? 0]!
    return `dejó en su carrito ${pr.name.toLowerCase()} ${pr.color} ${size} hace ${c.cart?.h ?? 0} horas`
  }
  if (a === "cruzada")
    return `recibió su ${top?.p.name.toLowerCase() ?? "pedido"} hace ${c.delivered ?? 0} días`
  if (a === "recompra") {
    const x = c.buys.find((b) => b.p.dura)
    return x ? `compró ${x.p.name.toLowerCase()} hace ${x.d} días y dura unos ${x.p.dura}` : ""
  }
  if (a === "cumple") return `cumple el ${c.datos.cumple?.valor ?? ""} (lo dijo ella)`
  if (a === "vip") return `es VIP: ${k.why.replace(/\.$/, "")}`
  if (a === "recuperar")
    return `compró ${cat}${top?.p.pl ? ` ${top.p.pl}` : ""} hace ${k.last} días y su ritmo es cada ${k.ritmo} · en riesgo`
  if (a === "despertar") return `no compra hace ${k.last} días y compraba ${cat} ${size} · dormida`
  if (a === "nuevo") {
    const n = c.buys.filter((b) => b.p.cat === R.nuevo.cat).length
    return `compró ${R.nuevo.cat.toLowerCase()} ${n === 1 ? "una vez" : `${n} veces`} y llegó ${R.nuevo.name.toLowerCase()} ${R.fit(size)}`
  }
  return `${k.sens}: ${k.sensWhy}`
}

export function encargoDe(a: AccionId, c: Clienta, R: RubroC, porque?: string): Encargo {
  const size = c.datos.talla?.valor ?? c.buys[0]?.size ?? R.sizes[c.s] ?? ""
  const nv = R.nuevo
  const tope = soles(minimo(nv.price))
  const base = [
    "No escribir de nuevo si no responde: la campaña cierra sola.",
    "Si pide que no le escriban, anotar la baja y no ofrecer nada más.",
  ]
  const of: Record<AccionId, [string, string, string[]]> = {
    cart: [
      "El mismo carrito, al precio guardado. Sin rebaja nueva.",
      "Hasta hoy a las 18:40, cuando vence el precio del carrito.",
      ["No sumar productos que no pidió."],
    ],
    cruzada: [
      `${cap(R.extra.name)} a ${soles(R.extra.price)}, en su próximo envío sin cobrar envío otra vez.`,
      "Esta semana.",
      ["Sin descuento: ya es un precio bajo."],
    ],
    recompra: [
      "Lo mismo que compró, al precio de hoy y con su envío de siempre.",
      "Antes de que se le acabe: esta semana.",
      ["No cambiarle el producto ni el tono sin preguntar."],
    ],
    cumple: [
      "Envío gratis en su próxima compra de esta semana (lo pone la tienda).",
      "Hasta el domingo 29.",
      ["No sumar otra rebaja al envío gratis."],
    ],
    vip: [
      `${R.liq.name} a ${soles(R.liq.price)} (antes ${soles(R.liq.before)}) ${R.fit(size)}, un día antes que el resto.`,
      "Hoy y mañana, antes de que abra la liquidación.",
      ["Sin rebaja extra: el precio de liquidación ya es el mínimo."],
    ],
    recuperar: [
      `${nv.name} ${nv.color} ${R.fit(size)} a ${soles(nv.price)}. Si duda, una sola rebaja hasta ${tope}, pagando hoy.`,
      "La rebaja vale hasta las 18:00 del día que responda; la campaña cierra el domingo 29.",
      [
        `No bajar de ${tope}: es el mínimo que dejó la tienda.`,
        "Una sola oferta: no mejorarla si insiste.",
      ],
    ],
    despertar: [
      `${nv.name} ${nv.color} ${R.fit(size)} a ${soles(nv.price)}. Si duda, una sola rebaja hasta ${tope}, pagando hoy.`,
      "La rebaja vale hasta las 18:00 del día que responda; la campaña cierra el domingo 29.",
      [
        `No bajar de ${tope}: es el mínimo que dejó la tienda.`,
        "Una sola oferta: no mejorarla si insiste.",
      ],
    ],
    nuevo: [
      `${nv.name} ${nv.color} ${R.fit(size)} a ${soles(nv.price)}. Rebaja solo si la pide, hasta ${tope}.`,
      "Mientras haya stock en su talla; la campaña cierra el domingo 29.",
      [`No bajar de ${tope}: es el mínimo que dejó la tienda.`],
    ],
    liq: [
      `${R.liq.name} a ${soles(R.liq.price)} (antes ${soles(R.liq.before)}) ${R.fit(size)}.`,
      "Hasta el domingo 29, o mientras haya stock.",
      ["Sin rebaja extra: el precio de liquidación ya es el mínimo."],
    ],
  }
  const [ofrecer, plazo, no] = of[a]
  return {
    campana: ACC[a].t(R),
    para: c.name,
    porque: porque ?? motivoDe(a, c, R),
    ofrecer,
    plazo,
    noHacer: [...no, ...base],
  }
}
