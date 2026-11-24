// «Cómo llenar un odontograma en niños» (texto de la voz clínica en la mesa del 24 nov). Las
// edades salen de la tabla de la AAPD («Dental Growth and Development»). Qué se marca en la
// mixta con un diente que todavía no sale por su edad queda por confirmar con una clínica
// real: la guía no lo enseña.
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "odontograma-en-ninos",
  topic: "Odontograma",
  title: "Cómo llenar un odontograma",
  accent: "en niños.",
  name: "Cómo llenar un odontograma en niños",
  menu: "Odontograma en niños",
  seoTitle: "Odontograma en niños: dientes de leche y dentición mixta, con PDF",
  description:
    "Cómo llenar el odontograma de un niño: los dientes de leche del 51 al 85, la dentición mixta y el molar de los 6 años, que no es de leche. Con PDF para imprimir.",
  lead: "Los dientes de leche del 51 al 85, la dentición mixta y el molar de los 6 años, que no es de leche. Con el odontograma de niños en PDF.",
  updated: "2026-11-24",
  short: [
    "Los dientes de leche se numeran del 51 al 85: cuadrantes 5 a 8 y dientes 1 a 5 desde el centro.",
    "A los 4 años tiene sus 20 dientes de leche. De los 6 a los 12 conviven con los permanentes, y el molar de los 6 años ya es permanente.",
    "Marca cada diente que está en la boca, en su fila, con los mismos colores y siglas que en adultos.",
  ],
  steps: [
    {
      title: "Numera los dientes de leche del 51 al 85",
      text: [
        "La primera cifra es el cuadrante: 5 arriba a la derecha, 6 arriba a la izquierda, 7 abajo a la izquierda y 8 abajo a la derecha. La segunda es el lugar desde el centro: 1 y 2 son los incisivos, 3 el canino, 4 y 5 los molares. En los dientes de leche no hay premolares: el 4 y el 5 son molares. El 75 se lee «siete-cinco».",
      ],
      figure: {
        kind: "fdi",
        dentition: "temporal",
        mark: 75,
        caption: "Marcado, el 75: el segundo molar de leche de abajo a la izquierda. Se mira de frente al niño: su derecha queda a tu izquierda.",
      },
    },
    {
      title: "Sabe qué dientes tiene a su edad",
      text: [
        "A los 2 años y medio o 3 ya salieron los 20 dientes de leche. Hacia los 6 sale el primer molar permanente, detrás del último de leche, **sin que se caiga ninguno**: por eso se confunde con uno de leche, y no lo es (16, 26, 36 y 46). Desde ahí, los de leche se van cambiando hasta los 12 o 13.",
        "Las edades son aproximadas: muchos niños sanos no siguen el calendario al pie de la letra.",
      ],
      figure: {
        kind: "tabla",
        head: ["Edad", "Lo que suele tener en la boca"],
        rows: [
          ["2½ a 5 años", "Los 20 de leche (51 a 85)"],
          ["6 años", "Los 20 de leche **y los molares de los 6 años** (16, 26, 36, 46). Empiezan a salir los incisivos centrales de abajo (31, 41)"],
          ["7 a 8 años", "Salieron los incisivos centrales (11, 21, 31, 41) y los laterales de abajo (32, 42); se cayeron sus dientes de leche (51, 61, 71, 72, 81, 82)"],
          ["8 a 9 años", "Salen los laterales de arriba (12, 22) y se caen el 52 y el 62"],
          ["9 a 12 años", "Se cambian los caninos y los molares de leche por los caninos y premolares permanentes"],
          ["12 a 14 años", "Salen los segundos molares (17, 27, 37, 47)"],
          ["17 años en adelante", "Pueden salir los terceros molares (18, 28, 38, 48)"],
        ],
        caption: "Fuente de las edades: AAPD, «Dental Growth and Development».",
      },
    },
    {
      title: "Usa las filas que le tocan",
      text: [
        "La hoja trae cuatro filas: las de afuera son los permanentes y las dos del medio, los de leche. A los 4 años solo usas las del medio. En la dentición mixta usas las cuatro: cada diente que está en la boca se marca en su fila. El 36 que acaba de salir va en la fila de abajo, y el 75 que sigue en la boca, en la del medio.",
      ],
      figure: {
        kind: "fdi",
        dentition: "mixta",
        caption: "Las cuatro filas de la hoja, como se miran de frente: los permanentes afuera y los de leche en medio.",
      },
    },
    {
      title: "Marca como en adultos, con lo propio de los niños",
      text: ["Los colores y las siglas son los mismos que en adultos. En los niños verás además:"],
      list: [
        "la **pulpotomía** (PP) y la **pulpectomía** (PC) en dientes de leche;",
        "la **corona de acero** en un molar de leche, que se marca como corona metálica (**CM**), en azul si está bien;",
        "el **sellante** (S) y las **fosas y fisuras profundas** (FFP);",
        "el diente que **está saliendo**: una flecha en zigzag, en azul, hacia donde sale.",
      ],
      figure: {
        kind: "tabla",
        head: ["Mateo, 7 años", "Fila", "Cómo se marca"],
        rows: [
          ["El 21 está saliendo", "Permanente de arriba", "Flecha en zigzag azul"],
          ["El 36, con fosas profundas", "Permanente de abajo", "**FFP** en el recuadro, azul"],
          ["El 46, con un sellante bueno", "Permanente de abajo", "El sellante en la cara oclusal y **S**, en azul"],
          ["El 75, con una caries que llega a la pulpa", "De leche de abajo", "La oclusal en rojo y **CDP**"],
          ["El 84, extraído por caries a los 5 años", "De leche de abajo", "Aspa azul y **DEX**"],
        ],
      },
      after: [
        "**Ojo con la palabra «temporal»:** en la hoja, «corona temporal» y «restauración temporal» quieren decir **provisional** (van en rojo), no «de leche».",
        "Si el permanente sale y el de leche sigue ahí (pasa mucho con los incisivos de abajo, que salen por detrás), marca los dos, cada uno en su fila, y el que sale con la flecha.",
      ],
    },
    {
      title: "Quién lo trae y quién decide",
      text: [
        "Anota quién trae al niño y quién es su responsable (mamá, papá o quien lo represente). El plan, el presupuesto y los consentimientos los decide y los firma su responsable. El teléfono del responsable no es el del niño: cada uno tiene su ficha.",
      ],
    },
  ],
  sheets: [{ sheet: "odontograma-ninos", label: "Niños", detail: "Dientes de leche y dentición mixta, con las edades · PDF" }],
  tryIt: {
    demo: "odontograma-ninos",
    title: "En odentIA, la dentición viene sola por la edad.",
    text: "Para un niño de 4 años se abren sus 20 dientes de leche; de 6 a 12, la mixta: los permanentes por fuera y los de leche por dentro. Tú la cambias con un toque si hace falta, y marcas cada diente igual que en adultos.",
    note: "Elige a Valentina o a Mateo, cambia la dentición y toca una pieza.",
    product: { href: "/historia-clinica-y-odontograma", label: "Mira «Historia y odontograma»" },
  },
  faq: [
    {
      q: "¿El molar de los 6 años es de leche?",
      a: "No. Sale hacia los 6 años detrás del último molar de leche, sin que se caiga ninguno, y es permanente: el 16, 26, 36 o 46. Si se pierde, no lo reemplaza otro.",
    },
    {
      q: "¿Hay una hoja distinta para niños?",
      a: "No. Es la misma hoja de cuatro filas: los dientes de leche van en las dos del medio. A los 4 años usas esas dos; en la mixta, las cuatro.",
    },
    {
      q: "¿Qué hago si sale el permanente y el de leche no se ha caído?",
      a: "Márcalos a los dos, cada uno en su fila; el que sale lleva la flecha de erupción.",
    },
    {
      q: "¿«Temporal» quiere decir de leche?",
      a: "En el odontograma, «corona temporal» y «restauración temporal» quieren decir provisional, y van en rojo. Los dientes de leche no se pintan de rojo por ser de leche: se pintan según lo que tienen.",
    },
  ],
  related: ["como-llenar-un-odontograma", "presupuesto-dental"],
  card: "Los dientes de leche del 51 al 85, la dentición mixta y el molar de los 6 años, que no es de leche.",
}
