---
language: "es"
source_slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
source_sha256: "98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90"
title: "Pistas de subtítulos integradas y separadas: lo que debes saber"
seo_title: "Subtítulos integrados, externos e incrustados: diferencias"
meta_description: "Compara pistas integradas, archivos externos y texto incrustado. Aprende qué indican realmente el contenedor, el selector de pistas y la opción de desactivarlas."
excerpt: "Una pista integrada no es texto incrustado en la imagen. Compara el almacenamiento de subtítulos con un ejemplo completo y distingue qué demuestra el selector de lo que sigue desconocido."
topic_cluster: "Gestión de subtítulos"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Pistas de subtítulos integradas y separadas: lo que debes saber

> **En resumen:** Los datos de subtítulos integrados se almacenan dentro del contenedor multimedia; los externos se almacenan por separado y se asocian al medio. Ambos pueden convertirse en una pista seleccionable cuando sean compatibles. Los subtítulos incrustados ya forman parte de la imagen del vídeo y no pueden desactivarse como una pista. Un selector de subtítulos que funciona demuestra que funciona un control, no dónde se almacenan los datos.

«Integrado» se usa a menudo tanto para una pista dentro del contenedor como para texto renderizado de forma permanente en la imagen. Esa ambigüedad importa: uno puede ser seleccionable y el otro forma parte de la propia imagen. Empieza por cómo está empaquetado el medio y después comprueba qué ofrece este reproductor para la versión elegida.

## Define las tres categorías prácticas

- **Pista integrada seleccionable:** datos de subtítulos empaquetados dentro del contenedor multimedia, separados de sus imágenes de vídeo y ofrecidos como opción cuando son compatibles.
- **Pista asociada separada:** datos de subtítulos almacenados aparte del medio y vinculados a través de la fuente o del contexto de reproducción. Un archivo separado se denomina a veces archivo auxiliar o sidecar.
- **Texto incrustado:** píxeles que ya están en la imagen del vídeo; ningún selector puede desactivarlos de forma independiente.

Un **contenedor**, como MKV o MP4, empaqueta flujos multimedia y metadatos. No es en sí mismo una pista de subtítulos ni una garantía de compatibilidad del decodificador. La [guía de contenedores de MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) distingue el contenedor de los códecs que contiene. Por tanto, una extensión MKV por sí sola no indica qué subtítulos existen ni si un reproductor concreto los ofrecerá.

