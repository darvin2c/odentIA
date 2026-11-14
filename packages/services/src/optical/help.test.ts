import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { HELP_TOPICS, type HelpTopic, helpTopicForScreen, matchHelpTopics } from "../help-guide.js"
import { helpBankLabelProblems } from "../help-guide-suite.js"
import { OPTICAL_HELP_TOPICS } from "./help.js"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** Lo que una guía cita entre comillas, como lo lee `missingQuotedNames`. */
function quotedNames(topics: readonly HelpTopic[]): Set<string> {
  const out = new Set<string>()
  for (const topic of topics) {
    for (const text of [topic.purpose, ...(topic.faqs ?? []).flatMap((faq) => [faq.q, faq.a])]) {
      for (const match of text.matchAll(/«([^»]+)»/g)) {
        out.add((match[1] ?? "").replace(/[.,…:;?¿!¡]+$/g, "").replace(/^¿/, "").trim())
      }
    }
  }
  return out
}

/** Lo que escriben las pantallas de vistIA y los servicios, sin las guías, las pruebas ni los comentarios. */
function codeText(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "__golden__") continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.(test|stories|spec|gen)\./.test(name) && !/^(help|help-guide.*)\.ts$/.test(name)) {
        out.push(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      }
    }
  }
  for (const dir of ["packages/clinic-app/src", "apps/optical-clinic/src", "packages/clinical/src", "packages/optical/src", "packages/services/src"]) {
    walk(resolve(ROOT, dir))
  }
  return out.join("\n").normalize("NFC").toLowerCase()
}

/**
 * Lo que solo la guía de vistIA cita. Lo demás ya lo cita la de odentIA, que
 * `help-guide.test.ts` compara con las pantallas.
 */
const OWN_QUOTED = [
  "Una sola vez",
  "Dejar de repetir",
  "Control anual de la vista",
  "En 1 año",
  "Preparar presupuesto",
  // El examen de la vista y la receta de lentes (entrega 3).
  "Examen de la vista",
  "Receta de lentes",
  "Recetas de lentes",
  "Emitir receta de anteojos",
  "Emitir receta de lentes de contacto",
  "Transcribir receta externa",
  "Sin verificar",
  "La revisé: verificar",
  "Anteriores",
  // El pedido de lentes (entrega 4).
  "Vender lentes",
  "Vender con esta receta",
  "Sin adelanto",
  "Atrasados",
  "Enviado al laboratorio",
  "Llegó del laboratorio",
  "Revisado: está listo",
  "Entregar",
  "Marcar listo",
  "Rehacer",
  "Cambiar rol",
  // «Tus lentes están listos» (entrega 5).
  "Tus lentes ya están listos para recoger",
  "Aviso de que está listo",
  "Enviar el aviso",
  "Enviarlo otra vez",
  "Tus pedidos",
  "Tu cuenta",
  "Emitir otra desde su examen",
  // Lo indicado queda aceptado y un control puede repetirse (`budgetRequired`, `repeatingControls`).
  "Reservar lo indicado",
  "Se repite",
  // El examen: la salud del ojo y cuándo conviene el oftalmólogo.
  "Salud del ojo",
  "Conviene que lo vea un oftalmólogo",
  "Lo que importa para la vista",
  // El pedido: sus pestañas, sus pasos, lo que lleva, la receta y el adelanto.
  "Pedidos",
  "Abiertos",
  "Listos",
  "Entregados",
  "Anulados",
  "En laboratorio",
  "Entregado",
  "se rehízo",
  "Lo que lleva",
  "Montura",
  "Lunas",
  "Lentes de contacto",
  "Medidas para montar",
  "Altura OD",
  "Altura OI",
  "Sin receta",
  "la agrega quien la ve",
  "Va con el pedido; la ve quien lo hace",
  "Agregar otro medio",
  "Se vende en",
  "Ver el ticket",
  "Pedido listo",
  // La montura en el inventario («Más datos» del producto).
  "Código de barras",
  "Marca",
  "Modelo",
  "Color",
  "Medidas",
  // Lo que trae una óptica: sus consentimientos y el título que propone el perfil profesional.
  "Dilatación de las pupilas",
  "Adaptación de lentes de contacto",
  "Tecnólogo médico en optometría",
]

