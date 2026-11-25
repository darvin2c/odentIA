// «Cómo hacer el cierre de caja en una clínica dental». Las cuentas son las del cierre de la app
// («Cerrar caja» y la hoja «CIERRE DE CAJA», como en `components/billing/CloseSheet.tsx`): debe haber
// = lo que quedó + los cobros en efectivo − los gastos pagados con la caja. Los otros medios no se
// cuentan: se comparan con su reporte. Montos de ejemplo, en soles. Sin video hasta que haya uno del
// cierre: el de registrar un cobro no enseña a cerrar.
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "cierre-de-caja-dental",
  topic: "Caja",
  title: "Cómo hacer el cierre de caja en tu clínica dental,",
  accent: "sin que falte nada.",
  name: "Cómo hacer el cierre de caja en una clínica dental",
  menu: "Cierre de caja",
  seoTitle: "Cierre y arqueo de caja dental: formato PDF y cómo hacerlo",
  description:
    "Cómo hacer el cierre de caja de una clínica dental: lo que debe haber, el arqueo del efectivo, la diferencia y lo que se entrega. Formato en PDF gratis.",
  lead: "Cuánto debe haber, cómo contar el efectivo y qué hacer si no cuadra, para entregar la caja con su hoja firmada. Con el formato en blanco en PDF.",
  updated: "2026-11-25",
  published: "2026-11-25",
  short: [
    "Debe haber lo que quedó del cierre anterior, más los cobros en efectivo, menos los gastos que pagaste con la caja.",
    "Cuenta el efectivo, billete por billete, y anota la diferencia: no la tapes. Tarjeta y transferencias no se cuentan: se comparan con su reporte.",
    "Decide cuánto queda para mañana y cuánto entregas, y firman quien entrega y quien recibe.",
  ],
  steps: [
    {
      title: "Empieza con lo que quedó",
      text: [
        "Cada caja abre con lo que **quedó del cierre anterior**: el sencillo para dar vuelto. Ese monto es el primero de la hoja.",
      ],
    },
    {
      title: "Anota cada cobro y cada gasto, con su medio",
      text: [
        "Cada cobro va con su hora, el paciente, lo que pagó y su **medio**: efectivo, tarjeta, transferencia o billetera digital. Cada gasto que pagas con la caja (un delivery de materiales, un taxi), con su comprobante.",
        "Si un paciente deja un adelanto, también es un cobro: anótalo con lo que adelantó, para descontarlo después.",
      ],
    },
    {
      title: "Cuánto debe haber",
      text: [
        "Solo cuenta el efectivo. Si en el día pusiste efectivo en la caja (más sencillo), sacaste (para el banco) o devolviste a un paciente, súmalo o réstalo: la plantilla trae un renglón para cada uno.",
      ],
      figure: {
        kind: "tabla",
        head: ["Cuenta", "Ejemplo"],
        rows: [
          ["Quedó del cierre anterior", "S/ 50,00"],
          ["Más los cobros en efectivo", "S/ 220,00"],
          ["Menos los gastos pagados con la caja", "− S/ 85,00"],
          ["**Debe haber**", "**S/ 185,00**"],
        ],
      },
    },
    {
      title: "Cuenta el efectivo y anota la diferencia",
      text: [
        "Cuenta **billete por billete y moneda por moneda** (el arqueo): la plantilla trae la tabla para hacerlo. Lo contado menos lo que debe haber es la **diferencia**.",
        "Si no cuadra, busca antes de cerrar: un cobro sin anotar, un vuelto mal dado, un gasto sin comprobante. Si igual no cuadra, **anota la diferencia** tal cual (sobran o faltan tantos soles) y avisa a quien administra. Una diferencia escondida vuelve a pasar.",
      ],
      figure: {
        kind: "tabla",
        head: ["Contaste", "Diferencia"],
        rows: [
          ["S/ 185,00", "Cuadra"],
          ["S/ 180,00", "Faltan S/ 5,00"],
          ["S/ 190,00", "Sobran S/ 5,00"],
        ],
      },
    },
    {
      title: "Tarjeta y transferencias: se comparan, no se cuentan",
      text: [
        "Lo cobrado con tarjeta se compara con el **reporte del POS** (la máquina de la tarjeta); las transferencias y billeteras, con lo que llegó a la cuenta. Si un cobro no aparece, se revisa ese día, no a fin de mes.",
      ],
    },
    {
      title: "Lo que queda, lo que se entrega y las firmas",
      text: [
        "Decide cuánto **queda en caja para mañana** y cuánto **entregas**: juntos suman lo que contaste. Con S/ 185 contados, si quedan S/ 50, entregas S/ 135. Firman quien entrega y quien recibe, con la fecha y la hora.",
      ],
    },
  ],
  sheets: [{ sheet: "cierre-de-caja", label: "Cierre de caja en blanco", detail: "Cobros, gastos, arqueo y firmas · PDF" }],
  tryIt: {
    demo: "caja",
    title: "En odentIA, cuentas el efectivo y la hoja sale lista para firmar.",
    text: "Cada cobro ya está registrado con su medio: al cerrar solo escribes lo que contaste. Si no cuadra, cierras igual y quien administra recibe el aviso.",
    note: "Elige cuánto contaste y mira cómo cambian la diferencia y lo que entregas.",
    product: { href: "/caja-y-cobros", label: "Mira «Caja y cobros»" },
  },
  faq: [
    {
      q: "¿Cada cuánto se cierra la caja?",
      a: "Al terminar cada turno o cada día, y siempre que la caja cambia de manos.",
    },
    {
      q: "¿Qué hago si sobra dinero?",
      a: "Lo mismo que si falta: anota la diferencia y busca por qué. Casi siempre es un cobro sin anotar o un vuelto que no se dio.",
    },
    {
      q: "¿El dinero de la tarjeta se cuenta en la caja?",
      a: "No. Se compara con el reporte del POS. En la caja solo se cuenta el efectivo.",
    },
    {
      q: "¿Cuánto dejo para el día siguiente?",
      a: "Lo que necesitas para dar vuelto. Lo decide la clínica; muchas dejan siempre el mismo monto.",
    },
  ],
  related: ["presupuesto-dental", "historia-clinica-odontologica"],
  card: "Cuánto debe haber, cómo contar el efectivo y qué hacer si no cuadra, con la hoja para firmar.",
}
