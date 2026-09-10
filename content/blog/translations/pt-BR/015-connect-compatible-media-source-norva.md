---
language: "pt-BR"
source_slug: "connect-compatible-media-source-norva"
source_sha256: "8efa2f6c3971568d3ed277e8cdd99305ea755c0d2b3628b40aefe9cc0d3bf659"
title: "Como conectar uma fonte de mídia compatível à Norva"
seo_title: "Como conectar uma fonte de mídia compatível à Norva"
meta_description: "Prepare, conecte e verifique uma fonte de mídia compatível autorizada na Norva, protegendo as credenciais e mantendo claras as evidências de diagnóstico."
excerpt: "Conecte uma fonte compatível autorizada pelo gerenciamento atual da Norva, proteja as configurações, espere o catálogo carregar e verifique um item conhecido antes de adicionar outras fontes."
topic_cluster: "Configuração e conta da Norva"
sources_heading: "Fontes"
next_step_heading: "Seu próximo passo"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Como conectar uma fonte de mídia compatível à Norva

> **Em poucas palavras:** Na web, abra o menu da conta, depois Settings (Configurações) e TV service (Serviço de TV). Escolha M3U link para uma URL completa de lista de reprodução ou Xtream login para dados compatíveis do provedor. Conecte apenas uma fonte própria ou que tenha autorização para usar, mantenha suas credenciais privadas e verifique um item conhecido antes de adicionar outras fontes. A Norva é um reprodutor; não fornece a fonte nem a mídia.

**O que foi verificado:** em 10 de setembro de 2026, usamos uma conta de teste conectada ao aplicativo web em produção para inspecionar os formulários e enviar um acesso Xtream de teste fornecido pelo usuário. Uma verificação posterior confirmou **Ready** (Pronta), filtragem de idioma por fonte e uma pesquisa que abriu um título com doze versões. As capturas são diretas e inalteradas, sem dados privados de conexão. Não houve teste de importação M3U ou passo a passo nativo em celular/TV; a reprodução bem-sucedida continua sendo uma verificação separada.

## Antes de começar

Confirme as quatro condições:

- Você controla a conta Norva.
- A fonte é sua ou você tem permissão para usá-la.
- Os termos da fonte permitem a conexão pretendida.
- A Norva atualmente aceita o método de conexão da fonte.

Obtenha os dados oficiais diretamente do proprietário da fonte ou da página da conta. Não use configurações encaminhadas sem origem clara.

Leia [O que preparar antes de adicionar sua fonte de mídia](/blog/prepare-media-source-setup/) para uma ficha de preparação.

## Passo 1: usar um ponto de acesso oficial da Norva

Abra a Norva pelo site oficial ou aplicativo instalado. Confira o endereço ou a identidade do aplicativo antes de inserir informações de conta ou fonte.

Entre na conta e no perfil pretendidos. Em um dispositivo compartilhado ou emprestado, não salve credenciais privadas, a menos que o dispositivo seja confiável e os termos da fonte permitam.

**Resultado observável:** a conta abre normalmente e você consegue acessar os controles de gerenciamento de fontes.

## Passo 2: localizar o gerenciamento de fontes

Na web, abra o menu da conta, escolha **Settings** (Configurações) e a aba **TV Service** (Serviço de TV). Esses textos em inglês são traduzidos quando outro idioma de interface é selecionado. Se o aplicativo abrir no Início, siga esse menu; não presuma que um link salvo de configurações abriu o painel correto.

Escolha **Add playlist** (Adicionar lista de reprodução) ou **Add provider** (Adicionar provedor) para abrir **Add TV service** (Adicionar serviço de TV). Nessa janela, as abas **M3U link** (Link M3U) e **Xtream login** (Login Xtream) adaptam o formulário às informações realmente recebidas.

Antes de digitar, confira se já existe outra fonte. Adicionar a mesma duas vezes pode criar categorias aparentemente duplicadas e confundir o diagnóstico posterior.

**Resultado observável:** um formulário de adição ou uma opção de conexão aceita está visível.

## Passo 3: selecionar um método compatível documentado

Faça esta distinção antes de colar qualquer coisa:

