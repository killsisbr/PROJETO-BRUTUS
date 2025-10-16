// 🔹 Checa se o cliente já informou nome, endereço e ponto da carne
function checarDadosObrigatorios(idAtual, carrinhoAtual) {
    const info = obterInformacoesCliente(idAtual) || {};
    const nome = info.nome || carrinhoAtual.nome;
    const endereco = info.endereco || carrinhoAtual.endereco;
    // ponto da carne pode estar em carrinhoAtual ou em algum item do carrinho
    let pontoCarne = carrinhoAtual.pontoCarne;
    if (!pontoCarne && Array.isArray(carrinhoAtual.carrinho)) {
        for (const item of carrinhoAtual.carrinho) {
            if (item.preparo && /mal|ao ponto|bem/i.test(item.preparo)) {
                pontoCarne = item.preparo;
                break;
            }
        }
    }
    return {
        nome: !!nome,
        endereco: !!endereco,
        pontoCarne: !!pontoCarne
    };
}
const carrinhoService = require('../services/carrinhoService');
const clientService = require('../services/clienteService'); // Corrigido aqui
const cardapioService = require('../services/cardapioService');
const { normalizarTexto, encontrarMelhorMatch, separarMensagem: separarMensagemNormalizada, limparDescricao } = require('../utils/normalizarTexto');
const atualizarEstadoDoCarrinho = carrinhoService.atualizarEstadoDoCarrinho;
const carrinhoView = carrinhoService.carrinhoView;
const mensagens = require('../utils/mensagens');
const numerosMap = require('../utils/mapaNumeros');
const mapaNumeros = numerosMap.mapa;
const resp = mensagens.mensagem;
const stats = carrinhoService.stats;
const obterInformacoesCliente = clientService.obterInformacoesCliente;
const valorTotal = carrinhoService.valorTotal;

// Cache para mapeamentos do banco de dados
let mappingsCache = null;
let lastMappingsUpdate = 0;
const CACHE_DURATION = 30000; // 30 segundos

// Função para obter mapeamentos do banco de dados
async function getMapeamentosCompletos() {
    const now = Date.now();
    if (!mappingsCache || (now - lastMappingsUpdate) > CACHE_DURATION) {
        try {
            await cardapioService.init();
            const dbMappings = cardapioService.getMappings();
            // Usa apenas os mapeamentos do banco de dados
            mappingsCache = dbMappings;
            lastMappingsUpdate = now;
            console.log('[analisePalavras] Mapeamentos atualizados:', Object.keys(dbMappings).length, 'do banco de dados');
        } catch (e) {
            console.error('[analisePalavras] Erro ao carregar mapeamentos do banco:', e);
            mappingsCache = {}; // fallback para objeto vazio
        }
    }
    return mappingsCache;
}

// 🔹 Limpa e quebra mensagem em palavras
function separarMensagem(mensagem) {
    return mensagem
        .toLowerCase()
        .replace(/\bmarmita\b/g, '')
        .replace(/[.,]/g, '')
        .split(/\s+/);
}

// 🔹 Remove frases de bebida da descrição do lanche
function removerFrasesDeBebidas(descricao, bebidasMap) {
    let novaDescricao = descricao.toLowerCase();
    for (const frase of Object.keys(bebidasMap)) {
        const regex = new RegExp(`\\b${frase}\\b`, 'gi');
        novaDescricao = novaDescricao.replace(regex, '');
    }
    return novaDescricao.replace(/\s+/g, ' ').trim();
}

// 🔹 Limpa texto auxiliar
function limparTexto(texto) {
    return texto.toLowerCase().replace(/[.,!?]/g, '').trim();
}

