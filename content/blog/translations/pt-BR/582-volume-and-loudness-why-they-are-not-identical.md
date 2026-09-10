---
language: "pt-BR"
source_slug: "volume-and-loudness-why-they-are-not-identical"
source_sha256: "c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1"
title: "Volume e sonoridade: por que não são a mesma coisa"
seo_title: "Volume e sonoridade: entenda a diferença"
meta_description: "Um controle de volume não é um medidor de sonoridade. Compare ganho, sonoridade do programa, picos, faixa dinâmica e mudanças de saída sem adivinhar por um número."
excerpt: "O mesmo ajuste de volume pode produzir níveis de escuta diferentes. Separe ganho do sinal, sonoridade do programa, picos e caminho de saída com um cálculo completo e uma lista de comparação."
topic_cluster: "Conceitos de qualidade de áudio"
sources_heading: "Fontes"
next_step_heading: "Seu próximo passo"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Volume e sonoridade: por que não são a mesma coisa

> **Em resumo:** Um controle de volume altera o ganho em um ponto da cadeia de reprodução. Sonoridade é o quanto um som parece forte; as medições de sonoridade de programa estimam essa percepção a partir do sinal de áudio usando um método definido. Gravação, mixagem e processamento afetam esse sinal, enquanto o dispositivo de saída e o ambiente de escuta também afetam o que você ouve. A mesma posição do controle não garante o mesmo nível de escuta.

Se um filme soa muito mais alto que outro sem você tocar no controle remoto, o controle de volume não mudou necessariamente. Você pode estar ouvindo outra mixagem, faixa ou modo de processamento. Comece separando o ajuste do controle do áudio sobre o qual ele atua, em vez de tratar o número exibido como uma medição da experiência inteira.

## Mapeie cada estágio de ganho

Ganho significa multiplicar a amplitude do sinal em um estágio específico. Um ganho digital simples multiplica cada amostra por um valor; [a documentação do GainNode da MDN](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) mostra esse princípio. Um controle de volume voltado ao usuário não precisa expor esse multiplicador diretamente, e um ajuste de “50” não é um nível acústico universal nem garante metade da sonoridade percebida.

Registre os controles que realmente se aplicam: volume do reprodutor, nível de mídia do sistema operacional, nível da TV ou do receiver, controles dos fones e qualquer ajuste por faixa. Alguns controles podem estar vinculados, enquanto outros estágios podem ser fixos ou ignorados no caminho escolhido. Confira qual dispositivo produz o som antes de mudar um controle por vez.

## Entenda a sonoridade de programa

A recomendação [UIT-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) define algoritmos de medição de sonoridade de programa e de pico verdadeiro. Uma leitura de sonoridade de programa descreve um sinal de áudio segundo esse método; não mede diretamente a pressão sonora nos seus ouvidos. A recomendação também observa que a sonoridade medida estima a percepção com alguma incerteza entre ouvintes, materiais e condições de escuta.

Você pode encontrar **LUFS**, unidades de sonoridade referenciadas à escala completa digital. Uma leitura integrada abrange o programa ou trecho analisado, enquanto leituras de prazo mais curto descrevem uma janela menor. Informe o método, os canais, o intervalo analisado e se a medição ocorreu antes ou depois do processamento. Não apresente uma amostra curta de diálogo como resultado do filme inteiro.

