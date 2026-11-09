import type { SuggestedConsentTemplate } from "@odentia/clinical"

/**
 * Los consentimientos que vistIA sugiere a una óptica: lo que en el examen o la
 * adaptación toca el ojo. Como los de odentIA y latidIA, nacen activos y sin
 * revisar: la óptica los lee y los ajusta a lo que hace.
 */
export const OPTICAL_CONSENT_TEMPLATES: readonly SuggestedConsentTemplate[] = [
  {
    key: "dilatacion-de-pupilas",
    title: "Dilatación de las pupilas",
    servicePrefixes: ["retinografia", "examen-de-la-vista"],
    sections: {
      procedure:
        "Se ponen unas gotas en los ojos para agrandar las pupilas y poder ver el fondo del ojo. El efecto dura de 4 a 6 horas.",
      benefits: ["Revisar la retina y el nervio óptico", "Encontrar a tiempo lo que no se ve con la pupila chica"],
      risks: [
        "Visión borrosa de cerca y molestia con la luz mientras dura el efecto",
        "No manejar hasta que pase el efecto",
        "Ardor al poner las gotas",
        "Subida de la presión del ojo, rara, en quien tiene el ángulo estrecho",
      ],
      alternatives: [
        "Examinar el fondo de ojo sin dilatar, con menos detalle",
        "Una foto del fondo de ojo con cámara sin dilatación",
      ],
      consequences: "Sin dilatar, algunas lesiones de la retina pueden pasar sin verse.",
    },
  },
  {
    key: "lentes-de-contacto",
    title: "Adaptación de lentes de contacto",
    servicePrefixes: ["adaptacion-lentes-de-contacto", "control-lentes-de-contacto"],
    sections: {
      procedure:
        "Se eligen y se prueban los lentes de contacto según la medida y la forma de cada ojo, y se enseña a ponerlos, quitarlos y limpiarlos.",
      benefits: ["Ver bien sin anteojos", "Más campo de visión para el deporte o el trabajo"],
      risks: [
        "Ojo rojo, ardor o sensación de cuerpo extraño mientras se adapta",
        "Infección de la córnea si no se cumplen la limpieza y el tiempo de uso",
        "Ojo seco",
      ],
      alternatives: ["Anteojos", "Derivar al oftalmólogo para evaluar otras opciones"],
      consequences: "Sin lentes de contacto, sigue viendo con sus anteojos o sin corrección.",
    },
  },
]