// 🔹 Lógica para adicionar bebidas
async function processarBebidas(palavras, idAtual, carrinhoAtual, palavrasProcessadas = new Set()) {
    const mapeamentos = await getMapeamentosCompletos();
    
    for (let i = 0; i < palavras.length; i++) {
        const anterior = palavras[i - 1] || '';
        const atual = palavras[i];
        const proxima = palavras[i + 1] || '';
        const depois = palavras[i + 2] || '';
        const terceira = palavras[i + 3] || '';
        let quantidade = 1;

        const combinacoes = [
            `${atual} ${proxima} ${depois} ${terceira}`,
            `${atual} ${proxima} ${depois}`,
            `${atual} ${proxima}`,
            `${atual}`
        ];

        // Encontrar todas as combinações válidas e escolher a mais específica (mais longa)
        let melhorMatch = null;
        let melhorTamanho = 0;
        
        for (const combo of combinacoes) {
            const chave = normalizarTexto(combo);

            if (mapeamentos[chave]) {
                // Verificar se o item é uma bebida
                const itemId = mapeamentos[chave];
                const items = cardapioService.getItems();
                const item = items.find(i => i.id === itemId);
                
                if (item && item.tipo === 'Bebida') {
                    // Priorizar combinações mais longas (mais específicas)
                    const tamanhoCombo = combo.trim().split(' ').length;
                    if (tamanhoCombo > melhorTamanho) {
                        melhorMatch = {
                            combo: combo,
                            chave: chave,
                            itemId: itemId,
                            tamanho: tamanhoCombo
                        };
                        melhorTamanho = tamanhoCombo;
                    }
                }
            }
        }
        
        // Se encontrou um match, processar o melhor (mais específico)
        if (melhorMatch) {
            if (mapaNumeros[anterior]) {
                quantidade = mapaNumeros[anterior];
            } else if (!isNaN(anterior)) {
                quantidade = parseInt(anterior);
            }

            if (quantidade <= 0 || isNaN(quantidade)) quantidade = 1;

            await carrinhoService.adicionarItemAoCarrinho(idAtual, melhorMatch.itemId, quantidade, melhorMatch.chave, 'Bebida');
            carrinhoAtual.aprt = true;
            carrinhoAtual.alertAdicionado = false;

            console.log(`✔ Bebida adicionada: ${melhorMatch.chave}, quantidade: ${quantidade}`);
            
            // Marcar as palavras como processadas
            const palavrasCombo = melhorMatch.combo.split(' ');
            for (let j = 0; j < palavrasCombo.length; j++) {
                palavrasProcessadas.add(i + j);
            }
            
            i += melhorMatch.combo.split(' ').length - 1;
        }
    }
}

