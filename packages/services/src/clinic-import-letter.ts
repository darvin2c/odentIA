/**
 * La carta de bienvenida de una clínica nueva (ADR 0104): le da la bienvenida
 * con la marca de su producto y le pide los datos de su clínica y su lista de
 * pacientes por correo, tal como los tiene. La arma la skill de carga en la
 * máquina de quien acompaña el alta, sin base de datos (`import:carta`).
 *
 * Es una carta formal: fecha, destinatario, asunto, saludo, cuerpo, despedida
 * y firma de quien acompaña, en la primera hoja; lo que hay que enviar, en un
 * anexo en la segunda. Trata de usted a quien la recibe.
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
 * Lo que cambia de un producto a otro. Los dominios son los de producción,
 * escritos aquí porque la carta sale para una clínica real y no hay un entorno
 * de donde leerlos (el comando corre sin base ni variables).
 */
const PRODUCT = {
  dental: {
    brand: "odentia",
    domain: "odentia32.com",
    platform: "la plataforma para clínicas odontológicas",
    rooms:
      "Unidades dentales: cantidad por sede y cómo las identifican (por ejemplo, «Unidad 1»).",
    roles: "recepción, odontología, caja o administración",
    clinicians: "los odontólogos",
    college: "COP",
  },
  medical: {
    brand: "latidia",
    domain: "latidia72.com",
    platform: "la plataforma para clínicas y consultorios médicos",
    rooms:
      "Consultorios: cantidad por sede y cómo los identifican (por ejemplo, «Consultorio 1»).",
    roles: "recepción, consulta, caja o administración",
    clinicians: "los médicos",
    college: "CMP",
  },
} as const

/** Una fecha AAAA-MM-DD que existe en el calendario (no el 30 de febrero). */
const isoDate = z.iso.date({ error: "Fecha AAAA-MM-DD que exista en el calendario" })

/*
 * Los largos máximos son los que caben con todo lo demás en su largo máximo
 * (la prueba lo comprueba): la carta en la primera hoja y el anexo en la segunda.
 */

