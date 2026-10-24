/**
 * La demo de latidIA (issue 229, entrega 4): un consultorio médico en la misma
 * semilla de desarrollo que la de odentIA (`../dental/seed-demo.ts`), que lo
 * borra junto con sus clínicas y lo crea al final. Lo mínimo para recorrerlo:
 * la Dra. Elena Vela (propietaria) y Ana Torres, que también dirige Dental
 * Smile y entra una vez en cada dominio; una sede con dos salas y horario, la
 * agenda de hoy y mañana, los controles de presión de Luis con su examen y el
 * próximo, que se repite cada 3 meses, los antecedentes médicos de los tres,
 * y sus cinco especialidades y un tarifario de su biblioteca (entrega 8).
 *
 * Solo manual, como toda la semilla: nunca en CI ni importado por pruebas.
 */

import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { account, member, organization, user } from "@odentia/db/schema/auth"
import { encounter, orgSpecialty, treatmentTemplate } from "@odentia/db/schema/clinical"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, eq, inArray } from "drizzle-orm"
import { upsertAgentConfig } from "../agentConfig.js"
import { createAppointment, createRoom } from "../appointments.js"
import { setProfessionalSchedule } from "../availability.js"
import { savePatientHealth } from "../clinical.js"
import { setProfessionalSpecialties } from "../clinical-forms.js"
import { createFollowUp } from "../follow-ups.js"
import { createContact } from "../contacts.js"
import { createPatient } from "../patients.js"
import { ensureDefaultPaymentMethods } from "../payment-methods.js"
import { setProfessionalProfile } from "../professional-profiles.js"
import { fromTemplates } from "../service-catalog.js"
import { ensureClinicSpecialties } from "../specialties.js"

export const MEDICAL_DEMO_ORG = "seed-org-consultorio-san-martin"
export const VELA_ID = "seed-user-vela"

/** «2026-10-24T09:00:00-05:00»: el día de Lima, no el de UTC (desde las 19:00 de Lima en UTC ya es mañana). */
function lima(dayOffset: number, hhmm: string): string {
  const base = new Date(Date.now() - 5 * 60 * 60 * 1000)
  base.setUTCDate(base.getUTCDate() + dayOffset)
  return `${base.toISOString().slice(0, 10)}T${hhmm}:00-05:00`
}

/** El primer día desde `from` en que atiende el consultorio (lunes a sábado), en días desde hoy en Lima. */
function openDay(from: number): number {
  const base = new Date(Date.now() - 5 * 60 * 60 * 1000)
  base.setUTCDate(base.getUTCDate() + from)
  return base.getUTCDay() === 0 ? from + 1 : from
}