A recomendação [EBU R 128](https://tech.ebu.ch/publications/r128) usa medições de sonoridade em um modelo de normalização para radiodifusão e distingue sonoridade do nível máximo de pico verdadeiro. Ela não é uma meta universal para todos os aplicativos de consumo e não transforma um controle de volume em medidor.

## Separe picos e faixa dinâmica

Picos de amostra descrevem os maiores valores absolutos das amostras gravadas; a medição de pico verdadeiro estima picos da forma de onda que podem ocorrer entre amostras. Nenhum desses números informa por quanto tempo o programa permanece alto. Um impacto breve e um diálogo contínuo podem atingir o mesmo pico e apresentar níveis gerais de escuta diferentes.

A faixa dinâmica diz respeito ao contraste entre material mais baixo e mais alto. Aumentar um ajuste de volume fixo eleva ambos; não aproxima seletivamente o diálogo baixo dos efeitos sonoros altos. O processamento de faixa dinâmica trata de outro problema. Por exemplo, [as orientações oficiais da Sony](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665) descrevem ajustes que alteram esse contraste em TVs e formatos de áudio específicos. Esse é um exemplo próprio de determinados dispositivos, não uma afirmação de que o Norva ofereça o mesmo ajuste.

## Contribuição original: ficha de ganho e sonoridade

Este é um **exemplo aritmético construído**, não uma mídia medida, um teste de escuta ou um ajuste de volume do Norva. Suponha dois sinais digitais com os picos de amostra abaixo e um ganho linear simples de 0.5. Os valores de pico sem unidade são frações da escala completa digital, não decibéis ou medições de pressão sonora. Nenhum outro processamento está incluído.

| Sinal construído | Maior valor absoluto de amostra de entrada | Multiplicador de ganho | Pico de amostra de saída calculado | Sonoridade do programa ou nível nos ouvidos |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Desconhecido a partir desses valores |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Desconhecido a partir desses valores |

O mesmo ganho deixa picos de saída diferentes porque os sinais de entrada diferem. O pico de amostra calculado de B é três vezes o de A, mas isso **não** significa que B soe três vezes mais alto. Não especificamos o restante de nenhum dos sinais, sua duração, o equipamento de saída ou as condições de escuta.

Igualar esses picos ainda não estabeleceria sonoridade de programa igual. Esta ficha para deliberadamente no que a aritmética comprova; ela não pode fornecer uma leitura em LUFS, uma classificação de qualidade ou um nível seguro para fones. Um multiplicador de 0.5 também não implica que o controle de um produto específico deva ficar em 50%.

## Compare faixas com o nível igualado

Se a pergunta é qual faixa está mais clara, evite deixar o nível como uma diferença sem controle. Use este pequeno procedimento com mídias que você tem autorização para reproduzir:

1. Identifique os rótulos e as funções das duas faixas. Uma faixa de comentários não é a mesma mixagem da trilha principal; use o [guia da lista de faixas de áudio](/blog/how-to-read-an-audio-track-list-before-playback/) se os rótulos não estiverem claros.
2. Escolha a mesma passagem nas duas versões. Registre os tempos de início e fim e inclua diálogo e um momento mais alto se esse for o problema investigado.
3. Mantenha fixos o dispositivo, o caminho de saída, a posição de escuta e o estado do processamento. Registre configurações desconhecidas em vez de supor que estejam desligadas.
4. Compare em um nível baixo e confortável. Reduza a faixa aparentemente mais alta para fazer uma correspondência aproximada do nível percebido; não aumente a mais baixa até que um efeito sonoro alto fique desconfortável. Se usar um medidor válido de sonoridade, registre separadamente seu método e escopo.
5. Alterne a ordem e registre uma observação específica, como “o diálogo continua difícil de acompanhar após igualar aproximadamente os níveis”. Não transforme uma preferência informal em uma afirmação de superioridade medida.

Uma correspondência feita de ouvido é aproximada, não um resultado de conformidade com normas. Se não for possível comparar a passagem com conforto, pare a comparação.

## Inclua a normalização

A normalização de sonoridade ajusta o ganho do programa ou da reprodução em direção a uma relação de sonoridade definida. Já a normalização de picos usa um critério de pico. Nenhum dos termos, por si só, significa aproximar diálogos baixos e efeitos sonoros altos dentro de um programa; isso exigiria uma mudança nos níveis relativos entre eles.

Metas, escopo de medição, tratamento dos picos e controles do usuário dependem da implementação. Consulte a documentação do aplicativo, da TV, do receiver ou dos fones para identificar normalização ou processamento dinâmico ativo. Este artigo não estabelece uma meta de normalização do Norva nem afirma que o Norva aplique EBU R 128.

## Inclua a sensibilidade da saída e o ambiente

Fones e alto-falantes podem produzir níveis acústicos diferentes a partir do mesmo sinal digital ou ajuste exibido. Encaixe, distância, reflexos do ambiente, ruído de fundo e processamento do dispositivo também afetam a escuta. Ao trocar de saída, você mudou a comparação, mesmo que o número na tela continue igual.

Se detalhes baixos forem mascarados pelo ruído do ambiente, investigue o local ou use uma [cobertura adequada de legendas](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) em vez de aumentar continuamente o volume. As [orientações da OMS para escuta segura](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening) destacam tanto o nível sonoro quanto a duração da exposição e recomendam pausas e reduzir a necessidade de aumentar o som em locais ruidosos. Conforto, sozinho, não é uma medição de exposição.

## Relate uma diferença de nível

Registre item e versão, rótulos exatos das faixas, tempos do trecho, controles de volume aplicáveis, estado do processamento, caminho e dispositivo de saída, condições do ambiente, método de comparação e resultado. Inclua medições válidas somente quando estiverem disponíveis, com seu escopo. “Sem medição de sonoridade; processamento da TV desconhecido” é mais útil que uma estimativa inventada de decibéis a partir do controle.

O [guia completo de qualidade de áudio](/blog/the-complete-guide-to-understanding-audio-quality/) mapeia o restante da cadeia.

## Erros comuns e limitações

Evite comparar números de controles entre dispositivos, tratar a igualdade de picos como igualdade de sonoridade ou usar uma leitura não validada de nível sonoro no celular como prova calibrada. Um microfone de celular perto de um alto-falante também não mede diretamente o som dentro dos fones. Uma escuta informal não é um teste formal de conformidade de sonoridade, uma avaliação auditiva ou prova de que um codec ou reprodutor é melhor.

## Confira o nível depois de mudar o caminho de saída

Ao trocar alto-falantes por fones ou por um receiver, confira o nível do destino antes de iniciar ou retomar a reprodução e comece baixo. Registre os estágios de ganho ativos em vez de copiar o número anterior. Se mudou o caminho e a mídia ao mesmo tempo, volte a uma passagem conhecida em nível baixo antes de decidir que a nova faixa causou a diferença.

## Perguntas frequentes

### Volume é o mesmo que sonoridade de programa?

Não. O controle de volume define o ganho em um estágio da reprodução. Uma leitura de sonoridade de programa caracteriza o sinal segundo um método de medição especificado; nenhum deles determina sozinho o nível acústico nos seus ouvidos.

### O mesmo valor do controle produz a mesma sonoridade em dois dispositivos?

Não. Estrutura de ganho, amplificador, sensibilidade da saída, alto-falantes ou fones, ambiente e processamento são diferentes.

### Normalização de picos é o mesmo que normalização de sonoridade?

Não. Medições de pico e de sonoridade descrevem propriedades diferentes e atendem a fluxos de trabalho diferentes.

## Seu próximo passo

Antes de comparar outra versão, registre a faixa e o caminho de saída realmente usados. Depois, [explore os recursos de reprodução do Norva](https://norva.tv/#features) sem presumir um modo de normalização não documentado. O Norva é um software de reprodução de mídia, sem conteúdo ou assinatura de TV incluídos; suas mídias devem vir de uma fonte compatível que você tenha autorização para usar.

## Fontes

- [MDN: ganho digital e GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [UIT-R BS.1770: sonoridade de programa e pico verdadeiro](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: normalização de sonoridade](https://tech.ebu.ch/publications/r128)
- [Sony: ajustes de faixa dinâmica e formatos aplicáveis](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [OMS: escuta segura, nível e duração da exposição](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Recursos do Norva](https://norva.tv/#features)
