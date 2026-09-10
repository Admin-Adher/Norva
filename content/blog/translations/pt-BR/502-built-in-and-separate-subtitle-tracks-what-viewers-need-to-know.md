---
language: "pt-BR"
source_slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
source_sha256: "98b9d0bbd83440fb5f247e1595988ce7cc53b352a8396f7bd1e88988ce55ed90"
title: "Faixas de legendas internas e separadas: o que você precisa saber"
seo_title: "Legendas internas, externas e gravadas na imagem: entenda"
meta_description: "Compare faixas internas, arquivos externos e texto gravado na imagem. Saiba o que o contêiner, o seletor de faixas e a opção de desligar realmente informam."
excerpt: "Uma faixa interna não é texto gravado na imagem. Compare o armazenamento de legendas em um exemplo completo e separe o que o seletor comprova do que continua desconhecido."
topic_cluster: "Gerenciamento de legendas"
sources_heading: "Fontes"
next_step_heading: "Seu próximo passo"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Faixas de legendas internas e separadas: o que você precisa saber

> **Em resumo:** Dados de legendas internas ficam dentro do contêiner de mídia; legendas externas são armazenadas separadamente e associadas à mídia. Ambas podem se tornar faixas selecionáveis quando houver compatibilidade. Legendas gravadas na imagem já fazem parte do vídeo e não podem ser desligadas como uma faixa. Um seletor de legendas que funciona comprova que um controle funciona, não onde os dados estão armazenados.

“Integrada” costuma ser usado tanto para uma faixa dentro do contêiner quanto para texto renderizado permanentemente na imagem. Essa ambiguidade importa: uma pode ser selecionável, enquanto o outro faz parte da própria imagem. Comece por como a mídia está empacotada e depois confira o que este reprodutor oferece para a versão escolhida.

## Defina as três categorias práticas

- **Faixa interna selecionável:** dados de legendas empacotados dentro do contêiner de mídia, separados das imagens do vídeo e apresentados como opção quando há compatibilidade.
- **Faixa associada separada:** dados de legendas armazenados fora da mídia e vinculados pela fonte ou pelo contexto de reprodução. Um arquivo separado às vezes é chamado de arquivo auxiliar ou sidecar.
- **Texto gravado na imagem:** pixels já presentes na imagem do vídeo; nenhum seletor consegue desligá-los de forma independente.

Um **contêiner**, como MKV ou MP4, empacota fluxos de mídia e metadados. Ele não é uma faixa de legendas nem uma garantia de compatibilidade do decodificador. O [guia de contêineres da MDN](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) separa o contêiner dos codecs dentro dele. Portanto, uma extensão MKV sozinha não informa quais legendas existem nem se um reprodutor específico vai disponibilizá-las.

