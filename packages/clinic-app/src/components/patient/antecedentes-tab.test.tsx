import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { asaLabel, type HealthDeclarationView, type PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"
import {
  AntecedentesSummary,
  buildDrafts,
  ClinicalGroupCard,
  DeclaredHealthSnapshot,
  hasOriginalDeclaration,
  healthReviewedWords,
  laterDeclarationsOf,
} from "./antecedentes-tab"
import { EMPTY_HEALTH_FORM } from "./patient-health-fields"

// Las fechas en el formato de la clínica, no en el de la máquina que corre la prueba (el CI está en inglés).
beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
})
afterAll(() => {
  setOrgLocale(undefined, undefined)
})

declareProduct(bareProduct("dental"))

// QA del 6 nov (B4): la ASA guardada no salía en ningún resumen.
describe("la clasificación ASA en el resumen de antecedentes", () => {
  it("se dice con su nombre", () => {
    expect(asaLabel("II")).toBe("ASA II · enfermedad sistémica leve")
  })
  it("sin clasificar, nada", () => {
    expect(asaLabel("")).toBeNull()
    expect(asaLabel(null)).toBeNull()
  })
})

// QA del 14 nov (H4a de clínica): «Revisar antecedentes» llegaba con «Niega… · Ausencia confirmada»
// puesto desde el «No» que marcó la paciente; con un solo «Revisar y guardar» quedaba un «niega» que
// nadie preguntó.
describe("«Revisar antecedentes» con un «No» que dijo la persona", () => {
  const said = {
    revision: 1,
    reviewStatus: { allergies: "unknown", conditions: "none", medications: "none" },
    allergies: [],
    conditions: [],
    medications: [],
    bloodGroup: null,
    reviewedAt: null,
    reviewedBy: null,
    latestAnamnesis: null,
    reviewPending: true,
    declared: [
      {
        by: { kind: "patient", name: null, relation: null },
        at: "2026-11-13T19:27:00.000Z",
        allergies: [],
        conditions: [],
        medications: [],
        pregnancy: false,
        saidNo: { allergies: false, conditions: true, medications: false },
      },
    ],
  } as unknown as PatientHealth

  // Revisión final del 15 nov (clínica H1): al guardar por otro motivo (las semanas del embarazo), su
  // «No» pasaba a «No se le preguntó». Llega con lo que dijo: guardar es revisarlo con ella.
  it("llega con su «No», nunca como «No se le preguntó»", () => {
    const drafts = buildDrafts(said)
    expect(drafts.reviewStatus.conditions).toBe("none")
    // El «niega» que anotó el equipo también se conserva.
    expect(drafts.reviewStatus.medications).toBe("none")
  })

  it("junto al grupo dice «Dijo que no» con su día, sin un «Niega» que nadie preguntó", () => {
    const page = renderToStaticMarkup(
      <ClinicalGroupCard title="Condiciones" review="none" saidNo="Dijo que no · 13 nov · sin revisar" reviewField={null}>
        {null}
      </ClinicalGroupCard>,
    )
    expect(page).toContain("Dijo que no · 13 nov · sin revisar")
    expect(page).not.toContain("No se le preguntó")
    expect(page).not.toContain("Niega")
  })
})

// QA del 14 nov (H2 y H6 de desarrollo, 5 del auditor).
describe("«Ver declaración original»", () => {
  it("muestra el embarazo que dijo al registrarse, con sus semanas", () => {
    const page = renderToStaticMarkup(
      <DeclaredHealthSnapshot
        health={{ allergies: { state: "recorded", items: [{ substance: "Ibuprofeno" }] }, personal: { embarazo: true, semanasEmbarazo: 22 } }}
      />,
    ).replace(/<[^>]+>/g, "")
    expect(page).toContain("Ibuprofeno")
    expect(page).toContain("Embarazo · Sí · 22 semanas")
  })

  it("no se ofrece si el equipo la registró sin nada de su salud", () => {
    expect(hasOriginalDeclaration({ respondent: "staff", answers: {} }, [])).toBe(false)
    expect(hasOriginalDeclaration({ respondent: "staff", answers: { health: { bloodGroup: "O+" } } }, [])).toBe(true)
    expect(hasOriginalDeclaration({ respondent: "patient", answers: {} }, [])).toBe(true)
    expect(hasOriginalDeclaration(null, [{}])).toBe(true)
    expect(hasOriginalDeclaration(null, [])).toBe(false)
  })

  // QA de formularios del 15 nov (K16): su «No sé» se lee «No sabe», como el resto de lo que dijo.
  it("su «No sé» a las alergias y al anticoagulante dice «No sabe»", () => {
    const page = renderToStaticMarkup(
      <DeclaredHealthSnapshot
        health={{ allergies: { state: "unknown", items: [] }, anticoagulants: { state: "unknown" } }}
      />,
    ).replace(/<[^>]+>/g, "")
    expect(page).toContain("Alergias · No sabe")
    expect(page).toContain("Anticoagulantes · No sabe")
    expect(page).not.toContain("no se le preguntó")
  })
})

