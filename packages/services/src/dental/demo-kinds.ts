import type { DemoCountry, DemoKindRecipe } from "../demo-recipes.js"
import { birthDateForAge } from "../demo-recipes.js"
import type { Random, ReportsSeedNote, ReportsSeedPerson } from "../seed-reports.js"

/**
 * Los tipos de demo de odentIA (lienzo «Demos para presentar», tablero 6):
 * clínica general (la de Dental Smile), ortodoncia, implantes y
 * odontopediatría. Varias sedes no es un tipo: sale del tamaño grande. Los
 * diagnósticos son de la CIE-11 oficial; los servicios, de la biblioteca
 * dental (`biblioteca.csv`), con su especialidad del país.
 */

const DENTAL_EXPENSES: DemoKindRecipe["expenses"] = [
  { category: "Personal", concept: "Planilla del mes", cents: 4_200_00, perStaffCents: 2_100_00, day: 28 },
  { category: "Alquiler", concept: "Alquiler del local", rent: true, day: 1 },
  { category: "Laboratorio", concept: "Coronas y prótesis", revenueShare: 0.09, day: 20 },
  { category: "Materiales", concept: "Insumos", revenueShare: 0.06, day: 12 },
  { category: "Servicios", concept: "Luz, agua e internet", cents: 650_00, day: 18 },
]

function adult(random: Random, minAge: number, maxAge: number): ReportsSeedPerson {
  return { birthDate: birthDateForAge(random.int(minAge, maxAge), random), sex: random.chance(0.57) ? "F" : "M" }
}

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

/** Qué se escribe según el tratamiento: el nombre del servicio dice qué se hizo. */
function dentalNote(service: { name: string }, random: Random): ReportsSeedNote {
  const name = service.name.toLowerCase()
  const pieces = ["1.6", "2.6", "3.6", "4.6", "1.4", "2.5", "3.7", "4.5"]
  const piece = random.pick(pieces)
  if (name.includes("resina") || name.includes("obtura"))
    return { evolution: `Caries en pieza ${piece}. Restauración con resina, oclusión controlada.`, diagnosisCode: "DA08.0" }
  if (name.includes("endodoncia") || name.includes("pulpotom"))
    return { evolution: `Pulpitis en pieza ${piece}. Tratamiento de conductos sin complicaciones; control en una semana.`, diagnosisCode: "DA09.0" }
  if (name.includes("exodoncia"))
    return { evolution: `Exodoncia de pieza ${piece}. Hemostasia lograda; indicaciones posoperatorias entregadas.`, diagnosisCode: "DA0A.1" }
  if (name.includes("profilaxis") || name.includes("destartraje") || name.includes("raspado"))
    return { evolution: "Profilaxis y destartraje. Encías inflamadas en sector anterior; técnica de cepillado reforzada.", diagnosisCode: "DA0B.1" }
  if (name.includes("ortodoncia") || name.includes("contención"))
    return { evolution: "Control de ortodoncia: cambio de arco y activación. Higiene buena.", diagnosisCode: "DA0E.3" }
  if (name.includes("implante") || name.includes("corona") || name.includes("prótesis") || name.includes("poste"))
    return { evolution: `Rehabilitación de pieza ${piece} según plan; paciente conforme.`, diagnosisCode: "DA0A.1" }
  if (name.includes("flúor") || name.includes("sellante"))
    return { evolution: "Aplicación preventiva. Riesgo de caries moderado; control en seis meses.", diagnosisCode: "QA00.8" }
  return { evolution: "Evaluación odontológica completa. Se explica el plan de tratamiento.", diagnosisCode: "QA00.8" }
}