Los datos de subtítulos no siempre son texto plano. La [especificación de subtítulos de Matroska](https://www.matroska.org/technical/subtitles.html) describe subtítulos basados en texto y formatos basados en imágenes como VobSub. Una pista basada en imágenes sigue estando separada de la imagen del vídeo; «basada en imágenes» no significa «incrustada». Estas categorías describen el empaquetado, no la calidad de la traducción ni si la información de accesibilidad está completa.

## Identifica la categoría por el comportamiento

Abre el selector de subtítulos del elemento y la versión exactos y registra las entradas antes de cambiar nada. Elige una pista, anota su etiqueta y examina una escena con un subtítulo. Si hay un control para desactivarlo, úsalo y vuelve al mismo momento; comparar dos momentos distintos puede ser simplemente comparar un subtítulo con una pausa sin texto.

Si el texto seleccionado desaparece, eso establece que se podía controlar en este contexto. **No** distingue una pista integrada de una externa. Si el texto permanece, una posibilidad es que esté incrustado, pero comprueba si hay otra capa activa de subtitulado o una función de subtítulos del dispositivo antes de concluir que forma parte del vídeo. Confirma el almacenamiento mediante información sobre el medio suministrado, no solo por el estilo visual.

## Trata la compatibilidad con pistas separadas como condicional

Un recurso separado necesita una asociación con el elemento correcto y un formato compatible con el contexto de reproducción. El [elemento HTML track](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track), por ejemplo, apunta explícitamente a un recurso externo y puede indicar un idioma y una etiqueta. El [borrador de especificación WebVTT](https://www.w3.org/TR/webvtt1/) define un formato de texto sincronizado utilizado para ese fin. Es un ejemplo de plataforma web, no una descripción de los controles de importación de Norva.

Un archivo junto a un vídeo no se asocia automáticamente con él en todos los reproductores. Comprueba el flujo documentado para el dispositivo y la fuente que usas. La existencia de pistas externas no establece por sí sola que Norva permita importar cualquier archivo local, asociar automáticamente por nombre de archivo o admitir todos los formatos.

## Aportación original: ficha de empaquetado

Esta **ilustración creada para la guía** utiliza un clip ficticio, Harbour Gate, con la frase «The gate is open» («La puerta está abierta») en 00:18. No hay archivos de muestra descargables ni observaciones de reproducción de Norva. Las filas A–C definen distintas formas en que un propietario podría preparar ese clip; el comportamiento de los controles presupone un reproductor compatible con el recurso indicado.

| Versión | Información de empaquetado suministrada en el ejemplo | Comportamiento esperado de los controles | Conclusión justificada |
| --- | --- | --- | --- |
| A | Un contenedor MKV contiene vídeo, audio y una pista de subtítulos en inglés separada dentro de él | Seleccionar inglés muestra la frase; desactivar esa pista la oculta | Pista integrada, porque se conoce explícitamente su almacenamiento |
| B | Un vídeo MP4 está asociado explícitamente con un archivo WebVTT en inglés separado que contiene la frase | Seleccionar inglés muestra la frase; desactivar la pista la oculta | Recurso externo, porque se conocen la asociación y el almacenamiento separado |
| C | El propietario renderizó la frase inglesa dentro de las imágenes del vídeo; no se proporciona pista de subtítulos | Un control para desactivar subtítulos no puede eliminar esos píxeles | Texto incrustado, porque así se define el vídeo suministrado |
| D | Solo se conoce una entrada del reproductor etiquetada Inglés; puede mostrar y ocultar la frase | La alternancia funciona, igual que en A y B | Pista seleccionable; el almacenamiento integrado o externo sigue sin confirmarse |

Las filas A y B pueden verse idénticas en el reproductor. La fila D es el límite importante: una prueba de desactivación no puede distinguirlas. Un elemento real también puede combinar texto incrustado con una traducción seleccionable, por lo que distintas líneas visibles pueden pertenecer a más de una categoría.

Para reutilizar la ficha, registra elemento y versión, lista completa del selector, etiqueta seleccionada, tiempo del subtítulo, resultado al desactivarlo y procedencia de la información de empaquetado. Escribe «sin confirmar» donde la fuente multimedia no aporte suficiente detalle.

## Compara versiones con cuidado

Una versión puede empaquetar los subtítulos de otra forma u ofrecer un conjunto distinto. Mantén fijos dispositivo, perfil y fuente multimedia al comparar versiones, y registra cada lista completa de pistas. Verifica edición y duración además del título: un recurso sincronizado para otro montaje puede no coincidir con la película del mismo nombre.

Que falte una pista después de cambiar de versión no demuestra que un recurso separado no se haya cargado.

## Diagnostica una pista separada ausente

Primero establece por qué esperas esa pista. Una etiqueta de catálogo, un archivo proporcionado por el propietario y una pista realmente enumerada para esta versión son tipos de evidencia distintos. Pregunta si el propietario de la fuente confirma el recurso y su asociación con la versión seleccionada.

Registra idioma y función esperados, dispositivo, versión de app o navegador, conectividad y selector completo. Distingue «no aparece en la lista», «aparece pero no se puede seleccionar» y «seleccionada pero sin subtítulo visible en el momento comprobado». Esas observaciones apuntan a preguntas diferentes; ninguna demuestra por sí sola un defecto del reproductor. Conserva esa evidencia antes de cambiar nombres de archivos, mover recursos, quitar la fuente, borrar datos o reinstalar.

## Entiende las diferencias de funciones

Las pistas integradas y externas pueden ofrecer subtítulos útiles. Las opciones de estilo dependen del formato y del renderizador; los recursos de texto e imagen no tienen por qué ofrecer los mismos controles. El texto incrustado no puede cambiarse de estilo ni desactivarse de forma independiente desde un selector de subtítulos. Las [orientaciones de subtitulado del W3C](https://www.w3.org/WAI/media/av/captions/) también distinguen los subtítulos que el espectador puede ocultar de los abiertos que permanecen visibles.

La [guía completa de gestión de subtítulos](/blog/the-complete-guide-to-managing-subtitle-tracks/) explica las comprobaciones de idioma, función, sincronización, estado y dispositivo que se aplican después de encontrar una pista.

Después evalúa qué contiene: [el subtitulado de accesibilidad y los subtítulos de diálogo pueden cubrir necesidades de información distintas](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). Si hay subtítulos pero cuesta leerlos, distingue [la legibilidad de los caracteres de la facilidad de lectura](/blog/legibility-and-readability-two-different-viewing-problems/) en lugar de culpar al método de almacenamiento.

## Protege los derechos de las fuentes y la privacidad

Utiliza medios y recursos de subtítulos que te pertenezcan o a los que estés autorizado a acceder. Norva es un reproductor multimedia, sin contenido ni suscripción de TV incluidos; conectar un recurso no concede derechos sobre él. No subas medios ni archivos de subtítulos a soporte sin el permiso necesario. Empieza un informe con etiquetas no sensibles, pasos y marcas de tiempo; revisa las capturas para detectar direcciones privadas de fuentes o datos de cuenta antes de compartirlas.

## Errores comunes y limitaciones

Evita llamar al texto incrustado pista integrada seleccionable, prometer asociación automática, suponer compatibilidad con todos los formatos y editar archivos de origen antes de conservar evidencias.

El empaquetado puede seguir siendo opaco cuando la fuente solo muestra una opción reproducible. Describe el comportamiento observado del selector en lugar de adivinar el método de almacenamiento.

## Preguntas frecuentes

### ¿Se pueden desactivar los subtítulos incrustados?

No como una pista separada, porque el texto forma parte de la imagen. Otra versión del medio puede ser distinta, pero verifica su disponibilidad.

### ¿Las pistas separadas siempre son archivos de texto?

No. WebVTT y SubRip son ejemplos basados en texto, pero los recursos también pueden estar basados en imágenes, como VobSub. «Separado» describe dónde se guarda el recurso respecto al medio, no cómo se codifican sus subtítulos. Comprueba el formato real y la compatibilidad documentada.

### ¿Una pista separada ausente significa que el reproductor está roto?

No. Verifica la asociación, el elemento y la versión, los metadatos de la fuente, la compatibilidad del formato y el selector antes de atribuir una causa.

## Tu siguiente paso

Si la fuente confirma un recurso de subtítulos pero el resultado sigue sin estar claro, lleva tu ficha de empaquetado completa al [soporte de Norva](https://norva.tv/support). Indica lo que observaste y lo que sigue sin confirmar; deja fuera del informe inicial los archivos multimedia y los detalles privados de conexión.

## Fuentes

- [MDN: contenedores multimedia y los códecs que contienen](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska: códecs de subtítulos, incluidas pistas basadas en texto e imágenes](https://www.matroska.org/technical/subtitles.html)
- [MDN: elemento HTML track y recursos externos](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C: borrador de especificación WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: subtitulado, subtítulos y presentación abierta o cerrada](https://www.w3.org/WAI/media/av/captions/)
- [Norva: funciones y requisitos de fuentes compatibles](https://norva.tv/#features)
