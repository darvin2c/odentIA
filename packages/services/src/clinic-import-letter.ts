/**
 * La carta de bienvenida de una clínica nueva (ADR 0104): le da la bienvenida
 * con la marca de su producto y le pide su lista de pacientes por correo, tal
 * como la tiene. La arma la skill de carga en la máquina de quien acompaña el
 * alta, sin base de datos (`import:carta`).
 *
 * El texto (`welcomeLetterContent`) va aparte del dibujo para probar lo que
 * promete: a qué buzón, hasta cuándo y en cuántos días se borra. Lo que la carta
 * promete lo cumple la skill (`.claude/skills/odentia-carga/SKILL.md`).
 */
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { brandPaper } from "@odentia/mail"
import { z } from "zod"
import { CONSUMER_COMPLAINT_PROVIDER } from "./consumer-complaints.js"
import {
  type DocumentClinic,
  DocumentKit,
  dayWords,
  type Inline,
  SIZE,
  sheetFormat,
} from "./document-kit.js"

/** Días, como máximo, que el correo con la lista queda en el buzón: lo dice la carta y lo cumple la skill. */
export const WELCOME_LETTER_RETENTION_DAYS = 30

/**
 * Lo que cambia de un producto a otro. Los dominios son los de producción
 * (los de la web, `apps/web/src/lib/product.ts`): la carta sale para una clínica real.
 */
const PRODUCT = {
  dental: {
    brand: "odentia",
    domain: "odentia32.com",
    rooms: "Sus unidades dentales: cuántas hay en cada sede y cómo las llaman («Unidad 1»).",
    roles: "recepción, odontología, caja o administración",
    clinicians: "los odontólogos",
    college: "COP",
  },
  medical: {
    brand: "latidia",
    domain: "latidia72.com",
    rooms: "Sus consultorios: cuántos hay en cada sede y cómo los llaman («Consultorio 1»).",
    roles: "recepción, consulta, caja o administración",
    clinicians: "los médicos",
    college: "CMP",
  },
} as const

/** Una fecha AAAA-MM-DD que existe en el calendario (no el 30 de febrero). */
const isoDate = z.iso.date({ error: "Fecha AAAA-MM-DD que exista en el calendario" })

/*
 * Los largos máximos son los que caben con todo lo demás en su largo máximo
 * (la prueba lo comprueba): la carta en la primera hoja y en la segunda lo
 * que hay que enviar.
 */

export const welcomeLetterSchema = z
  .strictObject({
    /** El producto de la clínica: su marca, su web y su buzón. */
    product: z.enum(CLINICAL_PRODUCTS).default("dental"),
    /** La clínica, como la conocen sus pacientes. */
    clinic: z.string().trim().min(2).max(70),
    /** A quién va dirigida: «Dra. Ana Pérez, directora». */
    to: z.string().trim().min(2).max(55),
    /** Quien acompaña el alta: para dudas, nunca para recibir datos de pacientes. */
    companion: z.strictObject({
      name: z.string().trim().min(2).max(50),
      email: z.email().max(50),
      phone: z.string().trim().min(6).max(20).optional(),
    }),
    /** Hasta cuándo enviar la lista. */
    deadline: isoDate,
    /** Si todavía no se sabe qué usa la clínica para sus pacientes: la carta se lo pregunta. */
    askCurrentSystem: z.boolean().default(true),
    /** El día de la carta; sin decirlo, hoy. */
    date: isoDate.optional(),
    /** El buzón que recibe la lista; sin decirlo, soporte@ del dominio del producto. */
    inbox: z.email().max(50).optional(),
  })
  .refine((letter) => letter.deadline >= (letter.date ?? todayInLima()), {
    path: ["deadline"],
    message: "La fecha límite es anterior a la carta",
  })
export type WelcomeLetterInput = z.input<typeof welcomeLetterSchema>

/** Un paso de «Lo que necesitamos»: lo que hay que hacer, en negrita, y su detalle. */
export interface LetterStep {
  lead: string
  rest: string
}

export interface WelcomeLetterContent {
  brand: "odentia" | "latidia"
  brandName: string
  domain: string
  inbox: string
  /** «Lima, 9 de noviembre de 2026». */
  placeAndDate: string
  to: string
  clinic: string
  title: string
  intro: string[]
  steps: LetterStep[]
  help: { title: string; body: string }
  /** Lo que más importa, en un recuadro al empezar la hoja de lo que hay que enviar: a dónde y hasta cuándo. */
  send: { title: string; body: string }
  /** Los datos de la clínica que se piden junto con la lista: lo que el equipo registra en el alta. */
  clinicData: string[]
  /** Si la clínica todavía no dijo qué usa: la pregunta, en el paso de la reunión de alta. */
  currentSystem: string | null
  /** «La lista de pacientes»: qué sirve, lo que conviene que traiga y lo que no se puede cargar. */
  list: { lead: string; items: string[]; tail: string }
  after: string[]
}

