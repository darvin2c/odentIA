import type { DemoCountry, DemoKindRecipe } from "../demo-recipes.js"
import { birthDateForAge } from "../demo-recipes.js"
import type { Random, ReportsSeedNote, ReportsSeedPerson } from "../seed-reports.js"
import { ageOn } from "../seed-reports.js"
import type { EyeExam } from "@odentia/optical"

/**
 * Los tipos de demo de vistIA: la óptica de barrio, que examina la vista y
 * vende los lentes (la más común en Perú, Colombia y México), y la que además
 * hace terapia visual a niños. Varias sedes no es un tipo: sale del tamaño
 * grande. Los diagnósticos son de la CIE-11 oficial (capítulo 09 y el examen
 * de la vista, QA00.6); los servicios, de la biblioteca óptica
 * (`biblioteca_optica.csv`), con su especialidad. Las monturas, las lunas y los
 * lentes de contacto no son servicios: son productos del inventario, que se
 * venden. vistIA cotiza con el pedido de lentes, no con el presupuesto clínico.
 */

const OPTICAL_EXPENSES: DemoKindRecipe["expenses"] = [
  {
    category: "Personal",
    concept: "Planilla del mes",
    // Quienes venden y el técnico que arma los lentes.
    cents: 2_400_00,
    // El sueldo base de cada optómetra, con su nombre (va junto a su comisión).
    perStaffCents: 1_000_00,
    day: 28,
  },
  { category: "Alquiler", concept: "Alquiler del local", rent: true, day: 1 },
  { category: "Laboratorio", concept: "Lunas del laboratorio óptico", revenueShare: 0.1, day: 20 },
  { category: "Materiales", concept: "Insumos de la óptica", revenueShare: 0.03, day: 12 },
  { category: "Servicios", concept: "Luz, agua e internet", cents: 450_00, day: 18 },
]

/**
 * Lo que guarda una óptica en Inventario. Entra lo que no gasta ningún
 * servicio (lo que se vende y lo retirado) y lo que gasta algún servicio de su
 * tipo: una óptica sin terapia visual no guarda parches para niños.
 */
