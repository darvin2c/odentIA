import { MINSA_ACCENTS } from "./diagnosis-accents.js"

/**
 * Títulos de la CIE-10 del MINSA para leer en pantalla (ADR 0103). El MINSA los
 * publica en mayúsculas y sin tildes («SINDROME DE DOWN»); en odentIA se leen
 * como frase y con sus tildes («Síndrome de Down»), y el título oficial se
 * guarda aparte, sin cambios. Las tildes salen de `MINSA_ACCENTS`.
 *
 * Conservan su forma las siglas, los nombres propios y los géneros de
 * microorganismos («VIH», «Down», «Salmonella»). Salen de la CIE-10 de Chile
 * (MINSAL/DEIS 2018), donde se escriben así, revisadas a mano el 2026-10-28.
 */
const PROPER_WORDS = [
  "ABO", "ACTH", "ADA", "ADN", "AGE", "ALK-negativo", "ALK-positivo", "Alzheimer", "anti-B",
  "anti-T", "Aquiles", "Arnold-Chiari", "Asperger", "B", "Bacillus", "Baker", "Balcanes", "Balo",
  "Barrett", "Bartholin", "BCG", "BCR", "Beau", "Behcet", "Bell", "Besnier", "Bitot", "Bordetella",
  "Boston", "Bouchard", "Brill", "Brucella", "Brugia", "Budd-Chiari", "Buerger", "Burkitt", "C",
  "California", "Campylobacter", "Candida", "Chagas", "Chikungunya", "Chlamydia", "Churg-Strauss",
  "Civatte", "Clostridium", "Colorado", "Coronavirus", "Coxsackie", "CR", "Creutzfeldt-Jakob",
  "Crigler-Najjar", "Crimea-Congo", "Crohn", "Cushing", "D", "DAINE", "Devic", "DHL", "Di", "Down",
  "Dressler", "Dupuytren", "Ebola", "Ebstein", "Echinococcus", "ECHO", "Edwards", "Epstein-Barr",
  "Erb", "Escherichia", "Eustaquio", "Fallot", "Falopio", "Felty", "Forestier", "FPN", "G",
  "George", "Gilbert", "GMSI", "Gottron", "Graves", "Grover", "Guillain-Barre", "H", "Haemophilus",
  "Hansen", "Heberden", "Helicobacter", "HELLP", "Hirschsprung", "Histoplasma", "Hodgkin", "Horner",
  "Huntington", "Hurst", "IDCS", "IgA", "IgE", "IgG", "IgM", "IIIa", "IIIb", "Jaccoud", "Junin",
  "K", "Kaposi", "Kaschin-Beck", "Kawasaki", "Klebsiella", "Klinefelter", "Klumpke", "Kyasanur",
  "Kyrle", "Landau-Kleffner", "Langerhans", "Lassa", "Legg-Calve-Perthes", "Lejano", "Lequesne",
  "Letterer-Siwe", "LMA", "LMC", "LSD", "Luis", "Luschka", "Lyell", "Lyme", "M", "Machupo",
  "MacLeod", "Magendie", "Marburg", "Marfan", "Meckel", "Melkersson", "Mendelson", "Meniere",
  "Micheli", "Mollaret", "Moyamoya", "Mycoplasma", "NCOP", "Nelson", "Nezelof", "Nilo", "NK",
  "Norwalk", "Oddi", "Omsk", "Oriente", "Oropouche", "Paget", "Papovavirus", "Parastrongylus",
  "Parkinson", "Parvovirus", "Pasini", "Patau", "Pediculus", "Pellegrini-Stieda", "PHHF", "Pick",
  "Plasmodium", "Pneumocystis", "Pontiac", "Potter", "Proteus", "Pseudomonas", "Quervain",
  "Raynaud", "Refsum", "Reiter", "Rett", "Reye", "Rh", "Rickettsia", "Rift", "Rocio", "Ross",
  "Salmonella", "San", "Schistosoma", "Schmorl", "SCPH", "Sezary", "Shigella", "SIDA", "Silvio",
  "SPH", "SRAG", "ST", "Staphylococcus", "Still", "Streptococcus", "Sweet", "T", "T-linfotropico",
  "Taenia", "Takayasu", "TBC", "Tietze", "Tinea", "Tor", "Tourette", "Toxoplasma", "Turner",
  "Vater", "Vibrio", "VIH", "Vincent", "Waldeyer", "Waterhouse-Friderichsen", "Weber-Christian",
  "Wegener", "Wells", "Wernicke", "Willebrand", "Wiskott-Aldrich", "Wuchereria", "Xq", "XXY", "XY",
  "XYY", "Yersinia", "Zika",
]
const PROPER = new Map(PROPER_WORDS.map((word) => [word.toUpperCase(), word]))