/** La Ayuda de vistIA: las mismas pantallas, con lo que tiene una óptica. */
describe("la guía de vistIA", () => {
  // El nombre fijo de cada respuesta no lo lee nadie en la app: se hereda igual en todos los productos.
  const text = JSON.stringify(OPTICAL_HELP_TOPICS, (key, value) => (key === "id" ? undefined : value))

  it("no habla de lo que una óptica no tiene", () => {
    for (const word of [
      /odontograma/i,
      /odontólog/i,
      /odontolog/i,
      /odentIA/i,
      /\bpiezas?\b/i,
      /sillón|sillones/i,
      /unidad(es)? dental/i,
      /ortodoncia|endodoncia|periodoncia/i,
      /caries/i,
      /\b(coronas?|resinas?|muelas?|exodoncias?|dientes?)\b/i,
      /radiograf/i,
      /panorámica|cbct|dicom/i,
      /«Dictar»|«Reanudar»/,
      /descanso/i,
      /signos vitales|examen físico/i,
      /\bASA\b|anest/i,
    ]) {
      expect(text).not.toMatch(word)
    }
  })

  it("no inventa botones: lo que cita está en las pantallas", () => {
    const dental = quotedNames(HELP_TOPICS)
    const own = [...quotedNames(OPTICAL_HELP_TOPICS)].filter((name) => !dental.has(name))
    expect(own.sort()).toEqual([...OWN_QUOTED].sort())
    const code = codeText()
    expect(OWN_QUOTED.filter((name) => !code.includes(name.normalize("NFC").toLowerCase()))).toEqual([])
  })

  it("lleva las mismas pantallas y responde lo suyo", () => {
    // Las de siempre, en su orden, y al final las que solo tiene una óptica.
    expect(OPTICAL_HELP_TOPICS.slice(0, HELP_TOPICS.length).map((topic) => [topic.id, topic.path])).toEqual(
      HELP_TOPICS.map((topic) => [topic.id, topic.path]),
    )
    expect(OPTICAL_HELP_TOPICS.slice(HELP_TOPICS.length).map((topic) => [topic.id, topic.path])).toEqual([["pedidos", "/orders"]])
    expect(helpTopicForScreen("/orders", OPTICAL_HELP_TOPICS)?.id).toBe("pedidos")
    expect(helpTopicForScreen("/patients/123", OPTICAL_HELP_TOPICS)?.id).toBe("pacientes")
    const answer = (question: string) => matchHelpTopics(question, OPTICAL_HELP_TOPICS)[0]?.faq?.a ?? ""
    expect(answer("¿Quién es Ariadna?")).toContain("guía virtual de vistIA")
    expect(answer("¿Cómo dicto una atención?")).toContain("Clío no dicta")
    expect(answer("¿Cómo enciendo a Clío?")).toContain("Clío no dicta")
    expect(answer("¿Cómo veo una OCT?")).toContain("no un estudio en cortes")
    expect(answer("¿Cómo dejo dicho cuándo vuelve?")).toContain("«En 1 año»")
    expect(answer("¿Cómo se arma y se envía el presupuesto?")).toContain("No hace falta")
    expect(answer("¿Qué son las sesiones habituales de un servicio?")).toContain("terapia visual")
    expect(answer("¿Dónde subo una retinografía o un campo visual?")).toContain("campo visual")
    expect(answer("¿Cómo elijo el diagnóstico de una atención?")).toContain("El ojo se escribe en la nota")
    expect(text).toMatch(/optómetra/)
  })

  it("la de odentIA no cambia", () => {
    expect(JSON.stringify(HELP_TOPICS)).toMatch(/odontograma/)
    expect(helpTopicForScreen("/patients/123")?.id).toBe("pacientes")
  })

  const faqOf = (id: string) => OPTICAL_HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find((faq) => faq.id === id)
  const answerOf = (id: string) => faqOf(id)?.a ?? ""

  // Auditoría del 10 nov: lo que la guía decía y en una óptica no es así.
  it("vender con una receta: el camino de Ventas y Caja es «Vender lentes»", () => {
    // «Vender con esta receta» pide leer la historia, los pedidos y la caja: no lo ven Ventas ni Caja.
    expect(answerOf("vendo-unos-lentes")).toMatch(/^En Pedidos, «Vender lentes» \(también en su página › Cobros › «Pedidos»\)/)
    expect(answerOf("vendo-unos-lentes")).toContain("solo le aparece a quien además lee la historia clínica")
    expect(text).not.toMatch(/o en «Recetas de lentes» de su ficha, «Vender con esta receta»/)
    expect(answerOf("pedidos-sin-receta")).toContain("«Sin receta»")
  })

  it("Clínica tiene cuatro secciones, con «Recetas de lentes»", () => {
    const answer = answerOf("quedaron-atenciones-recetas-u-ordenes")
    expect(answer).toContain("Clínica tiene cuatro secciones: Antecedentes, Recetas de lentes, Historia y Documentos.")
    expect(answer).toContain("(presupuestos, recetas, órdenes, consentimientos, fichas, imágenes y otros archivos)")
    expect(text).not.toMatch(/tres secciones/)
  })

  it("la montura se vende con su pedido, no solo por «Cobrar»", () => {
    const answer = answerOf("vendo-cepillo-enjuague")
    expect(answer).toContain("«Vender lentes»")
    expect(answer).toContain("«Venta de mostrador»")
  })

  it("donde la guía dice quién puede, Ventas va con recepción y con caja", () => {
    expect(answerOf("escribo-alguien-nunca-escribio")).toContain("(la tienen recepción, Ventas, el propietario y el administrador)")
    expect(answerOf("pacientes-nuevo-contacto")).toContain("Lo hacen recepción, Ventas y Administración.")
    expect(answerOf("finanzas-otro-concepto")).toContain("Lo hacen caja, Ventas y Administración.")
    expect(answerOf("quien-puede-recibir-llega")).toContain("Ventas con precios")
    // Cerrar la caja no es de Ventas (`finance.close`).
    expect(answerOf("finanzas-cerrar-caja")).toContain("La cierran caja, propietario y administrador")
    expect(answerOf("equipo-ventas-no-puede")).toMatch(/^No: /)
    expect(answerOf("equipo-roles")).toContain("Ventas")
  })

  it("lo indicado queda aceptado: ni fases ni caminos, y sin dictado", () => {
    expect(text).not.toMatch(/Reservar lo aceptado|algo aceptado sin una cita|por fases|otra fase|falta elegir el camino/)
    expect(answerOf("alergias-toca-ultima-atencion")).toContain("«Reservar lo indicado»")
    expect(faqOf("pacientes-dictado-corregir-pausar")).toBeUndefined()
    expect(faqOf("agente-clio-probar-dictado")).toBeUndefined()
    expect(text).not.toMatch(/dictas otro|control radiográfico/)
  })

  it("el portal del cliente muestra sus recetas de lentes y sus pedidos", () => {
    expect(answerOf("ve-paciente-portal")).toContain("sus recetas de lentes")
    expect(answerOf("ve-paciente-portal")).toContain("«Tus pedidos»")
    expect(answerOf("pasa-receta-vencio")).toContain("12 meses")
  })

  it("tiene las preguntas que solo se hacen en una óptica", () => {
    for (const id of [
      "pacientes-recetas-lentes-quien",
      "pacientes-receta-gotas",
      "pacientes-receta-lentes-enviar",
      "pacientes-salud-ojo-oftalmologo",
      "inventario-montura-marca-modelo",
      "roles-hay-optica",
      "equipo-ventas-no-puede",
      "tareas-ventas-taller",
      "whatsapp-mensaje-pedido-listo",
      "formularios-consentimientos-optica",
      "especialidades-trae-optica",
      "pedidos-entregados-buscar",
      "pedidos-de-un-cliente",
      "pedidos-quien-vende-quien-marca",
      "pedidos-sin-receta",
      "pedidos-montura-lunas-medidas",
      "pedidos-adelanto-varios-medios",
      "pedidos-sin-ficha",
      "pedidos-no-veo-receta",
      "pedidos-que-significa-cada-paso",
    ]) {
      expect(faqOf(id), id).toBeDefined()
    }
    // Cada nombre fijo, una sola vez en la guía.
    const ids = OPTICAL_HELP_TOPICS.flatMap((topic) => (topic.faqs ?? []).map((faq) => faq.id))
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    // Lo clínico de la ficha va en su categoría, no en la de la lista de pacientes.
    for (const id of ["anoto-examen-vista", "emito-receta-lentes", "oct", "pacientes-receta-gotas"]) expect(faqOf(id)?.area, id).toBe("clinica")
  })
})

