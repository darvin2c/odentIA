import type { ClinicalProduct } from "@odentia/clinical"
import type { DemoSize } from "@odentia/db/schema/admin-demos"
import type { Random, ReportsSeedNote, ReportsSeedPerson } from "./seed-reports.js"

/**
 * Las recetas de las demos para presentar (ADR 0096): qué hace distinto a
 * cada tipo de clínica o consultorio. Lo común (crear la clínica, armar la
 * historia día por día, mantenerla al día) vive en `demo-build.ts`; cada
 * producto declara sus tipos en su carpeta y se conecta por `products.ts`.
 * Los precios se escriben en soles y se llevan a la moneda del país.
 */
export interface DemoServiceRecipe {
  /** La clave de la biblioteca del producto (`treatment_template.key`). */
  template: string
  /** Precio en soles; se convierte con `DemoCountry.priceFactor`. */
  price: number
  durationMin: number
  /** Cuántas veces sale en la agenda frente a los demás. */
  weight: number
  /** La primera visita de una persona nueva. */
  firstVisit?: boolean
}

/** Un producto de Inventario de la demo, con lo que cuesta y cuánto debe haber. */
export interface DemoProductRecipe {
  sku: string
  name: string
  /** Unidad de uso («guante»). */
  unit: string
  /** Unidad de compra y cuántas de uso trae; sin ella, se compra igual que se usa. */
  purchase?: { unit: string; factor: number }
  /** Costo de una unidad de compra (o de uso, sin ella), en soles. */
  cost: number
  /** Mínimo de la sede, en unidades de uso. */
  min: number
  /** Precio de venta de una unidad de uso, en soles: aparece en «Cobrar». */
  sale?: number
  /** Solo se vende, no se gasta en las atenciones. */
  onlySale?: boolean
  /** Ya no se usa: queda desactivado, con su compra de antes. */
  retired?: boolean
}

/** Lo que una demo tiene en Inventario y lo que gasta cada servicio. */
export interface DemoInventoryRecipe {
  /** Los proveedores, sin la forma de sociedad del país: «Dental Andina». */
  suppliers: readonly [string, string]
  products: readonly DemoProductRecipe[]
  /** Lo que gasta cada servicio de la biblioteca (`treatment_template.key`), por su `sku`. */
  materials: Readonly<Record<string, ReadonlyArray<{ sku: string; quantity: number }>>>
  /** Quedan por debajo de su mínimo: la pantalla dice «Hace falta». */
  low: readonly string[]
  /** De los que entran, al primero le queda un lote vencido y al segundo uno que vence en días. */
  expiring: readonly string[]
}

/**
 * Una promoción de la demo sobre un servicio de su receta. «vigente» empezó
 * hace tres semanas y sigue sin fin; «terminada» duró el mes pasado. Las dos
 * se usaron en cobros de la historia.
 */
export interface DemoPromotionRecipe {
  template: string
  name: string
  /** Lo lee Sofi tal cual a los pacientes: una condición de verdad. */
  conditions: string
  /** Precio de la promoción en soles; con «from», el mínimo. */
  price: number
  mode?: "fixed" | "from"
  when: "vigente" | "terminada"
}

/** Una respuesta oficial de Conocimiento (`KNOWLEDGE_BASICS` si tiene clave). */
export interface DemoKnowledgeRecipe {
  title: string
  body: string
  basicKey?: string
  askForms?: readonly string[]
}

