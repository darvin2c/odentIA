# Presentación de Fundadores

`/presentacion` en cada web (odentia32.com y latidia72.com): la presentación animada para quien entra primero al programa Fundadores. Se presenta con clics: cada momento muestra primero cómo es hoy («Hoy · …») y, con un clic, cómo es con el producto. Tiene guion para quien presenta (tecla N). No se indexa ni va en el mapa del sitio.

- `odentia/` y `latidia/`: cada una con `deck.html` (estilos y partes), `deck.js` (cómo avanza y sus escenas) y sus escenas 3D en three.js. La portada de odentIA es la escena real de las 32 piezas (`@odentia/brand-scene`); la de latidIA, la línea de pulso de su portada (`ECG` de `components/latidia/home/DictationDemo.tsx`).
- De pie (teléfono o tableta de hasta 1100 px), `deck.js` pone `stacked` en `<html>`: arriba el aviso «Gira el teléfono para ver la presentación» y las partes una debajo de otra, cada una al ancho de la pantalla; la que queda a la vista es la actual (sus escenas empiezan al llegar) y las flechas la llevan a la vista. Acostado y en el escritorio, el escenario de siempre.
- `figures.ts`: las cifras. En `deck.html` cada precio y condición es una marca `{{nombre}}` que se llena con los planes que publica la administración. Sin los dos planes, la página dice «Los precios se publican pronto».

Reglas: solo piezas de la marca (el diente y los corchetes en odentIA; la línea de pulso y los corchetes del [72] en latidIA); cada agente con su color (Sofi celeste, Clío menta, Argos ámbar); ninguna cifra de precio escrita a mano.