export async function seedMedicalDemo(
  db: Db,
  input: { anaId: string; passwordHash: string },
): Promise<void> {
  const ORG = MEDICAL_DEMO_ORG
  await db.transaction(async (tx) => {
    await tx
      .insert(organization)
      .values({ id: ORG, name: "Consultorio San Martín", slug: "sanmartin", createdAt: new Date() })
    await tx
      .update(saasSubscription)
      .set({ isDemo: true })
      .where(eq(saasSubscription.organizationId, ORG))
  })
  await db.insert(user).values({
    id: VELA_ID,
    name: "Dra. Elena Vela",
    firstName: "Elena",
    lastName: "Vela",
    email: "vela@odentia.dev",
    emailVerified: true,
    termsVersion: LEGAL.terms.version,
    termsAcceptedAt: new Date(),
  })
  await db.insert(account).values({
    id: randomUUID(),
    accountId: VELA_ID,
    providerId: "credential",
    userId: VELA_ID,
    password: input.passwordHash,
  })
  await db.insert(member).values([
    {
      id: randomUUID(),
      organizationId: ORG,
      userId: VELA_ID,
      role: "owner",
      createdAt: new Date(),
    },
    // Ana dirige Dental Smile y también este consultorio: «Elige tu clínica» muestra los dos.
    {
      id: randomUUID(),
      organizationId: ORG,
      userId: input.anaId,
      role: "admin",
      createdAt: new Date(),
    },
  ])
  await db
    .insert(processingAgreementAcceptance)
    .values({ organizationId: ORG, version: LEGAL.agreement.version, acceptedBy: VELA_ID })
  // Nace médico: así lo crearía el panel de latidIA (ADR 0087).
  await db.insert(orgProfile).values({
    organizationId: ORG,
    product: "medical",
    legalName: "Consultorio San Martín S.A.C.",
    tradeName: "Consultorio San Martín",
    fiscalDocNumber: "20609876543",
    countryCode: "PE",
    currency: "PEN",
    locale: "es-PE",
    timezone: "America/Lima",
    diagnosisSystem: "ICD-10",
    emergencyPhone: "+5115550188",
  })
  await setProfessionalProfile(db, ORG, VELA_ID, VELA_ID, {
    professionalTitle: "Médico cirujano",
    registrationBody: "CMP",
    registrationNumber: "045678",
    signatureName: "Elena Vela",
  })
  await db.transaction((tx) => ensureDefaultPaymentMethods(tx, ORG, VELA_ID, "PE"))
  // Clío encendida (entrega 10): las atenciones en borrador ofrecen «Dictar la atención».
  await db.transaction((tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: true }, { actorUserId: VELA_ID }))

  const [sede] = await db
    .insert(branch)
    .values({
      organizationId: ORG,
      name: "Sede San Martín",
      addressLine1: "Av. Perú 1820",
      city: "San Martín de Porres",
      district: "Lima",
      region: "PE-LMA",
      country: "PE",
    })
    .returning({ id: branch.id })
  if (!sede) throw new Error("No se pudo crear la Sede San Martín")
  const [sala1, sala2] = await Promise.all(
    ["Sala 1", "Sala 2"].map((name) => createRoom(db, ORG, { branchId: sede.id, name })),
  )
  if (!sala1 || !sala2) throw new Error("No se pudieron crear las salas")
  // Lunes a viernes, mañana y tarde; el sábado, solo la mañana.
  await setProfessionalSchedule(db, ORG, VELA_ID, {
    branchId: sede.id,
    professionalUserId: VELA_ID,
    rules: [
      ...[1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startMin: 8 * 60, endMin: 13 * 60 },
        { weekday, startMin: 15 * 60, endMin: 19 * 60 },
      ]),
      { weekday: 6, startMin: 8 * 60, endMin: 13 * 60 },
    ],
  })

  // Nace con las cinco especialidades de latidIA (decisión 3) y un tarifario de
  // su biblioteca, cada servicio con su código CPMS (entrega 8).
  await db.transaction((tx) => ensureClinicSpecialties(tx, ORG))
  const [general] = await db
    .select({ id: orgSpecialty.id })
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.organizationId, ORG), eq(orgSpecialty.key, "medicina_general")))
  if (!general) throw new Error("Falta Medicina general: revisa el catálogo de latidIA")
  await db.transaction((tx) => setProfessionalSpecialties(tx, ORG, VELA_ID, VELA_ID, [general.id]))
  const prices: Record<string, number> = {
    "consulta-medicina-general": 8000,
    "consulta-de-control": 5000,
    "consulta-medicina-familiar": 10000,
    "consulta-medicina-interna": 12000,
    "consulta-pediatria": 10000,
    "consulta-ginecologia": 12000,
    "control-nino-sano-1-a-4": 7000,
    nebulizacion: 3000,
    "inyectable-intramuscular": 1500,
    electrocardiograma: 6000,
    "glucosa-capilar": 1000,
    "ecografia-transvaginal": 12000,
  }
  const library = await db
    .select({ id: treatmentTemplate.id, key: treatmentTemplate.key })
    .from(treatmentTemplate)
    .where(and(eq(treatmentTemplate.product, "medical"), inArray(treatmentTemplate.key, Object.keys(prices))))
  if (library.length !== Object.keys(prices).length) {
    throw new Error("Falta la biblioteca de latidIA: ejecuta seed:procedures")
  }
  await db.transaction((tx) =>
    fromTemplates(
      tx,
      ORG,
      VELA_ID,
      library.map((row) => ({ templateId: row.id, priceCents: prices[row.key]!, durationMin: 20 })),
    ),
  )

  const people = [
    {
      given: "Rosa",
      family: "Paredes Luna",
      phone: "+51987650201",
      doc: "40112233",
      birthDate: "1980-03-14",
      sex: "F",
    },
    {
      given: "Luis",
      family: "Gómez Salas",
      phone: "+51987650202",
      doc: "08123456",
      birthDate: "1963-11-02",
      sex: "M",
    },
    {
      given: "Julia",
      family: "Ramos Vega",
      phone: "+51987650203",
      doc: "72345678",
      birthDate: "1994-07-21",
      sex: "F",
    },
  ]
  const patients: string[] = []
  for (const person of people) {
    const displayName = `${person.given} ${person.family}`
    const contact = await createContact(
      db,
      ORG,
      { displayName, givenNames: person.given, familyName: person.family, phone: person.phone },
      { userId: VELA_ID },
    )
    const patient = await createPatient(db, ORG, VELA_ID, {
      displayName,
      givenNames: person.given,
      familyName: person.family,
      contacts: [{ contactId: contact.id, relationship: "self", isPreferred: true }],
      docType: "DNI",
      docNumber: person.doc,
      nationality: "PE",
      birthDate: person.birthDate,
      sex: person.sex,
    })
    patients.push(patient.id)
  }
  const [rosa, luis, julia] = patients
  if (!rosa || !luis || !julia) throw new Error("Faltan los pacientes del consultorio")
  // Hoy (o el próximo día que atiende) y el siguiente.
  const first = openDay(0)
  const second = openDay(first + 1)
  const agenda = [
    {
      patientId: rosa,
      roomId: sala1.id,
      day: first,
      start: "09:00",
      end: "09:30",
      reason: "Consulta por dolor de cabeza",
    },
    {
      patientId: luis,
      roomId: sala2.id,
      day: first,
      start: "10:00",
      end: "10:15",
      reason: "Control de presión arterial",
    },
    {
      patientId: julia,
      roomId: sala1.id,
      day: second,
      start: "09:30",
      end: "10:00",
      reason: "Chequeo anual",
    },
  ]
  for (const item of agenda) {
    await createAppointment(db, ORG, VELA_ID, {
      branchId: sede.id,
      patientId: item.patientId,
      professionalUserId: VELA_ID,
      roomId: item.roomId,
      reason: item.reason,
      startsAt: lima(item.day, item.start),
      endsAt: lima(item.day, item.end),
      status: "programada",
    })
  }

  // Sus antecedentes médicos (entrega 5b): Julia, embarazada de 12 semanas;
  // Luis, hipertenso y fumador; Rosa, con sus vacunas al día.
  const today = lima(0, "12:00").slice(0, 10)
  const history: Array<{
    patientId: string
    conditions: Array<{ name: string; status: string }>
    answers: Record<string, unknown>
  }> = [
    {
      patientId: julia,
      conditions: [],
      answers: {
        embarazoLactancia: {
          embarazo: { estado: "si", fecha: today, semanas: 12 },
          lactancia: { estado: "no", fecha: today },
        },
        ginecoObstetricos: { gestas: 1, partos: 0, cesareas: 0, metodo: "ninguno" },
        habitos: { tabaco: "nunca", alcohol: "no", actividadFisica: "ligera" },
      },
    },
    {
      patientId: luis,
      conditions: [{ name: "Hipertensión arterial", status: "activa" }],
      answers: { habitos: { tabaco: "fuma", cigarrillosDia: 10, alcohol: "ocasional", actividadFisica: "sedentaria" } },
    },
    {
      patientId: rosa,
      conditions: [],
      answers: {
        vacunas: [
          // La del año pasado: siempre en el pasado, sea el mes que sea.
          { vacuna: "Influenza", fecha: `${Number(today.slice(0, 4)) - 1}-04-15` },
          { vacuna: "Tétanos" },
        ],
      },
    },
  ]
  for (const item of history) {
    await db.transaction((tx) =>
      savePatientHealth(tx, ORG, VELA_ID, item.patientId, {
        expectedRevision: 0,
        reviewStatus: {
          allergies: "unknown",
          conditions: item.conditions.length ? "recorded" : "unknown",
          medications: "unknown",
        },
        conditions: item.conditions,
        medications: [],
        anamnesis: { expectedVersion: 0, answers: item.answers },
      }),
    )
  }

  // Los controles de presión de Luis, ya firmados (entrega 5): la sección
  // «Signos vitales» los dibuja en el tiempo y el examen dice lo no examinado.
  const controls = [
    { daysAgo: 240, vitals: { presionSistolica: 152, presionDiastolica: 96, frecuenciaCardiaca: 84, peso: 86, talla: 170, glucosaCapilar: 132 } },
    { daysAgo: 180, vitals: { presionSistolica: 146, presionDiastolica: 92, frecuenciaCardiaca: 80, peso: 85, talla: 170 } },
    { daysAgo: 120, vitals: { presionSistolica: 138, presionDiastolica: 88, frecuenciaCardiaca: 78, peso: 83.5, talla: 170, glucosaCapilar: 118 } },
    { daysAgo: 60, vitals: { presionSistolica: 132, presionDiastolica: 84, frecuenciaCardiaca: 76, peso: 82, talla: 170, glucosaCapilar: 112 } },
  ]
  let lastControl: string | null = null
  for (const control of controls) {
    const startedAt = new Date(lima(-control.daysAgo, "10:00"))
    const [signed] = await db.insert(encounter).values({
      organizationId: ORG,
      patientId: luis,
      branchId: sede.id,
      professionalUserId: VELA_ID,
      status: "finalizada",
      reason: "Control de presión arterial",
      vitals: control.vitals,
      examination: {
        sistemas: {
          estadoGeneral: { estado: "sin_alteraciones" },
          toraxPulmones: { estado: "sin_alteraciones" },
          corazon: { estado: "sin_alteraciones" },
          extremidades:
            control.daysAgo > 150
              ? { estado: "con_hallazgos", hallazgo: "Edema leve en ambos tobillos, con fóvea." }
              : { estado: "sin_alteraciones" },
        },
      },
      evolution: "Hipertensión arterial en control; continúa con enalapril y dieta baja en sal.",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 20 * 60 * 1000),
      finalizedAt: new Date(startedAt.getTime() + 20 * 60 * 1000),
      finalizedBy: VELA_ID,
      signerName: "Elena Vela",
      signerTitle: "Médico cirujano",
      signerRegistration: "CMP 045678",
    }).returning({ id: encounter.id })
    lastControl = signed?.id ?? lastControl
  }

  // El próximo control de presión se repite cada 3 meses (entrega 7, decisión 16):
  // al completarlo queda indicado el siguiente, hasta que la doctora lo detenga.
  await db.transaction((tx) =>
    createFollowUp(tx, ORG, VELA_ID, luis, {
      kind: "mantenimiento",
      title: "Control de presión arterial",
      instructions: "Traer el registro de presión de la casa.",
      dueAt: lima(openDay(30), "09:00"),
      originEncounterId: lastControl,
      repeatEveryMonths: 3,
    }),
  )
}
