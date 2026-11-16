import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { canAccess, ORG_ROLES, type Permission } from "@odentia/auth/permissions"
import { describe, expect, it } from "vitest"
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import {
  HELP_TOPICS,
  helpGuideForRole,
  helpItemScreen,
  helpSmallTalk,
  helpTopicForScreen,
  helpWritePermissions,
  matchHelpTopics,
  PRODUCT_ONLY_SCREENS,
} from "./help-guide.js"
import { helpTopicsFor } from "./products.js"
import { describeHelpSearch, helpBanks, measureHelpBank } from "./help-guide-suite.js"
import { describeHelpScreen, exactHelpOption } from "./help.js"

/**
 * La guía de Ariadna contra el código y contra lo que pregunta la gente. Sin
 * base de datos. El CI la corre en todo PR, aunque el cambio no toque servicios:
 * una pantalla que cambia de nombre no puede llegar a main con la guía atrasada.
 * Lo mismo para latidIA está en `medical/help.test.ts`.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n")

const APPS = ["dental-clinic", "medical-clinic", "optical-clinic"] as const
const treeOf = (app: string) =>
  new Set(
    [...read(`apps/${app}/src/routeTree.gen.ts`).matchAll(/fullPath: '([^']+)'/g)].map(
      (match) => (match[1] ?? "").replace(/\/$/, "") || "/",
    ),
  )

describe("la guía coincide con el código", () => {
  it.each(APPS)("cada tema apunta a una pantalla que existe en %s", (app) => {
    const routes = treeOf(app)
    const all = [...routes]
    for (const topic of HELP_TOPICS) {
      expect(routes.has(topic.path), `${topic.id} → ${topic.path} ya no es una pantalla`).toBe(true)
      // `alsoAt` es la raíz de otras direcciones: basta con que exista algo debajo.
      for (const path of topic.alsoAt ?? []) {
        expect(all.some((route) => route === path || route.startsWith(`${path}/`)), `${topic.id} → ${path} ya no existe`).toBe(true)
      }
    }
    expect(new Set(HELP_TOPICS.map((topic) => topic.id)).size).toBe(HELP_TOPICS.length)
    expect(new Set(HELP_TOPICS.map((topic) => topic.path)).size).toBe(HELP_TOPICS.length)
  })

  it.each(APPS)("toda pantalla de la clínica en %s tiene su tema", (app) => {
    const treeText = read(`apps/${app}/src/routeTree.gen.ts`)
    const screens = [...treeText.matchAll(/id: '\/_org\/[^']*'\s+path: '[^']*'\s+fullPath: '([^']+)'/g)].map((match) => (match[1] ?? "").replace(/\/$/, ""))
    expect(screens.length).toBeGreaterThan(30)
    const orphan = screens.filter((path) => !helpTopicForScreen(path) && !PRODUCT_ONLY_SCREENS.includes(path))
    expect(orphan).toEqual([])
  })

  it("lo que solo muestra un producto tiene su tema en la guía de ese producto", () => {
    for (const path of PRODUCT_ONLY_SCREENS) {
      const owners = CLINICAL_PRODUCTS.filter((product) => helpTopicsFor(product).some((topic) => topic.path === path))
      expect(owners.length, path).toBeGreaterThan(0)
      expect(HELP_TOPICS.some((topic) => topic.path === path), `${path} no va en la guía de odentIA`).toBe(false)
    }
  })

  it("toda entrada del menú y de Configuración tiene su tema, con el mismo nombre", () => {
    const entries = (source: string) =>
      [...source.matchAll(/label: "([^"]+)", to: "([^"]+)"/g)].map((match) => ({ label: match[1] ?? "", to: match[2] ?? "" }))
    const menu = [...entries(read("packages/clinic-app/src/routes/_org.tsx")), ...entries(read("packages/clinic-app/src/routes/_org/settings.tsx"))]
    expect(menu.length).toBeGreaterThan(20)
    for (const item of menu) {
      // Lo que solo muestra un producto se busca en su guía.
      const topics = PRODUCT_ONLY_SCREENS.includes(item.to) ? CLINICAL_PRODUCTS.flatMap((product) => helpTopicsFor(product)) : HELP_TOPICS
      const topic = topics.find((candidate) => candidate.path === item.to)
      expect(topic, `Falta el tema de ${item.label} (${item.to})`).toBeTruthy()
      // La entrada «Configuración» del menú lleva a su primera sección: vale el nombre de la sección o el del grupo.
      expect([topic?.title, topic?.menuLabel, topic?.parent], item.to).toContain(item.label)
    }
  })

  it("cada permiso que nombra un tema existe en la matriz", () => {
    for (const topic of HELP_TOPICS) {
      for (const permission of helpWritePermissions(topic)) {
        expect(ORG_ROLES.some((role) => canAccess(role, permission as Permission)), `${topic.id}: ${permission}`).toBe(true)
      }
    }
    const canChange = (role: string, id: string) =>
      helpWritePermissions(HELP_TOPICS.find((topic) => topic.id === id)!).some((permission) => canAccess(role, permission as Permission))
    // Quien trabaja con ventas renombra las etapas; recepción recibe lo que llega al inventario.
    expect(canChange("reception", "pipelines")).toBe(true)
    expect(canChange("reception", "inventario")).toBe(true)
    // Quien atiende trabaja en la página de sus pacientes, aunque no los registre.
    expect(canChange("clinician", "pacientes")).toBe(true)
  })
})

describeHelpSearch("odentIA", HELP_TOPICS)

// QA de formularios del 15 nov (K18, B8 de la entrega 7): «niño» en la pregunta de la mamá llevaba a
// Pacientes cualquier pregunta con un niño. Dicha entera, o con lo que se le pregunta, la sigue encontrando.
describe("la pregunta de la mamá no se lleva cualquier pregunta con un niño", () => {
  const top = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]
  it("«niño» suelto no la responde ni ancla Pacientes", () => {
    expect(top("le doy una cita a un niño el viernes")?.faq?.id).not.toBe("que-le-preguntan-a-la-mama-de-un-nino")
    expect(top("le doy una cita a un niño el viernes")?.topic.id).not.toBe("pacientes")
  })
  it("lo que se le pregunta a la mamá, sí", () => {
    for (const question of ["¿Qué le preguntan a la mamá de un niño?", "que le preguntan a la mama de un menor", "biberón y chupón"])
      expect(top(question)?.faq?.id, question).toBe("que-le-preguntan-a-la-mama-de-un-nino")
  })
})

describe("la solo lectura por falta de pago", () => {
  const faqsOf = (topicId: string) => HELP_TOPICS.find((topic) => topic.id === topicId)?.faqs ?? []
  const firstFaq = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id ?? null

  it("cómo salir y qué pasa con un comprobante en revisión tienen su respuesta (QA del 11 nov)", () => {
    expect(firstFaq("Mi clínica está en solo lectura, ¿qué hago para volver a usarla?")).toBe("plan-y-pagos-solo-lectura")
    expect(
      firstFaq("Subí mi comprobante antes de que venza el cargo y todavía dice en revisión. ¿Igual me pueden pasar a solo lectura?"),
    ).toBe("plan-y-pagos-comprobante-en-revision")
  })

  it("no promete una prórroga en solo lectura: solo la da un comprobante en los días de gracia (`registerSaasReceipt`)", () => {
    // Lo que dice que un comprobante da más días: solo vale en los días de gracia.
    const answers = faqsOf("plan-y-pagos").filter((faq) => /da (una prórroga|unos días más)/.test(faq.a))
    expect(answers.length).toBeGreaterThan(0)
    for (const faq of answers) expect(faq.a, faq.id).toMatch(/días de gracia/)
    expect(faqsOf("plan-y-pagos").find((faq) => faq.id === "plan-y-pagos-registrar-comprobante")?.a).toContain("en solo lectura ya no da días")
  })
})

// QA de la entrega 3 (14 nov): «me dice que salga sin guardar aunque ya guardé, ¿se perdió?» llevaba a cómo
// llenar un formulario, que no lo explica, y nombraba una marca que la pantalla no muestra.
describe("salir de un formulario que se guarda solo", () => {
  const firstFaq = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id ?? null
  const faq = HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find((item) => item.id === "pacientes-formulario-salir-sin-guardar")

  it("la pregunta del equipo llega a su respuesta", () => {
    expect(firstFaq("Llené un formulario y me dice que salga sin guardar aunque ya guardé, ¿se perdió?")).toBe(
      "pacientes-formulario-salir-sin-guardar",
    )
    expect(firstFaq("¿Qué significa «Guardado, menos lo marcado»?")).toBe("pacientes-formulario-salir-sin-guardar")
  })

  it("explica cada estado y qué hace «Descartar y salir», con los nombres de la pantalla", () => {
    for (const words of ["«Guardado»", "«Guardado, menos lo marcado»", "«No se guardó»", "«¿Salir sin guardar?»", "«Seguir aquí»", "«Descartar y salir»"])
      expect(faq?.a).toContain(words)
    const all = HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).map((item) => item.a).join(" ")
    expect(all).not.toContain("«Declarado por el paciente»")
  })
})

// QA del 14 nov: contado como lo vive la doctora, la Ayuda no llegaba a la recomendada.
describe("la opción recomendada del presupuesto", () => {
  const firstFaq = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id ?? null
  const answer = HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find((faq) => faq.id === "ofrecer-dos-opciones")

  it.each([
    "opción recomendada",
    "cambiar la recomendada",
    "le sale marcada otra opción",
    "ya lo envié y la recomendada está mal",
  ])("«%s» la encuentra", (question) => {
    expect(firstFaq(question)).toBe("ofrecer-dos-opciones")
  })

  it("lo entregado se cambia con una revisión, no anulándolo", () => {
    expect(answer?.a).toContain("«Crear revisión»")
    expect(answer?.a).toMatch(/no con «Anular presupuesto»/)
  })
})

describe("saludar y agradecer", () => {
  it("se responden sin buscar", () => {
    expect(helpSmallTalk("Hola")).toContain("soy Ariadna")
    expect(helpSmallTalk("hola Ariadna")).toContain("soy Ariadna")
    expect(helpSmallTalk("¡Muchas gracias!")).toContain("De nada")
    expect(helpSmallTalk("Hola, ¿cómo cambio el logo?")).toBeNull()
  })
})

/** `desarrollo`, `control` y `final` ya se usaron para ajustar: no valen como medida, pero no pueden retroceder. */
describe("lo que se usó para ajustar", () => {
  it("no retrocede", () => {
    // Las 124 de siempre siguen sin fallos. Las 35 de odentIA que se sumaron el 2026-11-10 (lo nuevo de la guía y las de
    // dos partes) no se usaron para ajustar el buscador por palabras, que es solo el respaldo sin Jev: falla 13 de ellas.
    const desarrollo = measureHelpBank(helpBanks.desarrollo, HELP_TOPICS, "odentia")
    expect(desarrollo.bien).toBeGreaterThanOrEqual(138)
    expect(desarrollo.mal).toBeLessThanOrEqual(11)
    expect(desarrollo.noSabe).toBeLessThanOrEqual(2)
    expect(measureHelpBank(helpBanks.control, HELP_TOPICS).bien).toBeGreaterThanOrEqual(130)
    expect(measureHelpBank(helpBanks.final, HELP_TOPICS).bien).toBeGreaterThanOrEqual(85)
  })
})