// 🔹 Lógica para adicionar lanches
async function processarLanches(palavras, idAtual, carrinhoAtual, palavrasProcessadas = new Set()) {
    const lanche = await getMapeamentosCompletos();

    const modificadores = ['com', 'sem', 'tira', 'tirar', 'remover', 'mais', 'mas', 'bastante', 'menos'];
    const ingredientesSimples = ['bacon','baicon','baco','bacom','baicom','becon', 'biacon','becon', 'cheddar', 'catupiry', 'salada', 'tomate', 'queijo', 'ovo', 'frango', 'calabresa', 'hamburguer', 'onion', 'batata', 'pão', 'hambúrguer'];
    const palavrasIgnoradas = ['e', 'de', 'brutus', 'brutus'];

    let lanches = [];
    let lancheAtual = null;

    // Verificar se o pedido é especificamente sobre batata
    let pedidoBatata = false;
    for (let i = 0; i < palavras.length; i++) {
        const palavra = palavras[i].toLowerCase().replace(/[.,]/g, '');
        if (palavra.includes('batata') || palavra.includes('palito') || palavra.includes('rustica') || palavra.includes('rústica')) {
            pedidoBatata = true;
            break;
        }
    }

    for (let i = 0; i < palavras.length; i++) {
        // Pular palavras já processadas como bebidas
        if (palavrasProcessadas.has(i)) {
            continue;
        }
        const atual = palavras[i].toLowerCase().replace(/[.,]/g, '');
        const anterior = i > 0 ? palavras[i - 1].toLowerCase().replace(/[.,]/g, '') : '';
        const proxima = palavras[i + 1] ? palavras[i + 1].toLowerCase().replace(/[.,]/g, '') : '';
        const depois = palavras[i + 2] ? palavras[i + 2].toLowerCase().replace(/[.,]/g, '') : '';
        const terceira = palavras[i + 3] ? palavras[i + 3].toLowerCase().replace(/[.,]/g, '') : '';
        let quantidade = 1;

        // Verificar se é "com tudo" no contexto de batata
        if (atual === 'com' && proxima === 'tudo') {
            // Verificar se temos uma batata no pedido
            let temBatata = false;
            for (let j = 0; j < palavras.length; j++) {
                if (j !== i && j !== i + 1) { // Não contar as palavras "com" e "tudo"
                    const palavra = palavras[j].toLowerCase().replace(/[.,]/g, '');
                    if (palavra.includes('batata') || palavra.includes('palito') || palavra.includes('rustica') || palavra.includes('rústica')) {
                        temBatata = true;
                        break;
                    }
                }
            }
            
            if (temBatata) {
                // Ignorar "tudo" como item separado, vamos tratá-lo como "com tudo"
                continue;
            }
        }

        if (mapaNumeros[anterior]) {
            quantidade = mapaNumeros[anterior];
        } else if (!isNaN(parseInt(anterior))) {
            quantidade = parseInt(anterior);
        }

        const combinacoes = [];

        if (terceira) combinacoes.push(`${atual} ${proxima} ${depois} ${terceira}`);
        if (depois) combinacoes.push(`${atual} ${proxima} ${depois}`);
        if (proxima) combinacoes.push(`${atual} ${proxima}`);
        combinacoes.push(atual);

        let encontrado = false;
        let melhorLancheMatch = null;
        let melhorLancheTamanho = 0;

        for (const combo of combinacoes) {
            const chave = normalizarTexto(combo);
            const palavrasDoCombo = combo.trim().split(' ');
            const ehIngredienteSimples = ingredientesSimples.includes(chave);
            const anteriorACombo = i > 0 ? palavras[i - 1].toLowerCase().replace(/[.,]/g, '') : '';
            const ehModificadorComIngrediente = (
                palavrasDoCombo.length === 1 &&
                modificadores.includes(anteriorACombo) &&
                ehIngredienteSimples
            );
            const ignorarIngredienteRepetido = (
                lancheAtual &&
                ehIngredienteSimples &&
                modificadores.includes(anteriorACombo)
            );

            // Verificar se é "tudo" e estamos em um contexto de "com tudo" para batata
            if (chave === 'tudo') {
                // Verificar se a palavra anterior é "com" e se temos batata no pedido
                let contextoComTudo = false;
                if (anteriorACombo === 'com') {
                    // Verificar se temos uma batata no pedido
                    for (let j = 0; j < palavras.length; j++) {
                        if (j !== i && j !== i - 1) { // Não contar as palavras "com" e "tudo"
                            const palavra = palavras[j].toLowerCase().replace(/[.,]/g, '');
                            if (palavra.includes('batata') || palavra.includes('palito') || palavra.includes('rustica') || palavra.includes('rústica')) {
                                contextoComTudo = true;
                                break;
                            }
                        }
                    }
                }
                
                if (contextoComTudo) {
                    // Ignorar "tudo" neste contexto
                    continue;
                }
            }

            if (lanche[chave] && !ehModificadorComIngrediente && !ignorarIngredienteRepetido) {
                // Priorizar combinações mais longas (mais específicas)
                const tamanhoCombo = combo.trim().split(' ').length;
                if (tamanhoCombo > melhorLancheTamanho) {
                    melhorLancheMatch = {
                        combo: combo,
                        chave: chave,
                        itemId: lanche[chave],
                        tamanho: tamanhoCombo
                    };
                    melhorLancheTamanho = tamanhoCombo;
                }
            }
        }
        
        // Se encontrou um match, processar o melhor (mais específico)
        if (melhorLancheMatch) {
            // Verificar se é um pedido de batata
            const isBatata = melhorLancheMatch.chave.includes('batata') || 
                             melhorLancheMatch.chave.includes('palito') || 
                             melhorLancheMatch.chave.includes('rustica') || 
                             melhorLancheMatch.chave.includes('rústica');
            
            if (lancheAtual) lanches.push(lancheAtual);

            lancheAtual = {
                tamanho: melhorLancheMatch.chave,
                idSelect: melhorLancheMatch.itemId,
                quantidade,
                descricao: [],
                // Se for batata e for o foco do pedido, manter o tipo original
                isBatata: isBatata && pedidoBatata
            };

            i += melhorLancheMatch.combo.split(' ').length - 1;
            encontrado = true;
        }

        if (!encontrado && lancheAtual) {
            const eNumero = !isNaN(parseInt(atual)) || mapaNumeros[atual];

            if (!eNumero && !palavrasIgnoradas.includes(atual)) {
                // Verifica se é um adicional que deve ser processado separadamente
                const palavrasAdicional = ['adicional', 'adicionais', 'mais', 'com'];
                if (palavrasAdicional.includes(atual) && proxima) {
                    // Processa adicionais como itens separados
                    let ingredienteEncontrado = false;
                    
                    // Verifica se o próximo ingrediente tem ID no mapa de lanches
                    const ingredientesComId = {
                        'bacon': 'adicional bacon',
                        'queijo': 'adicional queijo', 
                        'catupiry': 'adicional catupiry',
                        'cheddar': 'adicional cheddar',
                        'batata': 'adicional batata',
                        'palito': 'adicional batata palito',
                        'rustica': 'adicional batata rústica',
                        'rústica': 'adicional batata rústica'
                    };
                    
                    if (ingredientesComId[proxima] && lanche[ingredientesComId[proxima]]) {
                        // Adiciona como item separado no carrinho
                        await carrinhoService.adicionarItemAoCarrinho(idAtual, lanche[ingredientesComId[proxima]], 1, ingredientesComId[proxima], 'Adicional');
                        i++; // pula o ingrediente já processado
                        ingredienteEncontrado = true;
                    }
                    
                    if (!ingredienteEncontrado) {
                        // Se não encontrou ID específico, adiciona à descrição normalmente
                        if (modificadores.includes(atual) && ingredientesSimples.includes(proxima)) {
                            lancheAtual.descricao.push(`${atual} ${proxima}`);
                            i++; // pula o ingrediente
                        } else {
                            lancheAtual.descricao.push(atual);
                        }
                    }
                } else {
                    // Verifica se o ingrediente atual tem um adicional correspondente no mapa
                    const ingredientesComId = {
                        'bacon': 'adicional bacon',
                        'queijo': 'adicional queijo', 
                        'catupiry': 'adicional catupiry',
                        'cheddar': 'adicional cheddar',
                        'batata': 'adicional batata',
                        'palito': 'adicional batata palito',
                        'rustica': 'adicional batata rústica',
                        'rústica': 'adicional batata rústica'
                    };
                    
                    // Se o anterior foi "com", "mais", "e" e o atual é um ingrediente com ID, adiciona como adicional
                    if (['com', 'mais', 'e'].includes(anterior) && ingredientesComId[atual] && lanche[ingredientesComId[atual]]) {
                        await carrinhoService.adicionarItemAoCarrinho(idAtual, lanche[ingredientesComId[atual]], 1, ingredientesComId[atual], 'Adicional');
                    } 
                    // Verificar se é "com tudo" para batata
                    else if (anterior === 'com' && atual === 'tudo') {
                        // Verificar se temos uma batata no pedido
                        let temBatata = false;
                        for (let j = 0; j < palavras.length; j++) {
                            if (j !== i && j !== i - 1) { // Não contar as palavras "com" e "tudo"
                                const palavra = palavras[j].toLowerCase().replace(/[.,]/g, '');
                                if (palavra.includes('batata') || palavra.includes('palito') || palavra.includes('rustica') || palavra.includes('rústica')) {
                                    temBatata = true;
                                    break;
                                }
                            }
                        }
                        
                        if (temBatata) {
                            // Adicionar adicionais comuns para batata
                            const adicionaisComuns = ['bacon', 'queijo', 'cheddar', 'catupiry'];
                            for (const adicional of adicionaisComuns) {
                                const chaveAdicional = `adicional ${adicional}`;
                                if (lanche[chaveAdicional]) {
                                    await carrinhoService.adicionarItemAoCarrinho(idAtual, lanche[chaveAdicional], 1, chaveAdicional, 'Adicional');
                                }
                            }
                        } else {
                            lancheAtual.descricao.push(atual);
                        }
                    }
                    // Verifica se o atual é um ingrediente que pode ser adicional, mesmo sem palavra anterior específica
                    else if (ingredientesComId[atual] && lanche[ingredientesComId[atual]]) {
                        // Verifica se há contexto de adicional nas palavras anteriores (busca nas últimas 3 palavras)
                        let temContextoAdicional = false;
                        for (let j = Math.max(0, i - 3); j < i; j++) {
                            const palavraAnterior = palavras[j] ? palavras[j].toLowerCase().replace(/[.,]/g, '') : '';
                            if (['adicional', 'adicionais', 'mais', 'com', 'e'].includes(palavraAnterior)) {
                                temContextoAdicional = true;
                                break;
                            }
                        }
                        
                        if (temContextoAdicional) {
                            await carrinhoService.adicionarItemAoCarrinho(idAtual, lanche[ingredientesComId[atual]], 1, ingredientesComId[atual], 'Adicional');
                        } else {
                            lancheAtual.descricao.push(atual);
                        }
                    }
                    else if (modificadores.includes(atual) && ingredientesSimples.includes(proxima)) {
                        // Se atual for "sem" e a próxima "bacon", guarda como "sem bacon"
                        lancheAtual.descricao.push(`${atual} ${proxima}`);
                        i++; // pula o ingrediente
                    } else {
                        lancheAtual.descricao.push(atual);
                    }
                }
            }
        }
    }

    if (lancheAtual) {
        lanches.push(lancheAtual);
    }

    for (const m of lanches) {
        // Usar função centralizada de limpeza de descrição (substitui 26 replace() por regex otimizada)
        let descricao = limparDescricao(m.descricao.join(' '));

        // descricao = removerFrasesDeBebidas(descricao, bebidas).trim(); // Removido - bebidas não definida

        // Se for uma batata e for o foco do pedido, usar o tipo original do item
        let tipoItem = 'Lanche';
        if (m.isBatata) {
            // Obter o tipo original do item
            const items = cardapioService.getItems();
            const item = items.find(i => i.id === m.idSelect);
            tipoItem = item && item.tipo ? item.tipo : 'Acompanhamento';
        }

        await carrinhoService.adicionarItemAoCarrinho(idAtual, m.idSelect, m.quantidade, descricao, tipoItem);

        carrinhoAtual.alertAdicionado = false;
        carrinhoAtual.aprt = true;
    }

    return lanches;
}