| O que você tem | Opção na Norva | Primeira verificação |
| --- | --- | --- |
| Um endereço completo de lista de reprodução | M3U link | A URL completa vem da fonte autorizada, não de uma página de download de aplicativo. |
| Endereço de servidor e credenciais compatíveis, ou um link Xtream completo | Xtream login | O proprietário confirma esse formato e sua permissão para conectá-lo. |
| Apenas usuário e senha de outro aplicativo | My provider only gave me an app login | Peça um formato de fonte compatível; não adivinhe um endereço de servidor. |

![Formulário M3U da Norva com o campo Playlist URL, nome de serviço opcional e botão Add.](/assets/blog/source-m3u-live-web-20260910.jpg "Formulário M3U web em produção, 10 de setembro de 2026. Os campos estão vazios; esta imagem não comprova uma importação M3U concluída.")

Para **M3U link**, insira o endereço completo em **Playlist URL**. O formulário descreve um endereço `http` ou `https` e apresenta `.m3u`, `.m3u8` e `get.php` como indícios comuns, não como provas de permissão ou compatibilidade. **Service name** (Nome do serviço) é opcional: um apelido neutro ajuda a distinguir fontes sem expor credenciais.

![Formulário Xtream da Norva mostrando o primeiro passo de conexão e opções de link completo ou dados manuais do servidor.](/assets/blog/source-xtream-live-web-20260910.jpg "Etapa inicial de Xtream em produção, capturada antes de inserir o acesso de teste. Continue leva à escolha do período de acesso, não diretamente a uma importação concluída.")

Para **Xtream login**, o fluxo atual começa em **Connect provider** (Conectar provedor). Use **Provider URL or complete Xtream link** (URL do provedor ou link Xtream completo), ou expanda **Enter server login manually** (Inserir manualmente o login do servidor) se esse foi o formato recebido. Revise cada etapa seguinte na tela, sem tratar **Continue** (Continuar) como confirmação de que a fonte já está conectada.

Faça cada valor solicitado corresponder às informações oficiais da fonte. Evite adicionar espaços, mudar maiúsculas e minúsculas ou “corrigir” um endereço, salvo orientação da documentação da fonte.

A política de privacidade da Norva diz que as configurações de fonte são usadas para conectar o serviço à fonte em nome do usuário. Revise a política antes de enviar configurações sensíveis.

### Se você só tem um login de aplicativo

Selecione **My provider only gave me an app login** (Meu provedor só me forneceu um login de aplicativo). O painel explica por que as credenciais de outro aplicativo não podem simplesmente ser importadas como fonte da Norva e oferece uma mensagem solicitando um link M3U compatível ou dados de servidor Xtream. Contate o proprietário pelo canal oficial; não cole senhas em publicações públicas de suporte.

![Painel de ajuda da Norva explicando que um login de aplicativo precisa de dados compatíveis de fonte antes de ser conectado.](/assets/blog/source-app-login-help-live-web-20260910.jpg "Orientação web em produção para credenciais limitadas a um aplicativo; nenhuma conta de provedor ou link privado é mostrado.")

## Passo 4: inserir as configurações em privado

Use copiar e colar quando for prático e confira o começo e o fim de cada valor não secreto. Mantenha senhas, links privados, nomes de usuário e tokens fora de:

- capturas de tela;
- gravações de tela;
- conversas públicas de suporte;
- notas de análise;
- documentos compartilhados;
- ferramentas de histórico da área de transferência em que você não confia.

Se uma TV dificultar a entrada segura, use o fluxo documentado de pareamento ou conta em vez de expor as credenciais.

**Resultado observável:** os campos obrigatórios estão completos sem segredo exposto.

## Passo 5: salvar uma vez e permitir o primeiro carregamento

No formulário M3U, use **Add** (Adicionar) uma vez após conferir a URL. Para Xtream, **Continue** abre **Provider access period** (Período de acesso ao provedor). As opções visíveis são **Duration bought** (Duração comprada), **Start and end dates** (Datas de início e término) e **Add this later** (Adicionar depois). Registre apenas condições que você realmente conhece; isso é separado do seu plano Norva.

No teste, não haviam sido fornecidas datas de acesso, então selecionamos **Add this later**, depois **Continue**, revisamos **Add later / No new dates** (Adicionar depois / Nenhuma nova data) e usamos **Finish without dates** (Concluir sem datas) uma vez. O contador mudou de cinco passos para três nesse caminho mais curto. Não invente datas apenas para terminar a configuração.

