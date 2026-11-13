/**
 * Lo que arma la skill de carga en la máquina de quien acompaña el alta, sin base de
 * datos (`import:clinica`): de la fuente que escribe con lo que la clínica envió
 * (`clinica.fuente.json`, con rutas a sus archivos y lo que hay que revisar), el plan
 * que carga la administración (`clinica.json`, con los archivos dentro) y el plan de
 * carga en PDF para aprobarlo.
 *
 * Cada servicio se busca en la biblioteca del producto (`seeds/biblioteca*.csv`) con su
 * código de la lista del país; uno que no está, o sin código donde es obligatorio, se
 * dice antes de llegar a la administración.
 */
import { readFileSync } from "node:fs"
import { extname, resolve } from "node:path"
import { type ClinicalProduct, clinicalProfileFor, postalAddressErrors } from "@odentia/clinical"
import { brandPaper, type MailBrand } from "@odentia/mail"
import { z } from "zod"
import { type ClinicSetupPlan, clinicSetupPlanSchema } from "./clinic-setup-plan.js"
import { CONSUMER_COMPLAINT_PROVIDER } from "./consumer-complaints.js"
import { type DocumentClinic, DocumentKit, dayWords, SIZE, sheetFormat } from "./document-kit.js"
import { KNOWLEDGE_BASICS } from "./knowledge.js"
import { COUNTRY_CURRENCY } from "./organization-profile.js"

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }

/** Lo que solo sirve para revisar el plan: no viaja a la administración. */
const reviewSchema = z
  .strictObject({
    /** Lo que llegó: fecha, por dónde y qué. */
    received: z.array(z.string().trim().min(2).max(400)).max(10).default([]),
    /** Lo que no se carga y por qué. */
    notLoaded: z.array(z.string().trim().min(2).max(400)).max(20).default([]),
    /** Lo que decide quien aprueba, con la recomendación. */
    decisions: z.array(z.string().trim().min(2).max(600)).max(20).default([]),
    /** Las imágenes: qué llegó y qué se hizo con cada una. */
    images: z.array(z.string().trim().min(2).max(400)).max(10).default([]),
  })
  .default({ received: [], notLoaded: [], decisions: [], images: [] })

export type ClinicSetupReview = z.output<typeof reviewSchema>

/** Lo de revisar de una fuente (`review` de `clinica.fuente.json`), para armar otra vez el PDF del plan. */
export function clinicSetupReview(source: unknown): ClinicSetupReview {
  return reviewSchema.parse((source as Record<string, unknown> | null)?.review)
}

/** Una entrada de la biblioteca con su código en la lista del país, para el plan y su PDF. */
export interface LibraryEntry {
  key: string
  name: string
  code: string | null
}

const LIBRARY_FILES: Record<ClinicalProduct, { names: string; codes: string }> = {
  dental: { names: "biblioteca.csv", codes: "biblioteca_codigos.csv" },
  medical: { names: "biblioteca_medica.csv", codes: "biblioteca_medica_codigos.csv" },
  optical: { names: "biblioteca_optica.csv", codes: "biblioteca_optica_codigos.csv" },
}

const BRANDS: Record<ClinicalProduct, { brand: MailBrand; domain: string }> = {
  dental: { brand: "odentia", domain: "odentia32.com" },
  medical: { brand: "latidia", domain: "latidia72.com" },
  optical: { brand: "vistia", domain: "vistia20.com" },
}

/** Una línea de CSV simple (la biblioteca no trae comas dentro de comillas salvo en el nombre, al final). */
function csvRows(text: string): string[][] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const cells: string[] = []
      let cell = ""
      let quoted = false
      for (const char of line) {
        if (char === '"') quoted = !quoted
        else if (char === "," && !quoted) {
          cells.push(cell)
          cell = ""
        } else cell += char
      }
      cells.push(cell)
      return cells
    })
}