// Auditor, 15 nov (A3): quien se registró en línea y recepción resolvió con «Es otra persona» se quedaba
// sin «Ver declaración original»: su declaración entró con la ficha y su registro no traía su salud.
describe("lo que se muestra aparte del registro con que se creó su ficha", () => {
  const patient = { kind: "patient" as const, name: null, relation: null }
  const declaration = (via: HealthDeclarationView["via"], at: string, enteredAt: string): HealthDeclarationView => ({
    at,
    enteredAt,
    via,
    by: patient,
    health: { allergies: { state: "recorded", items: [{ substance: "Ibuprofeno" }] } },
  })
  const withHealth = { answers: { health: { allergies: { state: "recorded", items: [{ substance: "Ibuprofeno" }] } } } }

  it("el registro que trae su salud ya la muestra: su declaración no se repite", () => {
    // Registro en línea directo: entró con la ficha, en el mismo instante.
    const sameTime = "2026-11-14T08:29:00.000Z"
    expect(laterDeclarationsOf([declaration("registro", sameTime, sameTime)], { ...withHealth, createdAt: sameTime })).toEqual([])
    // Recepción lo resolvió después: el registro lleva la hora en que lo envió, la de su declaración.
    expect(
      laterDeclarationsOf([declaration("registro", sameTime, "2026-11-14T13:10:00.000Z")], { ...withHealth, createdAt: sameTime }),
    ).toEqual([])
  })

  it("si el registro no trae su salud, su declaración se muestra con su hora", () => {
    // Lo que ya se resolvió antes: el registro quedó del equipo, sin su salud, a la hora de recepción.
    const resolvedAt = "2026-11-14T13:10:00.000Z"
    const said = declaration("registro", "2026-11-14T08:29:00.000Z", resolvedAt)
    expect(laterDeclarationsOf([said], { answers: {}, createdAt: resolvedAt })).toEqual([said])
  })

  it("lo de su enlace y otro registro posterior siempre van aparte", () => {
    const link = declaration("enlace", "2026-11-15T10:00:00.000Z", "2026-11-15T10:00:00.000Z")
    const again = declaration("registro", "2026-11-16T10:00:00.000Z", "2026-11-16T10:05:00.000Z")
    const form = declaration("formulario", "2026-11-17T10:00:00.000Z", "2026-11-17T10:00:00.000Z")
    expect(laterDeclarationsOf([link, again, form], { ...withHealth, createdAt: "2026-11-14T08:29:00.000Z" })).toEqual([link, again])
    expect(laterDeclarationsOf([link], null)).toEqual([link])
  })
})

// Auditor, 14 nov: «Revisado por personal autorizado», sin nadie, al lado de una alergia sin revisar.
describe("la revisión de los antecedentes", () => {
  it("nombra a quien la hizo y el día, y dice que es de los antecedentes", () => {
    expect(healthReviewedWords("2026-11-14T15:00:00.000Z", "u1", () => "Dra. Ana Torres")).toBe(
      "Antecedentes revisados por Dra. Ana Torres · 14 nov",
    )
    expect(healthReviewedWords("2026-11-14T15:00:00.000Z", null, () => "")).toBe("Antecedentes revisados · 14 nov")
  })
})

// QA del 14 nov (causa raíz): «Ver declaración original» no traía el corazón, la anestesia, el tabaco,
// la lactancia ni las operaciones que dijo.
describe("«Ver declaración original» con todo lo que dijo", () => {
  it("el corazón, el antibiótico, la anestesia, el tabaco, la lactancia y las operaciones, tal como llegaron", () => {
    const page = renderToStaticMarkup(
      <DeclaredHealthSnapshot
        health={{
          dental: { corazon: { riesgoEndocarditis: "si", antibioticoPrevio: "no_sabe" }, problemaAnestesia: "no" },
          medical: { tabaco: "fuma", cigarrillos: "10_o_mas", lactancia: true },
          personal: { cirugias: "Apendicectomía" },
        }}
      />,
    ).replace(/<[^>]+>/g, "")
    expect(page).toContain("Válvula, problema del corazón de nacimiento o endocarditis · Sí")
    expect(page).toContain("Su médico le indicó antibiótico antes del dentista · No sabe")
    expect(page).toContain("Problema con la anestesia o sangrado tras una extracción · No")
    expect(page).toContain("Tabaco · Fuma, 10 o más al día")
    expect(page).toContain("Lactancia · Sí")
    expect(page).toContain("Operaciones · Apendicectomía")
  })
})

