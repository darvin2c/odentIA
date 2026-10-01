---
name: odentia-ux
description: Diseñar, implementar o revisar pantallas, formularios, navegación y recorridos de odentIA. Usar también para cambios de interacción, estados, accesibilidad, responsive y feedback; no solo cambios visuales.
---

# UX de odentIA

Método de trabajo, no catálogo visual ni fuente paralela de reglas de negocio. Todas las rutas siguientes parten de la raíz del repositorio.

## Cargar solo contexto pertinente

- Visión, objetivo del software y objetivo de la UX: `AGENTS.md` raíz, fuente principal de estas definiciones. Responsabilidades de las aplicaciones: `apps/AGENTS.md`.
- Composición: `packages/ui-patterns/AGENTS.md`; primitivas: `packages/ui/AGENTS.md` si se modifican.
- Consultar el componente y su story existente; localizar símbolos/consumidores con LSP. No leer todo el catálogo para una pantalla.
- Referencias: `packages/ui-patterns/src/app-shell.stories.tsx`, `page-header.stories.tsx`, `data-table.stories.tsx`, `form/form-drawer.stories.tsx` y `charts/charts.stories.tsx` dentro del mismo directorio `src`.
- Reglas del dominio afectado en su AGENTS y servicios; la interfaz no las redefine.

## Diseñar desde la tarea

1. Expresar en una frase: **actor + tarea + resultado observable**. Identificar permiso, contexto previo y siguiente paso; no añadir requisitos de producto no solicitados.
2. Relacionar el cambio con el valor para el cliente/equipo y un criterio verificable de UX. Aplicar el filtro de valor frente a complejidad del AGENTS raíz; considerar simplificar o reutilizar antes de añadir una capacidad. Ejemplo: continuidad de atención → reservar desde el caso conserva sus vínculos explícitos sin crear otra ficha.
3. Elegir acción principal y jerarquía. Mostrar información necesaria para decidir; detalles y acciones secundarias progresivos. No esconder operaciones frecuentes por minimalismo ni llenar la pantalla de controles equivalentes.
4. Reutilizar composición existente. Decidir lista/detalle, formulario o diálogo según el recorrido, no por preferencia estética; conservar contexto al abrir/cerrar y al pasar a móvil.
5. Elegir interacción y ayudas por facilidad de uso: no imponer chat para todo ni añadir drag and drop por novedad. Si arrastrar facilita la tarea, ofrecer también una alternativa accesible; mostrar ayuda donde se necesita, sin saturar la pantalla.

## Resolver estados antes de implementar

- Carga, vacío inicial, sin resultados, error recuperable y permiso insuficiente son estados distintos. Dar una salida útil sin revelar datos no autorizados.
- Mutaciones: prevenir duplicados mientras se guarda, distinguir pendiente/confirmado/fallido y conservar entrada ante error. Optimismo solo con reversión coherente.
- Formularios: etiquetas, ayudas y errores accionables; datos auxiliares tardíos no reinician borradores. Cambiar entidades relacionadas invalida selecciones incompatibles.
- Navegación: proteger trabajo sin guardar, conservar filtros/vista pertinentes, devolver foco al origen y mantener un retorno claro en móvil.
- Acciones destructivas o cierres: explicar consecuencias y pedir motivo/confirmación cuando el contrato lo exige; no añadir confirmaciones a toda acción rutinaria.
- Autorización: controles coherentes con permisos, más validación real del servidor. Un teléfono compartido o una aprobación del equipo nunca verifica al paciente ni confirma por el interlocutor.

## Implementar y comprobar

- Usar patrones, tokens y estados existentes; semántica HTML, nombres accesibles, foco visible, teclado y contraste. No comunicar estado solo con color ni depender de hover.
- Verificar anchos estrechos con contenido realista y textos largos; scroll local deliberado sin desbordar el documento. Respetar movimiento reducido cuando haya animaciones.
- Nueva composición compartida: story junto al componente con estados pertinentes. Nueva pantalla/entidad: ampliar semilla manual según regla raíz.
- Abrir superficie real y completar el recorrido modificado: entrada, acción, respuesta y recuperación. Probar escritorio/móvil y teclado; si afecta permisos, comprobar rechazo del servidor.
- Observar estados intermedios cuando haya guardado, drag o navegación bloqueada. Un screenshot final no demuestra transición correcta.
- Tests permanentes solo para regresiones plausibles de comportamiento; no snapshots de redacción ni geometría SVG en jsdom.

## Entrega breve

Informar: tarea resuelta, decisión/tradeoff relevante, recorrido realmente ejercitado y limitaciones observadas. No afirmar accesibilidad completa por una comprobación parcial ni calidad de proveedor real con un fake.

Reglas transversales nuevas van en el AGENTS del área; motivos duraderos con alternativas en un ADR breve. No crear `design.md`, duplicar catálogo de componentes ni guardar bitácoras de pruebas en esta skill.