Os dados de legendas nem sempre são texto simples. A [especificação de legendas do Matroska](https://www.matroska.org/technical/subtitles.html) descreve legendas baseadas em texto e formatos baseados em imagens, como VobSub. Uma faixa baseada em imagens continua separada da imagem do vídeo; “baseada em imagens” não significa “gravada na imagem”. Essas categorias descrevem o empacotamento, não a qualidade da tradução ou a completude da acessibilidade.

## Identifique a categoria pelo comportamento

Abra o seletor de legendas para o item e a versão exatos e registre as entradas antes de mudar algo. Escolha uma faixa, anote seu rótulo e examine uma cena com uma legenda. Se houver um controle para desligar, use-o e volte ao mesmo momento; comparar dois momentos diferentes pode simplesmente comparar uma legenda com uma pausa sem texto.

Se o texto selecionado desaparecer, isso estabelece que ele era controlável nesse contexto. **Não** distingue uma faixa interna de uma externa. Se o texto permanecer, estar gravado na imagem é uma possibilidade, mas confira se há outra camada ativa de legendas ou um recurso de legendas do dispositivo antes de concluir que ele faz parte do vídeo. Confirme o armazenamento por informações sobre a mídia fornecida, não apenas pelo estilo visual.

## Trate a compatibilidade com faixas separadas como condicional

Um recurso separado precisa estar associado ao item certo e usar um formato compatível com o contexto de reprodução. O [elemento HTML track](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track), por exemplo, aponta explicitamente para um recurso externo e pode fornecer idioma e rótulo. O [rascunho da especificação WebVTT](https://www.w3.org/TR/webvtt1/) define um formato de texto temporizado usado para essa finalidade. Este é um exemplo de plataforma web, não uma descrição dos controles de importação do Norva.

Um arquivo ao lado de um vídeo não é associado automaticamente a ele em todos os reprodutores. Confira o fluxo documentado para o dispositivo e a fonte usados. A existência de faixas externas não estabelece, por si só, importação de qualquer arquivo local, associação automática por nome de arquivo ou compatibilidade universal de formatos no Norva.

## Contribuição original: ficha de empacotamento

Esta **ilustração criada para o guia** usa um clipe fictício, Harbour Gate, com a frase “The gate is open” (“O portão está aberto”) em 00:18. Não há arquivos de amostra para baixar nem observações de reprodução do Norva. As linhas A–C definem formas diferentes pelas quais um proprietário poderia preparar o clipe; o comportamento dos controles pressupõe um reprodutor compatível com o recurso especificado.

| Versão | Informação de empacotamento fornecida no exemplo | Comportamento esperado dos controles | Conclusão justificada |
| --- | --- | --- | --- |
| A | Um contêiner MKV contém vídeo, áudio e uma faixa de legendas em inglês separada dentro dele | Selecionar inglês mostra a frase; desligar essa faixa a oculta | Faixa de legendas interna, porque seu armazenamento é explicitamente conhecido |
| B | Um vídeo MP4 está explicitamente associado a um arquivo WebVTT em inglês separado que contém a frase | Selecionar inglês mostra a frase; desligar a faixa a oculta | Recurso externo de legendas, porque a associação e o armazenamento separado são conhecidos |
| C | O proprietário renderizou a frase em inglês nas imagens do vídeo; nenhuma faixa de legendas é fornecida | Um controle para desligar legendas não pode remover esses pixels | Texto gravado na imagem, porque o vídeo fornecido é definido dessa forma |
| D | Só se conhece uma entrada do reprodutor rotulada Inglês; ela pode mostrar e ocultar a frase | A alternância funciona, como em A e B | Faixa selecionável; o armazenamento interno ou externo continua sem confirmação |

As linhas A e B podem parecer idênticas no reprodutor. A linha D é o limite importante: um teste de desligar a legenda não consegue diferenciá-las. Um item real também pode combinar texto gravado na imagem com uma tradução selecionável, portanto mais de uma categoria pode se aplicar a linhas visíveis diferentes.

Para reutilizar a ficha, registre item e versão, lista completa do seletor, rótulo selecionado, tempo da legenda, resultado no estado desligado e a origem de qualquer informação de empacotamento. Escreva “não confirmado” sempre que a fonte de mídia não fornecer detalhes suficientes.

## Compare versões com cuidado

Uma versão pode empacotar legendas de outra forma ou oferecer outro conjunto. Mantenha fixos o dispositivo, o perfil e a fonte de mídia ao comparar versões e registre cada lista completa de faixas. Verifique edição e duração, além do título: um recurso de legendas temporizado para outro corte pode não se alinhar ao filme com o mesmo nome.

Uma faixa ausente após mudar de versão não comprova que um recurso separado tenha falhado ao carregar.

## Diagnostique uma faixa separada ausente

Primeiro estabeleça por que espera aquela faixa. Um rótulo de catálogo, um arquivo fornecido pelo proprietário e uma faixa realmente listada para essa versão são tipos diferentes de evidência. Pergunte se o proprietário da fonte confirma o recurso e sua associação com a versão selecionada.

Registre idioma e função esperados, dispositivo, versão do app ou navegador, conectividade e seletor completo. Separe “não listada”, “listada, mas não pode ser selecionada” e “selecionada, mas nenhuma legenda visível no momento verificado”. Essas observações levam a perguntas diferentes; nenhuma, sozinha, comprova defeito no reprodutor. Preserve essas evidências antes de renomear arquivos, mover recursos, remover a fonte, limpar dados ou reinstalar.

## Entenda as diferenças de recursos

Faixas internas e externas podem fornecer legendas úteis. As opções de estilo dependem do formato e do renderizador; recursos baseados em texto e em imagens não precisam oferecer os mesmos controles. Texto gravado na imagem não pode ter o estilo alterado nem ser desligado de forma independente por um seletor de legendas. As [orientações do W3C sobre legendas](https://www.w3.org/WAI/media/av/captions/) também distinguem legendas que o público pode ocultar de legendas abertas que permanecem exibidas.

O [guia completo de gerenciamento de legendas](/blog/the-complete-guide-to-managing-subtitle-tracks/) explica verificações de idioma, função, sincronização, estado e dispositivo que se aplicam depois que uma faixa é encontrada.

Depois avalie o conteúdo da faixa: [legendas de acessibilidade e legendas de diálogo podem atender a necessidades de informação diferentes](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). Se as legendas estiverem presentes, mas difíceis de ler, diferencie [a legibilidade dos caracteres da facilidade de leitura](/blog/legibility-and-readability-two-different-viewing-problems/) em vez de culpar o método de armazenamento.

## Proteja os direitos das fontes e a privacidade

Use mídias e recursos de legendas que pertençam a você ou aos quais tenha autorização de acesso. O Norva é um reprodutor de mídia, sem conteúdo ou assinatura de TV incluídos; conectar um recurso não concede direitos sobre ele. Não envie mídias ou arquivos de legendas ao suporte sem a permissão necessária. Comece um relato com rótulos não sensíveis, passos e marcas de tempo; revise capturas para identificar endereços privados de fontes ou detalhes da conta antes de compartilhá-las.

## Erros comuns e limitações

Evite chamar texto gravado na imagem de faixa interna selecionável, prometer associação automática, supor compatibilidade com todos os formatos e editar arquivos de origem antes de preservar evidências.

O empacotamento pode continuar opaco quando a fonte oferece apenas uma opção reproduzível. Descreva o comportamento observado do seletor em vez de adivinhar o método de armazenamento.

## Perguntas frequentes

### É possível desligar legendas gravadas na imagem?

Não como uma faixa separada, pois o texto faz parte da imagem. Outra versão da mídia pode ser diferente, mas verifique a disponibilidade.

### Faixas separadas de legendas são sempre arquivos de texto?

Não. WebVTT e SubRip são exemplos baseados em texto, mas os recursos de legendas também podem ser baseados em imagens, como VobSub. “Separado” descreve onde o recurso é armazenado em relação à mídia, não como suas legendas são codificadas. Confira o formato real e a compatibilidade documentada.

### Uma faixa separada ausente significa que o reprodutor está quebrado?

Não. Verifique associação, item e versão, metadados da fonte, compatibilidade do formato e seletor antes de atribuir uma causa.

## Seu próximo passo

Se a fonte confirmar um recurso de legendas, mas o resultado continuar incerto, leve sua ficha de empacotamento preenchida ao [suporte do Norva](https://norva.tv/support). Informe o que observou e o que ainda não foi confirmado; deixe arquivos de mídia e detalhes privados de conexão fora do relato inicial.

## Fontes

- [MDN: contêineres de mídia e os codecs que contêm](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska: codecs de legendas, incluindo faixas baseadas em texto e imagens](https://www.matroska.org/technical/subtitles.html)
- [MDN: elemento HTML track e recursos externos](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C: rascunho da especificação WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: legendas, subtítulos e apresentação aberta ou fechada](https://www.w3.org/WAI/media/av/captions/)
- [Norva: recursos e requisitos de fontes compatíveis](https://norva.tv/#features)
