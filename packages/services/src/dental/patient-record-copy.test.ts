/**
 * La copia completa de la historia (mesa del 18 nov): trae todo y dice lo mismo que la ficha. Va en
 * lo dental porque los casos son de odentIA (odontograma y periodontograma): lo común no importa
 * lo dental (`packages/dental/src/boundaries.test.ts`).
 *
 * - C1 · Rosa: la receta anulada por su alergia va en su PDF con «ANULADA» y su motivo, el archivo
 *   retirado se nombra sin su nombre ni su archivo, la orden sin resultado y el control por venir
 *   están en «Lo que sigue».
 * - C2 · Carlos: nadie le preguntó por alergias, enfermedades ni medicación: «no se le preguntó»,
 *   no «Sin registros.»; sus dos periodontogramas van como tabla y en FHIR con su clasificación.
 * - C3 · Lucía: el plan dice su decisión y la 46 dice sus dos caminos, que no se suman, sin precios.
 * - FHIR: el paquete de un caso completo pasa el esquema JSON oficial de HL7 FHIR R4 (4.0.1) y cada
 *   referencia se resuelve dentro de él.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { withOrgContext } from "@odentia/db"
import {
  patient,
  patientAllergy,
  patientDocument,
  prescription,
  serviceCatalog,
} from "@odentia/db/schema/clinical"
import { issuedPaper } from "@odentia/db/schema/clinical-forms"
import { Ajv } from "ajv"
import { eq } from "drizzle-orm"
import { strFromU8, unzipSync } from "fflate"
import { afterEach, expect, it, vi } from "vitest"
import { addPatientAllergy } from "../allergies.js"
import { placeBudgetPath } from "../budget-paths.js"
import { decideBudget, deliverBudget } from "../budgets.js"
import { addClinicalNote, retirePatientDocument } from "../clinical.js"
import { createClinicalOrder } from "../clinical-forms.js"
import { clinicalFixture, readyToClose } from "../clinical-test-fixture.js"
import { addOdontogramEntries } from "./odontogram.js"
import { savePeriodontalTooth, startPeriodontalChart } from "./periodontal.js"
import { DocumentKit } from "../document-kit.js"
import { createEncounter, finalizeEncounter } from "../encounters.js"
import { createFollowUp } from "../follow-ups.js"
import { addPlanItem } from "../plan.js"
import {
  buildPatientRecordCopy,
  type PatientRecordCopy,
  patientRecordSummary,
  RECORD_README,
} from "../patient-record.js"
import { clinicIsoDay } from "../patient-record-copy.js"
import { type FhirResource, relativeResources } from "../patient-record-test-kit.js"
import { cancelPrescription, createPrescription } from "../prescriptions.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()
afterEach(() => vi.restoreAllMocks())

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>
const ORG = "org_a"
const DEPS = { storage: {} }

/** Lo que el PDF de lectura y los papeles escriben, línea por línea (los tipos de letra van recortados). */
async function copyWithText(f: Fixture, options: { copyLink?: { url: string; until: Date } } = {}) {
  const lay = vi.spyOn(DocumentKit.prototype, "lay")
  const copy = await f.run((tx) => buildPatientRecordCopy(tx, ORG, f.patient.id, DEPS, options))
  const text = JSON.stringify(lay.mock.calls.map((call) => call[0]))
  lay.mockRestore()
  return { copy, text }
}

const entry = (copy: PatientRecordCopy, name: string) =>
  copy.entries.find((item) => item.name === name)
const fhirOf = (copy: PatientRecordCopy) => {
  const found = copy.entries.find((item) => item.name.endsWith(".fhir.json"))
  return JSON.parse(new TextDecoder().decode(found?.bytes)) as {
    entry: Array<{ fullUrl: string; resource: FhirResource }>
  }
}
const readme = (copy: PatientRecordCopy) =>
  new TextDecoder().decode(entry(copy, RECORD_README)?.bytes)