const ZONE = { locale: "es-PE", timezone: "America/Lima" }

/** «el viernes 13 de noviembre»; con el año, si no es el de la carta. */
function deadlineWords(deadline: string, letterDate: string): string {
  const day = new Date(`${deadline}T00:00:00Z`)
  const weekday = new Intl.DateTimeFormat("es-PE", { timeZone: "UTC", weekday: "long" }).format(day)
  const date = new Intl.DateTimeFormat("es-PE", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    ...(deadline.slice(0, 4) === letterDate.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(day)
  return `el ${weekday} ${date}`
}

/** El día de hoy en Lima, AAAA-MM-DD. */
function todayInLima(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE.timezone }).format(new Date())
}

/** Lo que dice la carta, ya con la marca y las fechas. */
export function welcomeLetterContent(raw: WelcomeLetterInput): WelcomeLetterContent {
  const letter = welcomeLetterSchema.parse(raw)
  const product = PRODUCT[letter.product]
  const { name: brandName } = brandPaper(product.brand)
  const date = letter.date ?? todayInLima()
  const inbox = letter.inbox ?? `soporte@${product.domain}`
  const companion = letter.companion
  // El celular no se parte entre dos líneas: sus espacios no cortan.
  const contact = [companion.email, companion.phone?.replace(/ /g, "\u00a0")]
    .filter(Boolean)
    .join(" · ")
  const until = deadlineWords(letter.deadline, date)
  const currentSystem = letter.askCurrentSystem
    ? "Cuéntennos ahí qué usan hoy para sus pacientes (un programa, Excel o un cuaderno) y si de ahí pueden descargar las citas y los saldos."
    : null
  return {
    brand: product.brand,
    brandName,
    domain: product.domain,
    inbox,
    placeAndDate: `Lima, ${dayWords(date, ZONE)}`,
    to: letter.to,
    clinic: letter.clinic,
    title: `Bienvenidos a ${brandName}`,
    intro: [
      `Gracias por confiar en ${brandName}, una marca de ${CONSUMER_COMPLAINT_PROVIDER.legalName} Desde ahora, sus pacientes, sus citas, su historia clínica y sus conversaciones estarán en un solo lugar.`,
      "Para empezar a trabajar con su propia información necesitamos los datos de su clínica y su lista de pacientes, tal como los tienen: no hace falta ordenarlos ni llenar una plantilla.",
    ],
    steps: [
      {
        lead: `Entren a ${brandName}.`,
        rest: `Acepten la invitación que les llegó al correo. Al entrar, ${brandName} les pide aceptar el contrato de encargo de datos, con el que nos autorizan a cargar su información. Hasta que lo acepten, no podemos abrir lo que nos envíen.`,
      },
      {
        lead: `Envíen los datos de su clínica y su lista de pacientes a ${inbox} hasta ${until},`,
        rest: "en un solo correo con el nombre de la clínica en el asunto. En la página siguiente está lo que nos sirve: envíen lo que tengan y lo que falte lo completamos en la reunión. No los envíen por WhatsApp: son datos de salud.",
      },
      {
        lead: "En la reunión de alta,",
        rest: [
          `que ${companion.name} coordina con ustedes, revisamos juntos lo que enviaron y completamos lo que falte.`,
          currentSystem,
          "Si no saben cómo descargar la lista de su sistema, la descargamos juntos.",
        ]
          .filter(Boolean)
          .join(" "),
      },
    ],
    send: {
      title: `Envíen todo a ${inbox} hasta ${until}`,
      body: "En un solo correo, con el nombre de la clínica en el asunto. Envíen lo que tengan: lo que falte lo completamos en la reunión.",
    },
    help: {
      title: "¿Dudas?",
      body: `Escríbanle a ${companion.name}, quien los acompaña en el alta: ${contact}.`,
    },
    clinicData: [
      "La empresa: razón social, RUC, nombre comercial y su logo en imagen.",
      "Cada sede o local: nombre, dirección, teléfono y horario de atención.",
      product.rooms,
      `Su equipo: de cada persona, nombre completo, correo, celular y qué hace (${product.roles}) y, de ${product.clinicians}, su especialidad y su número de colegiatura (${product.college}). Cada persona recibirá una invitación para entrar.`,
      "Sus servicios y precios: su lista como la tengan; sirve una foto o el papel.",
    ],
    currentSystem,
    list: {
      lead: "Sirve su Excel o lo que descarga su sistema; si tiene varias descargas, la de pacientes. Basta el nombre de cada paciente y, si la lista los trae, también sirven:",
      items: [
        "su número de historia y su documento;",
        "su fecha de nacimiento, con el año completo, y su sexo;",
        "su celular, su correo y su dirección;",
        "de los menores, el papá, la mamá o quien los trae: su nombre, documento, parentesco y celular.",
      ],
      tail: "Lo que falte se completa después. Un PDF o fotos de fichas todavía no se pueden cargar: si solo tienen fichas en papel, lo vemos juntos en la reunión.",
    },
    after: [
      "Lo dudoso, como dos pacientes con el mismo nombre, lo confirmamos con ustedes: nunca juntamos a dos personas solo porque se parecen.",
      "Cargar a sus pacientes no les envía ningún mensaje. Al terminar les decimos cuántos entraron, cuántos ya estaban y cuáles no y por qué.",
      `Eliminamos su correo y sus archivos de nuestro buzón al terminar la carga y, como máximo, a los ${WELCOME_LETTER_RETENTION_DAYS} días de recibirlos.`,
      `Las citas, los saldos y la historia anterior todavía no se cargan: las citas de la primera semana se registran en ${brandName} y lo demás consérvenlo como lo tienen.`,
    ],
  }
}

