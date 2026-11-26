// «Plan de tratamiento odontológico por fases». Las fases y su orden son las de la app
// (`TREATMENT_PHASES` y `phaseForTreatment` de @odentia/dental); la plantilla en blanco sale de
// `blank-sheets.ts`. Lo clínico del ejemplo lo revisó la voz clínica (mesa del 26 nov). La plata va en la
// guía del presupuesto: aquí no hay precios.
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "plan-de-tratamiento-odontologico",
  topic: "Plan de tratamiento",
  title: "Cómo hacer un plan de tratamiento por fases,",
  accent: "con cada cita en su lugar.",
  name: "Cómo hacer un plan de tratamiento odontológico por fases",
  menu: "Plan de tratamiento",
  seoTitle: "Plan de tratamiento odontológico por fases: ejemplo y PDF",
  description:
    "Cómo armar un plan de tratamiento odontológico por fases: urgencia, básica, quirúrgica, rehabilitadora y mantenimiento, con un ejemplo y el formato en PDF gratis.",
  lead: "Del diagnóstico de cada pieza al orden en que lo vas a hacer: las cinco fases, qué va en cada una y cuántas citas toma. Con un caso de ejemplo y el formato en PDF.",
  updated: "2026-11-26",
  published: "2026-11-26",
  short: [
    "Primero lo que duele o se infecta, después sanar caries y encía, luego la cirugía, la rehabilitación y el mantenimiento.",
    "Cada tratamiento va con su pieza, su diagnóstico y las sesiones que toma; lo que sostiene a otro va antes.",
    "Con sus precios, el plan se vuelve el presupuesto que el paciente acepta.",
  ],
  steps: [
    {
      title: "Antes de empezar, sus antecedentes",
      text: [
        "Repasa sus **alergias**, sus **medicamentos** y sus enfermedades antes de ordenar nada: un anticoagulante cambia cuándo y cómo haces una cirugía, y una alergia, lo que le pones.",
      ],
    },
    {
      title: "Parte del diagnóstico de cada pieza",
      text: [
        "Un plan sale de lo que encontraste: **un diagnóstico por problema, con su pieza**. Escribe el tipo cuando cambia lo que harás: una pulpitis **irreversible** lleva endodoncia; una reversible, no.",
      ],
      figure: {
        kind: "tabla",
        head: ["Pieza", "Diagnóstico"],
        rows: [
          ["36", "Pulpitis irreversible sintomática (K04.0)"],
          ["15", "Caries de la dentina (K02.1)"],
          ["46", "Ausente: se extrajo (K08.1)"],
          ["Boca", "Sarro (K03.6) y gingivitis crónica (K05.1)"],
        ],
        caption: "El caso de Jorge, que usamos en toda la guía. Los códigos, en la [guía de la CIE-10](/guias/cie-10-odontologia).",
      },
    },
    {
      title: "Reparte cada tratamiento en su fase",
      text: [
        "Las fases van en el orden en que se atiende. Lo que no puede esperar va primero; lo que se apoya en otra cosa va después de ella.",
      ],
      figure: {
        kind: "tabla",
        head: ["Fase", "Qué va", "En el caso de Jorge"],
        stack: true,
        rows: [
          ["**Urgencia**", "Dolor, infección o trauma", "Endodoncia del 36"],
          ["**Básica o higiénica**", "Controlar caries y sanar la encía", "Resina del 15 · destartraje y profilaxis"],
          ["**Quirúrgica**", "Extracciones, implantes, cirugía de encía", "Implante en el 46"],
          ["**Rehabilitadora**", "Coronas, prótesis, carillas", "Corona del 36 · corona sobre el implante del 46"],
          ["**Mantenimiento**", "Controles y limpiezas", "Control y limpieza periódica"],
        ],
      },
      after: [
        "Al terminar la básica, **reevalúa la encía** antes de operar o rehabilitar: si sigue inflamada, se trata primero.",
      ],
    },
    {
      title: "Lo que se apoya en otro, después",
      text: [
        "Lo que sostiene a otro va antes, aunque estén en fases distintas: **la corona después de su endodoncia**, y la corona sobre el implante cuando el implante ya está listo. Aunque el 36 duela, su corona no se adelanta: lo urgente es la endodoncia.",
      ],
    },
    {
      title: "Pon las sesiones de cada uno",
      text: [
        "Cada tratamiento lleva las **sesiones** que toma y cuándo vuelve. Así el paciente sabe cuántas citas son y tú sabes qué reservar al terminar cada una.",
      ],
      figure: {
        kind: "tabla",
        head: ["Tratamiento", "Sesiones", "Cuándo vuelve"],
        rows: [
          ["Endodoncia del 36", "2", "En una semana"],
          ["Resina del 15", "1", "—"],
          ["Corona del 36", "2", "Cuando la endodoncia terminó"],
        ],
        caption: "Las sesiones son de ejemplo: cada clínica pone las suyas.",
      },
    },
    {
      title: "Explícaselo y pásalo a precios",
      text: [
        "Muéstrale el plan en orden: qué se hace primero y por qué. Con sus precios es el presupuesto: cómo armarlo, con opciones y forma de pago, está en la [guía del presupuesto](/guias/presupuesto-dental).",
      ],
    },
  ],
  sheets: [
    {
      sheet: "plan-de-tratamiento",
      label: "Plan de tratamiento en blanco",
      detail: "Si todavía trabajas en papel: el diagnóstico por pieza y las cinco fases, con sesiones y fechas · PDF",
    },
  ],
  tryIt: {
    demo: "plan",
    title: "En odentIA, cada tratamiento cae en su fase.",
    text: "Indicas el tratamiento y odentIA **propone su fase**: lo de dolor o infección en urgencia, la corona después de su endodoncia. Nace con las sesiones de su servicio, cada cita dice en qué sesión va («sesión 1 de 2»), al firmar te pregunta si terminaste y te ofrece **reservar la siguiente sesión** ahí mismo. Si dictas, Clío te propone el plan y tú lo revisas. Y al firmar, el presupuesto se arma solo con lo que indicaste.",
    product: { href: "/presupuestos-dentales", label: "Mira «Presupuestos»" },
  },
  faq: [
    {
      q: "¿Puedo cambiar un tratamiento de fase?",
      a: "Sí. Las fases son un orden de trabajo, no una regla: si tu caso pide otra cosa, lo mueves. En odentIA, la fase es una propuesta que cambias con «Planificar…».",
    },
    {
      q: "¿Qué pasa si encuentro algo nuevo a mitad del plan?",
      a: "Lo sumas en su fase y se lo explicas al paciente antes de hacerlo. Si cambia el costo, se actualiza el presupuesto y lo vuelve a aceptar.",
    },
    {
      q: "¿Dónde va la ortodoncia?",
      a: "Depende del caso: se empieza con la encía ya controlada y antes de la prótesis definitiva. Ponla donde tu plan lo necesite.",
    },
    {
      q: "¿Cuándo empieza el mantenimiento?",
      a: "Cuando terminó lo activo. Ahí van los controles y las limpiezas, cada cuánto lo decides según el paciente.",
    },
  ],
  related: ["presupuesto-dental", "cie-10-odontologia"],
  card: "Las cinco fases en su orden, qué va en cada una y cuántas citas toma, con un caso de ejemplo.",
}