![Escolha de período de acesso da Norva com Add this later selecionado e o contador mostrando o passo dois de três.](/assets/blog/source-access-period-live-web-20260910.jpg "Caminho real do teste: continuar sem registrar um período de acesso. Nenhuma compra, renovação ou lembrete foi configurado neste passo a passo.")

A Norva abriu **Preparing your catalog** (Preparando seu catálogo), exibiu **Importing** (Importando) e marcou a verificação de conexão como **Done** (Concluída). As contagens de títulos detectados começaram a crescer enquanto a preparação seguia em andamento. São observações separadas: credenciais aceitas não significam que todos os títulos já estejam prontos para reprodução.

![Painel de preparação de catálogo da Norva para uma fonte de teste com nome neutro, mostrando Importing e etapas separadas de conexão e catálogo.](/assets/blog/source-importing-live-web-20260910.jpg "Um estado intermediário real de importação, não um catálogo concluído. Contagens e progresso refletem essa fonte de teste no momento da captura; não prometem velocidade ou capacidade.")

O reprodutor pode precisar de tempo para buscar categorias, informações do catálogo ou dados do guia. Não envie nem remova a fonte repetidamente durante um carregamento normal.

Não é possível prometer um tempo universal de carregamento. Tamanho da fonte, conexão e dispositivo podem afetar o primeiro resultado.

**Resultado observável:** a Norva aceita as configurações ou apresenta um erro específico que pode ser registrado.

## Passo 6: verificar um item conhecido

Quando a biblioteca alcançar um estado estável:

1. confira a seção principal esperada;
2. abra uma categoria esperada;
3. pesquise um item conhecido;
4. verifique título, ano ou identidade do episódio, quando disponíveis;
5. examine informações de idioma ou legendas fornecidas pela fonte;
6. não presuma que metadados opcionais ausentes significam falha de toda a conexão.

Por exemplo, escolha um título cuja presença o proprietário confirme. Se a categoria carregar, mas o título não aparecer, anote esse resultado específico. Se aparecer, mas não reproduzir, o carregamento do catálogo funcionou; a reprodução ainda precisa de outra verificação. Nenhuma dessas observações comprova que toda a fonte funciona ou está com defeito.

**Observado no acompanhamento:** a mesma fonte estava marcada **Ready** em **Settings → TV Service**. Abrimos **Movies**, selecionamos **Blog walkthrough test** em **Source** e usamos **Audio language → Albanian** (Idioma do áudio → Albanês). Os cartões retornados exibiam **Albanian**. Após **Clear all** (Limpar tudo), pesquisar um título conhecido abriu seus detalhes com doze versões, ano e sinopse. Não foi necessário duplicar a fonte nem reenviá-la manualmente.

![Filtros de filmes da Norva com a fonte de teste e áudio albanês selecionados, ao lado de controles separados de categoria e legendas.](/assets/blog/catalog-audio-filter-live-web-20260910.jpg "Acompanhamento após a fonte alcançar Ready, 10 de setembro de 2026. A contagem é uma fotografia da fonte de teste deste usuário, não uma promessa sobre conteúdo ou capacidade de catálogo da Norva.")

### Não confunda um rótulo de fonte com uma faixa de áudio verificada

O filtro de áudio atual reúne rótulos reconhecidos de idioma e informações de faixas detectadas em arquivos no mesmo controle de navegação. Isso torna o rótulo útil para encontrar uma versão, mas não transforma país, nome de coleção ou prefixo de título em prova das faixas dentro do arquivo. Quando houver informações reais de faixas, use-as para escolher a versão. Uma indicação regional como **Nordic languages** (Idiomas nórdicos) não identifica um único idioma falado.

Verifique cada camada separadamente:

| Resultado visível | O que estabelece | O que ainda precisa ser verificado |
|---|---|---|
| A fonte mostra Ready | A Norva informa que o catálogo está pronto | Metadados e compatibilidade de reprodução de cada item |
| Um título aparece na fonte selecionada | O item pode ser encontrado no catálogo atual | Outros itens e a versão selecionada |
| Uma categoria da fonte aparece | Um rótulo de agrupamento foi recebido | Se há um gênero de filme verificado |
| Um filtro de idioma retorna uma versão | As informações disponíveis de idioma corresponderam ao filtro | Faixas realmente selecionáveis naquele arquivo e reprodutor |
| Language unidentified (Idioma não identificado) | Nenhum resultado utilizável de idioma do áudio está sendo exibido | Disponibilidade real de faixas e estado da análise |
| A página do reprodutor abre | A navegação ao reprodutor funcionou | Quadros de vídeo, avanço da reprodução e áudio utilizável |