const later = (days: number) => new Date(Date.now() + days * 86_400_000)

/** Rosa: alérgica a las penicilinas, la amoxicilina anulada por eso, un archivo retirado, la panorámica pedida y el control de la endodoncia. */
async function rosa() {
  const f = await clinicalFixture()
  const run = f.run
  const rx = await run((tx) =>
    createPrescription(tx, ...f.args, {
      items: [
        {
          genericName: "Amoxicilina",
          strength: "500 mg",
          dosageForm: "cápsula",
          dose: "1 cápsula",
          route: "oral",
          frequency: "cada 8 horas",
          duration: "7 días",
        },
      ],
    }),
  )
  await run((tx) =>
    addPatientAllergy(tx, ...f.args, {
      substance: "Penicilinas",
      severity: "severa",
      reaction: "Urticaria",
    }),
  )
  await run((tx) =>
    cancelPrescription(tx, ...f.args, rx.id, {
      reason: "Alergia a penicilina registrada; se retira la prescripción.",
    }),
  )
  const [wrong] = await ownerDb
    .insert(patientDocument)
    .values({
      organizationId: ORG,
      patientId: f.patient.id,
      category: "radiografia",
      label: "Periapical de Juan Pérez",
      storageKey: `org_a/${f.patient.id}/otro.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 2048,
    })
    .returning()
  await run((tx) =>
    retirePatientDocument(tx, ...f.args, wrong!.id, { reason: "Subida al paciente equivocado" }),
  )
  await ownerDb.insert(patientDocument).values({
    organizationId: ORG,
    patientId: f.patient.id,
    category: "radiografia",
    label: "Periapical de la 46",
    storageKey: `org_a/${f.patient.id}/46.jpg`,
    contentType: "image/jpeg",
    sizeBytes: 4096,
  })
  const order = await run((tx) =>
    createClinicalOrder(tx, ORG, f.actor, {
      kind: "imagen",
      patientId: f.patient.id,
      title: "Radiografía panorámica",
      recipient: "Centro de imágenes",
    }),
  )
  const [endodontics] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: ORG,
      name: "Endodoncia",
      scope: "tooth",
      source: "custom",
      priceCents: 65000,
      currency: "PEN",
    })
    .returning()
  const endo = await run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: endodontics!.id,
      sourceEncounterId: f.encounter.id,
      toothNumber: 46,
    }),
  )
  const control = await run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "tratamiento",
      planItemId: endo.id,
      title: "Control de evolución endodóntica",
      dueAt: later(20).toISOString(),
    }),
  )
  return { f, rx, wrong: wrong!, order, endo, control }
}

it("C1 · Rosa: la receta anulada va en su PDF con su sello y su motivo, lo retirado sin su nombre, y «Lo que sigue» dice la orden y el control", async () => {
  const { f, rx, wrong, order, control } = await rosa()
  const { copy, text } = await copyWithText(f, {
    copyLink: { url: "https://clinica.test/pendientes?abre=copia#t", until: later(7) },
  })

  // La receta anulada es un papel más, en su PDF, con «ANULADA» y su motivo en la hoja.
  const paper = copy.entries.find((item) => item.name.startsWith("papeles/Receta N.º"))
  expect(paper?.name).toMatch(/\(anulada\)/)
  expect(new TextDecoder().decode(paper?.bytes?.slice(0, 5))).toBe("%PDF-")
  expect(text).toContain("ANULADA")
  expect(text).toContain("Alergia a penicilina registrada; se retira la prescripción.")
  // En el PDF de lectura, la receta dice que se anuló y por qué; la alergia va en la primera página.
  expect(text).toMatch(
    /Receta N\.º \d+ · [^"]+ · anulada el [^"]+: Alergia a penicilina registrada/,
  )
  expect(text).toContain("Antes de atenderla")
  expect(text).toContain("Alergia severa: Penicilinas (grupo) · Urticaria")
  // «Lo que sigue»: la orden sin resultado y el control por venir.
  expect(text).toContain("Lo que sigue")
  expect(text).toMatch(
    /Orden de imagen: Radiografía panorámica · a Centro de imágenes · pedida el [^"]+ · sin resultado/,
  )
  expect(text).toMatch(/Control de evolución endodóntica · toca el /)
  // El enlace va en la primera página, con hasta cuándo.
  expect(text).toContain("https://clinica.test/pendientes?abre=copia#t")
  expect(text).toMatch(/Se baja con este enlace hasta el /)

  // Lo retirado: su tipo, su fecha y su motivo; ni su nombre ni su archivo, en ningún lado.
  expect(text).toMatch(
    /Radiografía del [^"]+ · retirado el [^"]+ por Clínico: Subida al paciente equivocado/,
  )
  expect(text).not.toContain("Juan Pérez")
  expect(
    copy.entries.some((item) => item.name.includes("Juan") || item.storageKey === wrong.storageKey),
  ).toBe(false)
  const fhirText = new TextDecoder().decode(
    copy.entries.find((item) => item.name.endsWith(".fhir.json"))?.bytes,
  )
  expect(fhirText).not.toContain("Juan Pérez")

  const resources = relativeResources(fhirOf(copy))
  const request = resources.find((r) => r.resourceType === "MedicationRequest")
  expect(request).toMatchObject({
    status: "cancelled",
    statusReason: { text: "Alergia a penicilina registrada; se retira la prescripción." },
  })
  expect(resources.find((r) => r.id === order.id)).toMatchObject({
    resourceType: "ServiceRequest",
    status: "active",
    intent: "order",
  })
  expect(resources.find((r) => r.id === control.id)).toMatchObject({
    resourceType: "ServiceRequest",
    status: "active",
  })
  expect(
    resources.find((r) => r.resourceType === "DocumentReference" && r.id === wrong.id),
  ).toMatchObject({ status: "entered-in-error" })
  // El papel de la receta va como DocumentReference con su ruta dentro del ZIP y lo que documenta.
  const prescriptionPaper = resources.find(
    (r) =>
      r.resourceType === "DocumentReference" &&
      decodeURIComponent(
        (r.content as Array<{ attachment: { url?: string } }>)[0]?.attachment.url ?? "",
      ) === paper?.name,
  )
  expect(prescriptionPaper).toMatchObject({
    context: { related: [{ reference: `MedicationRequest/${request?.id}` }] },
  })
  expect(rx.id).toBeTruthy()

  // Lo que cuenta la pantalla es lo que trae el ZIP.
  expect(copy.summary).toMatchObject({
    prescriptions: 1,
    orders: 1,
    images: 1,
    signedOdontograms: 0,
  })
  const summary = await f.run((tx) => patientRecordSummary(tx, ORG, f.patient.id, DEPS))
  expect({ ...summary, approxBytes: null }).toEqual({ ...copy.summary, approxBytes: null })

  // El LÉEME, en la raíz y al final: qué trae, los estándares que cumple y lo que no se pudo incluir.
  expect(copy.entries.at(-1)?.name).toBe(RECORD_README)
  const read = readme(copy)
  expect(read).toContain("HL7 FHIR R4 (4.0.1)")
  expect(read).toContain("«papeles»")
  expect(read).toContain("Nada: todo lo de su ficha va en esta copia.")
  expect(read).not.toMatch(/PDF\/A|DICOMDIR \(/)
  // Si un archivo no se lee al armar el ZIP, el LÉEME lo nombra.
  expect(
    new TextDecoder().decode(copy.readme(["documentos/Periapical de la 46 (1a2b3c4d).jpg"])),
  ).toContain("«documentos/Periapical de la 46 (1a2b3c4d).jpg»: no se pudo leer")
})

it("C2 · Carlos: «no se le preguntó» cuando nadie preguntó, y sus dos periodontogramas como tabla y en FHIR", async () => {
  const f = await clinicalFixture()
  const run = f.run
  // Primer sondaje, en la atención del fixture, y su cierre.
  const sondaje = async (encounterId: string, depth: number) => {
    const chart = await run((tx) => startPeriodontalChart(tx, ...f.args, { encounterId }))
    await run((tx) =>
      savePeriodontalTooth(tx, ...f.args, chart.id, {
        toothNumber: 37,
        probingDepth: [4, 3, depth, 4, 3, depth],
        recession: [0, 0, 1, 1, 0, 0],
        bleeding: [true, false, true, true, false, true],
      }),
    )
    return chart
  }
  const first = await sondaje(f.encounter.id, 5)
  await f.ready(f.encounter.id)
  await run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const second = await run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Reevaluación periodontal" }),
  )
  await sondaje(second.id, 7)

  const { copy, text } = await copyWithText(f)
  for (const line of [
    "Alergias: no se le preguntó",
    "Enfermedades: no se le preguntó",
    "Medicación: no se le preguntó",
  ])
    expect(text).toContain(line)
  // Antes decía «Sin registros.», que se lee «no tiene alergias».
  expect(text).not.toContain("Sin registros.")
  expect(text.match(/Periodontograma del /g)).toHaveLength(2)
  expect(text).toContain("Periodontogramas (2)")
  // La tabla: la 37, con sus tres sitios por cara y el nivel de inserción.
  expect(text).toContain("Sondaje V")
  expect(text).toContain("4 3 7")
  expect(text).toMatch(/Empeoró desde el anterior: pieza 37, [^"]+ de 5 a 7 mm/)

  const resources = relativeResources(fhirOf(copy))
  const lists = resources.filter((r) => r.resourceType === "List")
  expect(
    lists.map((r) => (r.emptyReason as { coding: Array<{ code: string }> }).coding[0]?.code),
  ).toEqual(["notasked", "notasked", "notasked"])
  expect(resources.filter((r) => r.resourceType === "AllergyIntolerance")).toEqual([])
  const charts = resources.filter(
    (r) =>
      r.resourceType === "Observation" && (r.code as { text?: string }).text === "Periodontograma",
  )
  expect(charts).toHaveLength(2)
  expect(
    charts.every((r) => Array.isArray(r.component) && (r.component as unknown[]).length >= 2),
  ).toBe(true)
})

it("C3 · Lucía: el plan dice lo que decidió, y la 46 sus dos caminos que no se suman, sin precios ni líneas repetidas", async () => {
  const f = await clinicalFixture()
  const service = async (name: string, priceCents: number, scope = "tooth") =>
    (
      await ownerDb
        .insert(serviceCatalog)
        .values({ organizationId: ORG, name, scope, source: "custom", priceCents, currency: "PEN" })
        .returning()
    )[0]!
  const indicate = async (serviceId: string, toothNumber: number | null) =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, { serviceId, sourceEncounterId: f.encounter.id, toothNumber }),
    )
  const resina16 = await indicate((await service("Resina", 18000)).id, 16)
  const endodoncia = await indicate((await service("Endodoncia", 65000)).id, 46)
  const corona = await indicate((await service("Corona", 90000)).id, 46)
  const exodoncia = await indicate((await service("Exodoncia", 15000)).id, 46)
  const draft = await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      decisions: [
        { planItemId: resina16.id, decision: "aceptado" },
        { planItemId: endodoncia.id, decision: "pospuesto" },
        { planItemId: corona.id, decision: "pospuesto" },
        { planItemId: exodoncia.id, decision: "pospuesto" },
      ],
    }),
  )

  const { copy, text } = await copyWithText(f)
  expect(text).toMatch(/Resina · pieza 16 · aceptado/)
  // Los dos caminos juntos, una sola vez, como opciones que no se suman.
  const paths = text.match(/Caminos que no se suman, falta que elija uno: [^"]+/g) ?? []
  expect(paths.length).toBeGreaterThanOrEqual(1)
  expect(paths[0]).toMatch(/A: Endodoncia · pieza 46 · [^"]*lo piensa[^"]* \+ Corona · pieza 46/)
  expect(paths[0]).toMatch(/ · o · B: Exodoncia · pieza 46 · [^"]*lo piensa/)
  // La exodoncia no sale además como un tratamiento suelto: va solo en su camino.
  expect(text).not.toMatch(/"Exodoncia · pieza 46 · lo piensa"/)
  // Sin precios: el plan dice qué se hará, no cuánto cuesta.
  expect(text).not.toMatch(/S\/ ?\d/)

  const resources = relativeResources(fhirOf(copy))
  const plan = resources.find((r) => r.resourceType === "CarePlan")
  expect(plan).toMatchObject({ status: "active", intent: "plan" })
  const activity = ((plan?.activity ?? []) as Array<{ reference: { reference: string } }>).map(
    (a) => a.reference.reference,
  )
  expect(activity).toEqual(
    expect.arrayContaining([`ServiceRequest/${resina16.id}`, `ServiceRequest/${exodoncia.id}`]),
  )
  expect(resources.find((r) => r.id === resina16.id)).toMatchObject({
    intent: "plan",
    status: "active",
  })
  expect(resources.find((r) => r.id === exodoncia.id)).toMatchObject({
    intent: "option",
    status: "active",
  })
  expect(JSON.stringify(resources)).not.toMatch(/priceCents|18000|65000/)
})

it("FHIR: el paquete de un caso completo pasa el esquema JSON oficial de HL7 FHIR R4 y toda referencia se resuelve dentro de él", async () => {
  const { f } = await rosa()
  const run = f.run
  await ownerDb
    .update(patient)
    .set({
      address: "Jr. Las Begonias 120, dpto. 302",
      addressCity: "Miraflores",
      addressDistrict: "Lima",
      addressCountry: "PE",
    })
    .where(eq(patient.id, f.patient.id))
  await run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 36,
      condition: "caries",
      surfaces: ["occlusal"],
      encounterId: f.encounter.id,
    }),
  )
  await run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 55,
      condition: "caries",
      surfaces: ["occlusal"],
      encounterId: f.encounter.id,
    }).catch(() => null),
  )
  const chart = await run((tx) =>
    startPeriodontalChart(tx, ...f.args, { encounterId: f.encounter.id }),
  )
  await run((tx) =>
    savePeriodontalTooth(tx, ...f.args, chart.id, {
      toothNumber: 36,
      probingDepth: [5, 3, 6, 5, 3, 6],
      recession: [0, 0, 1, 1, 0, 0],
      bleeding: [true, false, true, true, false, true],
    }),
  )
  await run((tx) =>
    addClinicalNote(tx, ...f.args, {
      note: "Control post-obturación: sin dolor, oclusión estable.",
      encounterId: f.encounter.id,
    }),
  )
  // Una alergia con su criticidad anotada (la columna de la ficha; el alta de hoy no la pide).
  const latex = await run((tx) =>
    addPatientAllergy(tx, ...f.args, { substance: "Látex", severity: "moderada" }),
  )
  await ownerDb
    .update(patientAllergy)
    .set({ criticality: "alta" })
    .where(eq(patientAllergy.id, latex.id))
  await readyToClose(ORG, f.actor, f.patient.id, f.encounter.id)
  await run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))

  const copy = await withOrgContext(appDb, ORG, (tx) =>
    buildPatientRecordCopy(tx, ORG, f.patient.id, DEPS),
  )
  const bundle = fhirOf(copy)

  // El esquema oficial de HL7, el de https://hl7.org/fhir/R4/fhir.schema.json.zip (4.0.1), guardado tal cual.
  const zip = readFileSync(new URL("../__fixtures__/fhir-r4/fhir.schema.json.zip", import.meta.url))
  const schema = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(zip))["fhir.schema.json"] as Uint8Array),
  )
  // El archivo de HL7 declara draft-06 pero nombra su id con «id» (de draft-04): Ajv pide «$id».
  schema.$id = schema.id
  delete schema.id
  const ajv = new Ajv({ strict: false, allErrors: true })
  ajv.addMetaSchema(createRequire(import.meta.url)("ajv/dist/refs/json-schema-draft-06.json"))
  ajv.addSchema(schema)
  // Cada recurso contra la definición de su tipo, para que un error diga cuál y dónde.
  const problems = bundle.entry.flatMap((item) => {
    const check = ajv.getSchema(`${schema.$id}#/definitions/${item.resource.resourceType}`)
    if (!check) return [`${item.resource.resourceType}: no es un recurso de R4`]
    return check(item.resource)
      ? []
      : (check.errors ?? []).map(
          (error) =>
            `${item.resource.resourceType}${error.instancePath} ${error.message} ${JSON.stringify(error.params)}`,
        )
  })
  expect(problems).toEqual([])
  // Y el paquete entero, como lo leerá otro sistema.
  const validate = ajv.getSchema(schema.$id) as NonNullable<ReturnType<typeof ajv.getSchema>>
  expect(validate(bundle)).toBe(true)

  // Cada referencia apunta a un fullUrl del paquete (o a algo contenido, «#…»).
  const fullUrls = new Set(bundle.entry.map((item) => item.fullUrl))
  const references: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value)) {
        if (key === "reference" && typeof inner === "string") references.push(inner)
        else walk(inner)
      }
  }
  walk(bundle.entry.map((item) => item.resource))
  expect(references.length).toBeGreaterThan(10)
  expect(references.filter((ref) => !ref.startsWith("#") && !fullUrls.has(ref))).toEqual([])
  // Lo que pide el acta, en el paquete.
  const types = new Set(bundle.entry.map((item) => item.resource.resourceType))
  for (const type of [
    "Patient",
    "Organization",
    "Practitioner",
    "Encounter",
    "CarePlan",
    "ServiceRequest",
    "MedicationRequest",
    "DocumentReference",
    "AllergyIntolerance",
    "Observation",
  ])
    expect(types).toContain(type)
  const patientResource = bundle.entry.find(
    (item) => item.resource.resourceType === "Patient",
  )?.resource
  expect(patientResource).toMatchObject({
    address: [{ line: ["Jr. Las Begonias 120, dpto. 302"], city: "Miraflores", country: "PE" }],
  })
  // La criticidad es la que anotó la ficha; sin ella no va (no se deduce de la reacción severa).
  const allergies = bundle.entry
    .filter((item) => item.resource.resourceType === "AllergyIntolerance")
    .map((item) => item.resource)
  const penicillin = allergies.find((r) =>
    (r.code as { text?: string }).text?.startsWith("Penicilinas"),
  )
  expect(penicillin).toBeDefined()
  expect(penicillin).not.toHaveProperty("criticality")
  expect(allergies.find((r) => (r.code as { text?: string }).text === "Látex")).toMatchObject({
    criticality: "high",
  })
  // El odontograma por pieza, con la pieza en FDI (`ex-tooth`).
  const tooth = bundle.entry.find(
    (item) =>
      (item.resource.code as { text?: string } | undefined)?.text === "Hallazgo del odontograma",
  )?.resource
  expect(tooth).toMatchObject({
    bodySite: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/ex-tooth" }] },
  })
  // Los papeles del producto (`recordPapers`): el odontograma, en su PDF, cuenta en lo que dice la pantalla.
  const odontograms = copy.entries.filter((item) => item.name.startsWith("papeles/Odontograma"))
  expect(odontograms.length).toBeGreaterThan(0)
  expect(
    odontograms.every((item) => new TextDecoder().decode(item.bytes?.slice(0, 5)) === "%PDF-"),
  ).toBe(true)
  const signed = bundle.entry.filter(
    (item) =>
      (item.resource.category as Array<{ text?: string }> | undefined)?.[0]?.text ===
      "Odontograma firmado",
  )
  expect(copy.summary.signedOdontograms).toBe(signed.length)
  // Cada archivo de un DocumentReference está en el ZIP.
  const names = new Set(copy.entries.map((item) => item.name))
  const urls = bundle.entry
    .filter(
      (item) =>
        item.resource.resourceType === "DocumentReference" &&
        item.resource.status !== "entered-in-error",
    )
    .map((item) =>
      (item.resource.content as Array<{ attachment: { url: string } }>)[0]!.attachment.url
        .split("/")
        .map(decodeURIComponent)
        .join("/"),
    )
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.filter((url) => !names.has(url))).toEqual([])
})