/** La biblioteca del producto con el código de cada entrada en la lista del país. */
export function loadLibrary(seedsDir: string, product: ClinicalProduct, countryCode: string): Map<string, LibraryEntry> {
  const files = LIBRARY_FILES[product]
  const system = clinicalProfileFor(countryCode).services?.system ?? null
  const [header, ...rows] = csvRows(readFileSync(resolve(seedsDir, files.names), "utf-8"))
  const keyAt = header!.indexOf("key")
  const nameAt = header!.indexOf("name")
  const codes = new Map<string, string>()
  if (system)
    for (const [key, codeSystem, code] of csvRows(readFileSync(resolve(seedsDir, files.codes), "utf-8")).slice(1))
      if (codeSystem === system && key && code) codes.set(key, code)
  // El nombre es la última columna y puede llevar comas («Ortodoncia integral, dentición adulta»).
  const nameOf = (row: string[]) => (nameAt === header!.length - 1 ? row.slice(nameAt).join(",") : row[nameAt]!)
  return new Map(rows.map((row) => [row[keyAt]!, { key: row[keyAt]!, name: nameOf(row), code: codes.get(row[keyAt]!) ?? null }]))
}

/** Un archivo de la fuente: su ruta, relativa a la fuente. */
const sourceFile = z.strictObject({ path: z.string().min(1) })

/**
 * Arma el plan desde la fuente: lee los archivos, los mete en base64 y lo valida. Devuelve
 * también lo de revisar y, por servicio, lo que dice la biblioteca.
 */
export function buildClinicSetupPlan(
  sourcePath: string,
  seedsDir: string,
): { plan: ClinicSetupPlan; review: ClinicSetupReview; library: Map<string, LibraryEntry>; problems: string[] } {
  const folder = resolve(sourcePath, "..")
  const source = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>
  const review = reviewSchema.parse(source.review)
  const embed = (value: unknown) => {
    const file = sourceFile.parse(value)
    const full = resolve(folder, file.path)
    const mime = MIME[extname(full).toLowerCase()]
    if (!mime) throw new Error(`«${file.path}»: el logo y la hoja van en PNG, JPG o WebP`)
    return { name: file.path.split(/[\\/]/).pop()!, mime, base64: readFileSync(full).toString("base64") }
  }
  const brand = source.brand as Record<string, unknown> | undefined
  const letterhead = source.letterhead as Record<string, unknown> | undefined
  const { review: _review, ...data } = source
  const plan = clinicSetupPlanSchema.parse({
    ...data,
    kind: "clinica",
    version: 1,
    brand: brand ? { ...brand, ...(brand.logo ? { logo: embed(brand.logo) } : {}) } : undefined,
    letterhead: letterhead ? { ...letterhead, file: embed(letterhead.file) } : undefined,
  })
  const library = loadLibrary(seedsDir, plan.product, plan.countryCode)
  const profile = clinicalProfileFor(plan.countryCode)
  const required = profile.services?.required ?? false
  const problems: string[] = []
  // Lo que la administración rechazaría, dicho aquí: la dirección de cada sede según el país.
  for (const branch of plan.branches) {
    const errors = postalAddressErrors(profile, {
      line: branch.addressLine1,
      city: branch.city,
      district: branch.district,
      region: branch.region,
      postalCode: branch.postalCode,
      country: plan.countryCode,
    })
    for (const message of Object.values(errors)) problems.push(`Sede «${branch.name}»: ${message}`)
  }
  // Y las monedas: la del país y, si cobra en otra, esa con su cambio de hoy.
  const base = COUNTRY_CURRENCY[plan.countryCode]
  const second = plan.identity?.secondCurrency ?? null
  if (second && !plan.identity?.exchangeRate) problems.push(`Para cobrar en ${second} hace falta el cambio de hoy (identity.exchangeRate)`)
  const charges = (currency: string) => currency === base || currency === second
  const currencies = [base, second].filter(Boolean).join(" y ")
  plan.services.forEach((service, index) => {
    if (!charges(service.currency))
      problems.push(`Servicio ${index + 1} («${service.name ?? service.template}»): cobra en ${service.currency} y la clínica cobra en ${currencies}: agrega identity.secondCurrency`)
  })
  for (const expense of plan.recurringExpenses)
    if (expense.currency && !charges(expense.currency))
      problems.push(`Gasto «${expense.concept}»: va en ${expense.currency} y la clínica cobra en ${currencies}`)
  plan.services.forEach((service, index) => {
    if (!service.template) {
      if (required && !service.officialCode) problems.push(`Servicio ${index + 1} («${service.name}»): uno propio lleva su código oficial`)
      return
    }
    const entry = library.get(service.template)
    if (!entry) problems.push(`Servicio ${index + 1}: «${service.template}» no está en la biblioteca`)
    else if (required && !entry.code) problems.push(`Servicio ${index + 1} («${entry.name}»): no tiene código en la lista del país`)
  })
  return { plan, review, library, problems }
}