/** Números romanos (tipo II, estadio IV, factor VIII, cromosoma X). */
const ROMAN = /^(X{0,3})(IX|IV|V?I{0,3})$/
/** Una vocal sola es una palabra («A», «O», «U»), salvo después de estas: hepatitis A, vitamina E. */
const LETTER_AFTER = new Set(["HEPATITIS", "VITAMINA", "TIPO", "GRUPO", "FACTOR", "INFLUENZA", "VIRUS", "CLASE"])

/** La palabra con sus tildes, en la misma forma: «sindrome» → «síndrome», «Barre» → «Barré». */
function withAccents(word: string): string {
  return word.replace(/\p{L}+/gu, (part) => {
    const accented = MINSA_ACCENTS[part.toLowerCase()]
    if (!accented) return part
    // Una sigla no lleva tilde; un nombre propio conserva su mayúscula.
    if (part.length > 1 && part === part.toUpperCase()) return part
    return part[0] === part[0]!.toUpperCase() ? accented[0]!.toUpperCase() + accented.slice(1) : accented
  })
}

function wordForDisplay(word: string, previous: string | undefined, inBrackets: boolean): string {
  return withAccents(casedWord(word, previous, inBrackets))
}

function casedWord(word: string, previous: string | undefined, inBrackets: boolean): string {
  const proper = PROPER.get(word)
  if (proper) return proper
  // Un código («J17.1»), una sigla sola entre corchetes («[SRAG]») o con cifras («COVID-19») quedan igual.
  if (/\d/.test(word) || inBrackets) return word
  if (ROMAN.test(word)) return word
  // Sin vocales no es una palabra del español: es una sigla («VPH», «LCR»).
  if (word.length > 1 && !/[AEIOUY]/.test(word)) return word
  // La «y» suelta siempre es la conjunción.
  if (word.length === 1 && word !== "Y" && previous && LETTER_AFTER.has(previous)) return word
  return word.toLowerCase()
}

/** «CARIES DE LA DENTINA» → «Caries de la dentina»; «SINDROME DE DOWN» → «Síndrome de Down». */
export function minsaTitleForDisplay(title: string): string {
  let previous: string | undefined
  // Entre corchetes va una sigla («[SRAG]») o un sinónimo («[HERPES SIMPLE]»): solo la sigla queda igual.
  const acronymInBrackets = (offset: number) =>
    /^\[[A-ZÑÜ0-9-]+\]/.test(title.slice(title.lastIndexOf("[", offset), title.indexOf("]", offset) + 1))
  let depth = 0
  const out = title.replace(/\[|\]|[A-ZÑÜ0-9][A-ZÑÜ0-9'.*†-]*/g, (token, offset: number) => {
    if (token === "[") {
      depth += 1
      return token
    }
    if (token === "]") {
      depth = Math.max(0, depth - 1)
      return token
    }
    const shown = wordForDisplay(token, previous, depth > 0 && acronymInBrackets(offset))
    previous = token
    return shown
  })
  // La primera letra de la frase, en mayúscula.
  return out.replace(/\p{L}/u, (letter) => letter.toUpperCase())
}