export const welcomeLetterSchema = z
  .strictObject({
    /** El producto de la clínica: su marca, su web y su buzón. */
    product: z.enum(CLINICAL_PRODUCTS).default("dental"),
    /** La clínica, como la conocen sus pacientes. */
    clinic: z.string().trim().min(2).max(70),
    /** A quién va dirigida: «Dra. Ana Pérez» o «Dra. Ana Pérez, directora». */
    to: z.string().trim().min(2).max(55),
    /** Quien acompaña el alta y firma la carta: para dudas, nunca para recibir datos de pacientes. */
    companion: z.strictObject({
      name: z.string().trim().min(2).max(50),
      /** Su cargo, bajo la firma; sin él, solo el nombre y la marca. */
      role: z.string().trim().min(2).max(50).optional(),
      email: z.email().max(50),
      phone: z.string().trim().min(6).max(20).optional(),
    }),
    /** Hasta cuándo enviar los datos y la lista. */
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

/** Un paso de «Próximos pasos»: su nombre, en negrita, y su detalle. */
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
  /** Título del PDF y del encabezado de la segunda hoja. */
  title: string
  subject: string
  salutation: string
  intro: string[]
  steps: LetterStep[]
  /** «Tratamiento de su información»: qué pasa con lo que envía. */
  after: string[]
  closing: string
  signature: { name: string; role: string | null; brand: string; contact: string }
  /** Lo que más importa, en un recuadro al empezar el anexo: a dónde y hasta cuándo. */
  send: { title: string; body: string }
  /** Los datos de la clínica que se piden junto con la lista: lo que el equipo registra en el alta. */
  clinicData: string[]
  /** Si la clínica todavía no dijo qué usa: la consulta, en el paso de la reunión. */
  currentSystem: string | null
  /** «Lista de pacientes»: qué sirve, lo que conviene que traiga y lo que no se puede cargar. */
  list: { lead: string; items: string[]; tail: string }
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
  const until = deadlineWords(letter.deadline, date)
  const currentSystem = letter.askCurrentSystem
    ? "En ella le consultaremos qué utiliza hoy para registrar a sus pacientes y si permite descargar sus citas y saldos."
    : null
  return {
    brand: product.brand,
    brandName,
    domain: product.domain,
    inbox,
    placeAndDate: `Lima, ${dayWords(date, ZONE)}`,
    to: letter.to,
    clinic: letter.clinic,
    title: `Bienvenida a ${brandName}`,
    subject: `Bienvenida a ${brandName} e información para la carga de sus datos`,
    // Formal y sin suponer el género de quien la recibe.
    salutation: "De nuestra consideración:",
    intro: [
      `Le damos la más cordial bienvenida a ${brandName}, ${product.platform} de ${CONSUMER_COMPLAINT_PROVIDER.legalName} Desde ahora, sus pacientes, citas, historia clínica y comunicaciones estarán reunidos en un solo lugar.`,
      "Para que su clínica comience a trabajar con su propia información, le solicitamos los datos de la clínica y su lista de pacientes tal como los maneja hoy, sin necesidad de ordenarlos ni adaptarlos a una plantilla.",
    ],
    steps: [
      {
        lead: `Acceso a ${brandName}.`,
        rest: `Acepte la invitación que recibió por correo. Al ingresar, ${brandName} le pedirá aceptar el contrato de encargo de datos, con el que nos autoriza a cargar su información; mientras no lo acepte, no podremos abrir lo que nos envíe.`,
      },
      {
        lead: `Envío de la información, hasta ${until}.`,
        rest: `Remita los datos de la clínica y su lista de pacientes en un solo correo a ${inbox}, con el nombre de la clínica en el asunto (detalle en el anexo). Envíe lo que tenga disponible; lo que falte lo completaremos en la reunión. Por tratarse de datos de salud, le pedimos no usar WhatsApp.`,
      },
      {
        lead: "Reunión de implementación.",
        rest: [
          `${companion.name} coordinará con usted una reunión para revisar la información y completar lo pendiente.`,
          currentSystem,
          "Si no sabe cómo descargar la lista, lo haremos juntos.",
        ]
          .filter(Boolean)
          .join(" "),
      },
    ],
    after: [
      "Las coincidencias dudosas, como dos pacientes con el mismo nombre, se confirman con usted: nunca unimos registros solo por su parecido.",
      "La carga no envía mensajes a sus pacientes. Al finalizar, le informaremos cuántos se cargaron, cuántos ya existían y cuáles no, con su motivo.",
      `Eliminamos su correo y sus archivos de nuestro buzón al concluir la carga y, como máximo, a los ${WELCOME_LETTER_RETENTION_DAYS} días de recibirlos.`,
      `Por ahora no se cargan citas, saldos ni historia clínica anterior: las citas de la primera semana se registran directamente en ${brandName}.`,
    ],
    closing: "Agradecemos su confianza y quedamos a su disposición para cualquier consulta.",
    signature: {
      name: companion.name,
      role: companion.role ?? null,
      brand: brandName,
      contact,
    },
    send: {
      title: `Enviar a ${inbox} hasta ${until}`,
      body: "En un solo correo, con el nombre de la clínica en el asunto. Envíe lo que tenga disponible: lo que falte lo completaremos en la reunión.",
    },
    clinicData: [
      "Empresa: razón social, RUC, nombre comercial y logotipo (en imagen).",
      "Sedes: nombre, dirección, teléfono y horario de atención de cada una.",
      product.rooms,
      `Equipo: nombre completo, correo, celular y función de cada persona (${product.roles}) y, de ${product.clinicians}, su especialidad y número de colegiatura (${product.college}). Cada persona recibirá una invitación para ingresar.`,
      "Servicios y precios: su tarifario en el formato que tenga; también sirve una foto o una copia en papel.",
    ],
    currentSystem,
    list: {
      lead: "Puede enviar su Excel o el archivo que descarga su sistema actual; si este ofrece varias descargas, la de pacientes. Solo el nombre es indispensable; si la lista los incluye, también nos sirven:",
      items: [
        "número de historia clínica y documento de identidad;",
        "fecha de nacimiento (con el año completo) y sexo;",
        "celular, correo electrónico y dirección;",
        "de los menores de edad, los datos de su padre, madre o apoderado: nombre, documento, parentesco y celular.",
      ],
      tail: "Los datos que falten podrán completarse después. Por ahora no es posible cargar fichas en PDF o en fotos: si su registro es en papel, lo revisaremos juntos en la reunión.",
    },
  }
}

/** La carta en PDF (A4), con el logotipo y el color de la marca y el titular en el membrete. */
export async function welcomeLetterPdf(
  raw: WelcomeLetterInput,
): Promise<{
  bytes: Uint8Array
  pages: number
  /** Las hojas de la carta hasta la firma: una, y el anexo en la siguiente. */
  letterPages: number
  content: WelcomeLetterContent
}> {
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
  // Dos hojas: la carta y el anexo con lo que hay que enviar, para reunirlo.
  // La carta, con su firma, cabe en la primera hoja; el anexo, en la segunda.
  const body = { size: SIZE.dense, leading: 1.45 }
  const section = { before: 9, after: 2 }

  // Fecha, destinatario, asunto y saludo, como una carta formal.
  kit.gap(6)
  kit.text(content.placeAndDate, { ...body, align: "right" })
  kit.gap(6)
  kit.text({ text: content.to, face: "sansSemi" }, { ...body, leading: 1.35 })
  kit.text(content.clinic, { ...body, leading: 1.35 })
  kit.text("Presente.", { ...body, leading: 1.35 })
  kit.gap(8)
  kit.text([{ text: "Asunto: ", face: "sansSemi" }, { text: content.subject, face: "sansSemi" }], body)
  kit.gap(6)
  kit.text(content.salutation, body)
  kit.gap(4)
  for (const paragraph of content.intro) {
    kit.text(paragraph, body)
    kit.gap(4)
  }

  kit.subheading("Próximos pasos", section)
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
    size: SIZE.dense,
    rowPad: 2,
    plain: true,
  })

  kit.subheading("Tratamiento de su información", section)
  kit.bullets(content.after, body)

  // Despedida y firma de quien acompaña, juntas: la firma nunca queda sola en otra hoja.
  const signature = { ...body, leading: 1.35 }
  kit.gap(6)
  kit.ensure(SIGNATURE_HEIGHT)
  kit.text(content.closing, body)
  kit.gap(4)
  kit.text("Atentamente,", body)
  kit.gap(12)
  kit.text({ text: content.signature.name, face: "sansSemi" }, signature)
  kit.text(
    content.signature.role ? `${content.signature.role} · ${content.signature.brand}` : content.signature.brand,
    { ...signature, tone: "gray" },
  )
  kit.text(content.signature.contact, { ...signature, tone: "gray" })
  const letterPages = kit.pageCount

  // El anexo empieza en su propia hoja, salvo que la carta ya haya pasado a ella.
  if (kit.pageCount === 1) kit.newPage()
  kit.heading("Anexo: información para la carga", { size: SIZE.h2small, before: 4, after: 6 })
  // La hoja se usa sola para reunir los datos: repite a dónde y hasta cuándo.
  kit.panel({ title: content.send.title, body: content.send.body, size: SIZE.dense })
  kit.subheading("1. Datos de la clínica", { before: 10, after: 2 })
  kit.bullets(content.clinicData, body)

  kit.subheading("2. Lista de pacientes", { before: 10, after: 2 })
  kit.text(content.list.lead, body)
  kit.bullets(content.list.items, body)
  kit.gap(4)
  kit.text(content.list.tail, body)

  const bytes = await kit.finish()
  return { bytes, pages: kit.pageCount, letterPages, content }
}

/** Lo que mide la despedida con la firma: dos líneas, tres de firma y sus espacios, para no partirla. */
const SIGNATURE_HEIGHT = 2 * SIZE.dense * 1.45 + 3 * SIZE.dense * 1.35 + 4 + 12