export interface DemoKindRecipe {
  key: string
  product: ClinicalProduct
  /** Como lo ve la administración: «Pediatría». */
  name: string
  /** Una línea: «Niños con su responsable». */
  hint: string
  /** Nombres de ejemplo: «Pediatría {lugar}». */
  clinicNames: readonly string[]
  /** El título de quien atiende, por sexo, y su especialidad: el tipo de la biblioteca que atiende (`librarySpecialtyIds`). */
  professional: { title: { F: string; M: string }; specialty: string | null }
  /** El tipo de cada profesional cuando el tipo de demo tiene varias especialidades (Policlínico). */
  specialtyRotation?: readonly string[]
  services: readonly DemoServiceRecipe[]
  /** Quién llega: edades, sexo y responsable de los menores (con nombres del país). */
  person: (random: Random, country: DemoCountry) => ReportsSeedPerson
  /** Lo que se escribe en cada atención. */
  note: (
    service: { name: string },
    random: Random,
    person: ReportsSeedPerson | null,
  ) => ReportsSeedNote
  /** Primer mensaje de quien escribe y la respuesta de Sofi. */
  inbound: readonly string[]
  reply: readonly string[]
  /** Lo que hoy espera a una persona en la Bandeja. */
  openTopics: readonly string[]
  /** El control que se repite y vence (control del niño sano, prenatal…). */
  followUp: { title: string; everyMonths: number } | null
  budgets: boolean
  /** Cuánto se llena la agenda de cada profesional. */
  occupancy: number
  expenses: ReadonlyArray<{
    category: string
    concept: string
    rent?: boolean
    cents?: number
    perStaffCents?: number
    revenueShare?: number
    day: number
  }>
  inventory: DemoInventoryRecipe
  promotions: readonly DemoPromotionRecipe[]
  /** Las respuestas que Sofi ya tiene publicadas. */
  knowledge: readonly DemoKnowledgeRecipe[]
}

/** Los tamaños (decisión 4): profesionales, sedes, consultorios por sede y pacientes que ya existen. */
export const DEMO_SIZE_RECIPES: Record<
  DemoSize,
  { name: string; professionals: number; branches: number; rooms: number; patients: number }
> = {
  pequeno: { name: "Pequeño", professionals: 1, branches: 1, rooms: 1, patients: 300 },
  mediano: { name: "Mediano", professionals: 3, branches: 1, rooms: 3, patients: 900 },
  grande: { name: "Grande", professionals: 8, branches: 2, rooms: 4, patients: 2_500 },
}

export interface DemoCountry {
  code: "PE" | "CO" | "MX"
  name: string
  /** La zona de la capital: México tiene varias y la clínica nace con una. */
  timezone: string
  /** De soles a la moneda del país, redondeado a un precio de lista. */
  priceFactor: number
  /** Mes-día sin atención. */
  holidays: ReadonlySet<string>
  surnames: readonly string[]
  given: { F: readonly string[]; M: readonly string[] }
  /** Los medios de pago que crea `ensureDefaultPaymentMethods`, con cuánto se usan. */
  paymentMethods: ReadonlyArray<{ name: string; typeCode: string; weight: number }>
  /** El colegio o registro de cada producto. */
  registration: Record<ClinicalProduct, string>
  /** Lugares para el nombre de la clínica. */
  places: readonly string[]
  /** Prefijo y largo de un celular del país. */
  mobile: { prefix: string; digits: number }
  /** La forma de sociedad de un proveedor y un número tributario con su forma («20…» en Perú). */
  company: { suffix: string; taxNumber: (random: Random) => string }
}

const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"
const digits = (random: Random, count: number): string =>
  Array.from({ length: count }, () => String(random.int(0, 9))).join("")

const GIVEN_F = [
  "María",
  "Lucía",
  "Ana",
  "Rosa",
  "Carmen",
  "Sofía",
  "Valeria",
  "Camila",
  "Gabriela",
  "Daniela",
  "Paola",
  "Patricia",
  "Mariana",
  "Natalia",
  "Claudia",
  "Alejandra",
  "Fiorella",
  "Milagros",
  "Silvia",
  "Lorena",
]
const GIVEN_M = [
  "José",
  "Carlos",
  "Luis",
  "Jorge",
  "Miguel",
  "Diego",
  "Andrés",
  "Fernando",
  "Ricardo",
  "Javier",
  "Raúl",
  "Óscar",
  "Víctor",
  "Hugo",
  "Martín",
  "Renzo",
  "César",
  "Iván",
  "Gonzalo",
  "Pedro",
]

