/** Compara como lo lee la persona: sin mirar tildes ni mayúsculas («Negra» es «negra»). */
const collator = new Intl.Collator("es", { sensitivity: "base" })

export const sameText = (a: string, b: string) => collator.compare(a, b) === 0
