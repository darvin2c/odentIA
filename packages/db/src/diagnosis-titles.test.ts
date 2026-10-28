import { expect, it } from "vitest"
import { minsaTitleForDisplay } from "./diagnosis-titles.js"

it("el título del MINSA se lee como frase y conserva siglas, nombres propios, romanos y códigos", () => {
  expect(minsaTitleForDisplay("CARIES DE LA DENTINA")).toBe("Caries de la dentina")
  expect(minsaTitleForDisplay("SINDROME DE DOWN, NO ESPECIFICADO")).toBe("Sindrome de Down, no especificado")
  expect(minsaTitleForDisplay("ENFERMEDAD POR VIH, RESULTANTE EN INFECCION POR MICOBACTERIAS")).toBe(
    "Enfermedad por VIH, resultante en infeccion por micobacterias",
  )
  expect(minsaTitleForDisplay("COLERA DEBIDO A VIBRIO CHOLERAE 01, BIOTIPO CHOLERAE")).toBe(
    "Colera debido a Vibrio cholerae 01, biotipo cholerae",
  )
  expect(minsaTitleForDisplay("DEFICIENCIA HEREDITARIA DEL FACTOR VIII")).toBe("Deficiencia hereditaria del factor VIII")
  expect(minsaTitleForDisplay("HEPATITIS AGUDA TIPO A, SIN COMA HEPATICO")).toBe("Hepatitis aguda tipo A, sin coma hepatico")
  expect(minsaTitleForDisplay("DEFICIENCIA DE VITAMINA D, NO ESPECIFICADA")).toBe("Deficiencia de vitamina D, no especificada")
  expect(minsaTitleForDisplay("SINDROME (CARDIO) PULMONAR POR HANTAVIRUS [SPH] [SCPH] (J17.1*)")).toBe(
    "Sindrome (cardio) pulmonar por hantavirus [SPH] [SCPH] (J17.1*)",
  )
  expect(minsaTitleForDisplay("COVID-19, VIRUS IDENTIFICADO")).toBe("COVID-19, virus identificado")
  expect(minsaTitleForDisplay("SINDROME DE GUILLAIN-BARRE")).toBe("Sindrome de Guillain-Barre")
  // Una sigla sin vocales queda como sigla; la «y» y la «a» sueltas, como palabras.
  expect(minsaTitleForDisplay("INFECCION POR VPH Y CANDIDIASIS A REPETICION")).toBe(
    "Infeccion por VPH y candidiasis a repeticion",
  )
})
