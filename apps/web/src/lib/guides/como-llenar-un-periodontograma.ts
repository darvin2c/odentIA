// «Cómo llenar un periodontograma». Los sitios, el signo de la recesión, la furca, la movilidad, la placa y
// lo que se calcula son los de la app (`@odentia/dental/periodontal`); la plantilla en blanco sale de
// `blank-sheets.ts`. Lo clínico lo revisó la voz clínica (mesa del 26 nov): la recesión con el signo de la
// app y el aviso del contrario. Lo que la app hace se cruzó con `periodontal-capture.tsx` (no se dicta).
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "como-llenar-un-periodontograma",
  topic: "Periodontograma",
  title: "Cómo llenar un periodontograma,",
  accent: "sitio por sitio y sin perderte.",
  name: "Cómo llenar un periodontograma",
  menu: "Periodontograma",
  seoTitle: "Periodontograma: cómo se llena, paso a paso y en PDF",
  description:
    "Cómo llenar un periodontograma: seis sitios por pieza, sondaje, recesión, pérdida de inserción, sangrado, movilidad, furca y placa. Con el formato en PDF gratis.",
  lead: "Qué se mide en cada pieza, en qué orden y cómo se anota, para que el número diga lo mismo hoy y en el control. Con un ejemplo y el formato en blanco en PDF.",
  updated: "2026-11-26",
  published: "2026-11-26",
  short: [
    "Seis sitios por pieza: tres por fuera y tres por dentro. En cada uno, la profundidad de sondaje y la recesión.",
    "Pérdida de inserción = sondaje + recesión. Aparte, el sangrado, la movilidad, la furca y la placa.",
    "Ojo con el signo: la recesión es positiva si se ve raíz y negativa si la encía cubre la corona.",
  ],
  steps: [
    {
      title: "Primero, una revisión rápida",
      text: [
        "En el día a día, empieza con una **revisión por sextantes**: si un sextante tiene una bolsa de **4 mm o más**, ahí haces el periodontograma completo. Si solo sangra, es para tratar la encía, no para sondear la boca entera. Sonda con **fuerza ligera**, recorriendo el surco.",
      ],
    },
    {
      title: "Seis sitios por pieza, siempre en el mismo orden",
      text: [
        "Cada pieza tiene **seis sitios**: por fuera, el mesial, el centro y el distal; por dentro (palatino arriba, lingual abajo), los mismos tres. Sonda siempre en el mismo orden, para no saltarte ninguno ni cruzarlos.",
      ],
      figure: {
        kind: "tabla",
        head: ["Cara", "Sitios"],
        rows: [
          ["Por fuera (vestibular)", "Mesial · centro · distal"],
          ["Por dentro (palatino o lingual)", "Mesial · centro · distal"],
        ],
      },
    },
    {
      title: "Profundidad de sondaje y recesión",
      text: [
        "La **profundidad de sondaje** va del borde de la encía al fondo de la bolsa, en milímetros. La **recesión** va del límite amelocementario al borde de la encía: **positiva si se ve raíz**, **negativa si la encía cubre parte de la corona**.",
        "Con las dos sale la **pérdida de inserción**: sondaje + recesión.",
      ],
      figure: {
        kind: "tabla",
        head: ["Sitio", "Sondaje", "Recesión", "Pérdida de inserción"],
        rows: [
          ["16 mesial, por fuera", "5 mm", "+2 (se ven 2 mm de raíz)", "**7 mm**"],
          ["14 distal, por fuera", "2 mm", "−1 (la encía cubre 1 mm de corona)", "**1 mm**"],
        ],
        caption: "Si en la 16 anotas la recesión como −2, la pérdida de inserción sale 3 y no 7: el signo cambia el diagnóstico.",
      },
    },
    {
      title: "Sangrado, supuración, movilidad y furca",
      text: [
        "Marca en cada sitio si **sangra** o **supura** al sondar. Por pieza, la **movilidad** (de 0 a 3) y la **furca** (grado 1, 2 o 3) en cada entrada: en los molares de arriba, por fuera, mesial por dentro y distal por dentro; en los de abajo, por fuera y por dentro; en el primer premolar de arriba, mesial y distal.",
        "Marca las piezas **ausentes**. Los **implantes** se sondean, pero no cuentan en los índices de las piezas.",
      ],
    },
    {
      title: "La placa, en cuatro caras",
      text: [
        "El **índice de placa** se mide aparte: en cada pieza, cuatro caras (por fuera, por dentro, mesial y distal), con placa o sin ella. El porcentaje es caras con placa entre caras revisadas.",
      ],
    },
    {
      title: "Qué te dicen los números",
      text: [
        "Sin pérdida de inserción, el **sangrado** dice si es salud o **gingivitis**: hay gingivitis cuando sangra el 10 % de los sitios o más. Si hay pérdida de inserción entre dientes, es **periodontitis**: su **estadio** (de I a IV) lo dan la pérdida de inserción, la pérdida ósea en la radiografía y las piezas perdidas por la encía; su **grado** (A, B o C), cuánto avanzó para su edad, si fuma y si tiene diabetes. Es la clasificación de 2017 (Papapanou y otros, y Chapple y otros, J Clin Periodontol 2018).",
        "En los controles, quien ya tuvo periodontitis está **inestable** si tiene una bolsa de 5 mm o más, o una de 4 mm que sangra; si no, **estable** si sangra menos del 10 % de los sitios y **en remisión** si sangra más.",
      ],
    },
  ],
  sheets: [
    {
      sheet: "periodontograma",
      label: "Periodontograma en blanco",
      detail: "Si todavía trabajas en papel: seis sitios por pieza, sangrado, movilidad, furca y placa · PDF",
    },
  ],
  tryIt: {
    demo: "periodontograma",
    title: "En odentIA, el periodontograma no se suma a mano.",
    text: "Se llena a pantalla completa, **una pieza y una cara a la vez**, con campos grandes y el teclado o la pantalla. El gráfico se dibuja al lado mientras escribes, **la pérdida de inserción y los índices salen solos** y te recuerda anotar en negativo la encía que cubre la corona. Cada cambio se guarda solo; si se cae el internet, lo que está en la pantalla se envía al volver. Te **propone la clasificación** con sus razones, tú la confirmas, y en el control lo **comparas con el anterior**.",
    product: { href: "/historia-clinica-y-odontograma", label: "Mira «Historia y odontograma»" },
  },
  faq: [
    {
      q: "¿Cada cuánto se repite el periodontograma?",
      a: "Al empezar, al reevaluar después de la fase básica y en los controles de mantenimiento. Comparar dos periodontogramas es lo que te dice si la encía mejora.",
    },
    {
      q: "¿Qué anoto si la encía cubre la corona?",
      a: "La recesión en negativo: −1, −2. Con 0, la pérdida de inserción sale mayor de lo que es.",
    },
    {
      q: "¿Los implantes se sondean?",
      a: "Sí, y se anotan, pero aparte: no cuentan en los índices de las piezas.",
    },
    {
      q: "¿Y si no tengo tiempo para la boca entera?",
      a: "Haz la revisión rápida por sextantes y el periodontograma completo donde haya una bolsa de 4 mm o más.",
    },
  ],
  related: ["como-llenar-un-odontograma", "plan-de-tratamiento-odontologico"],
  card: "Los seis sitios, el sondaje y la recesión con su signo, la pérdida de inserción, la furca y la placa.",
}
