// La web de cada producto: el mismo servidor publica dos webs distintas, la de odentIA y la de
// latidIA (`VITE_PRODUCT=medical` y su dominio). latidIA sirve solo sus páginas
// (`latidia-pages.json`: `serves`) y algunas existen solo en ella (`own`), que en odentIA no existen.
import LATIDIA_PAGES from "./latidia-pages.json"

/** Los productos que tienen web. */
const WEB_PRODUCTS = ["dental", "medical"] as const
export type WebProduct = (typeof WEB_PRODUCTS)[number]

/**
 * El producto de este armado; sin decirlo, odentIA. Uno que esta web aún no
 * conoce detiene el armado en vez de publicar en silencio la web de odentIA en
 * su dominio.
 */
function webProduct(asked: string | undefined): WebProduct {
  if (!asked) return "dental"
  const known = WEB_PRODUCTS.find((product) => product === asked)
  if (!known) throw new Error(`VITE_PRODUCT=${asked}: esta web todavía no tiene las páginas de ese producto`)
  return known
}

export const PRODUCT: WebProduct = webProduct(import.meta.env.VITE_PRODUCT)
export const MEDICAL = PRODUCT === "medical"

/** Las palabras que cambian entre las dos webs; lo demás se dice igual. */
export interface ProductWords {
  /** El nombre del producto. */
  name: string
  /** Quien atiende, en singular y en plural («odontólogo», «médicos»). */
  clinician: string
  clinicians: string
  /** A quién se le vende: «clínicas dentales», «consultorios médicos». */
  audience: string
  /** El lugar donde se atiende, con su artículo y con «tu». */
  clinic: string
  theClinic: string
  yourClinic: string
  /** «Tu clínica, en un mes», al empezar una frase. */
  YourClinic: string
  anotherClinic: string
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
    heavyImages: "imágenes",
    themeColor: "#1e0b3d",
  },
}

export const WORDS: ProductWords = WORDS_BY_PRODUCT[PRODUCT]

/** El dominio cuando no se dice otro (en local): el de cada producto. */
export const DEFAULT_DOMAIN = MEDICAL ? "latidia.localhost" : "odentia.localhost"

/** ¿Existe esta página en la web de este producto? En la de odentIA, todas menos las propias de latidIA. */
export function servesPage(path: string): boolean {
  const clean = path.replace(/\/+$/, "") || "/"
  // Los archivos (los de Astro, el ícono, el mapa del sitio) no son páginas.
  if (clean.startsWith("/_") || /\.[a-z0-9]+$/i.test(clean)) return true
  return MEDICAL ? LATIDIA_PAGES.serves.includes(clean) : !LATIDIA_PAGES.own.includes(clean)
}