it("un odontograma firmado que no se puede leer no tumba la copia, y contar lo que trae no dibuja ni guarda nada", async () => {
  const f = await clinicalFixture()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
      encounterId: f.encounter.id,
    }),
  )
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const assessmentId = (closed.odontogram as { id: string }).id
  const papersOf = () =>
    ownerDb.select().from(issuedPaper).where(eq(issuedPaper.patientId, f.patient.id))
  let puts = 0
  const counting = {
    putPatientDocument: async () => {
      puts += 1
      return { objectKey: "x.pdf", mimeType: "application/pdf", filename: "x.pdf", size: 1 }
    },
  }
  // Mirar (la pantalla, la página del enlace) no dibuja ni guarda ningún papel.
  const before = (await papersOf()).length
  const summary = await f.run((tx) =>
    patientRecordSummary(tx, ORG, f.patient.id, { storage: counting }),
  )
  expect(summary.signedOdontograms).toBe(1)
  expect(puts).toBe(0)
  expect((await papersOf()).length).toBe(before)

  // Su papel guardado no coincide con su huella: la copia sale igual y el LÉEME lo nombra.
  await ownerDb.insert(issuedPaper).values({
    organizationId: ORG,
    patientId: f.patient.id,
    documentType: "signed_odontogram",
    documentId: assessmentId,
    storageKey: "org_a/alterado.pdf",
    sha256: "0".repeat(64),
    sizeBytes: 10,
    patientInitials: "P. d.",
  })
  const altered = { getAttachment: async () => new TextEncoder().encode("otro archivo") }
  const copy = await f.run((tx) =>
    buildPatientRecordCopy(tx, ORG, f.patient.id, { storage: altered }),
  )
  expect(copy.entries.some((item) => item.name.startsWith("papeles/Odontograma firmado"))).toBe(
    false,
  )
  expect(copy.entries.some((item) => item.name.startsWith("papeles/Odontograma de hoy"))).toBe(true)
  expect(copy.summary.signedOdontograms).toBe(0)
  expect(readme(copy)).toMatch(
    /- Odontograma firmado · [^\r\n]+: no se pudo leer su PDF guardado; pídelo en la clínica\./,
  )
})

it("los nombres de los papeles llevan el día de la clínica, no el de UTC", async () => {
  // Las 21:30 del 17 en Lima son las 02:30 del 18 en UTC: el papel es del 17.
  expect(clinicIsoDay(new Date("2026-11-18T02:30:00Z"), "America/Lima")).toBe("2026-11-17")
  const { f, rx } = await rosa()
  const copy = await f.run((tx) => buildPatientRecordCopy(tx, ORG, f.patient.id, DEPS))
  const [row] = await ownerDb.select().from(prescription).where(eq(prescription.id, rx.id))
  const name = copy.entries.find((item) => item.name.startsWith("papeles/Receta"))?.name
  expect(name).toContain(` - ${clinicIsoDay(row!.issuedAt, "America/Lima")} (anulada)`)
})
