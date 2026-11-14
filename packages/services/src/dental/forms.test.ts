import { TREATMENT_KINDS } from "@odentia/dental"
import { expect, it } from "vitest"
import { assertFormSchema } from "../clinical-forms.js"
import { DENTAL_FORMS } from "./forms.js"

/** La clave que el servidor le daría a un formulario nuevo con ese título. */
const keyOfTitle = (title: string) =>
  title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

it("odentIA trae cuatro fichas: endodoncia, ortodoncia, odontopediatría y la de la norma", () => {
  expect(DENTAL_FORMS.suggestions.map((form) => [form.title, form.kind])).toEqual([
    ["Evaluación de endodoncia", "endodoncia"],
    ["Ficha de ortodoncia", "ortodoncia"],
    ["Ficha de odontopediatría", "odontopediatria"],
    ["Ficha odontoestomatológica", "general"],
  ])
})

it("cada ficha tiene preguntas que el servidor acepta, la clave de su título y un tipo de la biblioteca", () => {
  const kinds = TREATMENT_KINDS.map((kind) => kind.key as string)
  const keys = new Set<string>()
  for (const form of DENTAL_FORMS.suggestions) {
    expect(() => assertFormSchema(form.schema), form.title).not.toThrow()
    // Con la clave de su título, una ficha propia de la clínica que se llame igual no se duplica.
    expect(form.key).toBe(keyOfTitle(form.title))
    expect(kinds).toContain(form.kind)
    expect(form.description.length).toBeGreaterThan(10)
    keys.add(form.key)
  }
  expect(keys.size).toBe(DENTAL_FORMS.suggestions.length)
})

it("nada traba la atención: solo la pieza de la endodoncia se pide, y al finalizar su ficha", () => {
  const required = DENTAL_FORMS.suggestions.flatMap((form) =>
    form.schema.sections.flatMap((section) =>
      section.fields.filter((field) => field.required).map((field) => `${form.key}:${field.id}`),
    ),
  )
  expect(required).toEqual(["evaluacion-de-endodoncia:pieza"])
})

it("la ficha de odontopediatría no pide el peso (está en los signos vitales) y se ofrece a menores de 12", () => {
  const pediatric = DENTAL_FORMS.suggestions.find((form) => form.kind === "odontopediatria")
  const labels =
    pediatric?.schema.sections.flatMap((section) => section.fields.map((field) => field.label.toLowerCase())) ?? []
  expect(labels.some((label) => label.includes("peso"))).toBe(false)
  expect(DENTAL_FORMS.byAge).toEqual({ underYears: 12, kind: "odontopediatria" })
})

it("cada pregunta de casillas tiene su «No tiene» o «Ninguno»: sin marcar no es una respuesta", () => {
  for (const form of DENTAL_FORMS.suggestions)
    for (const section of form.schema.sections)
      for (const field of section.fields.filter((item) => item.type === "opcion_multiple")) {
        expect(field.options?.some((option) => /^(no tiene|ninguno|ninguna)$/i.test(option)), `${form.key}:${field.id}`).toBe(true)
        expect(field.help ?? "", `${form.key}:${field.id}`).not.toMatch(/sin marcar/i)
      }
})

// QA del 14 nov (voz clínica): lo que la consulta anota y la ficha no tenía dónde.
it("ortodoncia anota la clase molar y canina de cada lado y la línea media de cada arcada; endodoncia, lo que separa los diagnósticos", () => {
  const ids = (key: string) =>
    DENTAL_FORMS.suggestions.find((form) => form.key === key)?.schema.sections.flatMap((section) => section.fields.map((field) => field.id)) ?? []
  expect(ids("ficha-de-ortodoncia")).toEqual(
    expect.arrayContaining([
      "clase_molar_derecha",
      "clase_molar_izquierda",
      "clase_canina_derecha",
      "clase_canina_izquierda",
      "linea_media_superior",
      "linea_media_inferior",
    ]),
  )
  expect(ids("ficha-de-ortodoncia")).not.toContain("clase_molar")
  expect(ids("evaluacion-de-endodoncia")).toEqual(
    expect.arrayContaining(["dolor_intensidad", "tumefaccion", "fistula", "movilidad", "sondaje", "hallazgo_radiografico"]),
  )
})
