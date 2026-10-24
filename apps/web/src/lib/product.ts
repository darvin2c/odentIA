// La web de cada producto (issue 229, decisión 18): el mismo código sirve la de odentIA y la de
// latidIA. El build de latidIA lleva `VITE_PRODUCT=medical` y su dominio; empieza con cuatro
// páginas (inicio, precios, pedir invitación y legales) y lo demás no existe en su dominio.
import LATIDIA_PAGES from "./latidia-pages.json"

export type WebProduct = "dental" | "medical"

export const PRODUCT: WebProduct = import.meta.env.VITE_PRODUCT === "medical" ? "medical" : "dental"
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
    heavyImages: "imágenes",
    themeColor: "#1e0b3d",
  },
}

export const WORDS: ProductWords = WORDS_BY_PRODUCT[PRODUCT]

/** El dominio cuando no se dice otro (en local): el de cada producto. */
export const DEFAULT_DOMAIN = MEDICAL ? "latidia.localhost" : "odentia.localhost"

/** ¿Existe esta página en la web de este producto? En la de odentIA, todas. */
export function servesPage(path: string): boolean {
  if (!MEDICAL) return true
  const clean = path.replace(/\/+$/, "") || "/"
  // Los archivos (los de Astro, el ícono, el mapa del sitio) no son páginas.
  if (clean.startsWith("/_") || /\.[a-z0-9]+$/i.test(clean)) return true
  return (LATIDIA_PAGES as readonly string[]).includes(clean)
}