/** El nombre fijo de cada respuesta: lo usan los videos, el registro y las mediciones. */
describe("cada respuesta tiene su nombre fijo", () => {
  it.each(CLINICAL_PRODUCTS)("único y bien escrito en la guía de %s", (product) => {
    const ids = helpTopicsFor(product).flatMap((topic) => (topic.faqs ?? []).map((faq) => faq.id))
    expect(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([])
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })
})

// QA del 14 nov (H5 de desarrollo y el auditor): preguntas de «lo que dijo el paciente» que la guía no
// reconocía, sobre todo después de otra pregunta en la misma conversación.
describe("lo que dijo el paciente, con las palabras de quien pregunta", () => {
  const firstFaq = (question: string) => matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id ?? null
  it.each([
    ["El paciente puso algo mal, ¿cómo lo corrijo?", "pacientes-cuestionario-corregir-lo-que-puso"],
    ["¿Qué pasa cuando le doy Marcar como revisado?", "pacientes-cuestionario-respondio-antes-de-venir"],
    ["¿Qué significa que diga lo dijo ella sin revisar?", "pacientes-antecedentes-declaracion-original"],
    ["La mamá marcó que no tiene alergias, ¿cuenta como niega?", "pacientes-antecedentes-declaracion-original"],
  ])("«%s»", (question, faq) => {
    expect(firstFaq(question)).toBe(faq)
  })
  it("«El paciente puso algo mal, ¿cómo lo corrijo?» se reconoce tal cual, sin pasar por Jev ni por la pregunta anterior", () => {
    const exact = exactHelpOption("El paciente puso algo mal, ¿cómo lo corrijo?", HELP_TOPICS)
    expect(exact?.kind === "faq" ? exact.faq.id : null).toBe("pacientes-cuestionario-corregir-lo-que-puso")
  })
  it("no promete que lo revisado siga a la vista en la atención firmada", () => {
    const answer = HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find(
      (faq) => faq.id === "pacientes-cuestionario-respondio-antes-de-venir",
    )?.a
    expect(answer).not.toContain("sigue a la vista ahí")
    expect(answer).toContain("después de firmarla")
  })
})

// Revisión final de formularios del 15 nov (A8 del auditor, H8 de desarrollo): «¿dónde veo lo que respondió?»
// le daba a la odontóloga y a caja la respuesta de recepción, y a caja le prometía lo clínico.
describe("cada rol recibe la respuesta que es para él", () => {
  const faqs = HELP_TOPICS.flatMap((topic) => topic.faqs ?? [])
  const idsOf = (role: string) => new Set(helpGuideForRole(HELP_TOPICS, role).flatMap((topic) => (topic.faqs ?? []).map((faq) => faq.id)))
  const WHAT_SHE_SAID = ["pacientes-cuestionario-respondio-antes-de-venir", "recepcion-puedo-ver-lo-que-respondio", "caja-puedo-ver-lo-que-dijo-de-su-salud"]

  it.each([
    ["owner", "pacientes-cuestionario-respondio-antes-de-venir"],
    ["admin", "pacientes-cuestionario-respondio-antes-de-venir"],
    ["clinician", "pacientes-cuestionario-respondio-antes-de-venir"],
    ["reception", "recepcion-puedo-ver-lo-que-respondio"],
    ["cashier", "caja-puedo-ver-lo-que-dijo-de-su-salud"],
  ])("%s tiene una sola de las tres: la suya", (role, own) => {
    const ids = idsOf(role)
    expect(WHAT_SHE_SAID.filter((id) => ids.has(id))).toEqual([own])
  })

  it("cada permiso que nombra una respuesta existe en la matriz", () => {
    for (const faq of faqs) {
      const named = [faq.needs, faq.notFor?.has, faq.notFor?.lacks].flatMap((item) => (item === undefined ? [] : [item].flat()))
      for (const permission of named) expect(ORG_ROLES.some((role) => canAccess(role, permission as Permission)), `${faq.id}: ${permission}`).toBe(true)
    }
  })

  it("lo escrito igual que en la guía tampoco trae la de otro rol", () => {
    const exactId = (question: string, role: string) => {
      const option = exactHelpOption(question, helpGuideForRole(HELP_TOPICS, role))
      return option?.kind === "faq" ? option.faq.id : null
    }
    expect(exactId("¿Puedo ver lo que respondió?", "reception")).toBe("recepcion-puedo-ver-lo-que-respondio")
    expect(exactId("¿Puedo ver lo que respondió?", "clinician")).not.toBe("recepcion-puedo-ver-lo-que-respondio")
    expect(exactId("¿Dónde veo lo que respondió antes de venir?", "clinician")).toBe("pacientes-cuestionario-respondio-antes-de-venir")
    expect(exactId("¿Dónde veo lo que respondió antes de venir?", "cashier")).toBeNull()
  })

  it("la de caja no promete nada clínico ni sus alergias", () => {
    const cashier = faqs.find((faq) => faq.id === "caja-puedo-ver-lo-que-dijo-de-su-salud")
    expect(cashier?.a).toMatch(/^No:/)
    expect(cashier?.a).not.toContain("sí las ves")
  })
})

// Pendiente de la entrega 11 de formularios: en la atención, la Ayuda decía «Estás en la ficha de una persona»
// y «Llévame» sacaba a la lista de Pacientes.
describe("dentro de una persona", () => {
  const patients = HELP_TOPICS.find((topic) => topic.id === "pacientes")
  it("sabe si está en su atención, en su página o en la lista", () => {
    expect(helpItemScreen("/patients/p1/encounters/e1", patients)).toEqual({ label: "la atención", named: true })
    expect(helpItemScreen("/people/p1", patients)).toEqual({ label: "la ficha de una persona", named: false })
    expect(helpItemScreen("/people", patients)).toBeNull()
    expect(helpItemScreen("/agenda", HELP_TOPICS.find((topic) => topic.id === "agenda"))).toBeNull()
  })
  it("la Ayuda nombra la atención", () => {
    expect(describeHelpScreen("/patients/p1/encounters/e1").title).toBe("la atención")
    expect(describeHelpScreen("/people/p1").title).toBe("la ficha de una persona")
    expect(describeHelpScreen("/people").title).toBe("Pacientes")
  })
})

// Estudio de la atención del 16 nov (C9, C22 y las palabras de la novata): la Ayuda le explicaba
// «Nuevo paciente» al odontólogo, que no lo tiene, y no contestaba qué ve recepción de la atención.
describe("la Ayuda sabe del rol, de cada botón y de las palabras de la atención", () => {
  const faqOf = (question: string, role: string) => {
    const option = exactHelpOption(question, helpGuideForRole(HELP_TOPICS, role))
    return option?.kind === "faq" ? option.faq.id : null
  }

  it("«Nuevo paciente» solo a quien lo tiene; al odontólogo, a quién pedírselo", () => {
    expect(faqOf("¿Cómo registro un paciente nuevo?", "reception")).toBe("registro-paciente-nuevo")
    expect(faqOf("¿Cómo registro un paciente nuevo?", "owner")).toBe("registro-paciente-nuevo")
    expect(faqOf("¿Cómo registro un paciente nuevo?", "clinician")).toBe("registro-paciente-nuevo-lo-pide")
    expect(faqOf("¿Cómo registro un paciente nuevo?", "cashier")).toBe("registro-paciente-nuevo-lo-pide")
    const asked = HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find((faq) => faq.id === "registro-paciente-nuevo-lo-pide")
    expect(asked?.a).toContain("recepción")
    expect(asked?.a).not.toContain("«Nuevo paciente»")
  })

  it("recepción tiene su respuesta sobre la atención, y quien lee la historia no la recibe", () => {
    expect(faqOf("¿Puedo ver la atención de un paciente?", "reception")).toBe("recepcion-ver-atencion")
    expect(faqOf("¿Puedo ver la atención de un paciente?", "clinician")).toBeNull()
  })

  it.each([
    ["¿Cómo le reservo lo que aceptó, como la corona o la sesión que sigue?", "pacientes-reservar-lo-aceptado"],
    ["¿Para qué sirve «Completar» en «Realizado hoy»?", "pacientes-realizado-hoy-completar"],
    ["Llené la ficha de endodoncia, ¿tengo que poner otra vez el diagnóstico?", "pacientes-ficha-endodoncia-propone-diagnostico"],
  ])("«%s» tiene su respuesta propia", (question, id) => {
    expect(faqOf(question, "owner")).toBe(id)
  })

  const WORDS = [
    "palabras-siglas-caries",
    "palabras-nts-188",
    "palabras-cie-10",
    "palabras-asa",
    "palabras-adenda",
    "palabras-inmutable",
    "palabras-liberarla",
    "palabras-lo-piensa",
    "palabras-indicado-hoy",
  ]
  it("cada palabra de la atención se dice en una línea", () => {
    const faqs = HELP_TOPICS.flatMap((topic) => topic.faqs ?? [])
    for (const id of WORDS) {
      const faq = faqs.find((item) => item.id === id)
      expect(faq, id).toBeDefined()
      expect(faq!.a.length, id).toBeLessThanOrEqual(260)
    }
  })

  it.each([
    ["¿Qué es CDP?", "palabras-siglas-caries"],
    ["que es cdp", "palabras-siglas-caries"],
    ["¿Qué es la ASA?", "palabras-asa"],
    ["que es una adenda", "palabras-adenda"],
  ])("«%s» la responde la palabra, no una pantalla", (question, id) => {
    expect(matchHelpTopics(question, HELP_TOPICS)[0]?.faq?.id).toBe(id)
  })
})