// 🔹 Gatilhos de comandos: cardápio, entrega, retirada, pix
function getCardapio(palavras, carrinhoAtual, msg, idAtual, client, MessageMedia) {
    if (palavras.some(p => ['cardapio', 'cardápio', 'cardápio?', 'cardapio?'].includes(p.toLowerCase()))) {
        // cooldown para prevenir múltiplos envios próximos
        try {
            const id = idAtual;
            if (!carrinhoAtual) carrinhoAtual = {};
            const last = carrinhoAtual.lastCardapioSent || 0;
            const now = Date.now();
            const COOLDOWN = 3000;
            if (now - last < COOLDOWN) {
                console.log('[getCardapio] ignorando envio por cooldown', id);
                return;
            }
            carrinhoAtual.lastCardapioSent = now;
        } catch(e) {}
        const cardapioMedia = MessageMedia.fromFilePath('./cardapio.jpg');
        const cardapioMedia2 = MessageMedia.fromFilePath('./cardapio2.jpg');
        // Send the image with a caption
        client.sendMessage(msg.from, cardapioMedia, {
            caption: `Olá! Aqui está o nosso cardápio. Para pedir, basta me dizer o que você gostaria! 🍔`
        });
        client.sendMessage(msg.from, cardapioMedia2);
    }

}