// QA del 14 nov (B7): «Lo dijo ella · sin revisar» iba sobre toda la tarjeta, también sobre el losartán
// que anotó el equipo. La marca va por dato.
describe("la marca de lo que dijo, por dato", () => {
  it("con lo del equipo en la misma tarjeta, solo lo que dijo ella lleva la marca", () => {
    const page = renderToStaticMarkup(
      <AntecedentesSummary
        saved={{
          ...EMPTY_HEALTH_FORM,
          reviewStatus: { conditions: "unknown", medications: "recorded" },
          medications: [
            { id: "m1", name: "Losartán", dose: "50 mg", endDate: "" },
            { id: "m2", name: "warfarina", dose: "5 mg", endDate: "" },
          ] as unknown as typeof EMPTY_HEALTH_FORM.medications,
        }}
        pendingReview
        groups={[
          {
            by: { kind: "patient", name: null, relation: null },
            at: "2026-11-14T15:00:00.000Z",
            allergies: [],
            conditions: [],
            medications: ["m2"],
            pregnancy: false,
            saidNo: { allergies: false, conditions: false, medications: false },
          },
        ]}
        pregnancy={null}
        sex="F"
      />,
    ).replace(/<[^>]+>/g, "|")
    expect(page).toContain("Losartán 50 mg, warfarina 5 mg (lo dijo ella, sin revisar)")
    expect(page).not.toContain("Lo dijo ella · sin revisar")
  })
})

// Revisión final del 15 nov (dev H2): con dos correcciones, «Medicación vigente: apixabán 5 mg,
// warfarina 7.5 mg, warfarina 5 mg», sin marca. Lo de hoy, con su historia.
describe("lo que dijo que cambió, en el resumen de Antecedentes", () => {
  it("un solo anticoagulante vigente, con el de antes al lado", () => {
    const meds = [
      { id: "apix", name: "apixabán", dose: "5 mg", atcCode: "B01AF02", endDate: null },
      { id: "w75", name: "warfarina", dose: "7.5 mg", atcCode: "B01AA03", endDate: null },
      { id: "w5", name: "warfarina", dose: "5 mg", atcCode: "B01AA03", endDate: null },
    ]
    const page = renderToStaticMarkup(
      <AntecedentesSummary
        saved={{
          ...EMPTY_HEALTH_FORM,
          reviewStatus: { conditions: "unknown", medications: "recorded" },
          medications: meds.map((m) => ({ ...m, endDate: "" })) as unknown as typeof EMPTY_HEALTH_FORM.medications,
        }}
        pendingReview
        groups={[]}
        health={
          {
            medications: meds,
            changed: {
              by: { kind: "patient", name: null, relation: null },
              at: "2026-11-14T22:21:00.000Z",
              allergies: [],
              conditions: [],
              medications: ["w75", "w5"],
            },
          } as unknown as Pick<PatientHealth, "changed" | "medications">
        }
        pregnancy={null}
        sex="F"
      />,
    ).replace(/<[^>]+>/g, "|")
    expect(page).toContain("apixabán 5 mg · antes warfarina 7.5 mg y warfarina 5 mg, cambió el 14 nov")
    expect(page).not.toContain(", warfarina")
  })
})

// Pantalla del 15 nov: el resumen de Antecedentes decía «Dijo que no · sin revisar», sin el día.
it("el resumen dice su «No» con su día, como el cajón", () => {
  const page = renderToStaticMarkup(
    <AntecedentesSummary
      saved={{ ...EMPTY_HEALTH_FORM, reviewStatus: { conditions: "none", medications: "unknown" } }}
      pendingReview
      groups={[
        {
          by: { kind: "patient", name: null, relation: null },
          at: "2026-11-13T19:27:00.000Z",
          allergies: [],
          conditions: [],
          medications: [],
          pregnancy: false,
          saidNo: { allergies: false, conditions: true, medications: false },
        },
      ]}
      pregnancy={null}
      sex="F"
    />,
  ).replace(/<[^>]+>/g, "|")
  expect(page).toContain("Dijo que no · 13 nov · sin revisar")
})