export const DENTAL_DEMO_KINDS: readonly DemoKindRecipe[] = [
  {
    key: "general",
    product: "dental",
    name: "Clínica general",
    hint: "Odontología general",
    clinicNames: ["Dental {lugar}", "Clínica Dental {lugar}", "Sonrisa {lugar}"],
    professional: { title: { F: "Cirujana dentista", M: "Cirujano dentista" }, specialty: null },
    services: [
      { template: "consulta-odontologica-general", price: 50, durationMin: 30, weight: 1, firstVisit: true },
      { template: "profilaxis", price: 120, durationMin: 45, weight: 30 },
      { template: "resina-fotocurable-1-superficie-posterior", price: 180, durationMin: 45, weight: 24 },
      { template: "resina-fotocurable-2-superficies-posterior", price: 220, durationMin: 60, weight: 8 },
      { template: "exodoncia-simple", price: 150, durationMin: 45, weight: 8 },
      { template: "endodoncia-anterior-vital", price: 450, durationMin: 90, weight: 6 },
      { template: "corona-metal-ceramica-metal-base", price: 900, durationMin: 60, weight: 5 },
      { template: "blanqueamiento-externo-por-arcada", price: 600, durationMin: 60, weight: 4 },
      { template: "radiografia-periapical", price: 30, durationMin: 10, weight: 6 },
    ],
    person: (random, country) => (random.chance(0.12) ? minor(random, country, 6, 17) : adult(random, 18, 76)),
    note: (service, random) => dentalNote(service, random),
    inbound: ["Hola, quisiera una cita para limpieza", "Buenas, me duele una muela desde ayer, ¿tienen cita hoy?", "¿Cuánto cuesta una curación?", "Hola, ¿hacen blanqueamiento?"],
    reply: ["Hola, con gusto. ¿Qué día le acomoda esta semana?", "Hoy tenemos a las 5:30 p. m. para la evaluación. ¿Le reservo?", "La curación con resina tiene precio fijo por superficie; el odontólogo lo confirma en la evaluación."],
    openTopics: ["¿Aceptan pago en dos partes para la corona?", "Se me cayó la curación que me hicieron el mes pasado", "¿Atienden emergencias el domingo?"],
    followUp: { title: "Limpieza y control", everyMonths: 6 },
    budgets: true,
    occupancy: 0.72,
    expenses: DENTAL_EXPENSES,
  },
  {
    key: "ortodoncia",
    product: "dental",
    name: "Ortodoncia",
    hint: "Controles mensuales",
    clinicNames: ["Ortodoncia {lugar}", "Centro de Ortodoncia {lugar}", "Brackets {lugar}"],
    professional: { title: { F: "Cirujana dentista ortodoncista", M: "Cirujano dentista ortodoncista" }, specialty: "ortodoncia" },
    services: [
      { template: "consulta-odontologica-especializada", price: 80, durationMin: 30, weight: 1, firstVisit: true },
      { template: "consulta-odontologica-general", price: 60, durationMin: 30, weight: 1, firstVisit: true },
      { template: "control-de-ortodoncia", price: 150, durationMin: 30, weight: 62 },
      { template: "aparatologia-fija-de-ortodoncia", price: 3_500, durationMin: 90, weight: 4 },
      { template: "contencion-de-ortodoncia", price: 400, durationMin: 45, weight: 4 },
      { template: "profilaxis", price: 120, durationMin: 45, weight: 10 },
      { template: "radiografia-panoramica", price: 80, durationMin: 15, weight: 4 },
    ],
    person: (random, country) => (random.chance(0.55) ? minor(random, country, 11, 17) : adult(random, 18, 45)),
    note: (service, random) => dentalNote(service, random),
    inbound: ["Hola, ¿cuánto cuestan los brackets?", "Buenas, me toca mi control de ortodoncia", "Se me despegó un bracket, ¿me pueden ver?", "¿Tienen brackets estéticos?"],
    reply: ["Los brackets se pagan en cuotas mensuales. En la evaluación la doctora arma el plan y el precio.", "Con gusto, ¿le reservo su control el sábado a las 10:00?", "Sí, venga mañana a las 4:00 p. m. y se lo pegamos."],
    openTopics: ["¿Puedo pagar la cuota de este mes por transferencia?", "Mi hija tiene dolor después del ajuste, ¿es normal?", "¿Cuánto falta para que me quiten los brackets?"],
    followUp: { title: "Control de ortodoncia", everyMonths: 1 },
    budgets: true,
    occupancy: 0.78,
    expenses: DENTAL_EXPENSES,
  },
  {
    key: "implantes",
    product: "dental",
    name: "Implantes y rehabilitación",
    hint: "Presupuestos grandes",
    clinicNames: ["Implantes {lugar}", "Centro de Rehabilitación Oral {lugar}", "Dental Implant {lugar}"],
    professional: { title: { F: "Cirujana dentista implantóloga", M: "Cirujano dentista implantólogo" }, specialty: "implantologia" },
    services: [
      { template: "consulta-odontologica-especializada", price: 100, durationMin: 30, weight: 1, firstVisit: true },
      { template: "consulta-odontologica-general", price: 60, durationMin: 30, weight: 1, firstVisit: true },
      { template: "colocacion-de-implante-endooseo", price: 2_500, durationMin: 90, weight: 10 },
      { template: "corona-de-porcelana", price: 1_200, durationMin: 60, weight: 10 },
      { template: "poste-y-munon", price: 350, durationMin: 45, weight: 8 },
      { template: "protesis-completa-superior", price: 1_500, durationMin: 60, weight: 5 },
      { template: "exodoncia-simple", price: 150, durationMin: 45, weight: 10 },
      { template: "profilaxis", price: 120, durationMin: 45, weight: 14 },
      { template: "radiografia-panoramica", price: 80, durationMin: 15, weight: 8 },
    ],
    person: (random) => adult(random, 35, 82),
    note: (service, random) => dentalNote(service, random),
    inbound: ["Hola, quisiera información sobre implantes", "Buenas, ¿cuánto cuesta una prótesis completa?", "¿Hacen la tomografía ahí mismo?", "Hola, me falta una muela, ¿qué me recomiendan?"],
    reply: ["En la evaluación el doctor arma el plan del implante con la tomografía y le da el presupuesto.", "Con gusto. ¿Le reservo la evaluación el jueves a las 11:00?", "Sí, la tomografía se ve en la consulta con el doctor."],
    openTopics: ["¿Puedo pagar el implante en tres partes?", "¿Cuánto tiempo pasa entre el implante y la corona?", "Me sangra un poco donde me pusieron el implante"],
    followUp: { title: "Control del implante", everyMonths: 6 },
    budgets: true,
    occupancy: 0.66,
    expenses: DENTAL_EXPENSES,
  },
  {
    key: "odontopediatria",
    product: "dental",
    name: "Odontopediatría",
    hint: "Niños con su responsable",
    clinicNames: ["Odontopediatría {lugar}", "Dientecitos {lugar}", "Sonrisitas {lugar}"],
    professional: { title: { F: "Cirujana dentista odontopediatra", M: "Cirujano dentista odontopediatra" }, specialty: "odontopediatria" },
    services: [
      { template: "consulta-odontologica-especializada", price: 70, durationMin: 30, weight: 1, firstVisit: true },
      { template: "consulta-odontologica-general", price: 50, durationMin: 30, weight: 1, firstVisit: true },
      { template: "profilaxis", price: 90, durationMin: 30, weight: 24 },
      { template: "fluor-barniz", price: 60, durationMin: 15, weight: 18 },
      { template: "sellante", price: 70, durationMin: 20, weight: 14 },
      { template: "resina-fotocurable-1-superficie-posterior", price: 150, durationMin: 40, weight: 14 },
      { template: "pulpotomia", price: 250, durationMin: 45, weight: 6 },
      { template: "corona-de-acero-prefabricada-deciduo", price: 220, durationMin: 40, weight: 4 },
      { template: "exodoncia-simple", price: 120, durationMin: 30, weight: 5 },
    ],
    person: (random, country) => minor(random, country, 2, 12),
    note: (service, random) => dentalNote(service, random),
    inbound: ["Hola, quisiera una cita para mi hijo de 5 años", "Buenas, a mi hija le duele un diente de leche", "¿Atienden a niños que tienen miedo al dentista?", "Hola, ¿cuándo le toca el flúor a mi niño?"],
    reply: ["¡Con gusto! ¿Me dice el nombre del niño y qué día le acomoda?", "Sí, la doctora es especialista en niños. ¿Le reservo mañana a las 4:00 p. m.?", "Le toca este mes. ¿Le reservo junto con la limpieza?"],
    openTopics: ["¿Puedo entrar con mi hijo a la consulta?", "Mi niño se golpeó un diente jugando, ¿lo pueden ver hoy?", "¿Tienen cita para mis dos hijos seguidos?"],
    followUp: { title: "Flúor y control", everyMonths: 6 },
    budgets: true,
    occupancy: 0.74,
    expenses: DENTAL_EXPENSES,
  },
]