/**
 * El detalle de lo que el plan carga, por área, para el informe a la clínica: cada dato con
 * su valor, tal como quedó. Lo que espera a una persona (su perfil, su horario) no va: va en
 * «Aún no usamos».
 */
export function clinicSetupReportSections(
  plan: ClinicSetupPlan,
  library: Map<string, LibraryEntry>,
): Array<{ title: string; rows: Array<{ label: string; value: string }> }> {
  const sections: Array<{ title: string; rows: Array<{ label: string; value: string }> }> = []
  const add = (title: string, rows: Array<[string, string | null | undefined]>) => {
    const kept = rows.filter((row): row is [string, string] => !!row[1]).map(([label, value]) => ({ label, value }))
    if (kept.length) sections.push({ title, rows: kept })
  }
  const id = plan.identity ?? {}
  const base = COUNTRY_CURRENCY[plan.countryCode]
  add("Empresa", [
    ["Nombre comercial", id.tradeName],
    ["Razón social", id.legalName],
    [id.fiscalDocType === "RUC" || !id.fiscalDocType ? "RUC" : id.fiscalDocType, id.fiscalDocNumber],
    ["Dirección fiscal", id.fiscalAddress],
    ["Teléfono de urgencias", id.emergencyPhone],
    ["Monedas", id.secondCurrency ? `${base} y ${id.secondCurrency}${id.exchangeRate ? ` (cambio de hoy: ${id.exchangeRate})` : ""}` : base],
    ["Vigencia del presupuesto", plan.papers?.budgetValidDays ? `${plan.papers.budgetValidDays} días` : null],
    ["Ticket", plan.papers?.receiptWidth ? `${plan.papers.receiptWidth} mm` : null],
  ])
  add("Marca y papeles", [
    ["Color de la marca", plan.brand?.color],
    ["Logo", plan.brand?.logo ? "Su logo, en PNG transparente" : null],
    ["Hoja membretada", plan.letterhead ? "Su hoja, en la que salen recetas, presupuestos y demás papeles" : null],
  ])
  for (const branch of plan.branches)
    add(`Sede ${branch.name}`, [
      ["Dirección", [branch.addressLine1, branch.city].filter(Boolean).join(", ")],
      ["Teléfono de la sede", branch.phone],
      ["Unidades", branch.rooms.length ? branch.rooms.join(", ") : null],
      ["Cita regular", branch.appointmentMinutes ? `${branch.appointmentMinutes} minutos` : null],
    ])
  const system = clinicalProfileFor(plan.countryCode).services?.label ?? "código"
  add(
    "Servicios y precios",
    plan.services.map((service) => {
      const entry = service.template ? library.get(service.template) : undefined
      const name = service.name ?? entry?.name ?? "Servicio"
      const code = entry?.code ?? service.officialCode
      return [
        `${name}${code ? ` (${system} ${code})` : ""}`,
        `${service.priceDisclosure === "desde" ? "desde " : ""}${money(service.priceCents, service.currency)}${entry ? "" : " · servicio propio"}`,
      ]
    }),
  )
  add("Caja", [
    ["Medios de pago", plan.paymentMethods.map((m) => m.name).join(", ") || null],
    ...plan.recurringExpenses.map((e): [string, string] => [
      `Gasto fijo: ${e.concept}`,
      `${money(e.amountCents, e.currency ?? base ?? "PEN")}, ${e.everyMonths === 1 ? "cada mes" : `cada ${e.everyMonths} meses`}, el día ${e.day}`,
    ]),
  ])
  add(
    "Lo que responde su asistente a los pacientes",
    plan.knowledge.map((k): [string, string] => [k.title ?? KNOWLEDGE_BASICS.find((b) => b.key === k.basicKey)?.question ?? "Pregunta", k.body]),
  )
  add("Formatos propios (en borrador, para que los revise)", [
    ...plan.consents.map((c): [string, string] => ["Consentimiento", c.title]),
    ...plan.forms.map((f): [string, string] => ["Formulario", f.title]),
  ])
  return sections
}

