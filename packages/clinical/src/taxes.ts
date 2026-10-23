/**
 * El impuesto de lo que cobra la clínica (issue 145, ADR 0083). Lo propone el
 * país y la clínica solo lo cambia si su contador se lo pide. Los precios
 * siempre lo incluyen: una limpieza de 118 con IGV 18 % son 100 más 18.
 *
 * La categoría es la de UN/CEFACT 5305 (la de UBL y EN 16931): `S` con tasa,
 * `E` exento, `O` fuera del impuesto (excluido, inafecto o un régimen que no lo
 * cobra) y `Z` tasa cero. Ninguna afirma que la clínica cumple con su autoridad
 * tributaria: odentIA separa el impuesto para el ticket y Reportes; declara su
 * contador.
 */

export const TAX_CATEGORIES = ["S", "E", "O", "Z"] as const
export type TaxCategory = (typeof TAX_CATEGORIES)[number]

/** Atención (consultas, tratamientos, adelantos) o venta de un producto. */
export type TaxScope = "servicios" | "productos"

/** Lo que guarda la clínica o un cobro: la categoría y su tasa en puntos básicos (1800 = 18 %). */
export interface TaxRate {
  category: TaxCategory
  rateBps: number
}

/** Una opción de la lista del país. */
export interface TaxChoice extends TaxRate {
  key: string
  /** «IGV 18 %», «Exento de IVA». */
  label: string
  /** Una nota corta a la derecha de la opción: «Región fronteriza». */
  note?: string
}

/** Cómo está constituida la clínica, cuando el impuesto de la atención depende de eso. */
export interface TaxLegalForm {
  key: string
  label: string
  /** Opción de la lista para las atenciones y para los productos. */
  servicios: string
  productos: string
}

export interface CountryTaxProfile {
  /** «IGV», «IVA». */
  name: string
  /** La norma que lo fija, para «Normas de tu país». */
  law: string
  choices: readonly TaxChoice[]
  /** Lo que propone el país si no hay una forma que elegir. */
  servicios: string
  productos: string
  /** México: la atención depende de quién la presta (la primera es la que se propone). */
  legalForms?: readonly TaxLegalForm[]
  /** Por qué se pregunta la forma, debajo de la pregunta. */
  legalFormHelp?: string
}

/** Tope de «Otra tasa…»: ninguna tasa general de la región pasa del 27 %. */
export const MAX_CUSTOM_TAX_BPS = 5000

/**
 * Comprobado el 2026-10-23 en la norma de cada país: Perú, TUO de la Ley del
 * IGV (D.S. 055-99-EF; el Apéndice II no exonera la salud, y desde la Ley
 * 32387 el 18 % se reparte entre IGV e IPM); Chile, DL 825, art. 12 E n.° 20
 * (Ley 21.420: la atención ambulatoria está exenta); Colombia, Estatuto
 * Tributario, art. 476 n.° 1 (la odontología está excluida); México, Ley del
 * IVA, art. 15 fr. XIV (exenta solo si la presta una persona física o una
 * sociedad civil). Otro país entra con su norma: mientras no esté, no hay
 * impuesto que separar.
 */
