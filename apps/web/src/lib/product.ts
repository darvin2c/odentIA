// La web de cada producto: el mismo servidor publica una web por producto, la de odentIA, la de
// latidIA (`VITE_PRODUCT=medical`) y la de vistIA (`VITE_PRODUCT=optical`), cada una en su dominio.
// Lo que cambia de una a otra se decide con un mapa completo por producto (ADR 0164): al sumar uno,
// el compilador señala cada lugar que tiene que decir algo de él. Las webs con producto propio sirven
// solo sus páginas (`product-pages.json`: `serves`) y algunas existen solo en ellas (`own`); la de
// odentIA, el producto base, sirve todas menos las propias de las demás.
import PRODUCT_PAGES from "./product-pages.json"

/** Los productos que tienen web. */
const WEB_PRODUCTS = ["dental", "medical", "optical"] as const
export type WebProduct = (typeof WEB_PRODUCTS)[number]

/** El producto base: el de la web sin `VITE_PRODUCT` y el que sirve todas las páginas comunes. */
export const BASE_WEB_PRODUCT = "dental" satisfies WebProduct

/**
 * El producto de este armado; sin decirlo, odentIA. Uno que esta web aún no
 * conoce detiene el armado en vez de publicar en silencio la web de odentIA en
 * su dominio.
 */
function webProduct(asked: string | undefined): WebProduct {
  if (!asked) return BASE_WEB_PRODUCT
  const known = WEB_PRODUCTS.find((product) => product === asked)
  if (!known) throw new Error(`VITE_PRODUCT=${asked}: esta web todavía no tiene las páginas de ese producto`)
  return known
}

export const PRODUCT: WebProduct = webProduct(import.meta.env.VITE_PRODUCT)

/** Lo de este producto en un mapa completo: el compilador pide el valor de cada uno. */
export function ofProduct<T>(map: Record<WebProduct, T>): T {
  return map[PRODUCT]
}

/** Las palabras que cambian entre las webs; lo demás se dice igual. */
export interface ProductWords {
  /** El nombre del producto. */
  name: string
  /** Quien atiende, en singular y en plural («odontólogo», «médicos», «optómetras»). */
  clinician: string
  clinicians: string
  /** A quién se le vende: «clínicas dentales», «consultorios médicos», «ópticas». */
  audience: string
  /** El lugar donde se atiende, con su artículo y con «tu». */
  clinic: string
  theClinic: string
  yourClinic: string
  /** «Tu clínica, en un mes», al empezar una frase. */
  YourClinic: string
  anotherClinic: string
  /** «Nombre de la clínica», «Nombre del consultorio». */
  ofTheClinic: string
  /** A quién se atiende: «paciente» en la clínica y el consultorio, «cliente» en la óptica (paciente solo
   *  cuando se le examina). */
  patient: string
  patients: string
  /** Las imágenes que más ocupan (odentIA: las tomografías). */
  heavyImages: string
  /** El color de la barra del navegador, el de la noche de la portada. */
  themeColor: string
}

const WORDS_BY_PRODUCT: Record<WebProduct, ProductWords> = {
  dental: {
    name: "odentIA",
    clinician: "odontólogo",
    clinicians: "odontólogos",
    audience: "clínicas dentales",
    clinic: "clínica",
    theClinic: "la clínica",
    yourClinic: "tu clínica",
    YourClinic: "Tu clínica",
    anotherClinic: "otra clínica",
    ofTheClinic: "de la clínica",
    patient: "paciente",
    patients: "pacientes",
    heavyImages: "tomografías",
    themeColor: "#0a2129",
  },
  medical: {
    name: "latidIA",
    clinician: "médico",
    clinicians: "médicos",
    audience: "consultorios médicos",
    clinic: "consultorio",
    theClinic: "el consultorio",
    yourClinic: "tu consultorio",
    YourClinic: "Tu consultorio",
    anotherClinic: "otro consultorio",
    ofTheClinic: "del consultorio",
    patient: "paciente",
    patients: "pacientes",
    heavyImages: "imágenes",
    themeColor: "#1e0b3d",
  },
  // vistIA: la óptica examina la vista y vende los lentes; quien atiende es el optómetra y quien
  // compra, el cliente (paciente cuando se le examina).
  optical: {
    name: "vistIA",
    clinician: "optómetra",
    clinicians: "optómetras",
    audience: "ópticas",
    clinic: "óptica",
    theClinic: "la óptica",
    yourClinic: "tu óptica",
    YourClinic: "Tu óptica",
    anotherClinic: "otra óptica",
    ofTheClinic: "de la óptica",
    patient: "cliente",
    patients: "clientes",
    heavyImages: "imágenes",
    themeColor: "#0a2615",
  },
}

export const WORDS: ProductWords = WORDS_BY_PRODUCT[PRODUCT]

/** La marca de cada web en `data-brand` (web.css); odentIA es la de siempre, sin atributo. */
const BRAND_BY_PRODUCT: Record<WebProduct, "latidia" | "vistia" | undefined> = {
  dental: undefined,
  medical: "latidia",
  optical: "vistia",
}
export const BRAND = BRAND_BY_PRODUCT[PRODUCT]

/** Los agentes de cada producto. Clío no dicta en vistIA: la mesa del plan quitó dictar la refracción. */
export type WebAgent = "sofi" | "clio" | "argos"
const AGENTS_BY_PRODUCT: Record<WebProduct, readonly WebAgent[]> = {
  dental: ["sofi", "clio", "argos"],
  medical: ["sofi", "clio", "argos"],
  optical: ["sofi", "argos"],
}
export const AGENTS: readonly WebAgent[] = AGENTS_BY_PRODUCT[PRODUCT]
/** ¿Clío trabaja en este producto? Sin ella, la web no la nombra ni muestra sus precios. */
export const HAS_CLIO = AGENTS.includes("clio")

/** El dominio cuando no se dice otro (en local): el de cada producto (el mismo mapa de astro.config.mjs). */
const LOCAL_DOMAINS: Record<WebProduct, string> = {
  dental: "odentia.localhost",
  medical: "latidia.localhost",
  optical: "vistia.localhost",
}
export const DEFAULT_DOMAIN = LOCAL_DOMAINS[PRODUCT]

/** Las páginas de una web con producto propio: las que sirve y las que solo existen en ella. */
interface ProductPages {
  serves: string[]
  own: string[]
}
const PAGES: Record<Exclude<WebProduct, typeof BASE_WEB_PRODUCT>, ProductPages> = PRODUCT_PAGES
/** Las páginas que no existen en la web base: las propias de cada una de las demás. */
const OWN_OF_OTHERS = Object.values(PAGES).flatMap((pages) => pages.own)

/** ¿Existe esta página en la web de este producto? En la de odentIA, todas menos las propias de las demás. */
export function servesPage(path: string): boolean {
  const clean = path.replace(/\/+$/, "") || "/"
  // Los archivos (los de Astro, el ícono, el mapa del sitio) no son páginas.
  if (clean.startsWith("/_") || /\.[a-z0-9]+$/i.test(clean)) return true
  return PRODUCT === BASE_WEB_PRODUCT ? !OWN_OF_OTHERS.includes(clean) : PAGES[PRODUCT].serves.includes(clean)
}