const OPTICAL_INVENTORY: DemoKindRecipe["inventory"] = {
  suppliers: ["Distribuidora Óptica Central", "Monturas y Lentes del Pacífico"],
  products: [
    {
      sku: "INS-TOALLITA-ALCOHOL",
      name: "Toallitas con alcohol isopropílico",
      unit: "toallita",
      purchase: { unit: "caja", factor: 100 },
      cost: 18,
      min: 100,
    },
    {
      sku: "INS-TIRA-FLUORESCEINA",
      name: "Tiras de fluoresceína",
      unit: "tira",
      purchase: { unit: "caja", factor: 100 },
      cost: 70,
      min: 30,
    },
    {
      sku: "PRO-LC-PRUEBA",
      name: "Lentes de contacto de prueba",
      unit: "lente",
      purchase: { unit: "caja", factor: 6 },
      cost: 40,
      min: 12,
    },
    {
      sku: "PRO-ESTUCHE-LC",
      name: "Estuche para lentes de contacto",
      unit: "estuche",
      purchase: { unit: "bolsa", factor: 50 },
      cost: 75,
      min: 20,
    },
    {
      sku: "VEN-SOLUCION-360",
      name: "Solución multipropósito 360 ml",
      unit: "frasco",
      purchase: { unit: "caja", factor: 12 },
      cost: 168,
      min: 6,
      // Se vende y va en el kit de la adaptación de lentes de contacto.
      sale: 35,
    },
    {
      sku: "PRO-ESTUCHE-ANTEOJOS",
      name: "Estuche para anteojos",
      unit: "estuche",
      purchase: { unit: "caja", factor: 50 },
      cost: 150,
      min: 30,
    },
    {
      sku: "PRO-PANO-MICROFIBRA",
      name: "Paño de microfibra",
      unit: "paño",
      purchase: { unit: "bolsa", factor: 100 },
      cost: 90,
      min: 50,
    },
    {
      sku: "INS-REPUESTO-TALLER",
      name: "Tornillos y plaquetas de repuesto",
      unit: "juego",
      purchase: { unit: "bolsa", factor: 50 },
      cost: 60,
      min: 20,
    },
    {
      sku: "INS-PARCHE-OCULAR",
      name: "Parches oculares para niños",
      unit: "parche",
      purchase: { unit: "caja", factor: 50 },
      cost: 55,
      min: 20,
    },
    {
      sku: "VEN-MONTURA-ACETATO",
      name: "Montura de acetato",
      unit: "montura",
      cost: 45,
      min: 10,
      sale: 150,
      onlySale: true,
    },
    {
      sku: "VEN-LUNA-ANTIRREFLEJO",
      name: "Lunas monofocales con antirreflejo",
      unit: "par",
      cost: 35,
      min: 10,
      sale: 120,
      onlySale: true,
    },
    {
      sku: "VEN-LC-MENSUAL",
      name: "Lentes de contacto mensuales, caja de 6",
      unit: "caja",
      cost: 55,
      min: 6,
      sale: 120,
      onlySale: true,
    },
    {
      sku: "VEN-LC-COLOR",
      name: "Lentes de contacto de colores",
      unit: "par",
      cost: 30,
      min: 4,
      sale: 90,
      onlySale: true,
    },
    {
      sku: "VEN-GOTAS-LUBRICANTES",
      name: "Gotas lubricantes 10 ml",
      unit: "frasco",
      purchase: { unit: "caja", factor: 12 },
      cost: 120,
      min: 6,
      sale: 22,
      onlySale: true,
    },
    {
      sku: "VEN-LENTES-SOL",
      name: "Lentes de sol con filtro UV400",
      unit: "unidad",
      cost: 40,
      min: 6,
      sale: 120,
      onlySale: true,
    },
    {
      sku: "VEN-LUNA-VIDRIO",
      name: "Lunas de vidrio mineral",
      unit: "par",
      cost: 20,
      min: 0,
      retired: true,
    },
  ],
  materials: {
    // La mentonera y el oclusor se limpian con cada persona.
    "examen-de-la-vista": [{ sku: "INS-TOALLITA-ALCOHOL", quantity: 2 }],
    "control-de-la-vista": [{ sku: "INS-TOALLITA-ALCOHOL", quantity: 2 }],
    "examen-de-la-vista-ninos": [{ sku: "INS-TOALLITA-ALCOHOL", quantity: 2 }],
    tonometria: [{ sku: "INS-TOALLITA-ALCOHOL", quantity: 1 }],
    retinografia: [{ sku: "INS-TOALLITA-ALCOHOL", quantity: 1 }],
    // La adaptación lleva los lentes de prueba y el kit de inicio: estuche y solución.
    "adaptacion-lentes-de-contacto": [
      { sku: "PRO-LC-PRUEBA", quantity: 2 },
      { sku: "INS-TIRA-FLUORESCEINA", quantity: 1 },
      { sku: "PRO-ESTUCHE-LC", quantity: 1 },
      { sku: "VEN-SOLUCION-360", quantity: 1 },
    ],
    "control-lentes-de-contacto": [{ sku: "INS-TIRA-FLUORESCEINA", quantity: 1 }],
    // Los anteojos se entregan con su estuche y su paño.
    "adaptacion-anteojos-monofocales": [
      { sku: "PRO-ESTUCHE-ANTEOJOS", quantity: 1 },
      { sku: "PRO-PANO-MICROFIBRA", quantity: 1 },
    ],
    "adaptacion-anteojos-progresivos": [
      { sku: "PRO-ESTUCHE-ANTEOJOS", quantity: 1 },
      { sku: "PRO-PANO-MICROFIBRA", quantity: 1 },
    ],
    "reparacion-de-anteojos": [{ sku: "INS-REPUESTO-TALLER", quantity: 1 }],
    "evaluacion-vision-binocular": [{ sku: "INS-PARCHE-OCULAR", quantity: 1 }],
    "terapia-visual": [
      { sku: "INS-PARCHE-OCULAR", quantity: 1 },
      { sku: "INS-TOALLITA-ALCOHOL", quantity: 1 },
    ],
  },
  low: ["INS-TIRA-FLUORESCEINA", "PRO-ESTUCHE-ANTEOJOS", "VEN-LC-MENSUAL", "INS-PARCHE-OCULAR"],
  expiring: [
    "VEN-SOLUCION-360",
    "INS-TIRA-FLUORESCEINA",
    "INS-TOALLITA-ALCOHOL",
    "PRO-LC-PRUEBA",
    "INS-PARCHE-OCULAR",
  ],
}

/**
 * Lo que Sofi ya tiene respondido en una óptica: solo lo que no está en los
 * datos (ADR 0120). El horario sale del equipo de la demo y lo de la salud de
 * los ojos lo atiende un optómetra: no se escriben aquí.
 */
