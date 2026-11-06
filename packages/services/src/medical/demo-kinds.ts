import type { DemoCountry, DemoKindRecipe } from "../demo-recipes.js"
import { birthDateForAge } from "../demo-recipes.js"
import type { Random, ReportsSeedNote, ReportsSeedPerson } from "../seed-reports.js"

/**
 * Los tipos de demo de latidIA (lienzo «Demos para presentar», tablero 5):
 * las cinco especialidades con que nace un consultorio y el Policlínico, que
 * las junta. Cada uno cambia quién atiende, quién llega, por qué vuelve y qué
 * se escribe. Los diagnósticos son de la CIE-11 oficial; los servicios, de la
 * biblioteca médica (`biblioteca_medica.csv`).
 */

const GENERAL_EXPENSES: DemoKindRecipe["expenses"] = [
  {
    category: "Personal",
    concept: "Planilla del mes",
    cents: 3_200_00,
    perStaffCents: 1_800_00,
    day: 28,
  },
  { category: "Alquiler", concept: "Alquiler del local", rent: true, day: 1 },
  { category: "Laboratorio", concept: "Análisis derivados", revenueShare: 0.05, day: 20 },
  { category: "Materiales", concept: "Insumos médicos", revenueShare: 0.04, day: 12 },
  { category: "Servicios", concept: "Luz, agua e internet", cents: 520_00, day: 18 },
]

/**
 * Lo que guarda un consultorio en Inventario. Entra lo que gasta algún
 * servicio de su tipo y lo que se vende: un consultorio de pediatría no
 * guarda DIU.
 */
const MEDICAL_INVENTORY: DemoKindRecipe["inventory"] = {
  suppliers: ["Distribuidora Médica Central", "Insumos Hospitalarios del Sur"],
  products: [
    {
      sku: "INS-GUANTE-NITRILO",
      name: "Guantes de nitrilo",
      unit: "guante",
      purchase: { unit: "caja", factor: 100 },
      cost: 38,
      min: 200,
    },
    {
      sku: "INS-TORUNDA-ALCOHOL",
      name: "Torundas con alcohol",
      unit: "torunda",
      purchase: { unit: "bolsa", factor: 200 },
      cost: 15,
      min: 150,
    },
    {
      sku: "INS-JERINGA-5ML",
      name: "Jeringa de 5 ml con aguja 21G",
      unit: "jeringa",
      purchase: { unit: "caja", factor: 100 },
      cost: 45,
      min: 50,
    },
    {
      sku: "INS-JERINGA-1ML",
      name: "Jeringa de 1 ml con aguja 25G",
      unit: "jeringa",
      purchase: { unit: "caja", factor: 100 },
      cost: 42,
      min: 40,
    },
    {
      sku: "INS-MASCARILLA-NEB",
      name: "Mascarilla para nebulizar",
      unit: "mascarilla",
      purchase: { unit: "caja", factor: 50 },
      cost: 95,
      min: 20,
    },
    {
      sku: "MED-SUERO-FISIO",
      name: "Cloruro de sodio 0,9 % ampolla de 5 ml",
      unit: "ampolla",
      purchase: { unit: "caja", factor: 100 },
      cost: 65,
      min: 40,
    },
    {
      sku: "INS-TIRA-GLUCOSA",
      name: "Tiras reactivas de glucosa",
      unit: "tira",
      purchase: { unit: "frasco", factor: 50 },
      cost: 55,
      min: 50,
    },
    {
      sku: "INS-LANCETA",
      name: "Lancetas estériles",
      unit: "lanceta",
      purchase: { unit: "caja", factor: 100 },
      cost: 18,
      min: 50,
    },
    {
      sku: "INS-ELECTRODO-ECG",
      name: "Electrodos para electrocardiograma",
      unit: "electrodo",
      purchase: { unit: "bolsa", factor: 50 },
      cost: 30,
      min: 50,
    },
    {
      sku: "INS-GEL-ECO",
      name: "Gel para ecografía en sachet",
      unit: "sachet",
      purchase: { unit: "caja", factor: 50 },
      cost: 40,
      min: 25,
    },
    {
      sku: "INS-SUTURA-NYLON",
      name: "Sutura de nylon 3-0",
      unit: "sobre",
      purchase: { unit: "caja", factor: 12 },
      cost: 48,
      min: 6,
    },
    {
      sku: "INS-GASA-ESTERIL",
      name: "Gasas estériles 10 × 10 cm",
      unit: "gasa",
      purchase: { unit: "paquete", factor: 100 },
      cost: 30,
      min: 100,
    },
    {
      sku: "INS-CEPILLO-CITO",
      name: "Cepillo citológico",
      unit: "cepillo",
      purchase: { unit: "bolsa", factor: 100 },
      cost: 35,
      min: 20,
    },
    {
      sku: "INS-LAMINA-PORTA",
      name: "Láminas portaobjetos",
      unit: "lámina",
      purchase: { unit: "caja", factor: 50 },
      cost: 10,
      min: 20,
    },
    {
      sku: "INS-TUBO-VACIO",
      name: "Tubos de extracción al vacío",
      unit: "tubo",
      purchase: { unit: "caja", factor: 100 },
      cost: 55,
      min: 50,
    },
    {
      sku: "INS-AGUJA-VACIO",
      name: "Agujas para extracción al vacío 21G",
      unit: "aguja",
      purchase: { unit: "caja", factor: 100 },
      cost: 40,
      min: 40,
    },
    { sku: "PRO-DIU-COBRE", name: "DIU de cobre T380A", unit: "dispositivo", cost: 25, min: 3 },
    {
      sku: "VEN-TERMOMETRO-DIG",
      name: "Termómetro digital",
      unit: "termómetro",
      purchase: { unit: "caja", factor: 10 },
      cost: 120,
      min: 3,
      sale: 25,
      onlySale: true,
    },
    {
      sku: "VEN-ALCOHOL-GEL",
      name: "Alcohol en gel 250 ml",
      unit: "frasco",
      purchase: { unit: "caja", factor: 12 },
      cost: 96,
      min: 4,
      sale: 12,
    },
    {
      sku: "INS-TERMOMETRO-HG",
      name: "Termómetro de mercurio",
      unit: "termómetro",
      cost: 8,
      min: 0,
      retired: true,
    },
  ],
  materials: {
    nebulizacion: [
      { sku: "INS-MASCARILLA-NEB", quantity: 1 },
      { sku: "MED-SUERO-FISIO", quantity: 1 },
    ],
    "inyectable-intramuscular": [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "INS-JERINGA-5ML", quantity: 1 },
      { sku: "INS-TORUNDA-ALCOHOL", quantity: 1 },
    ],
    "sutura-simple": [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "INS-SUTURA-NYLON", quantity: 1 },
      { sku: "INS-GASA-ESTERIL", quantity: 2 },
      { sku: "INS-TORUNDA-ALCOHOL", quantity: 2 },
    ],
    "retiro-de-puntos": [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "INS-GASA-ESTERIL", quantity: 1 },
      { sku: "INS-TORUNDA-ALCOHOL", quantity: 1 },
    ],
    electrocardiograma: [{ sku: "INS-ELECTRODO-ECG", quantity: 10 }],
    "glucosa-capilar": [
      { sku: "INS-TIRA-GLUCOSA", quantity: 1 },
      { sku: "INS-LANCETA", quantity: 1 },
      { sku: "INS-TORUNDA-ALCOHOL", quantity: 1 },
    ],
    "aplicacion-de-vacuna": [
      { sku: "INS-JERINGA-1ML", quantity: 1 },
      { sku: "INS-TORUNDA-ALCOHOL", quantity: 1 },
    ],
    papanicolaou: [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "INS-CEPILLO-CITO", quantity: 1 },
      { sku: "INS-LAMINA-PORTA", quantity: 1 },
    ],
    "ecografia-obstetrica": [{ sku: "INS-GEL-ECO", quantity: 1 }],
    "ecografia-abdominal": [{ sku: "INS-GEL-ECO", quantity: 1 }],
    "ecografia-transvaginal": [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "INS-GEL-ECO", quantity: 1 },
    ],
    "toma-de-muestra-de-sangre": [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "INS-TUBO-VACIO", quantity: 2 },
      { sku: "INS-AGUJA-VACIO", quantity: 1 },
      { sku: "INS-TORUNDA-ALCOHOL", quantity: 1 },
    ],
    "colocacion-de-diu": [
      { sku: "INS-GUANTE-NITRILO", quantity: 2 },
      { sku: "PRO-DIU-COBRE", quantity: 1 },
      { sku: "INS-GASA-ESTERIL", quantity: 2 },
    ],
  },
  low: [
    "INS-MASCARILLA-NEB",
    "INS-TIRA-GLUCOSA",
    "INS-ELECTRODO-ECG",
    "INS-JERINGA-1ML",
    "INS-CEPILLO-CITO",
    "INS-TUBO-VACIO",
  ],
  expiring: [
    "MED-SUERO-FISIO",
    "INS-TIRA-GLUCOSA",
    "INS-JERINGA-1ML",
    "INS-GEL-ECO",
    "INS-TORUNDA-ALCOHOL",
    "INS-TUBO-VACIO",
    "INS-MASCARILLA-NEB",
    "INS-GUANTE-NITRILO",
  ],
}

