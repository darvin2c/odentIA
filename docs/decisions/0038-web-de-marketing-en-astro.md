# 0038 · La web de marketing es una app propia en Astro, generada por adelantado

Fecha: 17 de octubre de 2026 · Estado: aceptada

## Problema

odentIA necesita una web pública que venda y explique el producto: inicio, precios, los pilares «omnicanal» y «agéntica», cada agente, cada parte del sistema, seguridad, contacto y las páginas legales (24 al abrir). Tiene que leerse entera en los buscadores, cargar rápido en un teléfono, mostrar escenas con movimiento sin frenar la página y no mezclarse con la aplicación de las clínicas, que exige sesión, permisos por organización y datos clínicos.

## Decisión y motivo

- **App propia, `apps/web`, en Astro con salida estática.** Cada página se genera como HTML al compilar, con su título, descripción, datos estructurados (organización, producto con su precio, preguntas, migas) y mapa del sitio. Lo interactivo (las escenas de la portada, la calculadora, las pestañas) va en islas React que se cargan solo donde hacen falta, así el texto llega completo a los buscadores y el resto de la página no carga JavaScript.
- **Sin backend ni datos de visitantes.** La web no llama a la API, no tiene formularios que guarden datos y no usa cookies de terceros; enlaza al registro y al ingreso del panel. Las visitas se miden con los registros del servidor.
- **Única excepción: el Libro de Reclamaciones** (`/pe/libro-de-reclamaciones`). La norma peruana (D.S. 011-2011-PCM) exige una hoja virtual con número correlativo, guardada y con copia a quien reclama, así que ese formulario envía a una ruta pública de la API (`POST /api/public/libro-de-reclamaciones`, con límite por dirección y sin sesión) que la guarda en una tabla de plataforma a la que el rol de la aplicación no accede. Ningún otro formulario de la web envía datos.
- **Una sola fuente de cifras.** Los precios viven en `apps/web/src/lib/pricing.ts`, alineados con la ADR 0031, y solo los muestran la sección de precio del inicio y `/precios`. El paso siguiente es leerlos del plan por defecto de la administración al compilar.
- **Dirección:** en producción, el dominio raíz, que `docs/deployment.md` ya reserva para marketing (`WEB_URL` fija la dirección canónica). En local, `www.odentia.localhost`, porque ahí el dominio raíz lo usa la plataforma; `www` ya es un subdominio reservado.

## Alternativas descartadas

- *TanStack Start, como panel, platform y admin:* mismo stack, pero renderiza en servidor en cada visita y entrega el JavaScript de la aplicación entera; para páginas que no cambian entre visitas, Astro da HTML estático y menos peso con menos piezas que mantener.
- *Páginas dentro de `platform`:* mezclaría lo público con la aplicación autenticada, su enrutamiento por organización y su ciclo de despliegue.
- *Un constructor de webs externo:* sacaría los textos y precios del repositorio y de la revisión de código, y obligaría a otra herramienta con datos de visitantes.

## Consecuencias

- La web se despliega como archivos estáticos detrás del mismo borde HTTPS; cambiar un texto o un precio requiere compilar y publicar de nuevo.
- Astro y su integración de React son dependencias nuevas, solo de `apps/web`, que usa TypeScript 5.9 porque `astro check` todavía no admite TypeScript 7.
- Las páginas legales existen con su estructura pero sin texto: van con `noindex` y un aviso hasta que las redacte un abogado. La web no se publica antes.
- Revisar esta decisión si la web necesita contenido que cambie en cada visita (por ejemplo, un agente que converse con las clínicas) o si pasa a tener muchos contenidos editoriales que convenga gestionar fuera del código.

## Referencias

- `apps/web/` · ADR 0031 (precios) · lienzo «Web de marketing odentIA» (diseño aprobado el 17 de octubre de 2026).