const OPTICAL_KNOWLEDGE: DemoKindRecipe["knowledge"] = [
  {
    title: "¿Atienden sin cita?",
    body: "La medida de la vista es con cita, para que no tengas que esperar. Para elegir tu montura, recoger tus lentes o ajustarlos puedes venir sin cita en nuestro horario.",
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
    body: "Tu documento de identidad y los lentes que usas ahora, con tu última medida si la tienes. Si usas lentes de contacto, tráelos también.",
    basicKey: "primera_cita",
  },
  {
    title: "¿Cuánto demoran mis lentes?",
    body: "Depende de las lunas: las que tenemos en la óptica pueden estar el mismo día y las de laboratorio, como las progresivas, demoran de 3 a 7 días hábiles. Al encargarlos te damos la fecha de entrega.",
    askForms: ["¿Cuándo están listos mis lentes?"],
  },
]

function adult(random: Random, minAge: number, maxAge: number): ReportsSeedPerson {
  return {
    birthDate: birthDateForAge(random.int(minAge, maxAge), random),
    sex: random.chance(0.58) ? "F" : "M",
  }
}

/** Un menor con quien lo trae: casi siempre la mamá. */
function minor(random: Random, country: DemoCountry, minAge: number, maxAge: number): ReportsSeedPerson {
  const mother = random.chance(0.78)
  return {
    birthDate: birthDateForAge(random.int(minAge, maxAge), random),
    sex: random.chance(0.5) ? "F" : "M",
    guardian: {
      givenNames: random.pick(mother ? country.given.F : country.given.M),
      familyName: `${random.pick(country.surnames)} ${random.pick(country.surnames)}`,
      kinship: mother ? "MTH" : "FTH",
    },
  }
}

/** Los diagnósticos de las notas, de la CIE-11 oficial (MMS 2026-01, en español). */
const DX = {
  /** Miopía. */
  miopia: "9D00.0",
  /** Hipermetropía. */
  hipermetropia: "9D00.1",
  /** Astigmatismo. */
  astigmatismo: "9D00.2",
  /** Presbicia. */
  presbicia: "9D00.3",
  /** Anisometropía. */
  anisometropia: "9D00.4",
  /** Queratoconjuntivitis seca. */
  ojoSeco: "9A79",
  /** Fatiga ocular. */
  fatiga: "9D50",
  /** Conjuntivitis alérgica. */
  alergia: "9A60.02",
  /** Catarata relacionada con la edad, sin especificación. */
  catarata: "9B10.0Z",
  /** Sospecha de glaucoma. */
  glaucoma: "9C60",
  /** Insuficiencia de convergencia. */
  convergencia: "9C83.2",
  /** Heteroforia. */
  foria: "9C80.4",
  /** Infiltrados corneales asociados a lentes de contacto. */
  infiltrados: "9A77.0",
  /** Sin deficiencia de la visión. */
  sinDeficiencia: "QA00.62",
  /** Examen de los ojos o de la visión, sin especificación. */
  examen: "QA00.6Z",
} as const

/**
 * Un número de 0 a 1 propio de cada persona: sale de su nacimiento y su sexo,
 * así que es el mismo en todas sus visitas, las de la historia y las de la
 * agenda, y con cualquier optómetra.
 */