O acompanhamento mais recente testou a navegação do catálogo, não a reprodução de vídeo. Uma tentativa anterior abriu o reprodutor sem confirmar o avanço do vídeo antes de retornar com **Back** (Voltar). Portanto, não apresentamos Ready, indicações de idioma ou imagens como prova de uma sessão de exibição bem-sucedida.

## Passo 7: testar uma ação da conta

Adicione um favorito ou salve um pequeno progresso de reprodução. Volte à biblioteca e confirme o estado visível.

Isso testa a diferença entre dados da fonte e contexto da conta. Não comprova a compatibilidade de todos os itens, formatos ou dispositivos.

O favorito de teste estava presente quando o catálogo foi aberto mais tarde. Depois, o removemos e recarregamos para confirmar o estado original. O retorno imediato dos detalhes não havia mostrado a atualização, portanto a observação valida a persistência desse item, não resposta instantânea ou sincronização entre dispositivos.

O plano mais amplo para a primeira sessão está em [Primeiros passos com a Norva](/blog/norva-getting-started/).

## Se a conexão for parcial

Um resultado parcial informa mais do que “não funciona”. Registre qual camada funcionou:

- As configurações foram aceitas?
- Alguma categoria apareceu?
- Os títulos carregaram, mas as imagens falharam?
- As informações do catálogo carregaram, mas os dados do guia ficaram vazios?
- Um item conhecido abriu?
- A reprodução falhou apenas em um dispositivo?

Mude uma variável por vez. Confira os dados da fonte antes de reinstalar o aplicativo. Guarde uma captura do erro com os dados sensíveis ocultos somente depois de confirmar que não há credenciais nela.

## Segurança e limpeza da conta

Após uma configuração bem-sucedida:

- revise dispositivos confiáveis;
- remova os que você não controla mais;
- mantenha privado o registro da fonte;
- anote onde revisar permissão e termos;
- desconecte a fonte se a autorização terminar;
- altere credenciais expostas pelo processo oficial do proprietário.

As páginas de privacidade e exclusão de conta da Norva descrevem os controles disponíveis para os dados da conta Norva.

## Limitações

Uma conexão bem-sucedida não significa que todos os campos da fonte estejam completos, que todos os formatos funcionem em todos os dispositivos ou que haja acesso offline. Idiomas e legendas dependem da fonte e da mídia. O uso offline depende do dispositivo, da fonte e dos direitos associados.

A evidência cobre controles web atuais, um envio Xtream, um estado Ready posterior, filtragem de áudio por fonte, pesquisa/detalhes de um título e persistência/remoção de um favorito após reabrir. Não estabelece que todos os registros estejam completos ou possam ser reproduzidos. Reprodução bem-sucedida e resposta imediata de favoritos não foram validadas. Este teste web não validou importação M3U, fluxo nativo de celular/TV, uso offline ou continuidade entre dispositivos.

## Perguntas frequentes

### Por que adicionar só uma fonte primeiro?

Ela fornece uma base clara. Se surgir uma categoria, título ou erro, você sabe qual fonte o produziu.

### Devo compartilhar uma captura da conexão com o suporte?

Somente após ocultar todas as senhas, links privados, usuários, tokens e identificadores pessoais. Use o canal oficial de suporte da Norva.

### E se a Norva aceitar as configurações, mas nada aparecer?

Espere o carregamento inicial normal e verifique os dados e a conexão. Registre se o resultado está totalmente vazio ou parcialmente carregado antes de contatar o suporte.

## Seu próximo passo

[Abrir a Norva e conectar sua fonte](https://norva.tv/app)

Após entrar, use o menu da conta, **Settings** e depois **TV Service**, como mostrado acima.

## Fontes

- [Como a Norva funciona](https://norva.tv/#how-it-works)
- [Termos de Uso da Norva](https://norva.tv/terms)
- [Política de Privacidade da Norva](https://norva.tv/privacy)
- [Suporte da Norva](https://norva.tv/support)
