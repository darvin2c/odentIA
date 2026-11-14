/**
 * Catálogo de copy compartido (español). Antes venía de un paquete externo;
 * ahora vive en @odentia/ui-patterns. Todas las claves usadas por los
 * componentes del paquete; consumidores importan { common } del barrel.
 */
export const common = {
  actions: {
    cancel: "Cancelar",
    save: "Guardar",
    retry: "Reintentar",
    close: "Cerrar",
    /** Bajo un grupo de opciones que se puede dejar sin responder. */
    clearAnswer: "Quitar respuesta",
  },
  states: {
    loading: "Cargando…",
    refreshing: "Actualizando…",
    empty: "Sin resultados",
    emptyHint: "No hay nada para mostrar todavía.",
    error: "Algo salió mal",
  },
  errors: {
    generic: "Ocurrió un error inesperado. Inténtalo de nuevo.",
  },
  labels: {
    code: "Código",
    requestId: "ID de solicitud",
  },
  phone: {
    country: "País",
    placeholder: "Número de teléfono",
  },
  timeZone: {
    label: "Zona horaria",
    search: "Buscar ciudad o zona horaria…",
    empty: "Sin coincidencias",
  },
  sidePanel: {
    label: "Panel lateral",
    resize: "Redimensionar panel",
    /** Pista al pasar sobre el borde: el asa sola no dice qué hace. */
    resizeHint: "Arrastra o usa las flechas para cambiar el ancho · doble clic o Enter: el de siempre",
    /** Lo que oye el lector de pantalla: sin texto, algunos leen el valor como porcentaje. */
    width: (px: number) => `${px} píxeles de ancho`,
  },
  confirm: {
    /** Pregunta para un `window.confirm` (Aceptar/Cancelar); las superficies usan `unsaved`. */
    unsavedMessage: "Tienes cambios sin guardar. ¿Deseas descartarlos?",
    /**
     * «Salir sin guardar» (`UnsavedDialog`): cerrar un formulario o detalle y salir de la
     * pantalla con algo sin guardar preguntan con las mismas palabras. Quedarse es lo principal.
     */
    unsaved: {
      title: "¿Salir sin guardar?",
      description: "Lo que cambiaste aquí aún no se guardó. Si sales, se pierde.",
      keepEditing: "Seguir aquí",
      discard: "Descartar y salir",
    },
  },
  filters: {
    today: "Hoy",
    last3Days: "Últimos 3 días",
    last7Days: "Últimos 7 días",
    last30Days: "Últimos 30 días",
    thisMonth: "Este mes",
    lastMonth: "Mes pasado",
    previous: "Anterior",
    next: "Siguiente",
    search: "Buscar",
    moreFilters: "Más filtros",
    label: "Filtros",
    clear: "Limpiar",
    noResults: "Sin resultados",
    min: "Mín",
    max: "Máx",
    sort: "Ordenar",
    sortDefault: "Predeterminado",
  },
  views: {
    selectAll: "Seleccionar todo",
  },
  agenda: {
    today: "Hoy",
    previous: "Anterior",
    next: "Siguiente",
    view: "Vista",
    free: "Hueco libre",
    unavailable: "No disponible",
    noEntries: "Sin citas",
    more: "más",
  },
} as const
