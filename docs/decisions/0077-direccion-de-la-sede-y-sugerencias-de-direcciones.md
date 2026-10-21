# 0077 · La dirección de la sede, «Cómo llegar» y las sugerencias de direcciones

Fecha: 2026-10-21 · Estado: aceptada · Precisa a [0036](0036-nucleo-internacional-y-lo-que-solo-es-de-peru.md) · Issue 36 (lienzo «Sedes, direcciones y Tu plan», aprobado el 2026-10-21)

## Problema

La dirección del paciente ya tenía la forma internacional (ADR 0036), pero la de la sede seguía siendo texto peruano: «departamento» y «provincia» que ninguna pantalla llenaba, una «Dirección 2» y un enlace de mapa sin campo. Nadie podía decirle a un paciente cómo llegar. Escribir una dirección completa era lento, sobre todo en el celular del paciente, y el distrito, la provincia y el departamento se escribían de memoria.

## Decisión y motivo

- **La sede tiene la dirección del paciente** (HL7 FHIR Address): calle y número, ciudad, el nivel intermedio, región ISO 3166-2 (o su nombre si el país no tiene lista), código postal y país. Los nombres y la lista los pone el perfil del país. La dirección en una línea es una sola regla (`postalAddressText`) para la sede, el paciente, la reserva, la cita, los documentos y lo que sabe Sofi.
- **«Cómo llegar»** abre Google Maps con la dirección escrita y, si se eligió de Google, la ficha de la sede (Maps URLs: sin clave, sin costo, solo al tocarlo). Cada sede tiene un enlace corto de la clínica (`<clínica>/llegar/<sede>`) que pone la base al crearla y no cambia al renombrarla: es el que manda Sofi, porque el de Google mide más de 150 letras.
- **Sugerencias al escribir «Calle y número»**: la sede busca en Google Places (encuentra también la clínica por su nombre) y la persona en Geoapify, sobre OpenStreetMap. El motivo es el costo: una dirección con Google cuesta unos USD 0,022, siete veces una conversación de Sofi; 150 pacientes al mes serían USD 3,3, más que toda la IA de una clínica mediana (USD 1,4–2,2). Con Geoapify son centavos y su plan gratis (3 000 búsquedas al día) cubre por mucho tiempo. La sede se escribe una vez, así que Google en la práctica no cuesta.
  - Todo pasa por el servidor: al proveedor le llega solo lo escrito, sin nombre ni clínica, y su código no corre en las páginas. Los proveedores son adaptadores (`AddressProvider`): el núcleo solo conoce la dirección común.
  - Las sugerencias nunca obligan; lo escrito se guarda tal cual.
  - Se guarda lo que la persona deja en el formulario y, de Google, solo el identificador del lugar; nunca coordenadas. Las condiciones de Google piden no guardar lo que devuelve salvo ese identificador; su propia guía para formularios de dirección llena el formulario y la tienda guarda lo enviado. Es nuestra lectura de sus condiciones, no una revisión legal. Los datos de Geoapify son de OpenStreetMap, que permite guardarlos con su mención.
  - Cada lista lleva la mención que pide su proveedor: «Google Maps» o «Powered by Geoapify · © OpenStreetMap».
  - Tope por clínica y día: 200 búsquedas de sede y 600 de pacientes. Sin clave, sin respuesta o pasado el tope, los campos de siempre, sin mensaje. Si el plan diario de Geoapify se acaba, la administración lo ve en su Inicio.
  - La región que dice el mapa se lleva a la lista del país por código o por nombre (`regionFromMap`); lo que un nombre no distingue (Lima Metropolitana y Lima Provincias) va como otros nombres en la lista del país, no en el código.

## Alternativas descartadas

- *Google para todo:* lo más preciso, pero el paciente costaría más que la IA de la clínica.
- *HERE:* cuesta casi lo mismo que Google y encuentra menos en Perú.
- *Un botón «Completar dirección» (una consulta por paciente):* más barato que Google, pero sin lista al escribir; Geoapify da la lista por menos.
- *Que cada clínica traiga su clave de Google:* demasiado para una clínica mediana (cuenta, facturación, restricciones).
- *Guardar las coordenadas del lugar:* Google solo las permite 30 días y la sede no las necesita.

## Consecuencias

- Hay que crear las cuentas de Google Cloud (con facturación) y de Geoapify y poner sus claves en la API. Antes de usar Geoapify con pacientes reales se prueban 30 direcciones de Lima y de provincias: si llena mal el distrito o el departamento en más de 3 de cada 10, se apaga quitando su clave.
- Revisar si Geoapify pide el plan pagado para producción, si los precios de Google o Geoapify cambian, o si una clínica de otro país necesita otro proveedor.

## Referencias

`packages/clinical/src/postal-address.ts`, `packages/services/src/address-suggestions.ts`, `packages/services/src/branches.ts`, `apps/api/src/routes/address.ts`, `apps/platform/src/components/address/address-street-field.tsx`, migraciones 0059–0063.