/** La carta en PDF (A4), con el logotipo y el color de la marca y el titular en el membrete. */
export async function welcomeLetterPdf(
  raw: WelcomeLetterInput,
): Promise<{ bytes: Uint8Array; pages: number; content: WelcomeLetterContent }> {
  const content = welcomeLetterContent(raw)
  const paper = brandPaper(content.brand)
  // El papel es de la marca, no de una clínica: su logotipo, su color y el titular.
  const sender: DocumentClinic = {
    tradeName: content.brandName,
    legalName: CONSUMER_COMPLAINT_PROVIDER.legalName,
    fiscalDocType: "RUC",
    fiscalDocNumber: CONSUMER_COMPLAINT_PROVIDER.ruc,
    address: CONSUMER_COMPLAINT_PROVIDER.address,
    // La web de la marca va en la línea del teléfono: la carta no da uno general.
    phone: content.domain,
    branchName: null,
    logo: { bytes: paper.logoPng, kind: "png" },
    wordmark: true,
    brandInk: paper.color,
    locale: ZONE.locale,
    timezone: ZONE.timezone,
    sheetSize: "A4",
    receiptWidth: "80",
  }
  const kit = await DocumentKit.open(sender, sheetFormat("A4"), {
    title: content.title,
    docLabel: `Bienvenida · ${content.clinic}`,
  })
  // Dos hojas: la carta (qué hacer y qué pasa) y lo que hay que enviar, para reunirlo.
  const body = { size: SIZE.table, leading: 1.45 }

  kit.gap(8)
  kit.spread(
    { text: content.to, face: "sansSemi" },
    { text: content.placeAndDate, tone: "gray" },
    { size: SIZE.table, leading: 1.4 },
  )
  kit.text(content.clinic, { size: SIZE.table, tone: "gray", leading: 1.4 })
  kit.heading(content.title, { size: SIZE.h2, before: 12, after: 4 })
  content.intro.forEach((paragraph, index) => {
    if (index) kit.gap(4)
    kit.text(paragraph, body)
  })

  kit.subheading("Lo que necesitamos", { before: 8, after: 2 })
  kit.table({
    columns: [{ label: "", width: 18 }, { label: "" }],
    rows: content.steps.map((step, index) => [
      { text: String(index + 1), face: "sansBold" },
      [
        {
          inlines: [{ text: step.lead, face: "sansSemi" }, ` ${step.rest}`] satisfies Inline[],
          leading: 1.45,
        },
      ],
    ]),
    size: SIZE.table,
    rowPad: 2,
    plain: true,
  })
  // Lo único en negrita fuera de los pasos es a quién escribir: el paso 2 es lo que más pesa.
  kit.gap(6)
  kit.text([{ text: `${content.help.title} `, face: "sansSemi" }, content.help.body], body)

  kit.subheading("Qué pasa después", { before: 10, after: 2 })
  kit.bullets(content.after, body)

  // Lo que hay que enviar empieza en su propia hoja, salvo que la carta ya haya pasado a ella.
  if (kit.pageCount === 1) kit.newPage()
  kit.heading("Qué enviarnos", { size: SIZE.h2small, before: 4, after: 6 })
  // La hoja se usa sola para reunir los datos: repite a dónde y hasta cuándo.
  kit.panel({ title: content.send.title, body: content.send.body })
  kit.subheading("Los datos de la clínica", { before: 10, after: 2 })
  kit.bullets(content.clinicData, body)

  kit.subheading("La lista de pacientes", { before: 10, after: 2 })
  kit.text(content.list.lead, body)
  kit.bullets(content.list.items, body)
  kit.gap(4)
  kit.text(content.list.tail, body)

  const bytes = await kit.finish()
  return { bytes, pages: kit.pageCount, content }
}
