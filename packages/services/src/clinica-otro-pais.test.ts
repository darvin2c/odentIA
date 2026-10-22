/**
 * Nada de Perú fuera de lo de Perú (ADR 0036): una clínica de Bogotá que la
 * propia prueba arma recorre el alta, la atención y el odontograma sin ver
 * nada peruano. La semilla de desarrollo (peruana) no participa.
 */
import { randomUUID } from "node:crypto"
import { type Db, seedProcedureCodes, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { patientRegistrationConfig } from "@odentia/db/schema/org"
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { dentalProfileFor } from "@odentia/dental"
import { and, eq, isNull } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  createOdontogramAssessment,
  getOdontogram,
  getOdontogramPrint,
  listOdontogramAssessments,
} from "./clinical.js"
import { makeSigner, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import {
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
  getEncounterClosing,
  updateEncounterDraft,
} from "./encounters.js"
import { updateOrgRegion } from "./organization-profile.js"
import { getPatientMissingData, registerPatient } from "./patient-registration.js"
import { updatePatient } from "./patients.js"
import { setProfessionalProfile } from "./professional-profiles.js"
import { createService } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"
import { registerToothFinding } from "./dental/tooth-panel.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Lo que delataría a Perú en la ficha de otra clínica. */
const PERUVIAN = /\bDNI\b|\bSIS\b|ESSALUD|\bEPS\b|PE-[A-Z]{3}|ubigeo|NTS 188|MINSA|\bCOP\b/i

async function bogotaClinic() {
  const orgId = `co-${randomUUID()}`
  await insertOrg(ownerDb, orgId, orgId)
  const reception = randomUUID()
  const professional = randomUUID()
  for (const [id, name] of [[reception, "Paula Recepción"], [professional, "Luis Gómez"]] as const)
    await ownerDb.insert(user).values({ id, name, email: `${id}@example.test` })
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: orgId, userId: reception, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: orgId, userId: professional, role: "clinician", createdAt: new Date() },
  ])
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const profile = await run((tx) =>
    updateOrgRegion(tx, orgId, reception, { countryCode: "CO", applyCountryPreset: true }),
  )
  return { orgId, reception, professional, profile, run }
}

function answers(demographics: Record<string, unknown>) {
  const names = { givenNames: "Andrea", familyName: "Rojas", ...demographics }
  return {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: `${names.givenNames} ${names.familyName}`, ...names },
      respondent: "staff" as const,
      privacyAccepted: false,
    },
  }
}

it("otra clínica, otro país: el alta usa los documentos, el seguro y la dirección del núcleo, sin nada peruano", async () => {
  const c = await bogotaClinic()
  expect(c.profile).toMatchObject({ countryCode: "CO" })
  const register = (demographics: Record<string, unknown>) =>
    c.run((tx) => registerPatient(tx, c.orgId, { kind: "internal", userId: c.reception }, answers(demographics)))

  // Lo de Perú no se acepta en Bogotá: ni el DNI, ni el SIS, ni un departamento de la lista peruana.
  await expect(register({ docType: "DNI", docNumber: "45678904" })).rejects.toMatchObject({ status: 400 })
  await expect(register({ insuranceType: "PUBLICO", insuranceScheme: "SIS" })).rejects.toMatchObject({ status: 400 })

  // El documento nacional toma el país de la clínica; la región se escribe.
  const andrea = await register({
    docType: "NACIONAL",
    docNumber: "1020304050",
    birthDate: "1988-03-04",
    phone: "+573001234567",
    address: "Calle 85 # 11-53",
    addressCity: "Bogotá",
    addressRegion: "Cundinamarca",
    addressPostalCode: "110221",
    insuranceType: "PRIVADO",
  })
  expect(andrea).toMatchObject({
    docType: "NACIONAL",
    docCountry: "CO",
    addressRegion: "Cundinamarca",
    addressCountry: "CO",
    insuranceType: "PRIVADO",
    insuranceScheme: null,
  })
  expect(JSON.stringify(andrea)).not.toMatch(PERUVIAN)
  // Nada le falta para atenderla.
  expect(await c.run((tx) => getPatientMissingData(tx, c.orgId, andrea.id))).toEqual([])

  // El documento es único junto con su país: el mismo número de otro país es otra persona…
  const otra = await register({ givenNames: "Valentina", docType: "PASAPORTE", docNumber: "1020304050", docCountry: "VE" })
  expect(otra).toMatchObject({ docType: "PASAPORTE", docCountry: "VE" })
  const venezolana = await register({ givenNames: "María", docType: "NACIONAL", docNumber: "1020304050", docCountry: "VE" })
  expect(venezolana.docCountry).toBe("VE")
  // …y el mismo documento del mismo país dice de quién es, sin unirlas.
  await expect(register({ givenNames: "Andrea", docType: "NACIONAL", docNumber: "1020304050" })).rejects.toMatchObject({
    code: "DUPLICATE_DOCUMENT",
    message: "Ese documento ya está en la página de Andrea Rojas",
  })
  // El pasaporte no supone el país de la clínica: hay que elegirlo.
  await expect(register({ givenNames: "Camilo", docType: "PASAPORTE", docNumber: "AB123456" })).rejects.toMatchObject({
    status: 400,
    message: "Elige el país que emitió el documento",
  })
})

