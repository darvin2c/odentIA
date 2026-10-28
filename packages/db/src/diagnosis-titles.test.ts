import { expect, it } from "vitest"
import { minsaTitleForDisplay } from "./diagnosis-titles.js"

it("el título del MINSA se lee como frase, con tildes, y conserva siglas, nombres propios, romanos y códigos", () => {
  expect(minsaTitleForDisplay("CARIES DE LA DENTINA")).toBe("Caries de la dentina")
  expect(minsaTitleForDisplay("SINDROME DE DOWN, NO ESPECIFICADO")).toBe("Síndrome de Down, no especificado")
  expect(minsaTitleForDisplay("ENFERMEDAD POR VIH, RESULTANTE EN INFECCION POR MICOBACTERIAS")).toBe(
    "Enfermedad por VIH, resultante en infección por micobacterias",
  )
  expect(minsaTitleForDisplay("COLERA DEBIDO A VIBRIO CHOLERAE 01, BIOTIPO CHOLERAE")).toBe(
    "Cólera debido a Vibrio cholerae 01, biotipo cholerae",
  )
  expect(minsaTitleForDisplay("DEFICIENCIA HEREDITARIA DEL FACTOR VIII")).toBe("Deficiencia hereditaria del factor VIII")
  expect(minsaTitleForDisplay("HEPATITIS AGUDA TIPO A, SIN COMA HEPATICO")).toBe("Hepatitis aguda tipo A, sin coma hepático")
  expect(minsaTitleForDisplay("DEFICIENCIA DE VITAMINA D, NO ESPECIFICADA")).toBe("Deficiencia de vitamina D, no especificada")
  expect(minsaTitleForDisplay("COVID-19, VIRUS IDENTIFICADO")).toBe("COVID-19, virus identificado")
  // El nombre propio conserva su mayúscula y recibe su tilde.
  expect(minsaTitleForDisplay("SINDROME DE GUILLAIN-BARRE")).toBe("Síndrome de Guillain-Barré")
  // Una sigla sin vocales queda como sigla; la «y» y la «a» sueltas, como palabras.
  expect(minsaTitleForDisplay("INFECCION POR VPH Y CANDIDIASIS A REPETICION")).toBe(
    "Infección por VPH y candidiasis a repetición",
  )
  expect(minsaTitleForDisplay("INFECCIONES INTESTINALES DEBIDAS A VIRUS Y OTROS ORGANISMOS ESPECIFICADOS")).toBe(
    "Infecciones intestinales debidas a virus y otros organismos especificados",
  )
})

it("entre corchetes, la sigla queda igual y el sinónimo se lee como frase", () => {
  expect(minsaTitleForDisplay("SINDROME (CARDIO) PULMONAR POR HANTAVIRUS [SPH] [SCPH] (J17.1*)")).toBe(
    "Síndrome (cardio) pulmonar por hantavirus [SPH] [SCPH] (J17.1*)",
  )
  expect(minsaTitleForDisplay("TUNGIASIS [INFECCION DEBIDA A PULGA DE ARENA]")).toBe(
    "Tungiasis [infección debida a pulga de arena]",
  )
})

it("una palabra que cambia de sentido con la tilde queda como la escribe el MINSA", () => {
  expect(minsaTitleForDisplay("NECESIDAD DE INMUNIZACION SOLO CONTRA EL TETANOS")).toBe(
    "Necesidad de inmunización solo contra el tétanos",
  )
  expect(minsaTitleForDisplay("FIEBRE CONTINUA")).toBe("Fiebre continua")
})