/**
 * Lo que Sofi ya tiene respondido en un consultorio: solo lo que no está en los
 * datos (ADR 0120). El horario sale del equipo de la demo y una urgencia la
 * atiende la red de señales de alarma (ADR 0084): no se escriben aquí.
 */
const MEDICAL_KNOWLEDGE: DemoKindRecipe["knowledge"] = [
  {
    title: "¿Atienden sin cita?",
    body: "Atendemos con cita. Si no puede esperar a mañana, escríbenos y te damos el primer espacio libre del día.",
    basicKey: "sin_cita",
    askForms: ["¿Puedo ir sin reservar?"],
  },
  {
    title: "¿Qué pasa si llego tarde o no puedo ir?",
    body: "Si no puedes venir, avísanos por este chat con unas horas de anticipación y la cambiamos al día que te acomode. Si llegas más de 15 minutos tarde, te damos el siguiente espacio libre del día.",
    basicKey: "tardanza",
  },
  {
    title: "¿Qué necesito llevar a mi primera cita?",
    body: "Tu documento de identidad, tus análisis o informes anteriores y la lista de medicamentos que tomas.",
    basicKey: "primera_cita",
  },
]

function adult(random: Random, minAge = 18, maxAge = 75, female = 0.58): ReportsSeedPerson {
  return {
    birthDate: birthDateForAge(random.int(minAge, maxAge), random),
    sex: random.chance(female) ? "F" : "M",
  }
}

/** Un menor con quien lo trae: casi siempre la mamá. */
function child(random: Random, country: DemoCountry, maxAge: number): ReportsSeedPerson {
  const mother = random.chance(0.8)
  return {
    birthDate: birthDateForAge(random.int(0, maxAge), random),
    sex: random.chance(0.5) ? "F" : "M",
    guardian: {
      givenNames: random.pick(mother ? country.given.F : country.given.M),
      familyName: `${random.pick(country.surnames)} ${random.pick(country.surnames)}`,
      kinship: mother ? "MTH" : "FTH",
    },
  }
}

/** Años, con decimales, que tenía la persona el día `at`; sin datos, una adulta de 40. */
function ageAt(person: ReportsSeedPerson | null, at: Date): number {
  if (!person) return 40
  const born = Date.parse(`${person.birthDate.slice(0, 10)}T12:00:00Z`)
  return Math.max(0, (at.getTime() - born) / (365.25 * 86_400_000))
}

/**
 * El cuerpo de cada persona: cuán alta y cuán robusta es frente a la mediana
 * de su edad, de −1 a 1, y dos números de 0 a 1 para lo que la acompaña
 * siempre (si tiene una enfermedad crónica y cuál). Sale de su nacimiento y su
 * sexo, así que es el mismo en todas sus visitas, las de la historia y las de
 * la agenda, y con cualquier médico: la talla de un adulto no cambia y el peso
 * solo varía un poco.
 */
