# 0162 · El color de la marca de la clínica

Fecha: 2026-11-08 · Estado: aceptada · Precisa [0115](0115-documentos-del-paciente-con-un-solo-kit.md) (el color en el papel) y [0076](0076-chat-web-de-la-clinica-y-una-fila-por-persona.md) (el chat ya no tiene color propio)

## Problema

Todas las clínicas se veían iguales: turquesa en odentIA y morado en latidIA. El único color propio era el del chat web, con seis colores fijos escondidos en sus opciones, que contradeciría cualquier color puesto en otro lado. El dueño del producto pidió que cada clínica pueda usar el color de su marca en la app y en sus papeles, pero el papel tiene que seguir sobrio: se imprime en blanco y negro, se fotocopia y va a farmacias y seguros, y el rojo de ANULADO no puede competir con nada.

## Decisión y motivo

- **Un color por clínica, no por persona ni por sede**, en `org_profile.brand_color`: solo el que eligió la clínica (nulo es el del producto). Lo cambia quien tiene `settings.write`, con su propio «Usar este color» en «Datos de la clínica», y queda en la actividad (`org_profile.brand_color_set`, con `warnedReddish` si se parecía al rojo). Elegir el de fábrica lo guarda como nulo.
- **Cualquier color vale; la cuenta cuida que se lea.** Una sola cuenta, `brandPalette` en `@odentia/clinical`, porque la usan igual la pantalla, el chat y el papel. El relleno (`--primary-fill`: botones, cabecera y burbujas del chat, todo lo que lleva el color con letra encima) va con letra blanca siempre que oscurecerlo hasta una cuarta parte alcance: un naranja se tuesta apenas. Solo un color claro (amarillo, celeste, menta), que habría que cambiar demasiado, queda exacto con letra oscura. La fórmula de WCAG 2 prefiere la letra oscura sobre naranjas y rojos intensos, y a la vista es al revés (lo mismo mide APCA); el dueño del producto lo vio en pantalla; textos, enlaces, bordes, foco y la línea del papel usan el tono que llega a 4,5:1 sobre el fondo (`--primary`). En oscuro se aclara. Casi blanco y parecido al rojo se avisan sin frenar. Se guarda el color elegido y todo lo demás se calcula al mostrarlo.
- **Llega desde el primer pintado.** La raíz de cada app pide `GET /api/public/appearance/:slug` y escribe en el `<head>` un `<style>` que redefine el bloque «Marca» de `globals.css`, el tinte del asistente y los grises, con `:root:root:root` para pesar más que `[data-brand]` y `.dark`. Sin color, no escribe nada. La ruta es pública porque el color se ve en cada página de la clínica; una dirección que no es de una clínica responde igual que una sin color.
- **Lo del asistente también toma el color de la clínica** (decisión del usuario sobre el tablero 11 del lienzo): Sofi, Clío y Argos se reconocen por la marca del robot y su nombre, no por un color aparte.
- **Los grises acompañan al color, apenas** (estudio de diseño, tablero 12 del lienzo; decisión del dueño del producto): cada gris toma el tono de la marca con croma tope 0,012, proporcional a cuánto color tiene la marca (una marca gris da grises puros), y conserva su luz, así los contrastes no cambian. En claro, tarjeta, fondo y ventanas siguen blancos; en oscuro también se tiñen, porque son slate. Nunca en `.theme-light`. El texto gris se corrige si no llega a 4,5:1, y los tonos de la marca se miden contra estos grises. Se descartaron teñir solo el fondo y el menú (deja botones y bordes azulados), familias de grises a mano (cientos de valores, con saltos entre familias) y más croma (cansa, y en oscuro el naranja queda chocolate).
- **No cambian los colores con significado:** error, listo y aviso, la norma del odontograma (rojo, azul y la selección en violeta; el borde al pasar el mouse pasa a gris), los gráficos, los visores, la identidad de odentIA y latidIA y los correos de la plataforma.
- **El papel: dos toques.** La línea bajo el membrete y el cuadro de iniciales usan el tono legible (`DocumentClinic.brandInk`); el resto sigue en tinta y la térmica en negro. Lo que se guarda al emitir (receta, orden, descanso, hoja de atención y consentimiento firmado) queda como salió; lo que se arma en cada impresión (presupuesto, comprobante, la historia exportada) sale con el color de hoy, como ya pasa con el logo. La hoja que se firma en pantalla lleva lo mismo.
- **El chat web usa el color de la marca.** Se quita «Color del chat» y su `widgetColor`; `chat.js` recibe el color y la letra que se lee encima.

## Alternativas descartadas

- *Un tono legible para todo, también los botones.* Más simple, pero un amarillo o un celeste de marca quedaban mostaza o gris azulado: no se parecían a la marca.
- *Solo muestras fijas.* No alcanzan el color real de una marca. Quedan como sugeridos, junto con los colores del logo, la paleta y el código.
- *Que la clínica suba su membrete.* Dos fuentes de verdad para la dirección y el RUC, alturas que chocan con la hoja y un paso más en el alta. Se pide como referencia para sacar el color y los datos.
- *Solo en lo que ve el paciente.* Lo propuso el auditor; el dueño del producto lo quiso también en la app del equipo, y cuesta casi lo mismo.

## Consecuencias

- Las capturas de soporte se ven distintas en cada clínica.
- Un color parecido al turquesa de odentIA se distingue menos del de fábrica; no es un error.
- Revisar si una clínica real pide un membrete propio o un segundo color.

## Referencias

`packages/clinical/src/brand-color.ts`, `packages/clinic-app/src/lib/clinic-color.ts`, `components/settings/clinic-brand-color.tsx`, `packages/services/src/clinic-identity.ts` (`setClinicBrandColor`), `document-clinic.ts` (`clinicLogoColors`, `brandInk`), `apps/api/src/routes/public-appearance.ts`, migración `0066_color_de_la_marca`. Lienzo: https://claude.ai/artifact/2ua3TmzckN9Gw35nfEYzLe.
