---
language: "es"
source_slug: "handoff-mirroring-or-casting-know-which-workflow-you-need"
source_sha256: "b46f9a584d473e98e7d7972e1d512ff3202c7d9490c7c540717f8958313a123e"
title: "Continuidad, duplicación de pantalla o casting: elige el flujo que necesitas"
seo_title: "Continuidad, duplicación o casting: cuál utilizar"
meta_description: "Elige continuidad para ver de forma independiente, duplicación para copiar la pantalla o casting para un receptor. Compara controles, privacidad, acceso y dispositivos."
excerpt: "Decide si necesitas una app independiente, una copia de tu pantalla o reproducción en un receptor controlada desde el teléfono y comprueba los requisitos de esa ruta."
topic_cluster: "Continuidad entre dispositivos"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Continuidad, duplicación de pantalla o casting: elige el flujo que necesitas

> **En resumen:** Utiliza la continuidad entre dispositivos para seguir de forma independiente en la app del dispositivo de destino. Utiliza la duplicación de pantalla para reproducir tu pantalla en otra. Utiliza el casting hacia un receptor para seleccionar medios en un dispositivo y controlar su reproducción en otro. Elige según el comportamiento que necesitas y comprueba después los requisitos de app, receptor, red y fuente; la palabra «cast» por sí sola no identifica la ruta.

«Muestra esto en la TV» puede significar tres cosas: trasladar tu progreso de visionado, copiar la interfaz actual o usar el teléfono como mando. Una conexión exitosa puede seguir siendo el flujo equivocado si no hace lo que esperabas.

Aquí, **dispositivo de origen** es el teléfono u ordenador desde el que empiezas; **fuente multimedia** es el servicio o los archivos que proporcionan los medios que estás autorizado a usar. No son intercambiables.

## Compara los tres flujos

| Flujo | De dónde procede la experiencia visible | Dispositivo de origen después del inicio | Verificación principal |
| --- | --- | --- | --- |
| Continuidad entre dispositivos | La app abierta de forma independiente en el destino | No es necesario para renderizar la sesión del destino | Cuenta, perfil, fuente, elemento, versión, progreso |
| Duplicación de pantalla | Una reproducción de la pantalla de origen compartida | Sigue proporcionando la pantalla mostrada | Compatibilidad del sistema operativo y la pantalla; qué se comparte |
| Casting hacia un receptor | Medios reproducidos por un receptor y seleccionados desde un emisor | Proporciona controles de sesión; la dependencia continuada varía | Compatibilidad de emisor, receptor, medios y red, y derechos de uso |

