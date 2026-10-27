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
}

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
