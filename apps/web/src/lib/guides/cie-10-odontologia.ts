// «Códigos CIE-10 en odontología». Los códigos y sus títulos salen de la lista oficial que carga la app
// (`cie10-odontologia.json`, que escribe `pnpm --filter @odentia/services plantillas`), con lo odontológico
// de `isDentalDiagnosis`; los de uso diario y los errores frecuentes los eligió la voz clínica (mesa del
// 26 nov). Lo que hace la app se cruzó con `findingDiagnosisCode` (el odontograma propone el código) y
// `searchDiagnosisCodes` (busca por nombre o código, sin tildes): no entiende frases como «muela picada».
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "cie-10-odontologia",
  topic: "CIE-10",
  title: "Los códigos CIE-10 de la consulta dental,",
  accent: "sin recorrer la lista entera.",
  name: "Códigos CIE-10 en odontología",
  menu: "Códigos CIE-10",
  seoTitle: "CIE-10 en odontología: códigos más usados y buscador",
  description:
    "Los códigos CIE-10 de odontología de uso diario: caries, pulpa, encía, pérdida de dientes y trauma. Cómo se leen, errores frecuentes, buscador y lista en PDF.",
  lead: "Cómo se lee un código, los que usas casi todos los días y los errores que más se repiten. Con un buscador aquí mismo y la lista completa en PDF.",
  updated: "2026-11-26",
  published: "2026-11-26",
  short: [
    "Un diagnóstico por problema, con su pieza y su código: K02.1 es caries de la dentina.",
    "La letra y los dos números dicen el grupo (K02, caries); el número después del punto, cuál es.",
    "Usa el subcódigo, no el grupo, y al lado escribe lo que el código no dice: reversible, estadio, presuntivo.",
  ],
  steps: [
    {
      title: "Para qué sirve el código",
      text: [
        "La CIE-10 le da a cada diagnóstico un **código que se entiende igual en cualquier lugar**: en la historia, en un informe, para un seguro o para contar cuántos casos de cada cosa atiendes. Va al lado del diagnóstico escrito, con su pieza: «caries de la dentina en el 36 (K02.1)».",
      ],
    },
    {
      title: "Cómo se lee un código",
      text: [
        "La **letra y los dos números** son el grupo: K02 es caries dental. El **número después del punto** dice cuál: K02.0 es la caries limitada al esmalte, K02.1 la de la dentina y K02.5 la caries con exposición pulpar.",
        "Anota siempre el **subcódigo** cuando el grupo lo tiene: K02 solo no dice qué caries es.",
      ],
    },
    {
      title: "Los de uso diario",
      text: ["Casi toda la consulta cabe en estos. La lista completa de odontología está en el PDF y en el buscador de abajo."],
      figure: {
        kind: "tabla",
        head: ["Grupo", "Códigos"],
        rows: [
          ["Caries", "K02.0 esmalte · K02.1 dentina · K02.5 con exposición pulpar"],
          ["Pulpa y periápice", "K04.0 pulpitis · K04.1 necrosis de la pulpa · K04.4 periodontitis apical aguda · K04.5 periodontitis apical crónica · K04.6 absceso con fístula · K04.7 absceso sin fístula"],
          ["Encía y periodonto", "K05.1 gingivitis crónica · K05.3 periodontitis crónica · K06.0 retracción gingival · K03.6 depósitos (sarro)"],
          ["Pérdida y restos", "K08.1 pérdida por extracción o enfermedad periodontal · K08.3 raíz dental retenida · K01.1 dientes impactados"],
          ["Después de una extracción", "K10.3 alveolitis"],
          ["Desgaste y otros", "K03.0 atrición · K07.6 trastornos de la articulación temporomaxilar · K12.0 estomatitis aftosa recurrente"],
          ["Trauma", "S02.5 fractura de los dientes · S03.2 luxación de diente"],
          ["Control", "Z01.2 examen odontológico"],
        ],
        caption: "Los nombres aquí van cortos; en el buscador y en el PDF, con su título completo.",
      },
    },
    {
      title: "Lo que el código no dice, escríbelo al lado",
      text: ["Hay datos que cambian el tratamiento y el código no los trae:"],
      list: [
        "**K04.0 pulpitis:** escribe si es reversible o irreversible.",
        "**K05.3 periodontitis crónica:** anota el estadio y el grado de la clasificación de 2017.",
        "**Cada diagnóstico:** si es presuntivo (lo sospechas) o definitivo (lo confirmaste).",
      ],
    },
    {
      title: "Los errores que más se repiten",
      text: ["Cuidado con estos tres:"],
      list: [
        "**Un diente extraído es K08.1, no K00.0.** K00.0 (anodoncia) es el diente que nunca se formó.",
        "**El grupo sin subcódigo:** K04 no dice si es pulpitis, necrosis o absceso.",
        "**Un código para todo:** si tiene caries en el 15 y pulpitis en el 36, son dos diagnósticos, cada uno con su pieza.",
      ],
    },
  ],
  sheets: [
    {
      sheet: "cie10-odontologia",
      label: "Códigos CIE-10 de odontología",
      detail: "Los de uso diario al frente y la lista completa detrás · PDF",
    },
  ],
  tryIt: {
    demo: "cie10",
    title: "En odentIA, el código no se busca.",
    text: "Marcas la caries en el odontograma y **su código ya viene propuesto**, con su pieza. Lo que no se dibuja lo encuentras en el buscador de la atención, por nombre o por código y sin tildes, con lo odontológico primero. Si el paciente ya tenía ese diagnóstico, odentIA lo anota como **«Ya diagnosticado antes»**: no se repite.",
    note: "Busca un diagnóstico por su nombre o su código: aquí están los de odontología.",
    product: { href: "/historia-clinica-y-odontograma", label: "Mira «Historia y odontograma»" },
  },
  faq: [
    {
      q: "¿Dónde va el código en la historia?",
      a: "Al lado del diagnóstico escrito, con su pieza. El código no reemplaza a las palabras: las acompaña.",
    },
    {
      q: "¿Qué código pongo en un control sin hallazgos?",
      a: "Z01.2, examen odontológico.",
    },
    {
      q: "¿Uso la CIE-10 o la CIE-11?",
      a: "La que use tu país y tu clínica. Esta guía es de la CIE-10. odentIA trabaja con las dos: eliges la de tu clínica.",
    },
    {
      q: "¿Un mismo diente puede tener dos códigos?",
      a: "Sí, si tiene dos problemas: una caries de la dentina (K02.1) y una pulpitis (K04.0) en el mismo 36 son dos diagnósticos.",
    },
  ],
  related: ["historia-clinica-odontologica", "plan-de-tratamiento-odontologico"],
  card: "Cómo se lee un código, los de uso diario, lo que se escribe al lado y los errores más frecuentes.",
}
