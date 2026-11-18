# 0202 · Un solo WhatsApp para todas las apps: la conversación sabe su app

Fecha: 2026-11-17 · Estado: aceptada · Paso A1 del lienzo «Una sola administración para todas las apps» · Revisa ADR 0189 (Kairós vende en los chats) y 0196 (la Bandeja)

## Problema

La administración vende como Grupo Sallca por un solo número de WhatsApp (y una sola cuenta de Instagram y una página de Messenger) para odentIA, latidIA, vistIA y las apps que vengan. Kairós no sabía de qué app le hablaban: sin cliente arrancaba como odentIA (`client?.product ?? "dental"`) y solo cambiaba si registraba la clínica con otro producto. Por correo no pasaba: ahí lo dice el dominio al que escribieron.

## Decisión y motivo

- **La conversación guarda su app y cómo se supo** (`saas_chat.product` y `product_source`): `anuncio`, `enlace`, `lo_dijo` o `persona`. Con cliente manda la app de su ficha (`chatAppOf`). Sin nada de eso no se sabe, y nunca se asume.
- **Anuncio:** un mensaje que llega desde un anuncio de Facebook o Instagram que abre WhatsApp trae `referral` (el id del anuncio, su título y su texto). El anuncio se guarda una vez (`saas_ad`) y una persona de Administración lo ata a su app en Hoy («Anuncios por atar»). Desde ahí, cada conversación que abre nace con esa app, y las que ya abrió sin app la toman.
- **Enlace:** `wa.me` solo admite un texto ya escrito, sin referencia oculta. El botón de cada web abre el chat con «Hola, quiero información de latidIA» (`salesWhatsAppText`), y ese texto, o nombrar una sola app, dice la app sin modelo.
- **Lo dice la persona:** Kairós saluda como Grupo Sallca, pregunta qué negocio tiene sin nombrar ninguna app ni dar precios, y lo anota con su herramienta `elegir_app` cuando la persona lo dice («tengo una óptica»). La comprobación antes de enviar no deja salir el nombre de una app ni un importe mientras la app no se sabe. No registra una clínica sin saber su app.
- **Lo elige una persona:** Administración puede elegir o cambiar la app de una conversación sin cliente en su cajón; Kairós no cambia lo que eligió una persona.
- Lo que firma una conversación sin app es «Grupo Sallca»; con app, la marca de esa app.

## Alternativas descartadas

- **Un número por app:** cuesta un número, una revisión de Meta y una calificación por app, y no resuelve quien escribe directo. Queda abierto solo por marca o para aislar la calificación cuando haya volumen.
- **Preguntar siempre:** suma un paso a quien ya llegó por el anuncio o el botón de una app.
- **Adivinar la app con el modelo por cualquier frase:** lo que no dice una regla fija lo pregunta Kairós, y lo anota con su herramienta.

## Límites

- Messenger e Instagram todavía no leen su `referral` (`m.me/...?ref=` no siempre llega); ahí se sabe por el texto o preguntando.
- WhatsApp permite botones de respuesta; por ahora Kairós pregunta en texto. Los botones necesitan cambiar el adaptador de canales, que es de uso general (`shared/`) y va en su propio cambio.
- Sin probar contra Meta real: los chats de la administración siguen apagados hasta sus claves.