function bodyOf(person: ReportsSeedPerson | null): { height: number; build: number; trait: number; chronic: number } {
  const key = person ? `${person.birthDate.slice(0, 10)}:${person.sex}` : "sin-datos"
  const part = (salt: string): number => {
    let hash = 2166136261
    for (const char of `${salt}:${key}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    return (hash >>> 0) / 4294967296
  }
  return { height: part("talla") * 2 - 1, build: part("peso") * 2 - 1, trait: part("rasgo"), chronic: part("cronica") }
}

/** Una enfermedad crónica en control. */
type Chronic = "hipertension" | "diabetes" | "colesterol" | "obesidad"

/**
 * El año con que se cuenta la edad para saber si alguien tiene una enfermedad
 * crónica: uno fijo, para que nadie se enferme ni se cure de un día a otro
 * cuando cumple años.
 */
const CHRONIC_REFERENCE_YEAR = 2026

/**
 * La enfermedad crónica de cada persona, o ninguna: la misma en todas sus
 * visitas y con cualquier médico. Es más común con la edad (15 % antes de los
 * 40, 45 % hasta los 59 y 70 % desde los 60); nadie la tiene antes de los 25.
 * Quien tiene obesidad pesa como tal en todas sus visitas (`vitals`).
 */
function chronicOf(person: ReportsSeedPerson | null): Chronic | null {
  if (!person) return null
  const age = CHRONIC_REFERENCE_YEAR - Number(person.birthDate.slice(0, 4))
  if (age < 25) return null
  const body = bodyOf(person)
  if (body.chronic >= (age >= 60 ? 0.7 : age >= 40 ? 0.45 : 0.15)) return null
  return body.trait < 0.42 ? "hipertension" : body.trait < 0.76 ? "diabetes" : body.trait < 0.9 ? "colesterol" : "obesidad"
}

/** Mediana de talla (cm) y peso (kg) por edad, de 0 a 12 años (OMS, ambos sexos); entre dos puntos, la recta. */
const GROWTH: ReadonlyArray<[number, number, number]> = [
  [0, 50, 3.3],
  [0.5, 67, 7.6],
  [1, 75, 9.6],
  [2, 87, 12.2],
  [3, 95, 14.3],
  [4, 102, 16.3],
  [5, 109, 18.3],
  [6, 115, 20.5],
  [7, 121, 22.9],
  [8, 127, 25.4],
  [9, 132, 28.1],
  [10, 138, 31.2],
  [11, 143, 35],
  [12, 149, 39],
]

function growthAt(age: number): { talla: number; peso: number } {
  for (let index = 1; index < GROWTH.length; index += 1) {
    const [toAge, toTalla, toPeso] = GROWTH[index] as [number, number, number]
    const [fromAge, fromTalla, fromPeso] = GROWTH[index - 1] as [number, number, number]
    if (age <= toAge) {
      const share = (age - fromAge) / (toAge - fromAge)
      return { talla: fromTalla + (toTalla - fromTalla) * share, peso: fromPeso + (toPeso - fromPeso) * share }
    }
  }
  const [, talla, peso] = GROWTH[GROWTH.length - 1] as [number, number, number]
  return { talla, peso }
}

/**
 * Los signos de siempre, con valores de su edad el día de la visita. Talla y
 * peso son los de su cuerpo (`bodyOf`): un niño crece entre visitas y un
 * adulto no; el peso cambia apenas (±0,5 kg) y quien tiene obesidad
 * (`chronicOf`) la tiene en todas sus visitas.
 */
function vitals(
  random: Random,
  person: ReportsSeedPerson | null,
  at: Date,
  extra: Record<string, number> = {},
): Record<string, number> {
  const age = ageAt(person, at)
  const body = bodyOf(person)
  if (age < 12) {
    const median = growthAt(age)
    const talla = Math.round(median.talla * (1 + 0.035 * body.height) * 10) / 10
    const peso =
      Math.round(median.peso * (1 + 0.09 * body.build) * (1 + (random.next() - 0.5) * 0.02) * 10) / 10
    return {
      temperatura: Math.round((36.4 + random.next() * 0.8) * 10) / 10,
      frecuenciaCardiaca: random.int(85, 125),
      frecuenciaRespiratoria: random.int(20, 32),
      saturacionOxigeno: random.int(95, 99),
      peso,
      talla,
      ...(age < 3
        ? {
            perimetroCefalico:
              Math.round((34.5 + Math.min(age, 1) * 11.5 + Math.max(0, age - 1) * 1.7 + body.height) * 10) / 10,
          }
        : {}),
      ...extra,
    }
  }
  // De los 12 a los 18 se pasa, en línea recta, de lo de un niño de 12 a lo de su cuerpo
  // adulto; después la talla ya no cambia y el peso es el de su índice de masa corporal.
  const adultTalla = (person?.sex === "M" ? 169 : 156) + 7 * body.height
  const bmi = chronicOf(person) === "obesidad" ? 31 + 6 * ((body.build + 1) / 2) : 23.5 + 3.5 * body.build
  const adultPeso = bmi * (adultTalla / 100) ** 2
  const at12 = growthAt(12)
  const share = Math.min(1, (age - 12) / 6)
  const talla = Math.round(at12.talla * (1 + 0.035 * body.height) + (adultTalla - at12.talla * (1 + 0.035 * body.height)) * share)
  const base = at12.peso * (1 + 0.09 * body.build) + (adultPeso - at12.peso * (1 + 0.09 * body.build)) * share
  const peso = Math.round((base + (random.next() - 0.5)) * 10) / 10
  return {
    presionSistolica: random.int(108, 132),
    presionDiastolica: random.int(66, 84),
    frecuenciaCardiaca: random.int(62, 88),
    temperatura: Math.round((36.2 + random.next() * 0.7) * 10) / 10,
    saturacionOxigeno: random.int(95, 99),
    peso,
    talla,
    ...extra,
  }
}

function exam(found?: { system: string; text: string }): Record<string, unknown> {
  const sistemas: Record<string, unknown> = {
    estadoGeneral: { estado: "sin_alteraciones" },
    toraxPulmones: { estado: "sin_alteraciones" },
    corazon: { estado: "sin_alteraciones" },
    abdomen: { estado: "sin_alteraciones" },
  }
  if (found) sistemas[found.system] = { estado: "con_hallazgos", hallazgo: found.text }
  return { sistemas }
}

/** Para quién es lo que se receta: a un menor de 12 años, la dosis por su peso. */
type Patient = { child: boolean; adult: boolean; weightKg: number }
type Prescribed = NonNullable<ReportsSeedNote["prescription"]>
type Medication = Prescribed["items"][number]

/** Los mililitros de una dosis por kilo, sin pasar la dosis de un adulto (`maxMg`), redondeados al medio mililitro. */
const mlFor = (weightKg: number, mgPerKg: number, mgPerMl: number, maxMg: number): string =>
  `${(Math.round((Math.min(weightKg * mgPerKg, maxMg) / mgPerMl) * 2) / 2).toLocaleString("es")} ml`

/** Lo que se receta, por la Denominación Común Internacional de la lista médica (`GENERAL_MEDICATIONS`). */
const RX = {
  paracetamol: (who: Patient): Medication =>
    who.child
      ? {
          genericName: "paracetamol",
          strength: "120 mg/5 ml",
          dosageForm: "jarabe",
          dose: mlFor(who.weightKg, 15, 24, 500),
          route: "oral",
          frequency: "cada 6 horas si hay fiebre o dolor",
          duration: "3 días",
          quantity: 1,
          instructions: "No dar más de 4 tomas al día.",
        }
      : {
          genericName: "paracetamol",
          strength: "500 mg",
          dosageForm: "tableta",
          dose: "1 tableta",
          route: "oral",
          frequency: "cada 8 horas si hay fiebre o dolor",
          duration: "3 días",
          quantity: 9,
        },
  amoxicilina: (who: Patient, days: number): Medication =>
    who.child
      ? {
          genericName: "amoxicilina",
          strength: "250 mg/5 ml",
          dosageForm: "suspensión",
          dose: mlFor(who.weightKg, 50 / 3, 50, 500),
          route: "oral",
          frequency: "cada 8 horas",
          duration: `${days} días`,
          quantity: 2,
          instructions: "Completar los días aunque ya no tenga fiebre.",
        }
      : {
          genericName: "amoxicilina",
          strength: "500 mg",
          dosageForm: "cápsula",
          dose: "1 cápsula",
          route: "oral",
          frequency: "cada 8 horas",
          duration: `${days} días`,
          quantity: days * 3,
          instructions: "Completar los días aunque ya no tenga fiebre.",
        },
  ibuprofeno: (): Medication => ({
    genericName: "ibuprofeno",
    strength: "400 mg",
    dosageForm: "tableta",
    dose: "1 tableta",
    route: "oral",
    frequency: "cada 8 horas con alimentos",
    duration: "5 días",
    quantity: 15,
  }),
  sales: (): Medication => ({
    genericName: "sales de rehidratación oral",
    strength: "20,5 g",
    dosageForm: "sobre",
    dose: "1 sobre en 1 litro de agua hervida",
    route: "oral",
    frequency: "a libre demanda, después de cada deposición",
    duration: "3 días",
    quantity: 4,
  }),
  sulfatoFerrosoJarabe: (who: Patient): Medication => ({
    genericName: "sulfato ferroso",
    strength: "75 mg/5 ml",
    dosageForm: "jarabe",
    // 3 mg de hierro por kilo al día, hasta 60 mg (lo de un adulto).
    dose: mlFor(who.weightKg, 3, 3, 60),
    route: "oral",
    frequency: "una vez al día, lejos de las comidas",
    duration: "3 meses",
    quantity: 3,
  }),
  fluconazol: (): Medication => ({
    genericName: "fluconazol",
    strength: "150 mg",
    dosageForm: "cápsula",
    dose: "1 cápsula",
    route: "oral",
    frequency: "una sola vez",
    duration: "1 día",
    quantity: 1,
  }),
  enalapril: (): Medication => ({
    genericName: "enalapril",
    strength: "10 mg",
    dosageForm: "tableta",
    dose: "1 tableta",
    route: "oral",
    frequency: "cada 12 horas",
    duration: "30 días",
    quantity: 60,
  }),
  metformina: (): Medication => ({
    genericName: "metformina",
    strength: "850 mg",
    dosageForm: "tableta",
    dose: "1 tableta",
    route: "oral",
    frequency: "cada 12 horas con las comidas",
    duration: "30 días",
    quantity: 60,
  }),
  atorvastatina: (): Medication => ({
    genericName: "atorvastatina",
    strength: "20 mg",
    dosageForm: "tableta",
    dose: "1 tableta",
    route: "oral",
    frequency: "cada noche",
    duration: "30 días",
    quantity: 30,
  }),
  acidoFolico: (): Medication => ({
    genericName: "ácido fólico",
    strength: "1 mg",
    dosageForm: "tableta",
    dose: "1 tableta",
    route: "oral",
    frequency: "una vez al día",
    duration: "30 días",
    quantity: 30,
  }),
  sulfatoFerroso: (): Medication => ({
    genericName: "sulfato ferroso",
    strength: "300 mg",
    dosageForm: "tableta",
    dose: "1 tableta",
    route: "oral",
    frequency: "una vez al día, lejos de las comidas",
    duration: "30 días",
    quantity: 30,
  }),
} as const

/** Una consulta por enfermedad: qué tenía, qué se encontró, qué se recetó y si llevó descanso. */
type Episode = {
  code: string
  weight: number
  evolution: string
  found?: { system: string; text: string }
  fever?: boolean
  rx?: (who: Patient) => Medication[]
  /** Días de descanso médico, solo para un adulto. */
  leave?: { days: number; notes: string }
  /** Solo a esas edades el día de la visita (la bronquiolitis, antes de los 2 años). */
  minAge?: number
  maxAge?: number
}

/** Lo escrito en una atención con lo que se emitió en ella: la receta y, a un adulto, su descanso. */
function issued(
  note: Omit<ReportsSeedNote, "prescription" | "leave">,
  person: ReportsSeedPerson | null,
  at: Date,
  rx?: (who: Patient) => Medication[],
  leave?: { days: number; notes: string },
): ReportsSeedNote {
  const age = ageAt(person, at)
  const peso = note.vitals?.peso
  const who: Patient = { child: age < 12, adult: age >= 18, weightKg: typeof peso === "number" ? peso : 70 }
  const items = rx?.(who) ?? []
  return {
    ...note,
    ...(items.length > 0 ? { prescription: { items, ...(who.child ? { weightKg: who.weightKg } : {}) } } : {}),
    ...(leave && who.adult ? { leave } : {}),
  }
}

function episodeNote(
  episodes: readonly Episode[],
  random: Random,
  person: ReportsSeedPerson | null,
  at: Date,
): ReportsSeedNote {
  // Lo que le puede pasar a esa edad; si nada calza, lo de siempre.
  const age = ageAt(person, at)
  const fitting = episodes.filter((item) => (item.minAge ?? 0) <= age && age < (item.maxAge ?? 200))
  const episode = random.weighted(fitting.length > 0 ? fitting : episodes)
  return issued(
    {
      evolution: episode.evolution,
      diagnosisCode: episode.code,
      vitals: vitals(
        random,
        person,
        at,
        episode.fever ? { temperatura: Math.round((37.9 + random.next() * 1.1) * 10) / 10 } : {},
      ),
      examination: exam(episode.found),
    },
    person,
    at,
    episode.rx,
    episode.leave,
  )
}

/** A quién atiende cada especialidad: pediatría, hasta los 17 años; ginecología, a mujeres. */
const MEDICAL_SPECIALTY_WHO: NonNullable<DemoKindRecipe["specialtyWho"]> = {
  pediatria: { maxAge: 17 },
  ginecologia: { sex: "F", minAge: 12 },
  interna: { minAge: 18 },
}

const RESPIRATORY: readonly Episode[] = [
  {
    code: "CA00",
    weight: 30,
    evolution:
      "Rinorrea y congestión de tres días. Reposo, hidratación y paracetamol si hay fiebre.",
    found: {
      system: "bocaGarganta",
      text: "Mucosa nasal congestiva, faringe levemente eritematosa.",
    },
    rx: (who) => [RX.paracetamol(who)],
  },
  {
    code: "CA02.Z",
    weight: 18,
    evolution: "Odinofagia con fiebre. Analgésico y control en 72 horas si persiste.",
    found: { system: "bocaGarganta", text: "Faringe eritematosa sin exudado." },
    fever: true,
    rx: (who) => [RX.paracetamol(who)],
    leave: { days: 2, notes: "Reposo en casa e hidratación." },
  },
  {
    code: "CA03.Z",
    weight: 10,
    evolution: "Amigdalitis con placas. Antibiótico por diez días.",
    found: { system: "bocaGarganta", text: "Amígdalas hipertróficas con exudado blanquecino." },
    fever: true,
    rx: (who) => [RX.amoxicilina(who, 10), RX.paracetamol(who)],
    leave: { days: 3, notes: "Reposo en casa; volver si la fiebre sigue a las 72 horas." },
  },
  {
    code: "1A40.Z",
    weight: 16,
    evolution: "Deposiciones líquidas sin sangre. Sales de rehidratación y dieta blanda.",
    found: { system: "abdomen", text: "Ruidos aumentados, blando, sin signos de irritación." },
    rx: () => [RX.sales()],
    leave: { days: 1, notes: "Reposo en casa y dieta blanda." },
  },
]

/**
 * El control de la enfermedad crónica de la persona (`chronicOf`): la misma en
 * cada visita y con cualquier médico. Sin una, un chequeo.
 */
function chronicNote(random: Random, person: ReportsSeedPerson | null, at: Date): ReportsSeedNote {
  const chronic = chronicOf(person)
  if (!chronic)
    return {
      evolution: "Chequeo general sin hallazgos. Se piden análisis de rutina.",
      diagnosisCode: "QA00.0",
      vitals: vitals(random, person, at),
      examination: exam(),
    }
  if (chronic === "hipertension")
    return issued(
      {
        evolution:
          "Hipertensión arterial en control. Continúa con enalapril y dieta baja en sal; control en tres meses.",
        diagnosisCode: "BA00.Z",
        vitals: vitals(random, person, at, {
          presionSistolica: random.int(128, 158),
          presionDiastolica: random.int(80, 98),
        }),
        examination: exam(),
      },
      person,
      at,
      () => [RX.enalapril()],
    )
  if (chronic === "diabetes")
    return issued(
      {
        evolution:
          "Diabetes tipo 2. Metformina, plan de alimentación y caminata diaria; hemoglobina glicosilada en el próximo control.",
        diagnosisCode: "5A11",
        vitals: vitals(random, person, at, { glucosaCapilar: random.int(110, 210) }),
        examination: exam(),
      },
      person,
      at,
      () => [RX.metformina()],
    )
  if (chronic === "colesterol")
    return issued(
      {
        evolution: "Colesterol alto. Estatina y control de perfil lipídico en tres meses.",
        diagnosisCode: "5C80.0Z",
        vitals: vitals(random, person, at),
        examination: exam(),
      },
      person,
      at,
      () => [RX.atorvastatina()],
    )
  // Quien tiene obesidad la tiene en todas sus visitas: su peso es el de su diagnóstico (`vitals`).
  return {
    evolution: "Obesidad. Plan de alimentación y actividad física; control mensual de peso.",
    diagnosisCode: "5B81.01",
    vitals: vitals(random, person, at),
    examination: exam(),
  }
}

/**
 * Una consulta de medicina general o familiar: a veces el control de la
 * enfermedad crónica de la persona, si la tiene; si no, lo que le pasó.
 */
function generalNote(
  episodes: readonly Episode[],
  random: Random,
  person: ReportsSeedPerson | null,
  at: Date,
): ReportsSeedNote {
  if (chronicOf(person) && random.chance(0.35)) return chronicNote(random, person, at)
  return episodeNote(episodes, random, person, at)
}

/** Una consulta de pediatría: el control del niño sano o una enfermedad de la infancia. */
function pediatricNote(service: { name: string }, random: Random, person: ReportsSeedPerson | null, at: Date): ReportsSeedNote {
  if (/control|vacuna/i.test(service.name))
    return {
      evolution:
        "Crecimiento y desarrollo adecuados para su edad. Lactancia y alimentación según edad; próximo control indicado.",
      diagnosisCode: "QA00.Z",
      vitals: vitals(random, person, at),
      examination: exam(),
    }
  return episodeNote(
    [
      ...RESPIRATORY,
      {
        code: "AB00",
        weight: 12,
        evolution: "Otalgia derecha con fiebre. Analgésico y antibiótico; control en 48 horas.",
        found: {
          system: "cabezaCuello",
          text: "Membrana timpánica derecha abombada y eritematosa.",
        },
        fever: true,
        rx: (who) => [RX.amoxicilina(who, 7), RX.paracetamol(who)],
      },
      {
        code: "CA41.0",
        weight: 6,
        maxAge: 2,
        evolution:
          "Bronquiolitis leve. Lavados nasales, fraccionar tomas y signos de alarma explicados a la mamá.",
        found: {
          system: "toraxPulmones",
          text: "Sibilancias espiratorias leves, sin tiraje.",
        },
      },
      {
        code: "5B5K.0",
        weight: 4,
        evolution: "Palidez y hemoglobina baja. Sulfato ferroso y dieta rica en hierro.",
        rx: (who) => [who.child ? RX.sulfatoFerrosoJarabe(who) : RX.sulfatoFerroso()],
      },
    ],
    random,
    person,
    at,
  )
}

/** Una consulta de ginecología: el control prenatal o lo ginecológico. */
function gynecologyNote(service: { name: string }, random: Random, person: ReportsSeedPerson | null, at: Date): ReportsSeedNote {
  if (/obst|prenatal/i.test(service.name))
    return issued(
      {
        evolution:
          "Gestación de curso normal. Altura uterina acorde, latidos fetales presentes. Ácido fólico y hierro; próximo control en cuatro semanas.",
        diagnosisCode: "QA42.Z",
        vitals: vitals(random, person, at),
        examination: exam(),
      },
      person,
      at,
      () => [RX.acidoFolico(), RX.sulfatoFerroso()],
    )
  return episodeNote(
    [
      {
        code: "QA21.0",
        weight: 30,
        evolution: "Consejería en anticoncepción. Elige método y se indica seguimiento.",
        minAge: 15,
        maxAge: 50,
      },
      {
        code: "GA02.Z",
        weight: 22,
        evolution: "Flujo con prurito. Fluconazol en una sola toma y control si persiste.",
        found: {
          system: "genitourinario",
          text: "Flujo blanquecino grumoso, mucosa eritematosa.",
        },
        rx: () => [RX.fluconazol()],
      },
      {
        code: "GA30.0Z",
        weight: 10,
        evolution: "Bochornos y alteración del sueño. Medidas generales y control en tres meses.",
        minAge: 45,
      },
      {
        code: "QA00.Z",
        weight: 28,
        evolution: "Control ginecológico anual. Se toma Papanicolaou; resultado en diez días.",
        minAge: 21,
      },
      {
        code: "QA00.Z",
        weight: 28,
        evolution: "Control ginecológico anual sin hallazgos. Papanicolaou desde los 21 años.",
        maxAge: 21,
      },
    ],
    random,
    person,
    at,
  )
}

/** Lo de un consultorio de medicina general: lo agudo y, en un adulto, también lo crónico. */
const GENERAL_EPISODES: readonly Episode[] = [
  ...RESPIRATORY,
  {
    code: "ME84.2Z",
    weight: 12,
    evolution:
      "Dolor lumbar mecánico tras esfuerzo. Antiinflamatorio, calor local y pausas activas.",
    found: {
      system: "extremidades",
      text: "Contractura paravertebral lumbar, Lasègue negativo.",
    },
    rx: () => [RX.ibuprofeno()],
    leave: { days: 3, notes: "Reposo relativo; no cargar peso." },
  },
  {
    code: "8A81.Z",
    weight: 8,
    evolution: "Cefalea tensional por estrés laboral. Analgésico y control si se repite.",
    minAge: 18,
    rx: (who) => [RX.paracetamol(who)],
  },
  {
    code: "QA00.0",
    weight: 10,
    evolution: "Chequeo general sin hallazgos. Se piden análisis de rutina.",
  },
]

export const MEDICAL_DEMO_KINDS: readonly DemoKindRecipe[] = [
  {
    key: "medicina_general",
    product: "medical",
    name: "Medicina general",
    hint: "Fiebre, dolor, chequeos",
    clinicNames: [
      "Consultorio Médico {lugar}",
      "Centro Médico {lugar}",
      "Medicina General {lugar}",
    ],
    professional: { title: { F: "Médica cirujana", M: "Médico cirujano" }, specialty: "general" },
    specialtyWho: MEDICAL_SPECIALTY_WHO,
    services: [
      {
        template: "consulta-medicina-general",
        price: 80,
        durationMin: 20,
        weight: 40,
        firstVisit: true,
      },
      { template: "consulta-de-control", price: 50, durationMin: 15, weight: 22 },
      { template: "nebulizacion", price: 35, durationMin: 20, weight: 8 },
      { template: "inyectable-intramuscular", price: 20, durationMin: 10, weight: 9 },
      { template: "sutura-simple", price: 120, durationMin: 30, weight: 2 },
      { template: "retiro-de-puntos", price: 40, durationMin: 15, weight: 2 },
      { template: "electrocardiograma", price: 70, durationMin: 20, weight: 4, who: { minAge: 12 } },
      { template: "glucosa-capilar", price: 15, durationMin: 10, weight: 6 },
    ],
    person: (random) => adult(random, 16, 78),
    note: (_service, random, person, at) => generalNote(GENERAL_EPISODES, random, person, at),
    inbound: [
      "Hola, ¿tienen cita hoy? Tengo fiebre desde ayer",
      "Buenas, quisiera una consulta para un chequeo",
      "¿Atienden el sábado? Me duele la espalda",
      "Hola, necesito que me pongan una inyección que me recetaron",
    ],
    reply: [
      "Hola, sí. Hoy tenemos a las 4:15 p. m. o a las 5:00 p. m. ¿Cuál le acomoda?",
      "Con gusto. ¿Qué día le queda mejor esta semana?",
      "Sí atendemos el sábado de 9 a 1. ¿Le reservo a las 10:00?",
      "Sí, ponemos inyectables con la receta del médico. ¿A qué hora puede venir?",
    ],
    openTopics: [
      "¿Puedo ir con mi esposo y que lo vean a los dos en la misma cita?",
      "¿Aceptan mi seguro de la empresa?",
      "Me dieron un resultado de análisis, ¿{la doctora} lo puede revisar por aquí?",
    ],
    followUp: null,
    budgets: false,
    occupancy: 0.72,
    expenses: GENERAL_EXPENSES,
    inventory: MEDICAL_INVENTORY,
    promotions: [
      {
        template: "glucosa-capilar",
        name: "Chequeo de glucosa",
        conditions: "Medición en ayunas, con el resultado en el momento.",
        price: 10,
        when: "vigente",
      },
      {
        template: "electrocardiograma",
        name: "Electrocardiograma a precio especial",
        conditions: "Con la consulta del mismo día.",
        price: 50,
        when: "terminada",
      },
    ],
    knowledge: MEDICAL_KNOWLEDGE,
  },
  {
    key: "pediatria",
    product: "medical",
    name: "Pediatría",
    hint: "Niños con su responsable",
    clinicNames: [
      "Pediatría {lugar}",
      "Consultorio Pediátrico {lugar}",
      "Centro Pediátrico {lugar}",
    ],
    professional: { title: { F: "Médica pediatra", M: "Médico pediatra" }, specialty: "pediatria" },
    specialtyWho: MEDICAL_SPECIALTY_WHO,
    services: [
      { template: "consulta-pediatria", price: 100, durationMin: 20, weight: 38, firstVisit: true },
      { template: "control-nino-sano-menor-1", price: 90, durationMin: 30, weight: 14, who: { maxAge: 0 } },
      {
        template: "control-nino-sano-1-a-4",
        price: 90,
        durationMin: 30,
        weight: 12,
        who: { minAge: 1, maxAge: 4 },
      },
      {
        template: "control-nino-sano-5-a-11",
        price: 90,
        durationMin: 30,
        weight: 8,
        who: { minAge: 5, maxAge: 11 },
      },
      { template: "aplicacion-de-vacuna", price: 30, durationMin: 10, weight: 10 },
      { template: "nebulizacion", price: 35, durationMin: 20, weight: 10 },
    ],
    person: (random, country) => child(random, country, 13),
    note: (service, random, person, at) => pediatricNote(service, random, person, at),
    inbound: [
      "Hola, mi hijo tiene fiebre desde anoche, ¿tienen cita hoy?",
      "Buenas, quisiera el control de mi bebé de 6 meses",
      "Hola, ¿cuándo le toca su vacuna a mi hija?",
      "Mi niña tiene tos hace tres días, ¿la pueden ver?",
    ],
    reply: [
      "Hola, sí. Hoy hay a las 3:45 p. m. ¿Le reservo a nombre del niño?",
      "Con gusto. ¿Me confirma el nombre del bebé y qué día le queda mejor?",
      "Depende de su edad y de su carné de vacunas. Tráigalo al control y ahí se la ponen. ¿Le reservo?",
      "Sí, mañana a las 10:00 hay espacio. ¿Le reservo a nombre de la niña?",
    ],
    openTopics: [
      "¿{La doctora} puede ver a mis dos hijos en la misma cita?",
      "Mi hijo vomitó después de la vacuna, ¿es normal?",
      "¿Me pueden mandar el carné de vacunas por aquí?",
    ],
    followUp: { title: "Control de niño sano", everyMonths: 3 },
    budgets: false,
    occupancy: 0.78,
    expenses: GENERAL_EXPENSES,
    inventory: MEDICAL_INVENTORY,
    promotions: [
      {
        template: "nebulizacion",
        name: "Nebulización a precio especial",
        conditions: "Para niños con indicación médica de nebulizar.",
        price: 25,
        when: "vigente",
      },
      {
        template: "control-nino-sano-1-a-4",
        name: "Control del niño sano",
        conditions: "De 1 a 4 años, con peso, talla y desarrollo.",
        price: 70,
        when: "terminada",
      },
    ],
    knowledge: [
      ...MEDICAL_KNOWLEDGE,
      {
        title: "¿Atienden a niños? ¿Desde qué edad?",
        body: "Sí, atendemos desde recién nacidos hasta los 17 años, siempre con un adulto responsable.",
      },
    ],
  },
  {
    key: "ginecologia_obstetricia",
    product: "medical",
    name: "Ginecología y obstetricia",
    hint: "Embarazos y controles",
    clinicNames: ["Centro Materno {lugar}", "Ginecología {lugar}", "Clínica de la Mujer {lugar}"],
    professional: {
      title: { F: "Médica ginecóloga", M: "Médico ginecólogo" },
      specialty: "ginecologia",
    },
    specialtyWho: MEDICAL_SPECIALTY_WHO,
    services: [
      {
        template: "consulta-ginecologia",
        price: 120,
        durationMin: 25,
        weight: 34,
        firstVisit: true,
      },
      { template: "papanicolaou", price: 60, durationMin: 15, weight: 12, who: { minAge: 21 } },
      {
        template: "ecografia-obstetrica",
        price: 120,
        durationMin: 20,
        weight: 14,
        who: { minAge: 15, maxAge: 49 },
      },
      { template: "ecografia-transvaginal", price: 110, durationMin: 20, weight: 8, who: { minAge: 15 } },
      {
        template: "colocacion-de-diu",
        price: 250,
        durationMin: 30,
        weight: 3,
        who: { minAge: 15, maxAge: 49 },
      },
      {
        template: "colocacion-de-implante-anticonceptivo",
        price: 300,
        durationMin: 20,
        weight: 2,
        who: { minAge: 15, maxAge: 49 },
      },
    ],
    person: (random) => adult(random, 18, 58, 1),
    note: (service, random, person, at) => gynecologyNote(service, random, person, at),
    inbound: [
      "Hola, estoy embarazada de 8 semanas y quisiera mi primer control",
      "Buenas, me toca mi Papanicolaou, ¿tienen cita esta semana?",
      "Hola, quisiera información para ponerme el implante",
      "¿{La doctora} hace ecografías el mismo día?",
    ],
    reply: [
      "¡Felicidades! ¿Le reservo su primer control el martes a las 10:00?",
      "Sí, hay el jueves a las 4:00 p. m. Recuerde no tener relaciones 48 horas antes.",
      "Con gusto. Se coloca en una consulta corta, después de una evaluación. ¿Le reservo la evaluación?",
      "Sí, la ecografía se puede hacer en la misma consulta. ¿Qué día le acomoda?",
    ],
    openTopics: [
      "Tengo un sangrado leve y estoy de 10 semanas, ¿qué hago?",
      "¿Mi pareja puede entrar a la ecografía?",
      "¿Ya salió mi resultado del Papanicolaou?",
    ],
    // El control prenatal es de quien está embarazada: después de una atención de su gestación.
    // De la gestación de ahora: se indica hasta 8 meses después de su atención y, pasado el noveno, ya no corresponde.
    followUp: {
      title: "Control prenatal",
      everyMonths: 1,
      diagnoses: ["QA42.Z"],
      validMonths: 8,
      expired: "Terminó la gestación",
    },
    budgets: false,
    occupancy: 0.74,
    expenses: GENERAL_EXPENSES,
    inventory: MEDICAL_INVENTORY,
    promotions: [
      {
        template: "papanicolaou",
        name: "Papanicolaou preventivo",
        conditions: "Una toma por persona; el resultado llega en unos 10 días.",
        price: 45,
        when: "vigente",
      },
      {
        template: "ecografia-obstetrica",
        name: "Ecografía obstétrica a precio especial",
        conditions: "Para gestantes en control con nosotros.",
        price: 95,
        when: "terminada",
      },
    ],
    knowledge: [
      ...MEDICAL_KNOWLEDGE,
      {
        title: "¿Atienden a embarazadas?",
        body: "Sí, hacemos el control prenatal completo, con sus ecografías, desde el primer mes.",
      },
    ],
  },
  {
    key: "medicina_interna",
    product: "medical",
    name: "Medicina interna",
    hint: "Presión, diabetes, crónicos",
    clinicNames: [
      "Medicina Interna {lugar}",
      "Consultorio de Medicina Interna {lugar}",
      "Centro de Enfermedades Crónicas {lugar}",
    ],
    professional: {
      title: { F: "Médica internista", M: "Médico internista" },
      specialty: "interna",
    },
    specialtyWho: MEDICAL_SPECIALTY_WHO,
    services: [
      {
        template: "consulta-medicina-interna",
        price: 130,
        durationMin: 25,
        weight: 30,
        firstVisit: true,
      },
      { template: "consulta-de-control", price: 80, durationMin: 20, weight: 40 },
      { template: "electrocardiograma", price: 70, durationMin: 20, weight: 8 },
      { template: "glucosa-capilar", price: 15, durationMin: 10, weight: 12 },
      { template: "toma-de-muestra-de-sangre", price: 25, durationMin: 10, weight: 8 },
    ],
    person: (random) => adult(random, 38, 84, 0.55),
    note: (_service, random, person, at) => chronicNote(random, person, at),
    inbound: [
      "Hola, me toca mi control de presión, ¿hay cita esta semana?",
      "Buenas, se me acabaron las pastillas de la diabetes",
      "Hola, quisiera una consulta, tengo la glucosa alta",
      "¿{La doctora} puede ver mis análisis?",
    ],
    reply: [
      "Hola, sí. ¿Le reservo el control el miércoles a las 9:00?",
      "La receta se renueva en el control. ¿Le reservo mañana a las 11:00?",
      "Con gusto. Traiga sus análisis a la consulta. ¿Qué día le acomoda?",
      "Sí, tráigalos a su consulta y ahí se revisan. ¿Le reservo?",
    ],
    openTopics: [
      "Mi presión está en 160/100 esta mañana, ¿adelanto la cita?",
      "¿Puedo tomar el enalapril con la pastilla del resfrío?",
      "Falté a mi último control, ¿puedo reprogramar?",
    ],
    followUp: { title: "Control de presión y glucosa", everyMonths: 3, diagnoses: ["BA00.Z", "5A11"] },
    budgets: false,
    occupancy: 0.7,
    expenses: GENERAL_EXPENSES,
    inventory: MEDICAL_INVENTORY,
    promotions: [
      {
        template: "glucosa-capilar",
        name: "Control de glucosa",
        conditions: "Para pacientes en control de diabetes, con el resultado en el momento.",
        price: 10,
        when: "vigente",
      },
      {
        template: "electrocardiograma",
        name: "Electrocardiograma de control",
        conditions: "Con la consulta de control del mismo día.",
        price: 55,
        when: "terminada",
      },
    ],
    knowledge: MEDICAL_KNOWLEDGE,
  },
  {
    key: "medicina_familiar",
    product: "medical",
    name: "Medicina familiar",
    hint: "Familias enteras",
    clinicNames: [
      "Medicina Familiar {lugar}",
      "Consultorio Familiar {lugar}",
      "Salud Familiar {lugar}",
    ],
    professional: {
      title: { F: "Médica de familia", M: "Médico de familia" },
      specialty: "familiar",
    },
    specialtyWho: MEDICAL_SPECIALTY_WHO,
    services: [
      {
        template: "consulta-medicina-familiar",
        price: 90,
        durationMin: 20,
        weight: 38,
        firstVisit: true,
      },
      { template: "consulta-de-control", price: 55, durationMin: 15, weight: 18 },
      {
        template: "chequeo-preventivo-adulto",
        price: 150,
        durationMin: 30,
        weight: 10,
        who: { minAge: 30, maxAge: 59 },
      },
      {
        template: "chequeo-preventivo-adulto-mayor",
        price: 160,
        durationMin: 30,
        weight: 6,
        who: { minAge: 60 },
      },
      { template: "planificacion-familiar", price: 60, durationMin: 20, weight: 6, who: { minAge: 15 } },
      { template: "aplicacion-de-vacuna", price: 30, durationMin: 10, weight: 8 },
    ],
    person: (random, country) =>
      random.chance(0.3) ? child(random, country, 15) : adult(random, 18, 82),
    note: (service, random, person, at) =>
      /chequeo|preventivo/i.test(service.name)
        ? {
            evolution:
              "Chequeo preventivo anual. Peso, presión y análisis de rutina; consejería en hábitos.",
            diagnosisCode: "QA00.0",
            vitals: vitals(random, person, at),
            examination: exam(),
          }
        : generalNote(
            // La anticoncepción es de 15 a 49 años; la enfermedad crónica, de la persona.
            [
              ...RESPIRATORY,
              { code: "QA21.0", weight: 6, evolution: "Consejería en planificación familiar.", minAge: 15, maxAge: 50 },
            ],
            random,
            person,
            at,
          ),
    inbound: [
      "Hola, quisiera cita para mí y para mi mamá",
      "Buenas, ¿hacen el chequeo anual completo?",
      "Hola, mi hijo tiene tos, ¿lo pueden ver hoy?",
      "¿Cuánto cuesta el chequeo para mayores de 60?",
    ],
    reply: [
      "Con gusto. Le reservo dos citas seguidas el viernes a las 10:00 y 10:30, ¿le parece?",
      "Sí, el chequeo incluye examen y presión, y ahí se piden los análisis que hagan falta. ¿Qué día le acomoda?",
      "Sí, hoy hay a las 5:15 p. m. ¿Le reservo a nombre del niño?",
      "El chequeo del adulto mayor tiene precio especial este mes. ¿Le reservo uno?",
    ],
    openTopics: [
      "¿Pueden atender a toda la familia el mismo día?",
      "¿El chequeo incluye los análisis o se pagan aparte?",
      "Mi papá no puede venir, ¿hacen visitas a domicilio?",
    ],
    followUp: { title: "Chequeo preventivo anual", everyMonths: 12 },
    budgets: false,
    occupancy: 0.7,
    expenses: GENERAL_EXPENSES,
    inventory: MEDICAL_INVENTORY,
    promotions: [
      {
        template: "chequeo-preventivo-adulto-mayor",
        name: "Chequeo del adulto mayor",
        conditions: "Para mayores de 60 años, una vez al año.",
        price: 130,
        when: "vigente",
      },
      {
        template: "chequeo-preventivo-adulto",
        name: "Chequeo preventivo",
        conditions: "Para mayores de 18 años, una vez al año.",
        price: 120,
        when: "terminada",
      },
    ],
    knowledge: MEDICAL_KNOWLEDGE,
  },
  {
    key: "policlinico",
    product: "medical",
    name: "Policlínico",
    // Las especialidades que tiene dependen del tamaño: cada una con quien la atiende.
    hint: "Varias especialidades",
    clinicNames: ["Policlínico {lugar}", "Centro Médico {lugar}", "Policlínico San {lugar}"],
    professional: { title: { F: "Médica cirujana", M: "Médico cirujano" }, specialty: "general" },
    specialtyRotation: [
      "general",
      "pediatria",
      "ginecologia",
      "interna",
      "familiar",
      "general",
      "pediatria",
      "interna",
    ],
    specialtyWho: MEDICAL_SPECIALTY_WHO,
    // Cada especialidad tiene su consulta de primera vez; la que nadie del equipo atiende no se ofrece.
    services: [
      {
        template: "consulta-medicina-general",
        price: 80,
        durationMin: 20,
        weight: 26,
        firstVisit: true,
        specialty: "general",
      },
      {
        template: "consulta-pediatria",
        price: 100,
        durationMin: 20,
        weight: 14,
        firstVisit: true,
        specialty: "pediatria",
      },
      {
        template: "consulta-ginecologia",
        price: 120,
        durationMin: 25,
        weight: 10,
        firstVisit: true,
        specialty: "ginecologia",
      },
      {
        template: "consulta-medicina-interna",
        price: 130,
        durationMin: 25,
        weight: 10,
        firstVisit: true,
        specialty: "interna",
      },
      {
        template: "consulta-medicina-familiar",
        price: 90,
        durationMin: 20,
        weight: 8,
        firstVisit: true,
        specialty: "familiar",
      },
      { template: "consulta-de-control", price: 55, durationMin: 15, weight: 14 },
      { template: "nebulizacion", price: 35, durationMin: 20, weight: 5 },
      { template: "electrocardiograma", price: 70, durationMin: 20, weight: 4, who: { minAge: 12 } },
      { template: "ecografia-abdominal", price: 120, durationMin: 20, weight: 4 },
    ],
    person: (random, country) =>
      random.chance(0.25) ? child(random, country, 13) : adult(random, 16, 80),
    // Cada consulta escribe lo de su especialidad; lo demás, lo de medicina general, y a un niño solo lo de la infancia.
    note: (service, random, person, at) =>
      /pediatr/i.test(service.name)
        ? pediatricNote(service, random, person, at)
        : /ginecolog/i.test(service.name)
          ? gynecologyNote(service, random, person, at)
          : /interna/i.test(service.name)
            ? chronicNote(random, person, at)
            : generalNote(ageAt(person, at) < 18 ? RESPIRATORY : GENERAL_EPISODES, random, person, at),
    // Sofi dice lo que hay: las especialidades salen del equipo de la demo, sin sedes ni nombres.
    inbound: [
      "Hola, ¿qué especialidades atienden?",
      "Buenas, quisiera una cita para hoy",
      "¿Atienden los sábados?",
      "Hola, quisiera un chequeo general",
    ],
    reply: [
      "Atendemos {especialidades}. ¿Para quién es la cita?",
      "Hola, sí. Hoy hay a las 4:00 p. m. ¿Le reservo?",
      "Sí, los sábados atendemos de 9 a 1. ¿Le reservo a las 10:00?",
      "Con gusto. ¿Qué día le queda mejor esta semana?",
    ],
    openTopics: [
      "Si el médico me deriva a otra especialidad, ¿pago otra consulta?",
      "¿Tienen estacionamiento cerca?",
      "Quiero cambiar mi cita del jueves para el sábado",
    ],
    followUp: { title: "Control de presión y glucosa", everyMonths: 3, diagnoses: ["BA00.Z", "5A11"] },
    budgets: false,
    occupancy: 0.75,
    expenses: GENERAL_EXPENSES,
    inventory: MEDICAL_INVENTORY,
    promotions: [
      {
        template: "electrocardiograma",
        name: "Electrocardiograma de control",
        conditions: "Con la consulta del mismo día.",
        price: 55,
        when: "vigente",
      },
      {
        template: "ecografia-abdominal",
        name: "Ecografía abdominal a precio especial",
        conditions: "Con orden de uno de nuestros médicos.",
        price: 95,
        when: "terminada",
      },
    ],
    knowledge: MEDICAL_KNOWLEDGE,
  },
]
