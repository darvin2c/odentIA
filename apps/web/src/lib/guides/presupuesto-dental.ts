// «Cómo hacer un presupuesto dental» (texto de la voz clínica en la mesa del 24 nov). Los montos
// son de una clínica de ejemplo, en soles, y están sumados a mano; no son precios de odentIA. En
// odentIA, «Cómo se paga» es un texto de la clínica para todos sus presupuestos y el adelanto se
// cobra en caja: la guía no promete un campo de adelanto por presupuesto.
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "presupuesto-dental",
  topic: "Presupuestos",
  title: "Cómo hacer un presupuesto dental,",
  accent: "paso a paso.",
  name: "Cómo hacer un presupuesto dental",
  menu: "Presupuesto dental",
  seoTitle: "Cómo hacer un presupuesto dental, con plantilla en PDF",
  description:
    "Cómo hacer un presupuesto dental por fases: un renglón por tratamiento, forma de pago, adelanto y vigencia. Plantilla de presupuesto dental en PDF gratis.",
  lead: "Del odontograma al presupuesto: un renglón por tratamiento, ordenado por fases y con su forma de pago. Con el presupuesto en blanco en PDF.",
  updated: "2026-11-25",
  published: "2026-11-25",
  video: {
    youtubeId: "ngFPnBO64ZE",
    title: "La primera atención de un paciente en odentIA: anamnesis, consulta, cobro y presupuesto",
    published: "2026-11-21T06:35:18+00:00",
  },
  short: [
    "Parte de lo que encontraste: un renglón por tratamiento, con su diente, sus caras y sus sesiones.",
    "Ordénalo por fases. Si hay dos caminos, van lado a lado dentro de su fase y no se suman.",
    "Cierra con cómo se paga, el adelanto, hasta cuándo vale y la firma de quien decide.",
  ],
  steps: [
    {
      title: "Parte de lo que encontraste",
      text: [
        "Cada renglón del presupuesto nace de algo que encontraste en un diente. Antes de armarlo, revisa sus antecedentes: un anticoagulante, una alergia o un embarazo pueden cambiar el plan. Eso se anota en su historia, no en el odontograma ni en el presupuesto.",
      ],
      figure: {
        kind: "tabla",
        head: ["Jorge, 42 años", "Lo que encontramos"],
        rows: [
          ["15", "Caries de dentina en oclusal"],
          ["36", "Caries de dentina en mesial y oclusal"],
          ["16", "Resina filtrada en oclusal y distal"],
          ["47", "Falta: se extrajo por caries"],
          ["Toda la boca", "Placa y encía inflamada"],
        ],
      },
    },
    {
      title: "Un renglón por tratamiento, con su diente",
      text: [
        "Cada renglón dice el diente (y las caras, si es una resina), el tratamiento, cuántas sesiones lleva y su importe. La resina se cobra por caras; la limpieza, por toda la boca; el puente, por cada diente que forma.",
      ],
    },
    {
      title: "Ordénalo por fases, con la alternativa dentro de su fase",
      text: [
        "Las fases van en el orden en que se atiende: **urgencia** (dolor o infección), **básica** (limpieza y caries), **quirúrgica** (extracciones e implantes), **rehabilitadora** (coronas, puentes, prótesis) y **mantenimiento** (controles). La corona de un diente va después de su endodoncia.",
        "Si hay dos caminos para lo mismo, como reponer el 47 con un implante o con un puente, marca cada renglón con su opción, **A o B**, **dentro de su fase**: el implante es quirúrgico; su corona y el puente, rehabilitadores. Cada opción tiene su total: el paciente elige una y **no se suman**. Lo demás va igual en las dos.",
      ],
      figure: {
        kind: "tabla",
        head: ["Fase", "Diente", "Tratamiento", "Sesiones", "Importe"],
        rows: [
          ["Básica", "Toda la boca", "Limpieza (profilaxis)", "1", "S/ 120"],
          ["Básica", "15 (O)", "Resina de una cara", "1", "S/ 150"],
          ["Básica", "36 (MO)", "Resina de dos caras", "1", "S/ 200"],
          ["Básica", "16 (OD)", "Cambio de resina, dos caras", "1", "S/ 200"],
          ["", "", "**Subtotal básica**", "", "**S/ 670**"],
          ["Quirúrgica, **opción A**", "47", "Implante", "1, y de 3 a 6 meses de espera", "S/ 3 500"],
          ["Rehabilitadora, **opción A**", "47", "Corona sobre implante", "3", "S/ 1 500"],
          ["Rehabilitadora, **opción B**", "46–47–48", "Puente fijo de 3 piezas (S/ 900 c/u)", "3", "S/ 2 700"],
          ["Mantenimiento", "Toda la boca", "Control y limpieza a los 6 meses", "1", "S/ 120"],
          ["", "", "**Total con la opción A**", "", "**S/ 5 790**"],
          ["", "", "**Total con la opción B**", "", "**S/ 3 490**"],
        ],
        caption: "Un ejemplo con los montos de una clínica. La opción A o la B: el total es uno u otro, nunca los dos.",
      },
      after: ["Otro ejemplo: la Sra. Rosa necesita endodoncia en el 46 y una corona. La endodoncia va primero (en urgencia, si duele) y la corona después, en la rehabilitadora: nunca antes que la endodoncia."],
    },
    {
      title: "Deja claro cómo se paga, el adelanto y hasta cuándo vale",
      text: [
        "Escribe cómo se paga, por ejemplo: «Cada tratamiento se paga cuando se realiza; puede dejar un adelanto, que se descuenta de lo siguiente». Si el adelanto es para algo en particular, di para qué (el implante, por ejemplo).",
        "Pon hasta qué fecha vale el presupuesto, y qué pasa si al empezar aparece algo que no se veía: se le explica y se le entrega uno nuevo para que decida.",
      ],
      figure: {
        kind: "tabla",
        head: ["Cómo se paga", "Ejemplo"],
        rows: [
          ["Adelanto", "S/ 500, para el implante"],
          ["El resto", "Al hacer cada tratamiento"],
          ["Vale hasta", "El 24 de diciembre de 2026"],
        ],
      },
    },
    {
      title: "Su decisión y su firma",
      text: [
        "Deja escrito lo que decidió: en cada renglón, «acepto», «después» o «no». Si hay dos caminos: «elijo la opción A», «la B» o «lo voy a pensar». Puede aceptar una parte y dejar el resto para después. Firma el paciente o, si es menor, su responsable, y firmas tú.",
      ],
    },
  ],
  sheets: [{ sheet: "presupuesto", label: "Presupuesto en blanco", detail: "Por fases, con dos caminos y la firma · PDF" }],
  tryIt: {
    demo: "presupuesto",
    title: "En odentIA, el presupuesto sale del plan.",
    text: "Con los precios de tu lista y hasta tres opciones. El paciente lo recibe en su celular y elige ahí mismo, o lo firma en la consulta.",
    note: "El presupuesto de Carlos, con dos opciones: él elige la A desde su celular.",
    product: { href: "/presupuestos-dentales", label: "Mira «Presupuestos»" },
  },
  faq: [
    {
      q: "¿Pongo el precio de cada tratamiento o solo el total?",
      a: "Los dos: cada renglón con su importe y el total. Si hay opciones, un total con cada una.",
    },
    {
      q: "¿Puede aceptar solo una parte?",
      a: "Sí: en cada renglón marca «acepto», «después» o «no». Lo que es de un camino se acepta eligiendo ese camino.",
    },
    {
      q: "¿Qué pasa si al empezar encuentro algo más?",
      a: "Se le explica y se le entrega un presupuesto nuevo para que decida. No se cobra nada que no haya aceptado.",
    },
    {
      q: "¿Cuánto tiempo vale un presupuesto?",
      a: "Lo decide la clínica. Pon la fecha exacta: «vale hasta el…».",
    },
    { q: "¿Quién firma si es un niño?", a: "Su mamá, su papá o quien lo represente." },
  ],
  related: ["como-llenar-un-odontograma", "odontograma-en-ninos"],
  card: "Del odontograma al presupuesto: un renglón por tratamiento, ordenado por fases y con su forma de pago.",
}