const TAX_BY_COUNTRY: Readonly<Record<string, CountryTaxProfile>> = {
  PE: {
    name: "IGV",
    law: "TUO de la Ley del IGV",
    choices: [
      { key: "igv18", category: "S", rateBps: 1800, label: "IGV 18 %" },
      { key: "sin_igv", category: "O", rateBps: 0, label: "Sin IGV (Nuevo RUS)" },
    ],
    servicios: "igv18",
    productos: "igv18",
  },
  CL: {
    name: "IVA",
    law: "DL 825, art. 12 E n.° 20",
    choices: [
      { key: "iva19", category: "S", rateBps: 1900, label: "IVA 19 %" },
      { key: "exento", category: "E", rateBps: 0, label: "Exento de IVA" },
    ],
    servicios: "exento",
    productos: "iva19",
  },
  CO: {
    name: "IVA",
    law: "Estatuto Tributario, art. 476",
    choices: [
      { key: "iva19", category: "S", rateBps: 1900, label: "IVA 19 %" },
      { key: "excluido", category: "O", rateBps: 0, label: "Excluido de IVA" },
    ],
    servicios: "excluido",
    productos: "iva19",
  },
  MX: {
    name: "IVA",
    law: "Ley del IVA, art. 15 fr. XIV",
    choices: [
      { key: "iva16", category: "S", rateBps: 1600, label: "IVA 16 %" },
      { key: "iva8", category: "S", rateBps: 800, label: "IVA 8 %", note: "Región fronteriza" },
      { key: "exento", category: "E", rateBps: 0, label: "Exento de IVA" },
    ],
    servicios: "exento",
    productos: "iva16",
    legalForms: [
      { key: "persona_fisica", label: "Persona física o sociedad civil", servicios: "exento", productos: "iva16" },
      { key: "sociedad_mercantil", label: "Sociedad mercantil (S.A. de C.V. u otra)", servicios: "iva16", productos: "iva16" },
    ],
    legalFormHelp:
      "La atención de un cirujano dentista persona física o sociedad civil está exenta de IVA; la de una sociedad mercantil paga 16 %.",
  },
}

/** Las reglas del país, o null si odentIA aún no conoce su impuesto. */
export function taxProfileFor(country: string | null | undefined): CountryTaxProfile | null {
  const code = country?.trim().toUpperCase()
  return code ? (TAX_BY_COUNTRY[code] ?? null) : null
}

/** Lo que la clínica guardó: null en una cifra es «lo del país». */
export interface OrgTaxSettings {
  legalForm?: string | null
  servicios?: TaxRate | null
  productos?: TaxRate | null
}

/** Una cifra ya resuelta: la que vale y si es la del país. */
export interface EffectiveTax extends TaxRate {
  label: string
  /** Es lo que propone el país (con su forma, si la pregunta). */
  isDefault: boolean
  /** La opción de la lista, o null si es «Otra tasa…». */
  choiceKey: string | null
}

export interface OrgTaxes {
  name: string
  law: string
  /** La forma que vale (México), o null si el país no la pregunta. */
  legalForm: TaxLegalForm | null
  /** El país la pregunta y la clínica aún no respondió. */
  legalFormPending: boolean
  servicios: EffectiveTax
  productos: EffectiveTax
}

function choice(profile: CountryTaxProfile, key: string): TaxChoice {
  const found = profile.choices.find((item) => item.key === key)
  if (!found) throw new Error(`Opción de impuesto desconocida: ${key}`)
  return found
}

function sameRate(a: TaxRate, b: TaxRate): boolean {
  return a.category === b.category && a.rateBps === b.rateBps
}