const money = (cents: number, currency: string) =>
  `${currency === "PEN" ? "S/" : currency === "USD" ? "$" : `${currency} `}${(cents / 100).toLocaleString("es-PE", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]

/** El rol como se dice en la clínica. */
const ROLE_WORDS: Record<string, string> = {
  owner: "propietaria",
  admin: "administración",
  reception: "recepción",
  clinician: "profesional",
  cashier: "caja",
  sales: "ventas",
  workshop: "taller",
  member: "equipo",
}

/** El plan de carga en PDF, para aprobarlo antes de cargar. */
export async function clinicSetupPlanPdf(
  plan: ClinicSetupPlan,
  review: ClinicSetupReview,
  library: Map<string, LibraryEntry>,
  options: { number: number; date: string },
): Promise<{ bytes: Uint8Array; pages: number }> {
  const product = BRANDS[plan.product]
  const paper = brandPaper(product.brand)
  const titular = CONSUMER_COMPLAINT_PROVIDER
  const sender: DocumentClinic = {
    tradeName: paper.name,
    legalName: titular.legalName,
    fiscalDocType: "RUC",
    fiscalDocNumber: titular.ruc,
    address: titular.address,
    phone: product.domain,
    branchName: null,
    logo: { bytes: paper.logoPng, kind: "png" },
    wordmark: true,
    brandInk: paper.color,
    locale: "es-PE",
    timezone: "America/Lima",
    sheetSize: "A4",
    receiptWidth: "80",
  }
  const title = `Plan de carga N.º ${options.number} · ${plan.clinic}`
  const kit = await DocumentKit.open(sender, sheetFormat("A4"), {
    title,
    docLabel: "",
    legalNote: `${paper.name} · Uso interno · para aprobar`,
  })
  const body = { size: SIZE.dense, leading: 1.4 }
  const section = { before: 8, after: 2 }
  const rows = (pairs: Array<[string, string | null | undefined]>) =>
    kit.table({
      columns: [{ label: "Dato", width: 150 }, { label: "Valor" }],
      rows: pairs.filter(([, value]) => value).map(([label, value]) => [label, value!]),
      size: SIZE.dense,
      rowPad: 2,
    })

  kit.text(`Lima, ${dayWords(options.date, { locale: "es-PE", timezone: "America/Lima" })}`, { ...body, align: "right" })
  kit.heading(title, { size: SIZE.h2small, before: 4, after: 2 })
  kit.text("Qué se va a cargar y qué se va a hacer con la información que envió la clínica. Nada se carga sin aprobación.", body)

  if (review.received.length) {
    kit.subheading("Lo que llegó", section)
    kit.bullets(review.received, body)
  }
  if (plan.identity || plan.papers || plan.brand) {
    kit.subheading("Empresa, marca y papeles", section)
    const id = plan.identity ?? {}
    rows([
      ["Nombre comercial", id.tradeName],
      ["Razón social", id.legalName],
      ["Documento fiscal", id.fiscalDocNumber ? `${id.fiscalDocType ?? ""} ${id.fiscalDocNumber}`.trim() : null],
      ["Dirección fiscal", id.fiscalAddress],
      ["Teléfono de urgencias", id.emergencyPhone],
      ["Segunda moneda", id.secondCurrency ? `${id.secondCurrency}${id.exchangeRate ? ` · cambio ${id.exchangeRate}` : ""}` : null],
      ["Vigencia del presupuesto", plan.papers?.budgetValidDays ? `${plan.papers.budgetValidDays} días` : null],
      ["Ticket", plan.papers?.receiptWidth ? `${plan.papers.receiptWidth} mm` : null],
      ["Color de la marca", plan.brand?.color],
      ["Logo", plan.brand?.logo?.name],
      ["Hoja membretada", plan.letterhead ? `${plan.letterhead.file.name}: se mide y se sube al cargar` : null],
    ])
  }
  if (plan.branches.length) {
    kit.subheading("Sedes", section)
    kit.table({
      columns: [{ label: "Sede", width: 110 }, { label: "Dirección" }, { label: "Unidades", width: 120 }],
      rows: plan.branches.map((b) => [
        b.name,
        [b.addressLine1, b.district, b.city].filter(Boolean).join(", ") || "—",
        b.rooms.length ? b.rooms.join(", ") : "La que nace sola",
      ]),
      size: SIZE.dense,
      rowPad: 2,
    })
  }
  if (plan.services.length) {
    const system = clinicalProfileFor(plan.countryCode).services?.label ?? "Código"
    kit.subheading("Servicios: de la biblioteca, con su código", section)
    kit.table({
      columns: [{ label: "Servicio" }, { label: "Biblioteca", width: 150 }, { label: system, width: 52 }, { label: "Precio", width: 78 }],
      rows: plan.services.map((s) => {
        const entry = s.template ? library.get(s.template) : undefined
        return [
          s.name ?? entry?.name ?? "—",
          entry ? entry.name : "Excepción: servicio propio",
          entry?.code ?? s.officialCode ?? "—",
          `${s.priceDisclosure === "desde" ? "desde " : ""}${money(s.priceCents, s.currency)}`,
        ]
      }),
      size: SIZE.dense,
      rowPad: 2,
    })
  }
  if (plan.paymentMethods.length || plan.recurringExpenses.length) {
    kit.subheading("Caja", section)
    if (plan.paymentMethods.length) kit.text(`Medios de pago: ${plan.paymentMethods.map((m) => m.name).join(", ")}.`, body)
    if (plan.recurringExpenses.length)
      kit.bullets(
        plan.recurringExpenses.map((e) => `${e.concept}: ${money(e.amountCents, e.currency ?? "PEN")}, ${e.everyMonths === 1 ? "cada mes" : `cada ${e.everyMonths} meses`}, el día ${e.day}${e.person ? ` (sueldo de ${e.person})` : ""}`),
        body,
      )
  }
  if (plan.products.length || plan.suppliers.length) {
    kit.subheading("Inventario y proveedores", section)
    if (plan.suppliers.length) kit.text(`Proveedores: ${plan.suppliers.map((s) => s.name).join(", ")}.`, body)
    if (plan.products.length)
      kit.bullets(plan.products.slice(0, 40).map((p) => `${p.name}${p.onHand !== undefined ? `: ${p.onHand} ${p.unit ?? ""}`.trimEnd() : ""}${p.expiresAt ? `, vence ${p.expiresAt}` : ""}`), body)
    if (plan.products.length > 40) kit.text(`Y ${plan.products.length - 40} productos más.`, body)
  }
  if (plan.knowledge.length) {
    kit.subheading("Lo que responde el asistente", section)
    kit.bullets(
      plan.knowledge.map((k) => `${k.title ?? KNOWLEDGE_BASICS.find((b) => b.key === k.basicKey)?.label ?? k.basicKey}: ${k.body}`),
      body,
    )
  }
  if (plan.consents.length || plan.forms.length) {
    kit.subheading("Formatos propios", section)
    kit.bullets([...plan.consents.map((c) => `Consentimiento: ${c.title}`), ...plan.forms.map((f) => `Formulario: ${f.title}`)], body)
  }
  if (plan.team.length) {
    kit.subheading("Equipo", section)
    kit.bullets(
      plan.team.map((m) => {
        const what = [
          m.profile ? `${m.profile.professionalTitle}, ${m.profile.registrationBody} ${m.profile.registrationNumber ?? ""}`.trim() : null,
          m.schedule.length ? `horario: ${m.schedule.map((r) => `${WEEKDAYS[r.weekday]} ${r.start}–${r.end}`).join(", ")}` : null,
          m.commissionBps !== undefined ? `comisión ${m.commissionBps / 100} %` : null,
        ].filter(Boolean)
        return `${m.name ?? m.email} (${m.email}), ${ROLE_WORDS[m.role] ?? m.role}${what.length ? `: ${what.join("; ")}` : ""}`
      }),
      body,
    )
    kit.text("Lo de cada profesional se carga cuando esa persona ya es parte de la clínica.", { ...body, tone: "gray" })
  }
  if (review.images.length) {
    kit.subheading("Imágenes", section)
    kit.bullets(review.images, body)
  }
  if (review.notLoaded.length) {
    kit.subheading("Lo que no se carga y por qué", section)
    kit.bullets(review.notLoaded, body)
  }
  if (review.decisions.length) {
    kit.subheading("Para decidir", section)
    kit.bullets(review.decisions, body)
  }
  const bytes = await kit.finish()
  return { bytes, pages: kit.pageCount }
}