function traitOf(person: ReportsSeedPerson | null, salt: string): number {
  const key = person ? `${person.birthDate.slice(0, 10)}:${person.sex}` : "sin-datos"
  let hash = 2166136261
  for (const char of `${salt}:${key}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}

/**
 * El año con que se cuenta la edad para la medida de cada persona: uno fijo,
 * para que nadie cambie de medida de un día a otro cuando cumple años.
 */
const REFRACTION_REFERENCE_YEAR = 2026

type Refraction = "miopia" | "hipermetropia" | "astigmatismo" | "ninguna"

/**
 * La medida de cada persona, la misma en todas sus visitas. A un niño pequeño
 * casi nunca le sale miopía (aparece en la edad escolar); la presbicia llega con
 * la edad, encima de la que ya tiene.
 */
function refractionOf(person: ReportsSeedPerson | null): Refraction {
  const value = traitOf(person, "refraccion")
  const age = person ? REFRACTION_REFERENCE_YEAR - Number(person.birthDate.slice(0, 4)) : 40
  if (age < 7) return value < 0.45 ? "hipermetropia" : value < 0.7 ? "astigmatismo" : "ninguna"
  return value < 0.4 ? "miopia" : value < 0.62 ? "astigmatismo" : value < 0.78 ? "hipermetropia" : "ninguna"
}

const refractionCode = (refraction: Refraction): string =>
  refraction === "ninguna" ? DX.sinDeficiencia : DX[refraction]

/** Lo que se escribe de la medida de cada persona: la primera vez, en el control y a un niño. */
const REFRACTION_TEXT: Record<Refraction, { exam: string; control: string; child: string }> = {
  miopia: {
    exam: "Refracción: miopía en ambos ojos, no ve bien de lejos. Se indican lentes para ver de lejos.",
    control: "Control: la miopía subió un poco en ambos ojos. Se actualiza la medida de las lunas.",
    child: "Miopía: no ve bien la pizarra. Se indican lentes para el colegio y control en un año.",
  },
  hipermetropia: {
    exam: "Refracción: hipermetropía leve, se cansa al leer. Se indican lentes para cerca y para la computadora.",
    control: "Control: hipermetropía estable. Se mantiene la medida y se cambian las lunas rayadas.",
    child: "Hipermetropía: ve bien, pero se cansa al leer y al hacer tareas. Se indican lentes para el colegio.",
  },
  astigmatismo: {
    exam: "Refracción: astigmatismo en ambos ojos, visión borrosa de lejos y de cerca. Se indican lentes de uso permanente.",
    control: "Control: astigmatismo estable. Se mantiene la medida; ve bien con sus lentes.",
    child: "Astigmatismo: entrecierra los ojos para ver. Se indican lentes de uso permanente.",
  },
  ninguna: {
    exam: "Agudeza visual de 20/20 en ambos ojos sin lentes. No necesita lentes por ahora; control en un año.",
    control: "Control: sigue viendo 20/20 en ambos ojos sin lentes. Control en un año.",
    child: "Ve bien de lejos y de cerca para su edad. No necesita lentes; control en un año.",
  },
}

/** Una dioptría de la demo: en pasos de 0,25, como se fabrica. */
const quarter = (value: number) => Math.round(value * 4) / 4

/**
 * El examen de la vista de cada persona (entrega 3), coherente con su medida: la
 * refracción de cada ojo según su miopía, hipermetropía o astigmatismo, la adición
 * desde los 42 y su distancia pupilar. Es el mismo en todas sus visitas.
 */
function eyeExamOf(person: ReportsSeedPerson | null, age: number): EyeExam {
  const refraction = refractionOf(person)
  const strength = traitOf(person, "graduacion")
  const axis = traitOf(person, "eje") < 0.6 ? 180 : 90
  const sphere =
    refraction === "miopia"
      ? -quarter(0.75 + strength * 3.25)
      : refraction === "hipermetropia"
        ? quarter(0.75 + strength * 1.75)
        : refraction === "astigmatismo"
          ? -quarter(strength * 1.25)
          : 0
  const cylinder = refraction === "astigmatismo" ? -quarter(0.75 + strength * 1.25) : undefined
  const add = age >= 42 ? quarter(Math.min(2.5, 1 + (age - 42) * 0.0833)) : undefined
  const eye = (offset: number) => ({
    ...(refraction !== "ninguna" || add !== undefined ? { esfera: quarter(sphere + offset) } : {}),
    ...(cylinder !== undefined ? { cilindro: cylinder, eje: axis } : {}),
    ...(add !== undefined ? { adicion: add } : {}),
  })
  const blurred = refraction === "ninguna" ? "20/20" : refraction === "miopia" ? (strength > 0.5 ? "20/200" : "20/80") : "20/40"
  const half = 30 + Math.round(traitOf(person, "dp") * 6) / 2
  const refractionPart = refraction === "ninguna" && add === undefined ? {} : { refraccion: { od: eye(0), oi: eye(sphere < 0 ? -0.25 : 0) } }
  return {
    antecedentes: { usaLentes: refraction === "ninguna" ? "no" : "anteojos" },
    agudeza: {
      od: { scLejos: blurred, ccLejos: "20/20" },
      oi: { scLejos: blurred, ccLejos: "20/20" },
    },
    ...refractionPart,
    dp: { od: half, oi: half },
    salud: {
      externo: { estado: "sin_alteraciones" },
      pupilas: { estado: "sin_alteraciones" },
      fondo: { estado: "no_realizado", nota: "Sin dilatar" },
    },
  }
}

/** Un menor viene con quien lo trae: queda en su examen (entrega 3). */
function withCompanion(exam: EyeExam, person: ReportsSeedPerson | null): EyeExam {
  if (!person?.guardian) return exam
  const { givenNames, familyName, kinship } = person.guardian
  return { ...exam, acompanante: { nombre: `${givenNames} ${familyName}`, parentesco: kinship === "MTH" ? "madre" : "padre" } }
}

/** Lo que se puede encontrar en una atención: solo a esas edades el día de la visita. */
type Finding = { code: string; weight: number; evolution: string; minAge?: number; maxAge?: number }

function found(findings: readonly Finding[], random: Random, age: number): ReportsSeedNote {
  // Lo que le puede pasar a esa edad; el primero de cada lista vale a cualquiera.
  const fitting = findings.filter((item) => (item.minAge ?? 0) <= age && age < (item.maxAge ?? 200))
  const finding = random.weighted(fitting.length > 0 ? fitting : findings)
  return { evolution: finding.evolution, diagnosisCode: finding.code }
}

/** El examen o el control de un adulto: su medida y, desde los 42, la presbicia; a veces, algo más. */
function adultExamNote(control: boolean, random: Random, person: ReportsSeedPerson | null, age: number): ReportsSeedNote {
  return { ...adultFinding(control, random, person, age), examination: { ...withCompanion(eyeExamOf(person, age), person) } }
}

function adultFinding(control: boolean, random: Random, person: ReportsSeedPerson | null, age: number): ReportsSeedNote {
  const refraction = refractionOf(person)
  return found(
    [
      {
        code: refractionCode(refraction),
        weight: 60,
        evolution: REFRACTION_TEXT[refraction][control ? "control" : "exam"],
      },
      {
        code: DX.presbicia,
        weight: 70,
        minAge: 42,
        evolution: control
          ? "Control: la presbicia avanzó. Se sube la adición de las lunas para cerca."
          : "Presbicia: no ve bien de cerca para leer el celular. Se indican lentes para cerca o progresivos.",
      },
      {
        code: DX.fatiga,
        weight: 10,
        minAge: 14,
        maxAge: 56,
        evolution:
          "Fatiga ocular por muchas horas frente a la pantalla, con la medida estable. Pausas cada 20 minutos y lunas con antirreflejo.",
      },
      {
        code: DX.ojoSeco,
        weight: 7,
        minAge: 18,
        evolution:
          "Ojo seco: ardor y sensación de arenilla al final del día. Se recomiendan gotas lubricantes y parpadear más frente a la pantalla.",
      },
      {
        code: DX.alergia,
        weight: 4,
        evolution:
          "Ojos rojos con picazón: conjuntivitis alérgica. Compresas frías; si no mejora en unos días, se deriva a oftalmología.",
      },
      {
        code: DX.catarata,
        weight: 6,
        minAge: 60,
        evolution: "Visión borrosa que no mejora con lunas: opacidad del cristalino. Se deriva a oftalmología.",
      },
    ],
    random,
    age,
  )
}

/** El examen o el control de un niño: su medida y, a veces, un ojo que ve menos que el otro. */
function childExamNote(control: boolean, random: Random, person: ReportsSeedPerson | null, age: number): ReportsSeedNote {
  return { ...childFinding(control, random, person, age), examination: { ...withCompanion(eyeExamOf(person, age), person) } }
}

function childFinding(control: boolean, random: Random, person: ReportsSeedPerson | null, age: number): ReportsSeedNote {
  const refraction = refractionOf(person)
  const title = control ? "Control de la vista" : "Examen de la vista para niños"
  return found(
    [
      { code: refractionCode(refraction), weight: 86, evolution: `${title}. ${REFRACTION_TEXT[refraction].child}` },
      {
        code: DX.anisometropia,
        weight: 8,
        minAge: 4,
        evolution: `${title}. Un ojo ve menos que el otro por diferencia de medida. Se indican lentes y una evaluación de la visión binocular.`,
      },
      {
        code: DX.alergia,
        weight: 4,
        evolution: `${title}. Ojos rojos con picazón: conjuntivitis alérgica. Compresas frías; si no mejora, se deriva a oftalmología.`,
      },
    ],
    random,
    age,
  )
}

function contactLensNote(control: boolean, random: Random, person: ReportsSeedPerson | null, age: number): ReportsSeedNote {
  const refraction = refractionOf(person)
  if (control)
    return found(
      [
        {
          code: refractionCode(refraction),
          weight: 80,
          evolution:
            "Control de lentes de contacto: córnea sana con fluoresceína y buena visión con los lentes. Se renueva la caja.",
        },
        {
          code: DX.ojoSeco,
          weight: 14,
          evolution:
            "Control de lentes de contacto: sequedad al final del día. Se reducen las horas de uso y se recomiendan gotas lubricantes.",
        },
        {
          code: DX.infiltrados,
          weight: 3,
          evolution:
            "Control de lentes de contacto: ojo rojo con infiltrados en la córnea. Se suspenden los lentes y se deriva a oftalmología.",
        },
      ],
      random,
      age,
    )
  const lens =
    refraction === "astigmatismo" ? "tóricos" : refraction === "ninguna" ? "de colores sin medida" : "blandos mensuales"
  return {
    evolution: `Adaptación de lentes de contacto ${lens}: buen centrado y movimiento. Se enseña a ponerlos, quitarlos y limpiarlos.`,
    diagnosisCode: refractionCode(refraction),
  }
}

/** La entrega de los anteojos: con la medida de la persona, o para leer si solo tiene presbicia. */
function glassesNote(progressive: boolean, person: ReportsSeedPerson | null, age: number): ReportsSeedNote {
  if (progressive)
    return {
      evolution:
        "Entrega de anteojos progresivos: altura de montaje y distancia pupilar verificadas. Se explica cómo mirar por cada zona de la luna.",
      diagnosisCode: DX.presbicia,
    }
  const refraction = refractionOf(person)
  if (refraction !== "ninguna")
    return {
      evolution:
        "Entrega de anteojos monofocales: centrado y ajuste de la montura verificados; ve bien con su nueva medida.",
      diagnosisCode: DX[refraction],
    }
  return age >= 42
    ? { evolution: "Entrega de lentes para leer: centrado y ajuste de la montura verificados.", diagnosisCode: DX.presbicia }
    : {
        evolution: "Entrega de anteojos sin medida, con filtro de luz azul para la computadora. Montura ajustada.",
        diagnosisCode: DX.fatiga,
      }
}

/** Lo que tiene cada niño que hace terapia visual: el mismo en la evaluación y en cada sesión. */
function binocularOf(person: ReportsSeedPerson | null): { code: string; evaluation: string } {
  return traitOf(person, "binocular") < 0.65
    ? {
        code: DX.convergencia,
        evaluation:
          "Evaluación de la visión binocular: los ojos no se juntan bien al leer de cerca (insuficiencia de convergencia). Se indica terapia visual de 10 sesiones.",
      }
    : {
        code: DX.foria,
        evaluation:
          "Evaluación de la visión binocular: desviación latente de los ojos (heteroforia) que le cansa la vista al leer. Se indica terapia visual de 10 sesiones.",
      }
}

const THERAPY_SESSIONS = [
  "Sesión de terapia visual: ejercicios de convergencia con el cordón de Brock. Buena respuesta; se dejan ejercicios para la casa.",
  "Sesión de terapia visual: ejercicios de enfoque de lejos a cerca y de seguimiento con los ojos. Sus padres cuentan que lee con menos cansancio.",
  "Sesión de terapia visual: el punto próximo de convergencia mejoró. Se mantienen los ejercicios en casa.",
]

const REPAIRS = [
  "Cambio de plaquetas y ajuste de la montura. Sin cambio de medida.",
  "Tornillo de la varilla cambiado y montura alineada. Sin cambio de medida.",
  "Montura ajustada porque se resbalaba; lunas limpiadas. Sin cambio de medida.",
]

/**
 * Qué se escribe según el servicio: el nombre dice qué se hizo, y la medida es
 * la de la persona (`refractionOf`). La reparación no lleva diagnóstico.
 */
function opticalNote(
  service: { name: string },
  random: Random,
  person: ReportsSeedPerson | null,
  at: Date,
): ReportsSeedNote {
  const age = person ? ageOn(person.birthDate, at) : 40
  const name = service.name
  if (/terapia/i.test(name))
    return { evolution: random.pick(THERAPY_SESSIONS), diagnosisCode: binocularOf(person).code }
  if (/binocular/i.test(name)) {
    const binocular = binocularOf(person)
    return { evolution: binocular.evaluation, diagnosisCode: binocular.code }
  }
  if (/lentes de contacto/i.test(name)) return contactLensNote(/control/i.test(name), random, person, age)
  if (/repara/i.test(name)) return { evolution: random.pick(REPAIRS) }
  if (/anteojos/i.test(name)) return glassesNote(/progresiv/i.test(name), person, age)
  if (/presi[oó]n/i.test(name))
    return found(
      [
        { code: DX.examen, weight: 92, evolution: "Presión del ojo dentro de lo normal en ambos ojos." },
        {
          code: DX.glaucoma,
          weight: 8,
          minAge: 40,
          evolution: "Presión del ojo alta en ambos ojos. Se deriva a oftalmología para descartar glaucoma.",
        },
      ],
      random,
      age,
    )
  if (/fondo de ojo|retinograf/i.test(name))
    return found(
      [
        {
          code: DX.examen,
          weight: 88,
          evolution: "Fondo de ojo sin alteraciones. La foto queda para comparar en el próximo control.",
        },
        {
          code: DX.glaucoma,
          weight: 6,
          minAge: 40,
          evolution:
            "Fondo de ojo: nervio óptico con excavación amplia. Se deriva a oftalmología para descartar glaucoma.",
        },
        {
          code: DX.catarata,
          weight: 6,
          minAge: 60,
          evolution: "La foto del fondo de ojo sale opaca por el cristalino. Se deriva a oftalmología.",
        },
      ],
      random,
      age,
    )
  const control = /control/i.test(name)
  return age < 12 ? childExamNote(control, random, person, age) : adultExamNote(control, random, person, age)
}

/** La terapia visual de la demo es de niños: de 4 a 17 años, con su responsable. */
const THERAPY_WHO = { minAge: 4, maxAge: 17 } as const

export const OPTICAL_DEMO_KINDS: readonly DemoKindRecipe[] = [
  {
    key: "optica",
    product: "optical",
    name: "Óptica",
    hint: "Examen de la vista y lentes",
    clinicNames: ["Óptica {lugar}", "Centro Óptico {lugar}", "Óptica Visión {lugar}"],
    // El optómetra examina, adapta los lentes de contacto y entrega los anteojos.
    professional: { title: { F: "Optómetra", M: "Optómetra" }, specialty: "examen" },
    services: [
      {
        template: "examen-de-la-vista",
        price: 40,
        durationMin: 30,
        weight: 1,
        firstVisit: true,
        who: { minAge: 12 },
      },
      { template: "control-de-la-vista", price: 30, durationMin: 20, weight: 26 },
      {
        template: "examen-de-la-vista-ninos",
        price: 50,
        durationMin: 30,
        weight: 8,
        who: { minAge: 3, maxAge: 11 },
      },
      {
        template: "adaptacion-lentes-de-contacto",
        price: 120,
        durationMin: 45,
        weight: 5,
        who: { minAge: 12 },
      },
      {
        template: "control-lentes-de-contacto",
        price: 30,
        durationMin: 20,
        weight: 10,
        who: { minAge: 12 },
      },
      { template: "adaptacion-anteojos-monofocales", price: 20, durationMin: 15, weight: 16 },
      {
        template: "adaptacion-anteojos-progresivos",
        price: 50,
        durationMin: 30,
        weight: 8,
        who: { minAge: 40 },
      },
      { template: "reparacion-de-anteojos", price: 15, durationMin: 15, weight: 8 },
      { template: "tonometria", price: 30, durationMin: 10, weight: 4, who: { minAge: 18 } },
      { template: "retinografia", price: 60, durationMin: 15, weight: 4, who: { minAge: 18 } },
    ],
    // Adultos, muchos con presbicia, y algunos niños con quien los trae.
    person: (random, country) =>
      random.chance(0.16)
        ? minor(random, country, 3, 17)
        : random.chance(0.45)
          ? adult(random, 45, 84)
          : adult(random, 18, 44),
    note: opticalNote,
    inbound: [
      "Hola, ¿cuánto cuesta la medida de la vista?",
      "Buenas, se me rompió la luna de mis lentes",
      "¿Tienen lentes de contacto de colores?",
      "Hola, veo borroso de lejos, ¿me pueden atender?",
    ],
    reply: [
      "Hola. La medida de la vista tiene precio fijo y toma unos 30 minutos. ¿Qué día le acomoda para reservarle?",
      "Lo sentimos. Puede traer sus lentes sin cita en nuestro horario y vemos si se cambia solo la luna.",
      "Sí, tenemos lentes de contacto de colores, también con medida. La primera vez se revisa cómo le quedan. ¿Le reservo una cita?",
      "Claro. Le hacemos el examen de la vista para ver si necesita lentes. ¿Qué día le acomoda esta semana?",
    ],
    openTopics: [
      "¿Ya están listos mis lentes? Los encargué la semana pasada",
      "¿Puedo pagar los progresivos en dos partes?",
      "Me molestan los lentes nuevos, siento como mareo al caminar",
    ],
    followUp: { title: "Control anual de la vista", everyMonths: 12 },
    budgets: false,
    occupancy: 0.62,
    expenses: OPTICAL_EXPENSES,
    inventory: OPTICAL_INVENTORY,
    promotions: [
      {
        template: "examen-de-la-vista",
        name: "Medida de la vista a precio especial",
        conditions: "Con la compra de tus lentes en la óptica.",
        price: 20,
        when: "vigente",
      },
      {
        template: "control-de-la-vista",
        name: "Control anual a mitad de precio",
        conditions: "Para quienes compraron sus lentes con nosotros.",
        price: 15,
        when: "terminada",
      },
    ],
    knowledge: OPTICAL_KNOWLEDGE,
  },
  {
    key: "optica_terapia_visual",
    product: "optical",
    name: "Óptica con terapia visual",
    hint: "Terapia visual para niños",
    clinicNames: ["Centro Visual {lugar}", "Óptica y Terapia Visual {lugar}", "Visión Infantil {lugar}"],
    professional: { title: { F: "Optómetra", M: "Optómetra" }, specialty: "examen" },
    // Con un solo optómetra, él examina y hace la terapia; desde el tamaño mediano, otro la atiende.
    specialtyRotation: ["examen", "terapia", "examen", "examen", "terapia", "examen", "examen", "examen"],
    specialtyWho: { terapia: THERAPY_WHO },
    services: [
      {
        template: "examen-de-la-vista",
        price: 40,
        durationMin: 30,
        weight: 1,
        firstVisit: true,
        who: { minAge: 12 },
      },
      {
        template: "examen-de-la-vista-ninos",
        price: 50,
        durationMin: 30,
        weight: 18,
        who: { minAge: 3, maxAge: 11 },
      },
      { template: "control-de-la-vista", price: 30, durationMin: 20, weight: 14 },
      { template: "evaluacion-vision-binocular", price: 90, durationMin: 45, weight: 8, who: THERAPY_WHO },
      { template: "terapia-visual", price: 70, durationMin: 45, weight: 30, who: THERAPY_WHO },
      { template: "adaptacion-anteojos-monofocales", price: 20, durationMin: 15, weight: 12 },
      { template: "reparacion-de-anteojos", price: 15, durationMin: 15, weight: 5 },
    ],
    // La mitad son niños con su responsable; los demás, sus padres y otros adultos.
    person: (random, country) =>
      random.chance(0.5)
        ? minor(random, country, 3, 15)
        : random.chance(0.4)
          ? adult(random, 45, 80)
          : adult(random, 18, 44),
    note: opticalNote,
    inbound: [
      "Hola, en el colegio dicen que mi hijo tiene un ojo desviado, ¿lo pueden ver?",
      "Buenas, ¿qué es la terapia visual?",
      "Mi hija se queja de dolor de cabeza cuando lee, ¿la pueden atender?",
      "¿Cuántas sesiones de terapia visual son?",
    ],
    reply: [
      "Claro. Primero se le hace una evaluación de la visión binocular y ahí le dicen si necesita terapia visual. ¿Qué día le acomoda?",
      "Son ejercicios guiados para que los ojos trabajen juntos y enfoquen mejor. Se indican después de una evaluación. ¿Le reservo una?",
      "Sí. Le reservamos un examen de la vista para niños. ¿Qué día le queda mejor?",
      "Depende de cada niño: el número de sesiones se lo indican después de la evaluación. ¿Le reservo una?",
    ],
    openTopics: [
      "¿Puedo cambiar la sesión de terapia de mi hijo al sábado?",
      "¿Los ejercicios de la casa se hacen todos los días?",
      "Mi hijo no quiere usar el parche, ¿qué hago?",
    ],
    followUp: { title: "Control anual de la vista", everyMonths: 12 },
    budgets: false,
    occupancy: 0.66,
    expenses: OPTICAL_EXPENSES,
    inventory: OPTICAL_INVENTORY,
    promotions: [
      {
        template: "evaluacion-vision-binocular",
        name: "Evaluación visual escolar",
        conditions: "Para niños de 4 a 17 años; los resultados se explican a sus padres.",
        price: 70,
        when: "vigente",
      },
      {
        template: "examen-de-la-vista-ninos",
        name: "Medida de la vista de regreso a clases",
        conditions: "Para niños de 3 a 11 años.",
        price: 35,
        when: "terminada",
      },
    ],
    knowledge: [
      ...OPTICAL_KNOWLEDGE,
      {
        title: "¿Atienden a niños? ¿Desde qué edad?",
        body: "Sí, examinamos la vista de niños desde los 3 años y hacemos terapia visual desde los 4, siempre con un adulto responsable.",
        askForms: ["¿Puedo entrar con mi hijo?"],
      },
    ],
  },
]