/** «12,5 %» con la coma o el punto de la clínica; los enteros sin decimales. */
export function percentText(rateBps: number, locale = "es-PE"): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(rateBps / 100)} %`
}

/** El nombre de una tasa del país: la etiqueta de su opción o, si es otra, «IVA 12,5 %». */
export function taxRateLabel(profile: CountryTaxProfile, rate: TaxRate, locale?: string): string {
  const known = profile.choices.find((item) => sameRate(item, rate))
  if (known) return known.label
  return rate.category === "S" ? `${profile.name} ${percentText(rate.rateBps, locale)}` : `Sin ${profile.name}`
}

/** La forma que vale: la guardada si el país la conoce; si no, la primera, que es la que se propone. */
export function taxLegalFormOf(profile: CountryTaxProfile, key: string | null | undefined): TaxLegalForm | null {
  if (!profile.legalForms?.length) return null
  return profile.legalForms.find((item) => item.key === key) ?? profile.legalForms[0] ?? null
}

/** Lo que propone el país para cada cifra, con la forma elegida. */
export function defaultTaxRates(profile: CountryTaxProfile, legalForm?: string | null): Record<TaxScope, TaxChoice> {
  const form = taxLegalFormOf(profile, legalForm)
  return {
    servicios: choice(profile, form?.servicios ?? profile.servicios),
    productos: choice(profile, form?.productos ?? profile.productos),
  }
}

/** Las dos cifras que valen hoy para una clínica, o null si su país no tiene impuesto que separar. */
export function resolveOrgTaxes(
  country: string | null | undefined,
  settings: OrgTaxSettings = {},
  locale?: string,
): OrgTaxes | null {
  const profile = taxProfileFor(country)
  if (!profile) return null
  const legalForm = taxLegalFormOf(profile, settings.legalForm)
  const defaults = defaultTaxRates(profile, legalForm?.key)
  const effective = (scope: TaxScope): EffectiveTax => {
    const fallback = defaults[scope]
    const chosen = settings[scope] ?? null
    const rate = chosen ?? fallback
    const known = profile.choices.find((item) => sameRate(item, rate))
    return {
      category: rate.category,
      rateBps: rate.rateBps,
      label: taxRateLabel(profile, rate, locale),
      isDefault: sameRate(rate, fallback),
      choiceKey: known?.key ?? null,
    }
  }
  return {
    name: profile.name,
    law: profile.law,
    legalForm,
    legalFormPending: Boolean(profile.legalForms?.length) && !profile.legalForms?.some((item) => item.key === settings.legalForm),
    servicios: effective("servicios"),
    productos: effective("productos"),
  }
}

/** Una tasa válida: con impuesto, mayor que cero y hasta el tope; sin impuesto, cero. */
export function assertTaxRate(rate: TaxRate): TaxRate {
  if (!(TAX_CATEGORIES as readonly string[]).includes(rate.category)) throw new Error("Categoría de impuesto inválida")
  if (!Number.isInteger(rate.rateBps)) throw new Error("La tasa debe ser un número entero de puntos básicos")
  if (rate.category === "S" && (rate.rateBps < 1 || rate.rateBps > MAX_CUSTOM_TAX_BPS))
    throw new Error(`La tasa va de 0,01 % a ${MAX_CUSTOM_TAX_BPS / 100} %`)
  if (rate.category !== "S" && rate.rateBps !== 0) throw new Error("Lo que no lleva impuesto va sin tasa")
  return { category: rate.category, rateBps: rate.rateBps }
}

/**
 * El impuesto que ya va dentro de un importe con impuesto incluido, redondeado
 * a la unidad menor (como cada línea de una boleta: la suma de las líneas da el
 * total). 118,00 con 18 % → 18,00; 450,00 → 68,64.
 */
export function includedTaxCents(amountCents: number, rateBps: number): number {
  if (!Number.isSafeInteger(amountCents)) throw new Error("El importe debe ser un entero")
  if (rateBps <= 0 || amountCents === 0) return 0
  return Math.round((amountCents * rateBps) / (10_000 + rateBps))
}

/**
 * La línea que cierra todo ticket: odentIA no emite comprobantes (#39), y con
 * el impuesto a la vista el papel no debe parecer una boleta. La clínica no la
 * quita: su frase va antes.
 */
export const FISCAL_DISCLAIMER = "Recibo interno. No es un documento fiscal."

/** El pie del ticket: la frase de la clínica (si es otra) y siempre la línea fija. */
export function ticketFooterLines(notice: string | null | undefined): string[] {
  const own = notice?.trim() ?? ""
  return own && own !== FISCAL_DISCLAIMER ? [own, FISCAL_DISCLAIMER] : [FISCAL_DISCLAIMER]
}

/**
 * La línea corta debajo del impuesto cuando parte de lo cobrado no lo lleva:
 * «La atención no lleva IVA.». Null si todo lleva impuesto.
 */
export function ticketUntaxedNote(taxes: {
  name: string
  groups: ReadonlyArray<{ category: string; scopes: ReadonlyArray<"servicios" | "productos"> }>
}): string | null {
  const untaxed = new Set(taxes.groups.filter((group) => group.category !== "S").flatMap((group) => group.scopes))
  if (!untaxed.size) return null
  if (untaxed.size === 2) return `Parte de lo cobrado no lleva ${taxes.name}.`
  return untaxed.has("servicios") ? `La atención no lleva ${taxes.name}.` : `Los productos no llevan ${taxes.name}.`
}
