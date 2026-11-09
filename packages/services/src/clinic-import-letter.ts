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
    rooms: "sus sillones",
    clinicians: "los odontólogos",
  },
  medical: {
    brand: "latidia",
    domain: "latidia72.com",
    rooms: "sus consultorios",
    clinicians: "los médicos",
  },
} as const

/** Una fecha AAAA-MM-DD que existe en el calendario (no el 30 de febrero). */
const isoDate = z.iso.date({ error: "Fecha AAAA-MM-DD que exista en el calendario" })

/*
 * Los largos máximos son los que caben en una hoja con todo lo demás en su
 * largo máximo (la prueba lo comprueba): la carta no pasa de una página.
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
  /** Si la clínica todavía no dijo qué usa: la pregunta, al final de «La lista de pacientes». */
  currentSystem: string | null
  list: string[]
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
  const contact = [companion.email, companion.phone?.replace(/ /g, " ")]
    .filter(Boolean)
    .join(" · ")
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
      "Para empezar a trabajar con sus propios pacientes necesitamos su lista de pacientes, tal como la tienen: no hace falta ordenarla ni llenar una plantilla.",
    ],
    steps: [
      {
        lead: `Entren a ${brandName}.`,
        rest: `Acepten la invitación que les llegó al correo. Al entrar, ${brandName} les pide aceptar el contrato de encargo de datos: con él nos autorizan a cargar a sus pacientes.`,
      },
      {
        lead: `Envíen su lista de pacientes a ${inbox} hasta ${deadlineWords(letter.deadline, date)},`,
        rest: "con el nombre de la clínica en el asunto. No la envíen por WhatsApp: son datos de salud.",
      },
      {
        lead: "Para la reunión de alta, tengan a mano",
        rest: `su RUC, sus sedes con su horario, ${product.rooms}, su equipo (nombre, correo y qué hace cada persona y, de ${product.clinicians}, su colegiatura) y su lista de precios. De los precios sirve una foto o el papel que tienen.`,
      },
    ],
    help: {
      title: "¿Dudas?",
      body: `Escríbanle a ${companion.name}, quien los acompaña en el alta: ${contact}. Si no saben cómo descargar la lista, en la reunión lo hacemos juntos.`,
    },
    currentSystem: letter.askCurrentSystem
      ? `Cuéntenle también a quien los acompaña qué usan hoy para sus pacientes (un programa, Excel o un cuaderno) y si de ahí pueden descargar las citas y los saldos, sin enviarlos todavía.`
      : null,
    list: [
      "Sirve su Excel o lo que descarga su sistema; si tiene varias descargas, la de pacientes. Basta el nombre, y si la lista los trae también sirven el número de historia, el documento, la fecha de nacimiento con el año completo, el sexo, el celular, el correo y la dirección y, de los menores, el papá, la mamá o quien los trae, con su documento, parentesco y celular. Lo que falte se completa después. Un PDF o fotos de fichas todavía no se pueden cargar.",
    ],
    after: [
      "Lo dudoso, como dos pacientes con el mismo nombre, lo confirmamos con ustedes: nunca juntamos a dos personas solo porque se parecen.",
      "Cargar a sus pacientes no les envía ningún mensaje. Al terminar les decimos cuántos entraron, cuántos ya estaban y cuáles no y por qué.",
      `Eliminamos su correo y el archivo de nuestro buzón al terminar la carga y, como máximo, a los ${WELCOME_LETTER_RETENTION_DAYS} días de recibirlo.`,
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
    title: `${content.title} · ${content.clinic}`,
    docLabel: `Bienvenida · ${content.clinic}`,
  })
  // Una página: la clínica la lee en el celular, sin pasar de hoja.
  const body = { size: SIZE.dense, leading: 1.4 }

  kit.gap(8)
  kit.spread(
    { text: content.to, face: "sansSemi" },
    { text: content.placeAndDate, tone: "gray" },
    { size: SIZE.dense, leading: 1.4 },
  )
  kit.text(content.clinic, { size: SIZE.dense, tone: "gray", leading: 1.4 })
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
          leading: 1.4,
        },
      ],
    ]),
    size: SIZE.dense,
    rowPad: 2,
    plain: true,
  })
  kit.gap(6)
  kit.panel({ title: content.help.title, body: content.help.body, size: SIZE.dense })

  kit.subheading("La lista de pacientes", { before: 8, after: 2 })
  for (const [index, paragraph] of [
    ...content.list,
    ...(content.currentSystem ? [content.currentSystem] : []),
  ].entries()) {
    if (index) kit.gap(4)
    kit.text(paragraph, body)
  }

  kit.subheading("Qué pasa después", { before: 8, after: 2 })
  kit.bullets(content.after, body)

  const bytes = await kit.finish()
  return { bytes, pages: kit.pageCount, content }
}