export const DEMO_COUNTRIES: Record<DemoCountry["code"], DemoCountry> = {
  PE: {
    code: "PE",
    name: "Perú",
    timezone: "America/Lima",
    priceFactor: 1,
    holidays: new Set([
      "01-01",
      "05-01",
      "06-29",
      "07-28",
      "07-29",
      "08-30",
      "10-08",
      "11-01",
      "12-08",
      "12-25",
    ]),
    surnames: [
      "García",
      "Rodríguez",
      "Flores",
      "Quispe",
      "Mamani",
      "Sánchez",
      "Ramírez",
      "Torres",
      "Castillo",
      "Mendoza",
      "Vargas",
      "Rojas",
      "Chávez",
      "Gutiérrez",
      "Huamán",
      "Díaz",
      "Ruiz",
      "Paredes",
      "Salazar",
      "Cruz",
      "Morales",
      "Ortiz",
      "Navarro",
      "Reyes",
      "Silva",
      "Delgado",
      "Campos",
      "Vega",
      "Ríos",
      "Aguilar",
    ],
    given: { F: GIVEN_F, M: GIVEN_M },
    paymentMethods: [
      { name: "Yape", typeCode: "68", weight: 30 },
      { name: "Plin", typeCode: "68", weight: 6 },
      { name: "Efectivo", typeCode: "10", weight: 28 },
      { name: "Tarjeta", typeCode: "48", weight: 26 },
      { name: "Transferencia", typeCode: "30", weight: 10 },
    ],
    registration: { dental: "COP", medical: "CMP" },
    places: [
      "Los Olivos",
      "Miraflores",
      "San Borja",
      "Surco",
      "La Molina",
      "San Miguel",
      "Jesús María",
      "Magdalena",
      "Pueblo Libre",
      "Lince",
    ],
    mobile: { prefix: "+519", digits: 8 },
    // RUC de una persona jurídica: 11 dígitos que empiezan con 20.
    company: { suffix: "S.A.C.", taxNumber: (random) => `20${digits(random, 9)}` },
  },
  CO: {
    code: "CO",
    name: "Colombia",
    timezone: "America/Bogota",
    priceFactor: 1_100,
    holidays: new Set([
      "01-01",
      "01-06",
      "03-23",
      "05-01",
      "06-29",
      "07-20",
      "08-07",
      "08-15",
      "10-12",
      "11-01",
      "11-11",
      "12-08",
      "12-25",
    ]),
    surnames: [
      "Rodríguez",
      "Gómez",
      "González",
      "Martínez",
      "García",
      "López",
      "Hernández",
      "Sánchez",
      "Ramírez",
      "Pérez",
      "Díaz",
      "Muñoz",
      "Rojas",
      "Moreno",
      "Jiménez",
      "Álvarez",
      "Romero",
      "Valencia",
      "Ospina",
      "Restrepo",
      "Cardona",
      "Castaño",
      "Quintero",
      "Zapata",
      "Arango",
    ],
    given: {
      F: [
        "María",
        "Laura",
        "Valentina",
        "Daniela",
        "Natalia",
        "Carolina",
        "Paula",
        "Juliana",
        "Andrea",
        "Catalina",
        "Manuela",
        "Sara",
        "Luisa",
        "Diana",
        "Ángela",
      ],
      M: [
        "Juan",
        "Andrés",
        "Santiago",
        "Sebastián",
        "Carlos",
        "Felipe",
        "Camilo",
        "Mateo",
        "Alejandro",
        "Julián",
        "David",
        "Esteban",
        "Jorge",
        "Mauricio",
        "Nicolás",
      ],
    },
    paymentMethods: [
      { name: "Efectivo", typeCode: "10", weight: 34 },
      { name: "Tarjeta", typeCode: "48", weight: 40 },
      { name: "Transferencia", typeCode: "30", weight: 26 },
    ],
    registration: {
      dental: "Tarjeta profesional (RETHUS)",
      medical: "Tarjeta profesional (RETHUS)",
    },
    places: [
      "Chapinero",
      "Usaquén",
      "El Poblado",
      "Laureles",
      "Cedritos",
      "Teusaquillo",
      "Envigado",
      "Santa Bárbara",
      "Salitre",
      "Belén",
    ],
    mobile: { prefix: "+573", digits: 9 },
    // NIT de una sociedad: nueve dígitos y su dígito de verificación.
    company: {
      suffix: "S.A.S.",
      taxNumber: (random) => `9${digits(random, 8)}-${digits(random, 1)}`,
    },
  },
  MX: {
    code: "MX",
    name: "México",
    timezone: "America/Mexico_City",
    priceFactor: 5,
    holidays: new Set(["01-01", "02-03", "03-17", "05-01", "09-16", "11-17", "12-25"]),
    surnames: [
      "Hernández",
      "García",
      "Martínez",
      "López",
      "González",
      "Pérez",
      "Rodríguez",
      "Sánchez",
      "Ramírez",
      "Cruz",
      "Flores",
      "Gómez",
      "Morales",
      "Vázquez",
      "Reyes",
      "Jiménez",
      "Torres",
      "Díaz",
      "Gutiérrez",
      "Ruiz",
      "Mendoza",
      "Aguilar",
      "Ortiz",
      "Castillo",
      "Moreno",
    ],
    given: {
      F: [
        "María",
        "Guadalupe",
        "Fernanda",
        "Ximena",
        "Regina",
        "Valeria",
        "Daniela",
        "Andrea",
        "Mariana",
        "Sofía",
        "Paulina",
        "Itzel",
        "Montserrat",
        "Alejandra",
        "Gabriela",
      ],
      M: [
        "José",
        "Juan",
        "Luis",
        "Carlos",
        "Jesús",
        "Miguel",
        "Diego",
        "Emiliano",
        "Santiago",
        "Leonardo",
        "Alejandro",
        "Eduardo",
        "Fernando",
        "Ricardo",
        "Arturo",
      ],
    },
    paymentMethods: [
      { name: "Efectivo", typeCode: "10", weight: 36 },
      { name: "Tarjeta", typeCode: "48", weight: 38 },
      { name: "Transferencia", typeCode: "30", weight: 26 },
    ],
    registration: { dental: "Cédula profesional", medical: "Cédula profesional" },
    places: [
      "Polanco",
      "Del Valle",
      "Coyoacán",
      "Roma",
      "Condesa",
      "Satélite",
      "Providencia",
      "San Pedro",
      "Narvarte",
      "Lindavista",
    ],
    mobile: { prefix: "+521", digits: 10 },
    // RFC de una persona moral: tres letras, la fecha de constitución y la homoclave.
    company: {
      suffix: "S.A. de C.V.",
      taxNumber: (random) =>
        `${Array.from({ length: 3 }, () => random.pick([...LETTERS])).join("")}${String(random.int(5, 19)).padStart(2, "0")}${String(random.int(1, 12)).padStart(2, "0")}${String(random.int(1, 28)).padStart(2, "0")}${random.pick([...LETTERS])}${digits(random, 1)}${random.pick([...LETTERS])}`,
    },
  },
}

/** Un precio de lista en la moneda del país: soles por el factor, redondeado. */
export function demoPriceCents(price: number, country: DemoCountry): number {
  const value = price * country.priceFactor
  const step = value >= 10_000 ? 1_000 : value >= 1_000 ? 50 : value >= 100 ? 5 : 1
  return Math.round(value / step) * step * 100
}

/** Una fecha de nacimiento para una edad, en años cumplidos a hoy. */
export function birthDateForAge(age: number, random: Random): string {
  const now = new Date()
  const year = now.getUTCFullYear() - age - (random.chance(0.5) ? 1 : 0)
  const month = random.int(1, 12)
  const day = random.int(1, 28)
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}