function getPix(palavras, carrinhoAtual, msg, idAtual) {
    if (palavras.some(p => ['pix', 'pix!', 'chave.', 'chave?', 'pix?', 'picks'].includes(p.toLowerCase()))) {
        msg.reply(mensagens.mensagem.msgChavePix);
        carrinhoAtual.aprt = true;
    }
}



// 🔹 Função principal de análise
async function analisarPalavras(palavras, carrinhoAtual, msg, idAtual, client, MessageMedia) {
    // Primeiro processa bebidas
    const palavrasProcessadas = new Set();
    await processarBebidas(palavras, idAtual, carrinhoAtual, palavrasProcessadas);
    
    // Depois processa lanches, mas ignora palavras já processadas como bebidas
    const lanches = await processarLanches(palavras, idAtual, carrinhoAtual, palavrasProcessadas);

    getCardapio(palavras, carrinhoAtual, msg, idAtual, client, MessageMedia);
    //getRetirada(palavras, carrinhoAtual, msg, idAtual);
    getPix(palavras, carrinhoAtual, msg, idAtual);

    if (carrinhoAtual.aprt && !carrinhoAtual.alertAdicionado && carrinhoAtual.carrinho !== undefined) {
        if (valorTotal(idAtual) !== 0 && !carrinhoAtual.entrega && !carrinhoAtual.retirada) {
            msg.reply(`${carrinhoView(idAtual)} ${resp.msgmenuInicialSub}`);
        }
        carrinhoAtual.alertAdicionado = true;
    }

    return lanches;
}

