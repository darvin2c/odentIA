// «Cómo llenar un odontograma» (lienzo, tablero 3; texto revisado por la voz clínica en la mesa
// del 24 nov). Los colores, las siglas y los dibujos son los de la hoja que imprime la app
// (`@odentia/dental/catalog` y `odontogram-sheet`).
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "como-llenar-un-odontograma",
  topic: "Odontograma",
  title: "Cómo llenar un odontograma,",
  accent: "paso a paso.",
  name: "Cómo llenar un odontograma",
  menu: "Llenar un odontograma",
  seoTitle: "Cómo llenar un odontograma paso a paso (FDI), con PDF",
  description:
    "Cómo llenar un odontograma con la notación FDI: numera cada diente, ubica la cara y marca lo que ves con colores y siglas. Odontograma en PDF gratis.",
  lead: "Con la notación FDI: cómo se numera cada diente, cómo se nombran sus caras y cómo se marca lo que encuentras. Con el odontograma en PDF para descargar.",
  updated: "2026-11-26",
  published: "2026-11-25",
  // Su lista en el canal: un video que se suma ahí aparece solo en la guía.
  playlist: "PLWLbx_BbsOEo",
  short: [
    "Cada diente tiene dos cifras: la primera es el cuadrante y la segunda, su lugar desde el centro. El 36 se lee «tres-seis».",
    "Cada diente tiene cinco caras. Lo que está en una cara se pinta en esa cara; lo que es de todo el diente (si falta, una corona, una endodoncia) se dibuja sobre el diente, y al lado va su sigla.",
    "Rojo para lo que hay que tratar: caries y lo que está en mal estado o es provisional. Azul para lo que está en buen estado y para lo que no es una enfermedad, como el diente que falta.",
  ],
  steps: [
    {
      title: "Numera cada diente con FDI",
      text: [
        "La primera cifra es el cuadrante; la segunda, el lugar del diente contando desde el centro: 1 es el incisivo central y 8, el tercer molar. Ejemplo: el 36 es el primer molar inferior izquierdo. Se mira de frente al paciente, así que su derecha queda a tu izquierda.",
      ],
      figure: {
        kind: "fdi",
        dentition: "permanente",
        mark: 36,
        caption:
          "Marcado, el 36: primer molar inferior izquierdo. Los dientes de leche se numeran del 51 al 85: lo ves en la [guía del odontograma en niños](/guias/odontograma-en-ninos).",
      },
    },
    {
      title: "Ubica la cara del diente",
      text: [],
      list: [
        "**Oclusal** en molares y premolares, **incisal** en incisivos y caninos: la que muerde.",
        "**Mesial**: la que mira hacia la línea media, entre los dos incisivos centrales.",
        "**Distal**: la del lado contrario; en las muelas, la que mira hacia atrás.",
        "**Vestibular**: la que mira a los labios o a la mejilla.",
        "**Lingual** abajo o **palatina** arriba: la que mira a la lengua o al paladar.",
      ],
      figure: {
        kind: "caras",
        caption:
          "Las caras del 26. En la hoja, la vestibular va hacia afuera: arriba en los dientes de arriba y abajo en los de abajo. La mesial mira siempre hacia el centro.",
      },
      after: ["Una caries en el cuello del diente se marca en su cara: vestibular, lingual o palatina."],
    },
    {
      title: "Marca lo que encuentras",
      text: [
        "Lo que está en una cara se pinta en esa cara, con la forma que tiene. Lo que es de todo el diente se dibuja sobre el diente. En el recuadro de cada diente va su sigla. Usa lápiz rojo y azul.",
      ],
      figure: {
        kind: "tabla",
        head: ["Lo que ves", "Cómo se marca"],
        rows: [
          [
            "Caries en la cara oclusal del 36",
            "Pinta de **rojo** la zona oclusal, con la forma de la caries. En el recuadro, qué tan profunda es: **CE** (esmalte), **CD** (dentina) o **CDP** (llega a la pulpa).",
          ],
          [
            "Caries que toma la mesial y la oclusal del 36",
            "Pinta de **rojo** las dos caras, unidas: es **una sola caries**, con una sola sigla.",
          ],
          ["Resina en buen estado en el 26", "Pinta la cara de la resina en **azul**. En el recuadro, **R** (o **AM** si es amalgama)."],
          [
            "Resina en mal estado o con caries debajo, en el 16",
            "Pinta la cara de la resina en **rojo**. En el recuadro, **R**. No dibujes aparte una caries en la misma cara.",
          ],
          [
            "Falta el 47",
            "Un **aspa azul**, de la corona a la raíz. En el recuadro, por qué falta: **DEX** (se extrajo por caries) o **DAO** (por otra causa). Si no salió, **DNE**; si la radiografía la muestra retenida en el hueso pasada su edad, es una **impactación**: solo **I** en el recuadro, sin aspa.",
          ],
          [
            "Corona en el 11",
            "Un **cuadrado alrededor de la corona**: azul si está bien, rojo si está mal. En el recuadro, de qué es: **CMC** (metal-cerámica), **CLM** (libre de metal), **CM** (metálica).",
          ],
          [
            "Endodoncia en el 11",
            "Una **línea vertical** por dentro de la raíz; si la pieza tiene dos o tres raíces, una en cada una, nunca entre ellas. Azul si está bien, rojo si está mal. En el recuadro, **TC**.",
          ],
          ["Una corona o una restauración provisional", "Siempre en **rojo**: la corona provisional lleva **CT**."],
        ],
      },
    },
    {
      title: "Separa lo que encontraste de lo que harás",
      text: [
        "El odontograma dice cómo está la boca hoy: no dibujes lo que vas a hacer (una extracción indicada va en el plan, no en el odontograma). Lo que haces en cada cita se anota en su evolución, con la fecha.",
        "El odontograma del inicio no se borra ni se repinta. Cuando terminas el plan, o si aparece algo nuevo, haces otro con su fecha: ahí la caries que trataste ya se ve como restauración, en azul.",
      ],
    },
  ],
  sheets: [
    { sheet: "odontograma", label: "Adultos", detail: "Del 11 al 48, en la hoja completa · PDF" },
    { sheet: "odontograma-ninos", label: "Niños", detail: "Dientes de leche y dentición mixta, con las edades · PDF" },
  ],
  tryIt: {
    demo: "odontograma",
    title: "En odentIA, el odontograma se llena hablando o con un toque.",
    text: "Dictas «36, caries de dentina en oclusal» y **Clío la deja lista** con su diagnóstico y su código; tú la confirmas. O tocas el diente y eliges lo que ves: queda dibujado con su color y su sigla, en el arco y de frente, con su raíz. Y cuando registras el tratamiento, **la pieza se dibuja sola**: haces la resina y queda dibujada como restauración.",
    product: { href: "/historia-clinica-y-odontograma", label: "Mira «Historia y odontograma»" },
  },
  faq: [
    {
      q: "¿Qué es la notación FDI?",
      a: "Es la numeración de dos cifras de la Federación Dental Internacional, la más usada: la primera cifra es el cuadrante y la segunda, el diente. El 36 se lee «tres-seis». Si ves dientes numerados del 1 al 32, es otro sistema.",
    },
    {
      q: "¿Y si un diente tiene dos cosas?",
      a: "Se dibujan las dos, cada una con su sigla. Por ejemplo, el 11 con endodoncia, espigo y corona: la línea en la raíz, el cuadrado del espigo y el de la corona.",
    },
    {
      q: "¿Qué es un odontograma digital?",
      a: "El mismo odontograma, en la computadora o la tablet: tocas el diente, eliges lo que ves y queda dibujado con su fecha. Lo anterior no se borra: puedes ver cómo estaba la boca en cualquier fecha.",
    },
  ],
  related: ["odontograma-en-ninos", "como-llenar-un-periodontograma", "presupuesto-dental"],
  card: "Cómo se numera cada diente con FDI, cómo se nombran sus caras y cómo se marca lo que encuentras.",
}