it("«Faltan datos para atenderla» lo calcula el servidor: lo necesario siempre, lo que pide la clínica si es obligatorio y nunca lo censal", async () => {
  const c = await bogotaClinic()
  await ownerDb.insert(patientRegistrationConfig).values({
    organizationId: c.orgId,
    version: 1,
    enabled: false,
    fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, docType: "required", docNumber: "required", occupation: "optional" },
    privacyNotice: "",
  })
  const minimal = await c.run((tx) =>
    registerPatient(
      tx,
      c.orgId,
      { kind: "internal", userId: c.reception, scope: "essentials" },
      answers({ phone: "+573001234567" }),
    ),
  )
  expect((await c.run((tx) => getPatientMissingData(tx, c.orgId, minimal.id))).map((datum) => datum.key)).toEqual([
    "birthDate",
    "docType",
    "docNumber",
  ])
  // Completar lo que falta lo quita del aviso; la ocupación nunca cuenta.
  await c.run((tx) =>
    updatePatient(tx, c.orgId, c.reception, minimal.id, {
      birthDate: "1990-01-01",
      docType: "NACIONAL",
      docNumber: "52123456",
      identityConfirmed: true,
    }),
  )
  expect(await c.run((tx) => getPatientMissingData(tx, c.orgId, minimal.id))).toEqual([])
})

it("otra clínica, otro país: la atención y el odontograma son los del núcleo, sin siglas ni odontograma firmado", async () => {
  const c = await bogotaClinic()
  expect(dentalProfileFor("CO").odontogram).toBeNull()
  await makeSigner(c.orgId, c.professional)
  // Título y colegio de su país: el perfil no trae ninguno por defecto.
  await c.run((tx) =>
    setProfessionalProfile(tx, c.orgId, c.professional, c.professional, {
      professionalTitle: "Odontólogo",
      registrationBody: "Colegio de odontólogos",
      registrationNumber: "4567",
    }),
  )
  // Una clínica de Colombia nace con la CIE-11, la lista que recomienda su país (decisión 26).
  await seedDiagnosisCodes([{ code: "DA08.0", title: "Caries dental" }], "ICD-11")
  const andrea = await c.run((tx) =>
    registerPatient(
      tx,
      c.orgId,
      { kind: "internal", userId: c.reception },
      answers({ docType: "NACIONAL", docNumber: "52998877", birthDate: "1988-03-04", phone: "+573001112233" }),
    ),
  )
  const args = [c.orgId, c.professional, andrea.id] as const
  // Una resina propia que deja una restauración, sin variante: fuera de Perú es opcional.
  // En Colombia cada servicio lleva su código CUPS (ADR 0069): el de la obturación con resina.
  await seedProcedureCodes(ownerDb)
  const resin = await c.run(async (tx) =>
    createService(tx, c.orgId, c.professional, {
      name: "Resina compuesta",
      officialCode: "232102",
      specialtyId: (await librarySpecialtyIds(tx, c.orgId, ["restauradora"])).get("restauradora")!,
      scope: "surfaces",
      priceCents: 180000,
      leavesFinding: { condition: "definitive_restoration" },
    }),
  )
  const encounter = await c.run((tx) => createEncounter(tx, ...args, { reason: "Dolor en la muela" }))
  // El panel de la pieza: la caries sin variante ni sigla, con su diagnóstico de la atención.
  await c.run((tx) =>
    registerToothFinding(tx, ...args, {
      encounterId: encounter.id,
      toothNumbers: [16],
      condition: "caries",
      surfaces: ["occlusal"],
      diagnosis: { diagnosisCode: "DA08.0", diagnosisType: "provisional" },
    }),
  )
  const [caries] = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.encounterId, encounter.id), eq(odontogramEntry.condition, "caries")))
  expect(caries?.details).not.toHaveProperty("variant")
  // Lo tratado queda dibujado, también aquí.
  await c.run((tx) =>
    addEncounterProcedure(tx, c.orgId, c.professional, andrea.id, encounter.id, {
      serviceId: resin.id,
      toothNumber: 16,
      surfaces: ["occlusal"],
      odontogramEntryId: caries!.id,
    }),
  )
  await c.run((tx) => updateEncounterDraft(tx, ...args, encounter.id, { evolution: "Se obtura la 16." }))
  const closing = await c.run((tx) => getEncounterClosing(tx, ...args, encounter.id))
  expect(closing.odontogram).toBeNull()
  const closed = await c.run((tx) => finalizeEncounter(tx, ...args, encounter.id))
  expect(closed.encounter).toMatchObject({ status: "finalizada", signerTitle: "Odontólogo" })
  expect(closed.odontogram).toBeNull()
  // Ni odontograma firmado ni su botón: no hay norma que lo pida.
  expect(await c.run((tx) => listOdontogramAssessments(tx, c.orgId, andrea.id))).toEqual([])
  await expect(
    c.run((tx) => createOdontogramAssessment(tx, ...args, { purpose: "personal", specifications: "", observations: "" })),
  ).rejects.toMatchObject({ code: "SIGNED_ODONTOGRAM_UNAVAILABLE" })
  // Al cerrar, la 16 queda con su restauración y la caries ya tratada.
  const chart = await c.run((tx) => getOdontogram(tx, c.orgId, andrea.id))
  const active = chart.teeth["16"]!.entries.map((id) => chart.history.find((entry) => entry.id === id)?.condition)
  expect(active).toEqual(["definitive_restoration"])
  const restoration = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.condition, "definitive_restoration"), isNull(odontogramEntry.voidedAt), eq(odontogramEntry.patientId, andrea.id)))
  expect(restoration[0]?.details).not.toHaveProperty("variant")
  // La hoja que se imprime es la neutra: nada de la norma peruana.
  const sheet = await c.run((tx) => getOdontogramPrint(tx, c.orgId, andrea.id))
  expect(sheet.entries.map((entry) => entry.condition)).toEqual(["definitive_restoration"])
  expect(JSON.stringify({ closing, sheet, closed: closed.encounter })).not.toMatch(PERUVIAN)
})
