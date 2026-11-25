// «Cómo hacer un consentimiento informado dental». Las secciones son las de la app
// (`CONSENT_SECTION_LABELS` en `@odentia/clinical/consent`) y la declaración, la que firma el
// paciente en la tablet, en su celular o en papel (`CONSENT_DECLARATION`). Lo práctico: qué se
// escribe, cómo se explica y quién firma. Sin normas ni el valor legal de cada firma.
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "consentimiento-informado-dental",
  topic: "Consentimiento",
  title: "Cómo hacer un consentimiento informado dental,",
  accent: "que el paciente entienda.",
  name: "Cómo hacer un consentimiento informado dental",
  menu: "Consentimiento informado",
  seoTitle: "Consentimiento informado dental: cómo hacerlo, con formato en PDF",
  description:
    "Cómo hacer un consentimiento informado odontológico: qué va en cada parte, cómo explicarlo y quién firma si es menor. Formato en PDF gratis.",
  lead: "Qué se escribe en cada parte, cómo se explica antes de firmar y quién firma cuando es un niño. Con el formato en blanco en PDF.",
  updated: "2026-11-25",
  published: "2026-11-25",
  video: {
    youtubeId: "gj8FwYiV59k",
    title: "Consentimiento informado: todas las formas de firmarlo en odentIA (celular, código o papel)",
    published: "2026-11-16",
  },
  short: [
    "Uno por procedimiento: qué se va a hacer y por qué, qué se espera, sus riesgos, las alternativas y qué pasa si no se trata.",
    "Se explica con palabras simples antes de firmar, con sus riesgos propios, y se responden sus preguntas.",
    "Firma el paciente o, si es menor, su representante; y firma el profesional que informó. Va a su historia.",
  ],
  steps: [
    {
      title: "Cuándo se hace",
      text: [
        "Antes de un procedimiento que tiene riesgos: una extracción, una endodoncia, una cirugía, un implante, un blanqueamiento o una sedación. Se firma **antes de empezar**, no al terminar, y uno por procedimiento.",
      ],
    },
    {
      title: "Lo que va en cada parte",
      text: ["Siete partes, cada una en pocas líneas y con palabras que el paciente entienda. Un ejemplo, para una extracción:"],
      figure: {
        kind: "tabla",
        head: ["Parte", "Ejemplo: extracción del 38"],
        rows: [
          ["**Procedimiento propuesto**", "Sacar la muela del juicio de abajo a la izquierda, con anestesia local"],
          ["**Diagnóstico que lo motiva**", "Está atrapada en el hueso y se inflama a repetición"],
          ["**Beneficios esperados**", "Que no vuelva el dolor ni la inflamación"],
          ["**Riesgos y molestias**", "Dolor e hinchazón unos días, sangrado leve, alveolitis; rara vez, el labio adormecido unas semanas"],
          ["**Alternativas**", "Controlarla y tratar cada inflamación, sabiendo que puede volver"],
          ["**Consecuencias de no tratarse**", "Más inflamaciones, caries en la muela de al lado o infección"],
          ["**Información adicional**", "Lo propio de su caso y los cuidados de después"],
        ],
      },
    },
    {
      title: "Explícalo antes de que firme, con sus riesgos propios",
      text: [
        "Léelo con él, no se lo des a firmar sin hablar. Dile **lo que es propio de su caso**: si toma anticoagulantes, puede sangrar más; si fuma, cicatriza más lento. Eso se escribe en «Información adicional».",
        "Pregúntale si tiene dudas y respóndelas. Al firmar, declara justamente eso:",
      ],
      list: [
        "«He leído y comprendido la información, pude hacer preguntas y fueron respondidas. Autorizo el procedimiento descrito y sé que puedo revocar este consentimiento antes de que se realice.»",
      ],
    },
    {
      title: "Quién firma",
      text: [
        "Firma el **paciente**. Si es menor de edad, o no puede decidir solo, firma su **representante**: su mamá, su papá o su tutor, con su nombre, su documento y su parentesco.",
        "Firma también el **profesional que informó**, con su colegiatura, y va la fecha.",
      ],
    },
    {
      title: "Guárdalo en su historia y dale una copia",
      text: [
        "El consentimiento firmado va a su [historia clínica](/guias/historia-clinica-odontologica). Dale una copia si la quiere. Si cambia de opinión antes del procedimiento, no se hace: anótalo en su historia con la fecha.",
      ],
    },
  ],
  sheets: [{ sheet: "consentimiento", label: "Consentimiento en blanco", detail: "Las siete partes, la declaración y las firmas · PDF" }],
  tryIt: {
    demo: "consentimiento",
    title: "En odentIA, se firma en la tablet, en su celular o en papel.",
    text: "Cada tratamiento trae su consentimiento sugerido y lo ajustas a tu clínica. Se suman sus riesgos propios, firma él o su representante, y el PDF firmado queda en su historia.",
    note: "Marca la casilla y firma con el dedo o con el ratón, como en la tablet de la clínica.",
    product: { href: "/historia-clinica-y-odontograma", label: "Mira «Historia y odontograma»" },
  },
  faq: [
    {
      q: "¿Hago uno por cada tratamiento?",
      a: "Uno por procedimiento. Si son varias piezas con el mismo procedimiento, como dos extracciones, se nombran todas en el mismo.",
    },
    {
      q: "¿Qué hago si no quiere firmar?",
      a: "No se hace el procedimiento. Anota en su historia que se le explicó y que no aceptó, con la fecha.",
    },
    {
      q: "¿Puede cambiar de opinión después de firmar?",
      a: "Sí, mientras no se haya hecho el procedimiento. Se anota en su historia y no se hace.",
    },
    {
      q: "¿Quién firma si viene con su abuela?",
      a: "Firma su representante: su mamá, su papá o su tutor. Si quien lo acompaña no lo es, pide que venga o que firme antes.",
    },
  ],
  related: ["historia-clinica-odontologica", "presupuesto-dental"],
  card: "Qué va en cada parte, cómo explicarlo antes de firmar y quién firma cuando es un niño.",
}