/**
 * Lo mismo que `describeHelpSearch` le exige a la guía de cada producto, salvo
 * el piso a ciegas (abajo). «Lo que cita existe» va arriba, más estricto: la
 * lectura de pantallas de la suite incluye este archivo y lo daría por bueno.
 */
describe("buscar en la guía de vistIA", () => {
  const first = (question: string) => matchHelpTopics(question, OPTICAL_HELP_TOPICS)[0]?.topic.id ?? null
  const all = (question: string) => matchHelpTopics(question, OPTICAL_HELP_TOPICS).map((match) => match.topic.id)

  it("el banco por respuesta nombra lo que la guía tiene", () => {
    // Las preguntas de `help-preguntas.json` etiquetadas «vistia» (todavía ninguna).
    expect(helpBankLabelProblems("vistia", OPTICAL_HELP_TOPICS).join("\n")).toBe("")
  })

  it("toda pregunta frecuente se encuentra a sí misma", () => {
    for (const topic of OPTICAL_HELP_TOPICS) {
      for (const faq of topic.faqs ?? []) {
        expect(matchHelpTopics(faq.q, OPTICAL_HELP_TOPICS)[0]?.faq?.q, faq.q).toBe(faq.q)
        for (const form of faq.forms ?? []) expect(matchHelpTopics(form, OPTICAL_HELP_TOPICS)[0]?.faq?.q, form).toBe(faq.q)
      }
    }
  })

  it("nombrar una pantalla como el menú lleva a ella", () => {
    for (const topic of OPTICAL_HELP_TOPICS) {
      for (const name of [topic.title, ...(topic.menuLabel ? [topic.menuLabel] : [])])
        for (const question of [name, `¿Dónde está ${name}?`, `¿Dónde veo ${name}?`, `¿Qué es ${name}?`, `¿Para qué sirve ${name}?`]) {
          expect(first(question), question).toBe(topic.id)
        }
    }
  })

  it("una palabra dentro de otra no cuenta", () => {
    for (const question of ["gracias", "¿Cuál es la capital de Francia?", "¿Para qué sirve este botón?", "¿Puedo pintar el fondo?", "el sistema está lento"]) {
      expect(all(question), question).toEqual([])
    }
    expect(all("¿Dónde veo los controles del paciente?")).toEqual(["pacientes"])
    expect(all("¿Dónde veo mis tareas?")).toEqual(["tareas"])
    expect(all("¿Cómo cambio el logo?")).toEqual(["organizacion"])
  })

  it("entiende lo que se dice de otra forma", () => {
    expect(first("como paso un turno al jueves")).toBe("agenda")
    expect(first("quiero bloquearlo porque manda publicidad")).toBe("bandeja")
    expect(first("donde mando el link al paciente")).toBe("pacientes")
    expect(first("donde esta el presupueto")).toBe("pacientes")
    expect(first("no le llego la invitacion a la doctora")).toBe("equipo")
    expect(first("¿Cómo agrego una sala de examen?")).toBe("disponibilidad")
    expect(first("¿Cómo invito a un optómetra?")).toBe("equipo")
  })

  it("responde una sola pantalla", () => {
    expect(all("¿Cómo agendo una cita para un paciente?")).toEqual(["agenda"])
  })

  /**
   * `ciego` se escribió a ciegas para odentIA: sus preguntas del odontograma, del
   * sillón dental o de la endodoncia no son de una óptica (con ellas vistIA queda
   * en 81 de 120), y ajustar la guía de vistIA contra él lo gastaría. Hace falta
   * otro, escrito sin ver esta guía.
   */
  it.todo("a ciegas responde bien al menos 7 de cada 10, con un banco escrito para vistIA")
})