module.exports = {
    analisarPalavras,
    getCardapio,
    separarMensagem,
    checarDadosObrigatorios,
    // Resolve an input like "dallas sem cebola" into { itemName, preparo }
    parseItemInput: function(input) {
        if (!input) return null;
        const text = input.toLowerCase().trim();
        // padrões simples de preparo: "sem <ingrediente>", "com <ingrediente>", "em <ingrediente>"
        const preparoMatch = text.match(/\b(sem|com|em)\s+([a-zçãéíóúâêôãõ0-9\-]+)\b/);
        let preparo = null;
        let itemName = text;
        if (preparoMatch) {
            preparo = preparoMatch[0]; // e.g. "sem cebola"
            // remove trecho de preparo do nome
            itemName = text.replace(preparoMatch[0], '').trim();
        }
        // se sobrar vazio, assume a primeira palavra original
        if (!itemName) itemName = text.split(' ')[0];
        return { itemName: itemName.trim(), preparo: preparo };
    },
    getItemIdByName: async function(name) {
        if (!name) return null;
        
        // aceita strings com preparo: "dallas sem cebola"
        const parsed = module.exports.parseItemInput(name) || { itemName: String(name).toLowerCase().trim(), preparo: null };
        const nomeNormalizado = normalizarTexto(parsed.itemName);
        
        if (!nomeNormalizado) return null;
        
        // Obter mapeamentos combinados (arquivo + banco)
        const mapeamentos = await getMapeamentosCompletos();
        
        // Primeiro: tentativa direta com normalização
        if (mapeamentos[nomeNormalizado]) {
            return mapeamentos[nomeNormalizado];
        }
        
        // Segundo: usar lógica de melhor match com priorização por especificidade
        const melhorMatch = encontrarMelhorMatch(parsed.itemName, mapeamentos);
        if (melhorMatch) {
            return melhorMatch.valor;
        }
        
        // Terceiro: busca por tokens individuais (fallback para compatibilidade)
        const palavras = separarMensagemNormalizada(parsed.itemName);
        for (const palavra of palavras) {
            const palavraNormalizada = normalizarTexto(palavra);
            if (palavraNormalizada && mapeamentos[palavraNormalizada]) {
                return mapeamentos[palavraNormalizada];
            }
        }
        
        // não encontrado
        return null;
    }
};