Son categorías prácticas, no nombres rígidos de protocolos. Google documenta tanto [enviar una pestaña o pantalla de Chrome](https://support.google.com/chromecast/answer/3228332?hl=en) como [reproducir en un receptor controlado por un emisor](https://developers.google.com/cast/docs/overview). Esta guía llama «casting hacia un receptor» a lo segundo para que puedas distinguir el comportamiento previsto antes de seguir instrucciones de configuración.

## Elige el traspaso para dar continuidad

El traspaso entre dispositivos encaja cuando el objetivo es «terminar este contenido en la app de TV» o «pasar de la tableta a la web». La [página pública de funciones](https://norva.tv/#features) de Norva describe progreso, favoritos, historial y preferencias de perfil que te acompañan en las pantallas compatibles. Es continuidad del contexto de visionado, no una copia de la primera pantalla.

El destino sigue necesitando su propia vía compatible de Norva y acceso a la fuente multimedia compatible. Pausa la primera sesión, confirma en el destino el perfil previsto y la versión del elemento y verifica el punto de reanudación antes de reproducir. La [guía de continuidad estado por estado](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) cubre esa secuencia. Un póster coincidente no basta para identificar el mismo episodio o edición.

**Elígelo cuando:** quieras que el destino sea la pantalla principal sin reproducir la pantalla de origen.

## Elige la duplicación para una copia exacta de pantalla

La duplicación de pantalla reproduce una pantalla compartida en lugar de abrir una copia independiente de la app de destino. Compartir toda la pantalla puede revelar navegación, notificaciones, detalles de cuenta u otra actividad en pantalla. Compartir una pestaña o una sola app tiene un alcance menor cuando la plataforma lo ofrece; no supongas que esos modos muestran las mismas cosas.

Comprueba el alcance antes de empezar y cierra el material privado que pueda aparecer dentro de él. Verifica tanto imagen como sonido: las instrucciones de Chrome de Google distinguen el envío de pestaña del de pantalla completa y señalan que el audio de esta última puede permanecer en el ordenador. Una imagen visible no demuestra que el sonido también se haya trasladado.

**Elígelo cuando:** la necesidad real sea mostrar la misma interfaz o una pantalla que no sea multimedia a otros espectadores y exista compatibilidad verificada con la duplicación.

## Elige la reproducción remota para un flujo con receptor

En el modelo Cast de Google, un emisor inicia y controla la sesión mientras un receptor gestiona la reproducción de medios. El receptor no es simplemente una segunda copia de todo lo que aparece en el teléfono. Que la sesión continúe al cerrar el emisor o perder su conexión depende de la implementación real; compruébalo en lugar de suponer independencia del teléfono.

Un flujo con receptor necesita capacidades compatibles de emisor y receptor. La página de inicio pública de Norva enumera **Google Cast** por separado de su app Android TV y de la continuidad entre pantallas. Esa disponibilidad publicada no es una prueba de tu receptor concreto, formato multimedia, pista de subtítulos o red. Este artículo no informa de una prueba de casting de Norva completada.

El [borrador de la API Remote Playback del W3C](https://www.w3.org/TR/remote-playback/) describe una familia más amplia de mecanismos de reproducción remota, incluidos casos en los que el origen sigue renderizando o retransmitiendo medios. El [borrador de la API Presentation](https://www.w3.org/TR/presentation-api/) trata de presentar contenido web en otra pantalla. Ninguna especificación demuestra que una app implemente una API concreta ni que todos los receptores sean compatibles.

**Elígelo cuando:** el destino esté diseñado para recibir la reproducción y el emisor, receptor, medios, red, derechos de la fuente y documentación actual del producto permitan esa ruta.

## Empieza por preguntas sobre el objetivo

Pregúntate:

1. ¿Quiero que el destino ejecute su propia app después de la transición?
2. ¿Necesito compartir toda la pantalla, solo una app o únicamente el medio?
3. ¿Quiero seguir controlando la reproducción desde el dispositivo de origen?
4. ¿Qué información privada está dentro del alcance de uso compartido elegido?
5. ¿La ruta seleccionada puede acceder a la fuente multimedia autorizada?
6. ¿Esa función está documentada para estos dispositivos y versiones de app?
7. ¿Las condiciones actuales del plan de software y de la fuente multimedia permiten el uso previsto?

Si las respuestas se contradicen, no actives iconos de conexión al azar. Aclara primero el objetivo.

## Aportación original: ficha de selección

La siguiente ficha completa es una **ilustración creada para esta guía**, no un registro de pruebas del producto. Las personas, el título y la posición de pausa son ficticios. Cada elección sigue el objetivo indicado; la última columna es trabajo pendiente, no una comprobación superada.

| Situación indicada | Flujo elegido | Por qué encaja | Comprobar antes de usar |
| --- | --- | --- | --- |
| Maya pausó la película ficticia Harbour Walk en 18:40 en su teléfono y quiere terminarla en la app de TV con el mando del televisor | Continuidad entre dispositivos | La TV debe ejecutar una sesión independiente con el contexto guardado correcto | Mismo perfil, fuente autorizada, versión exacta y punto de reanudación en la app de TV compatible |
| Jules quiere que otra persona vea el panel de filtros abierto en un portátil | Duplicación o un modo compatible de compartir app o ventana | La propia interfaz, no solo un vídeo, debe aparecer en la pantalla | Alcance exacto de lo compartido, compatibilidad de pantalla y ausencia de material privado |
| Sam quiere elegir una película en el teléfono y seguir usando sus controles de reproducción para el receptor del salón | Casting hacia un receptor | El emisor controla la reproducción del receptor sin compartir toda la interfaz del teléfono | Emisor y receptor compatibles, medios accesibles, uso permitido y pistas necesarias de audio y subtítulos |

Las decisiones difieren aunque las tres personas digan «ponlo en la pantalla grande». Reutiliza las cuatro columnas con tu propia situación. Si la comprobación final es desconocida, la elección es provisional; una etiqueta atractiva de función no la completa.

## Verifica antes de actuar

Para una TV compartida, acordad de quién deben cambiar el progreso y las preferencias. La [guía para decidir entre perfiles separados y compartidos](/blog/separate-profiles-or-one-shared-profile-a-decision-framework/) ayuda a resolverlo antes de empezar la reproducción. Para un flujo con receptor, consulta las indicaciones actuales de Norva y del fabricante; no deduzcas compatibilidad de la forma de un icono, un tutorial antiguo u otra app.

Comprueba también la disponibilidad de audio y subtítulos en el destino. Una imagen correcta no demuestra que haya llegado cada [pista de subtítulos integrada o separada](/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/). Registra la versión de la app, el modelo del receptor, la versión del elemento elegido y el resultado visible si necesitas ayuda; no compartas credenciales de la fuente.

## Limitaciones y errores comunes

Los términos varían entre plataformas. Algunos productos agrupan descubrimiento, control y visualización bajo una etiqueta. Este artículo ofrece un marco de decisión, no instrucciones específicas de configuración de dispositivos.

Los errores habituales incluyen tratar la continuidad como duplicación, suponer que toda app de TV es un receptor, mostrar notificaciones durante la duplicación, confundir el número de perfiles con permiso de uso simultáneo y esperar pistas idénticas en todas las rutas. Norva es software de reproducción multimedia; no incluye contenido ni suscripción de TV. Un método de conexión no concede derechos sobre los medios ni anula las condiciones de acceso de una fuente.

## Preguntas frecuentes

### ¿La sincronización de Norva entre dispositivos significa que admite casting?

La sincronización por sí sola no establece compatibilidad con casting. Norva enumera Google Cast por separado en su página de inicio pública. Comprueba el emisor, receptor, fuente y medios compatibles para la ruta que quieres usar; esta guía no ha probado esa combinación de dispositivos.

### ¿La duplicación es lo mejor para vídeo?

No en todos los casos. Puede reproducir toda la pantalla de origen y mantener implicado el dispositivo de origen. Elige según el objetivo real y la ruta compatible.

### ¿Puedo usar los términos de forma intercambiable?

Evítalo. Nombra el comportamiento esperado del origen y del destino para que soporte y las personas del hogar entiendan el flujo.

## Tu siguiente paso

Elige una fila de la ficha de selección y después [revisa las funciones de Norva entre dispositivos](https://norva.tv/#features) con ese objetivo. Mantén explícitas las comprobaciones pendientes de dispositivos y fuente antes de trasladar una sesión.

## Fuentes

- [Google Cast: visión general de emisores y receptores](https://developers.google.com/cast/docs/overview)
- [Soporte de Google: enviar una pestaña o pantalla de Chrome a una TV](https://support.google.com/chromecast/answer/3228332?hl=en)
- [Borrador de la API Remote Playback del W3C](https://www.w3.org/TR/remote-playback/)
- [Borrador de la API Presentation del W3C](https://www.w3.org/TR/presentation-api/)
- [Funciones de Norva](https://norva.tv/#features)
