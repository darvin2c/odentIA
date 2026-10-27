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

function ageOf(person: ReportsSeedPerson | null): number {
  if (!person) return 40
  return Math.max(0, new Date().getUTCFullYear() - Number(person.birthDate.slice(0, 4)))
}

/** Los signos de siempre, con valores de su edad. */
function vitals(
  random: Random,
  person: ReportsSeedPerson | null,
  extra: Record<string, number> = {},
): Record<string, number> {
  const age = ageOf(person)
  if (age < 12) {
    const talla = Math.round(52 + age * 6.5 + random.int(-3, 3))
    return {
      temperatura: Math.round((36.4 + random.next() * 1.8) * 10) / 10,
      frecuenciaCardiaca: random.int(85, 125),
      frecuenciaRespiratoria: random.int(20, 32),
      saturacionOxigeno: random.int(95, 99),
      peso: Math.round((3.5 + age * 2.6 + random.next() * 2) * 10) / 10,
      talla,
      ...(age < 3
        ? { perimetroCefalico: Math.round((35 + age * 4 + random.next()) * 10) / 10 }
        : {}),
      ...extra,
    }
  }
  return {
    presionSistolica: random.int(108, 132),
    presionDiastolica: random.int(66, 84),
    frecuenciaCardiaca: random.int(62, 88),
    temperatura: Math.round((36.2 + random.next() * 0.7) * 10) / 10,
    saturacionOxigeno: random.int(95, 99),
    peso: Math.round((52 + random.next() * 34) * 10) / 10,
    talla: random.int(150, 182),
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

/** Una consulta por enfermedad: qué tenía, qué se encontró y qué se indicó. */
type Episode = {
  code: string
  weight: number
  evolution: string
  found?: { system: string; text: string }
  fever?: boolean
}

function episodeNote(
  episodes: readonly Episode[],
  random: Random,
  person: ReportsSeedPerson | null,
): ReportsSeedNote {
  const episode = random.weighted(episodes)
  return {
    evolution: episode.evolution,
    diagnosisCode: episode.code,
    vitals: vitals(
      random,
      person,
      episode.fever ? { temperatura: Math.round((37.9 + random.next() * 1.1) * 10) / 10 } : {},
    ),
    examination: exam(episode.found),
  }
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
  },
  {
    code: "CA02.Z",
    weight: 18,
    evolution: "Odinofagia con fiebre. Analgésico y control en 72 horas si persiste.",
    found: { system: "bocaGarganta", text: "Faringe eritematosa sin exudado." },
    fever: true,
  },
  {
    code: "CA03.Z",
    weight: 10,
    evolution: "Amigdalitis con placas. Antibiótico por diez días.",
    found: { system: "bocaGarganta", text: "Amígdalas hipertróficas con exudado blanquecino." },
    fever: true,
  },
  {
    code: "1A40.Z",
    weight: 16,
    evolution: "Deposiciones líquidas sin sangre. Sales de rehidratación y dieta blanda.",
    found: { system: "abdomen", text: "Ruidos aumentados, blando, sin signos de irritación." },
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
      { template: "electrocardiograma", price: 70, durationMin: 20, weight: 4 },
      { template: "glucosa-capilar", price: 15, durationMin: 10, weight: 6 },
    ],
    person: (random) => adult(random, 16, 78),
    note: (_service, random, person) =>
      episodeNote(
        [
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
          },
          {
            code: "8A81.Z",
            weight: 8,
            evolution: "Cefalea tensional por estrés laboral. Analgésico y control si se repite.",
            found: undefined,
          },
          {
            code: "QA00.0",
            weight: 10,
            evolution: "Chequeo general sin hallazgos. Se piden análisis de rutina.",
          },
        ],
        random,
        person,
      ),
    inbound: [
      "Hola, ¿tienen cita hoy? Tengo fiebre desde ayer",
      "Buenas, quisiera una consulta para un chequeo",
      "¿Atienden el sábado? Me duele la espalda",
      "Hola, necesito que me pongan una inyección que me recetaron",
    ],
    reply: [
      "Hola, sí. Hoy tenemos a las 4:20 p. m. o a las 5:00 p. m. ¿Cuál le acomoda?",
      "Con gusto. ¿Qué día le queda mejor esta semana?",
      "Sí atendemos el sábado de 9 a 1. ¿Le reservo a las 10:00?",
    ],
    openTopics: [
      "¿Puedo ir con mi esposo y que lo vean a los dos en la misma cita?",
      "¿Aceptan mi seguro de la empresa?",
      "Me dieron un resultado de análisis, ¿la doctora lo puede revisar por aquí?",
    ],
    followUp: null,
    budgets: false,
    occupancy: 0.72,
    expenses: GENERAL_EXPENSES,
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
    services: [
      { template: "consulta-pediatria", price: 100, durationMin: 20, weight: 38, firstVisit: true },
      { template: "control-nino-sano-menor-1", price: 90, durationMin: 30, weight: 14 },
      { template: "control-nino-sano-1-a-4", price: 90, durationMin: 30, weight: 12 },
      { template: "control-nino-sano-5-a-11", price: 90, durationMin: 30, weight: 8 },
      { template: "aplicacion-de-vacuna", price: 30, durationMin: 10, weight: 10 },
      { template: "nebulizacion", price: 35, durationMin: 20, weight: 10 },
    ],
    person: (random, country) => child(random, country, 13),
    note: (service, random, person) =>
      /control|vacuna/i.test(service.name)
        ? {
            evolution:
              "Crecimiento y desarrollo adecuados para su edad. Lactancia y alimentación según edad; próximo control indicado.",
            diagnosisCode: "QA00.Z",
            vitals: vitals(random, person),
            examination: exam(),
          }
        : episodeNote(
            [
              ...RESPIRATORY,
              {
                code: "AB00",
                weight: 12,
                evolution:
                  "Otalgia derecha con fiebre. Analgésico y antibiótico; control en 48 horas.",
                found: {
                  system: "cabezaCuello",
                  text: "Membrana timpánica derecha abombada y eritematosa.",
                },
                fever: true,
              },
              {
                code: "CA41.0",
                weight: 6,
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
              },
            ],
            random,
            person,
          ),
    inbound: [
      "Hola, mi hijo tiene fiebre desde anoche, ¿tienen cita hoy?",
      "Buenas, quisiera el control de mi bebé de 6 meses",
      "Hola, ¿cuándo le toca su vacuna a mi hija?",
      "Mi niña tiene tos hace tres días, ¿la pueden ver?",
    ],
    reply: [
      "Hola, sí. Hoy hay a las 3:40 p. m. con la doctora. ¿Le reservo a nombre del niño?",
      "Con gusto. ¿Me confirma el nombre del bebé y qué día le queda mejor?",
      "Le toca este mes. ¿Quiere que le reserve el control con la vacuna?",
    ],
    openTopics: [
      "¿La doctora puede ver a mis dos hijos en la misma cita?",
      "Mi hijo vomitó después de la vacuna, ¿es normal?",
      "¿Me pueden mandar el carné de vacunas por aquí?",
    ],
    followUp: { title: "Control de niño sano", everyMonths: 3 },
    budgets: false,
    occupancy: 0.78,
    expenses: GENERAL_EXPENSES,
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
    services: [
      {
        template: "consulta-ginecologia",
        price: 120,
        durationMin: 25,
        weight: 34,
        firstVisit: true,
      },
      { template: "papanicolaou", price: 60, durationMin: 15, weight: 12 },
      { template: "ecografia-obstetrica", price: 120, durationMin: 20, weight: 14 },
      { template: "ecografia-transvaginal", price: 110, durationMin: 20, weight: 8 },
      { template: "colocacion-de-diu", price: 250, durationMin: 30, weight: 3 },
      { template: "colocacion-de-implante-anticonceptivo", price: 300, durationMin: 20, weight: 2 },
    ],
    person: (random) => adult(random, 18, 58, 1),
    note: (service, random, person) => {
      if (/obst|prenatal/i.test(service.name))
        return {
          evolution:
            "Gestación de curso normal. Altura uterina acorde, latidos fetales presentes. Ácido fólico y hierro; próximo control en cuatro semanas.",
          diagnosisCode: "QA42.Z",
          vitals: vitals(random, person),
          examination: exam(),
        }
      return episodeNote(
        [
          {
            code: "QA21.0",
            weight: 30,
            evolution: "Consejería en anticoncepción. Elige método y se indica seguimiento.",
          },
          {
            code: "GA02.Z",
            weight: 22,
            evolution: "Flujo con prurito. Óvulos por siete días y control si persiste.",
            found: {
              system: "genitourinario",
              text: "Flujo blanquecino grumoso, mucosa eritematosa.",
            },
          },
          {
            code: "GA30.0Z",
            weight: 10,
            evolution:
              "Bochornos y alteración del sueño. Medidas generales y control en tres meses.",
          },
          {
            code: "QA00.Z",
            weight: 28,
            evolution: "Control ginecológico anual. Se toma Papanicolaou; resultado en diez días.",
          },
        ],
        random,
        person,
      )
    },
    inbound: [
      "Hola, estoy embarazada de 8 semanas y quisiera mi primer control",
      "Buenas, me toca mi Papanicolaou, ¿tienen cita esta semana?",
      "Hola, quisiera información para ponerme el implante",
      "¿La doctora hace ecografías el mismo día?",
    ],
    reply: [
      "¡Felicidades! El primer control dura media hora. ¿Le reservo el martes a las 10:00?",
      "Sí, hay el jueves a las 4:00 p. m. Recuerde no tener relaciones 48 horas antes.",
      "Sí, la ecografía se hace en la misma consulta. ¿Qué día le acomoda?",
    ],
    openTopics: [
      "Tengo un sangrado leve y estoy de 10 semanas, ¿qué hago?",
      "¿Mi pareja puede entrar a la ecografía?",
      "¿Ya salió mi resultado del Papanicolaou?",
    ],
    followUp: { title: "Control prenatal", everyMonths: 1 },
    budgets: false,
    occupancy: 0.74,
    expenses: GENERAL_EXPENSES,
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
    note: (_service, random, person) => {
      const roll = random.next()
      if (roll < 0.42)
        return {
          evolution:
            "Hipertensión arterial en control. Continúa con enalapril y dieta baja en sal; control en tres meses.",
          diagnosisCode: "BA00.Z",
          vitals: vitals(random, person, {
            presionSistolica: random.int(128, 158),
            presionDiastolica: random.int(80, 98),
          }),
          examination: exam(),
        }
      if (roll < 0.76)
        return {
          evolution:
            "Diabetes tipo 2. Metformina, plan de alimentación y caminata diaria; hemoglobina glicosilada en el próximo control.",
          diagnosisCode: "5A11",
          vitals: vitals(random, person, { glucosaCapilar: random.int(110, 210) }),
          examination: exam(),
        }
      if (roll < 0.9)
        return {
          evolution: "Colesterol alto. Estatina y control de perfil lipídico en tres meses.",
          diagnosisCode: "5C80.0Z",
          vitals: vitals(random, person),
          examination: exam(),
        }
      return {
        evolution: "Obesidad. Plan de alimentación y actividad física; control mensual de peso.",
        diagnosisCode: "5B81.01",
        vitals: vitals(random, person, { peso: random.int(92, 118) }),
        examination: exam(),
      }
    },
    inbound: [
      "Hola, me toca mi control de presión, ¿hay cita esta semana?",
      "Buenas, se me acabaron las pastillas de la diabetes",
      "Hola, quisiera una consulta, tengo la glucosa alta",
      "¿La doctora puede ver mis análisis?",
    ],
    reply: [
      "Hola, sí. ¿Le reservo el control el miércoles a las 9:00?",
      "La receta la renueva la doctora en el control. ¿Le reservo mañana a las 11:00?",
      "Con gusto. Traiga sus análisis a la consulta. ¿Qué día le acomoda?",
    ],
    openTopics: [
      "Mi presión está en 160/100 esta mañana, ¿adelanto la cita?",
      "¿Puedo tomar el enalapril con la pastilla del resfrío?",
      "Falté a mi control de septiembre, ¿puedo reprogramar?",
    ],
    followUp: { title: "Control de presión y glucosa", everyMonths: 3 },
    budgets: false,
    occupancy: 0.7,
    expenses: GENERAL_EXPENSES,
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
    services: [
      {
        template: "consulta-medicina-familiar",
        price: 90,
        durationMin: 20,
        weight: 38,
        firstVisit: true,
      },
      { template: "consulta-de-control", price: 55, durationMin: 15, weight: 18 },
      { template: "chequeo-preventivo-adulto", price: 150, durationMin: 30, weight: 10 },
      { template: "chequeo-preventivo-adulto-mayor", price: 160, durationMin: 30, weight: 6 },
      { template: "planificacion-familiar", price: 60, durationMin: 20, weight: 6 },
      { template: "aplicacion-de-vacuna", price: 30, durationMin: 10, weight: 8 },
    ],
    person: (random, country) =>
      random.chance(0.3) ? child(random, country, 15) : adult(random, 18, 82),
    note: (service, random, person) =>
      /chequeo|preventivo/i.test(service.name)
        ? {
            evolution:
              "Chequeo preventivo anual. Peso, presión y análisis de rutina; consejería en hábitos.",
            diagnosisCode: "QA00.0",
            vitals: vitals(random, person),
            examination: exam(),
          }
        : episodeNote(
            [
              ...RESPIRATORY,
              {
                code: "BA00.Z",
                weight: 10,
                evolution: "Presión alta en control. Continúa tratamiento y dieta baja en sal.",
              },
              { code: "QA21.0", weight: 6, evolution: "Consejería en planificación familiar." },
            ],
            random,
            person,
          ),
    inbound: [
      "Hola, quisiera cita para mí y para mi mamá",
      "Buenas, ¿hacen el chequeo anual completo?",
      "Hola, mi hijo tiene tos, ¿lo pueden ver hoy?",
      "¿Cuánto cuesta el chequeo para mayores de 60?",
    ],
    reply: [
      "Con gusto. Le reservo dos citas seguidas el viernes a las 10:00 y 10:20, ¿le parece?",
      "Sí, incluye examen, presión y análisis. ¿Qué día le acomoda?",
      "Sí, hoy hay a las 5:20 p. m. ¿Le reservo a nombre del niño?",
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
  },
  {
    key: "policlinico",
    product: "medical",
    name: "Policlínico",
    hint: "Las cinco, dos sedes",
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
    services: [
      {
        template: "consulta-medicina-general",
        price: 80,
        durationMin: 20,
        weight: 26,
        firstVisit: true,
      },
      { template: "consulta-pediatria", price: 100, durationMin: 20, weight: 14 },
      { template: "consulta-ginecologia", price: 120, durationMin: 25, weight: 10 },
      { template: "consulta-medicina-interna", price: 130, durationMin: 25, weight: 10 },
      { template: "consulta-medicina-familiar", price: 90, durationMin: 20, weight: 8 },
      { template: "consulta-de-control", price: 55, durationMin: 15, weight: 14 },
      { template: "nebulizacion", price: 35, durationMin: 20, weight: 5 },
      { template: "electrocardiograma", price: 70, durationMin: 20, weight: 4 },
      { template: "ecografia-abdominal", price: 120, durationMin: 20, weight: 4 },
    ],
    person: (random, country) =>
      random.chance(0.25) ? child(random, country, 13) : adult(random, 16, 80),
    note: (_service, random, person) =>
      episodeNote(
        [
          ...RESPIRATORY,
          {
            code: "BA00.Z",
            weight: 12,
            evolution: "Hipertensión arterial en control; continúa tratamiento.",
          },
          {
            code: "5A11",
            weight: 8,
            evolution: "Diabetes tipo 2 en control; continúa metformina.",
          },
          {
            code: "ME84.2Z",
            weight: 8,
            evolution: "Dolor lumbar mecánico. Antiinflamatorio y pausas activas.",
          },
          { code: "QA00.0", weight: 8, evolution: "Chequeo general sin hallazgos." },
        ],
        random,
        person,
      ),
    inbound: [
      "Hola, ¿qué especialidades atienden?",
      "Buenas, quisiera cita con pediatría para hoy",
      "Hola, ¿la ginecóloga atiende en la otra sede?",
      "¿Tienen medicina interna los sábados?",
    ],
    reply: [
      "Atendemos medicina general, pediatría, ginecología, medicina interna y medicina familiar. ¿Con cuál le reservo?",
      "Sí, hoy hay pediatría a las 4:00 p. m. en la sede principal. ¿Le reservo?",
      "Sí, la doctora atiende martes y jueves en la segunda sede. ¿Qué día le acomoda?",
    ],
    openTopics: [
      "¿Me pueden pasar de medicina general a la internista sin pagar otra consulta?",
      "¿En cuál sede hay estacionamiento?",
      "Quiero cambiar mi cita de pediatría a la otra sede",
    ],
    followUp: { title: "Control de presión y glucosa", everyMonths: 3 },
    budgets: false,
    occupancy: 0.75,
    expenses: GENERAL_EXPENSES,
  },
]
