const carrinhos = {}; // Objeto que armazena os carrinhos dos clientes em memória
const EventEmitter = require('events');
const events = new EventEmitter();
// Utility: normaliza IDs/contatos removendo sufixos como '@s.whatsapp.net' e '@broadcast'
function sanitizeId(rawId) {
    if (!rawId) return '';
    return String(rawId).replace('@s.whatsapp.net', '').replace('@broadcast', '');
}
// Sanitiza um objeto de carrinho removendo propriedades internas, timers, funções
function sanitizeCarrinho(input) {
    if (!input || typeof input !== 'object') return input;
    const seen = new WeakSet();
    function _san(v) {
        if (v === null) return null;
        if (typeof v !== 'object') return v;
        if (seen.has(v)) return undefined;
        seen.add(v);
        if (Array.isArray(v)) return v.map(_san).filter(x => typeof x !== 'undefined');
        const out = {};
        for (const k of Object.keys(v)) {
            if (k && typeof k === 'string' && k.startsWith('_')) continue;
            const val = v[k];
            if (typeof val === 'function') continue;
            try {
                const ctorName = val && val.constructor && val.constructor.name;
                if (ctorName === 'Timeout' || ctorName === 'Immediate') continue;
            } catch (e) {}
            if (val instanceof Date) { out[k] = val.toISOString(); continue; }
            const sanitized = _san(val);
            if (typeof sanitized !== 'undefined') out[k] = sanitized;
        }
        return out;
    }
    return _san(input);
}
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer'); // Biblioteca para gerar PDF
const pdfPrinter = require('pdf-to-printer'); // Biblioteca para imprimir PDF

const mensagens = require('../utils/mensagens'); // Caminho para o seu arquivo de mensagens
const { obterInformacoesCliente, atualizarEnderecoCliente, adicionarPedido } = require('./clienteService'); // Importa funções do serviço de cliente
const { obterPedidoPorId } = require('./clienteService');
const cardapio = require('../utils/cardapio'); // Cardápio sempre como array
const cardapioService = require('./cardapioService'); // Serviço de cardápio dinâmico

/**
 * Busca um item no cardápio (primeiro no dinâmico SQLite, depois no estático como fallback)
 * @param {number|string} itemId - ID do item a ser buscado
 * @returns {Object|null} - Item encontrado ou null
 */
async function buscarItemCardapio(itemId) {
    let itemCardapio = null;
    
    // Primeiro tenta encontrar no cardapioService dinâmico (SQLite)
    try {
        await cardapioService.init();
        const itemsDinamicos = cardapioService.getItems();
        itemCardapio = itemsDinamicos.find(i => i.id === itemId);
        if (itemCardapio) {
            console.log(`[CARDAPIO] Item ID ${itemId} encontrado no cardápio dinâmico:`, itemCardapio);
            return itemCardapio;
        }
    } catch (e) {
        console.error('[CARDAPIO] Erro ao buscar no cardápio dinâmico:', e);
    }
    
    // Se não encontrou no SQLite, tenta no cardápio estático como fallback
    if (!Array.isArray(cardapio)) {
        console.error('Cardápio estático não está carregado como array.');
        return null;
    }
    
    itemCardapio = cardapio.find(i => i.id === itemId);
    if (itemCardapio) {
        console.log(`[CARDAPIO] Item ID ${itemId} encontrado no cardápio estático:`, itemCardapio);
    }
    
    return itemCardapio;
}

const stats = { // Estados possíveis do carrinho para controle do fluxo do bot
    menuBebidas: 'menu-bebidas',
    menuUnidadeBebida: 'menu-quantidade-bebidas',
    menuConfirmandoPedido: 'confirmandoPedido',
    menuDescrição: 'definindo_preparo.',
    menuUnidade: 'definindo_unidade',
    menuPagamento: 'formar_de_pagamento',
    menuTroco: 'definindo_troco',
    menuEndereço: 'coletando_endereco',
    menuEntregaRetirada: 'escolhendo_entrega_retirada',
    menuResgate: 'resgate',
    menuAdicionais: 'adicionais',
    menuNome: 'coletando_nome',
    menuQuantidadeAdicionais: 'quantidade_adicionais',
    menuEmPreparo: 'pedindo_em_preparo',
    menuSuporte: 'suporte',
    menuInicial: 'menu-inicial',
    menuFinalizado: 'finalizado',
    saiuParaEntrega: 'saiu_para_entrega'
}

/**
 * Inicializa um novo carrinho para um cliente.
 * É importante que esta função seja chamada quando um cliente inicia uma nova sessão.
 * @param {string} clienteId ID único do cliente (ex: número de telefone).
 */
function inicializarCarrinho(clienteId) {
    if (!carrinhos[clienteId]) {
        carrinhos[clienteId] = {
            carrinho: [], // Array de itens do pedido
            estado: stats.menuInicial, // Estado atual da interação do bot com o cliente
            status: null, // Status do pedido (null, 'finalizado', etc.)
            valor: 0, // Valor temporário por item, não o total acumulado
            valorTotal: 0, // Valor total do pedido, incluindo entrega
            valorEntrega: 0, // Valor da taxa de entrega
            entrega: false, // Flag para indicar se é entrega (true) ou retirada (false)
            retirada: false, // Flag para indicar se é retirada
            endereco: null, // Endereço do cliente (texto)
            lat: null, // Latitude do endereço
            lng: null, // Longitude do endereço
            troco: undefined,
            alertAdicionado: true,
            observacao: undefined,
            formaDePagamento: undefined,
            observacaoConfirmada: undefined,
            aprt: true,
            idSelect: null // Usado para seleção de itens/opções
        };
        console.log(`[INFO] Carrinho inicializado para o cliente: ${clienteId}`);
    // Emite evento para consumidores (ex: dashboard em tempo real)
    try { events.emit('update', { type: 'init', id: clienteId, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carrinhos[clienteId]) : carrinhos[clienteId] }); } catch (e) {}
    }
}

/**
 * Compatibilidade: wrapper que retorna o carrinho inicializado.
 * Alguns lugares do código chamam `initCarrinho` e esperam receber o objeto do carrinho.
 */
function initCarrinho(clienteId) {
    inicializarCarrinho(clienteId);
    return carrinhos[clienteId];
}

/**
 * Calcula o valor total do carrinho, incluindo itens e taxa de entrega.
 * O valor é arredondado para duas casas decimais.
 * @param {string} id ID do cliente.
 * @returns {number} Valor total do pedido.
 */
function valorTotal(id) {
    // Certifica-se de que o carrinho existe
    if (!carrinhos[id]) {
        console.error(`Erro: Carrinho não encontrado para o ID ${id} em valorTotal.`);
        return 0;
    }

    let totalItens = carrinhos[id].carrinho.reduce((total, item) => {
        // Garante que preco e quantidade são números e calcula o subtotal
        const itemPreco = parseFloat(item.preco || 0);
        const itemQuantidade = parseInt(item.quantidade || 0);
        return total + (itemPreco * itemQuantidade);
    }, 0);

    let totalComEntrega = totalItens;

    // Adiciona a taxa de entrega se a entrega estiver ativa e o valor for um número válido
    if (carrinhos[id].entrega && typeof carrinhos[id].valorEntrega === 'number' && carrinhos[id].valorEntrega > 0) {
        totalComEntrega += carrinhos[id].valorEntrega;
    }

    // Armazena o valor total calculado no objeto do carrinho e o retorna formatado
    carrinhos[id].valorTotal = parseFloat(totalComEntrega.toFixed(2));
    return carrinhos[id].valorTotal;
}

/**
 * Adiciona um item ao carrinho do cliente.
 * @param {string} clienteId ID do cliente.
 * @param {number} itemId ID do item do cardápio.
 * @param {number} quantidade Quantidade do item.
 * @param {string} AnotarPreparo Anotações ou preparo especial para o item.
 * @param {string} tipagem Tipo do item (ex: 'Lanche', 'Bebida', 'Adicional').
 * @returns {object|null} O objeto do carrinho atualizado ou null em caso de erro.
 */
async function adicionarItemAoCarrinho(clienteId, itemId, quantidade, AnotarPreparo, tipagem, displayName) {
    inicializarCarrinho(clienteId); // Garante que o carrinho existe

    // Usar função centralizada de busca no cardápio
    const itemCardapio = await buscarItemCardapio(itemId);

    if (itemCardapio) {
        carrinhos[clienteId].carrinho.push({ // Adiciona o item ao array do carrinho
            id: itemCardapio.id,
            nome: displayName && String(displayName).trim().length > 0 ? String(displayName).trim() : itemCardapio.nome,
            quantidade: parseInt(quantidade), // Garante que a quantidade é um número inteiro
            preparo: AnotarPreparo,
            descricao: itemCardapio.descricao,
            preco: parseFloat(itemCardapio.preco), // Garante que o preço é um número float
            tipo: tipagem,
        });
        // debug: mostrar o item que foi adicionado
        try {
            const added = carrinhos[clienteId].carrinho[carrinhos[clienteId].carrinho.length - 1];
            console.log('[CARRINHO] item adicionado ->', { clienteId, item: added });
        } catch (e) {}
        // Recalcula o valor total após adicionar o item
        valorTotal(clienteId);
        // Emite atualização para o dashboard após recalcular o total
    try { events.emit('update', { type: 'add', id: clienteId, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carrinhos[clienteId]) : carrinhos[clienteId] }); } catch(e) {}
        return carrinhos[clienteId];
    } else {
        console.error(`Item do cardápio com ID ${itemId} não encontrado.`);
        return null;
    }
}

/**
 * Atualiza o estado atual do carrinho do cliente.
 * @param {string} clienteId ID do cliente.
 * @param {string} novoEstado Novo estado a ser definido para o carrinho.
 */
function atualizarEstadoDoCarrinho(clienteId, novoEstado) {
    inicializarCarrinho(clienteId); // Garante que o carrinho existe
    carrinhos[clienteId].estado = novoEstado;
    console.log(`[INFO] Estado do carrinho para ${clienteId} atualizado para: ${novoEstado}`);
    try { events.emit('update', { type: 'state_change', id: clienteId, estado: novoEstado, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carrinhos[clienteId]) : carrinhos[clienteId] }); } catch (e) {}
}

/**
 * Gera uma string formatada da visualização do carrinho para o cliente.
 * @param {string} id ID do cliente.
 * @returns {string} String formatada do carrinho.
 */
function carrinhoView(id) {
    if (!carrinhos[id]) {
        return '*Seu carrinho está vazio.*';
    }

    const marmitas = carrinhos[id].carrinho.filter(item => item.tipo === 'Lanche');
    const bebidas = carrinhos[id].carrinho.filter(item => item.tipo === 'Bebida');
    const adicionais = carrinhos[id].carrinho.filter(item => item.tipo === 'Adicional');
    const acompanhamentos = carrinhos[id].carrinho.filter(item => item.tipo === 'Acompanhamento');
    let msgCarrinhoAtual = '*SEU PEDIDO:* \n';

    if (marmitas.length > 0) {
        msgCarrinhoAtual += marmitas.map(item => `${item.quantidade}x ${item.nome} ${item.preparo ? `(${item.preparo})` : ''}`).join('\n');
        msgCarrinhoAtual += '\n';
    }

    if (acompanhamentos.length > 0) {
        msgCarrinhoAtual += acompanhamentos.map(item => `${item.quantidade}x ${item.nome} ${item.preparo ? `(${item.preparo})` : ''}`).join('\n');
        msgCarrinhoAtual += '\n';
    }

    if (bebidas.length > 0) {
        msgCarrinhoAtual += bebidas.map(item => `${item.quantidade}x ${item.nome} ${item.descricao || ''}`).join('\n');
        msgCarrinhoAtual += '\n';
    }
    
    if (adicionais.length > 0) {
        msgCarrinhoAtual += adicionais.map(item => `${item.quantidade}x ${item.nome} ${item.descricao}`).join('\n');
        msgCarrinhoAtual += '\n';
    }

    // 👉 Exibe a taxa de entrega se for um pedido de entrega e o valor for maior que zero
    if (carrinhos[id].entrega && typeof carrinhos[id].valorEntrega === 'number' && carrinhos[id].valorEntrega > 0) {
        msgCarrinhoAtual += `\n_+Taxa de entrega: R$ ${carrinhos[id].valorEntrega.toFixed(2)}_`;
        msgCarrinhoAtual += `\n`;
    }

    msgCarrinhoAtual += `────────────\nVALOR ATUAL: _*${valorTotal(id).toFixed(2)} R$*_ 💰\n`;
    return msgCarrinhoAtual;
}

/**
 * Reseta o carrinho de um cliente, limpando todos os itens e estados relacionados ao pedido.
 * @param {string} idAtual ID do cliente.
 * @param {object} carrinhoAtual Objeto do carrinho a ser resetado.
 */
function resetCarrinho(idAtual, carrinhoAtual) {
    if (!carrinhos[idAtual]) {
        console.warn(`Tentativa de resetar carrinho inexistente para o cliente: ${idAtual}`);
        return;
    }
    carrinhos[idAtual].carrinho = [];
    carrinhos[idAtual].status = null; // Resetar status do pedido
    carrinhos[idAtual].troco = undefined;
    carrinhos[idAtual].alertAdicionado = true;
    carrinhos[idAtual].observacao = undefined;
    carrinhos[idAtual].formaDePagamento = undefined;
    carrinhos[idAtual].observacaoConfirmada = undefined;
    carrinhos[idAtual].entrega = false; // Resetar status de entrega
    carrinhos[idAtual].valorTotal = 0; // Resetar valor total
    carrinhos[idAtual].retirada = false; // Melhor usar false ou null
    carrinhos[idAtual].aprt = true;
    carrinhos[idAtual].idSelect = null; // Limpar idSelect
    // Não atualize o estado para menuInicial aqui, isso deve ser feito pelo fluxo principal
    console.log('Carrinho resetado\n ' + JSON.stringify(carrinhos[idAtual])); // Printa o carrinho resetado
    try { events.emit('update', { type: 'reset', id: idAtual, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carrinhos[idAtual]) : carrinhos[idAtual] }); } catch (e) {}
    // Garantir que o estado volte ao menu inicial após reset
    try { atualizarEstadoDoCarrinho(idAtual, stats.menuInicial); } catch (e) { console.error('Erro ao atualizar estado no resetCarrinho:', e); }
}

// Helper para emitir atualizações manuais
function _emitUpdate(type, id) {
    try { events.emit('update', { type, id, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carrinhos[id]) : carrinhos[id] }); } catch (e) {}
}

/**
 * Retorna o objeto do carrinho para um cliente específico.
 * @param {string} idAtual ID do cliente.
 * @returns {object|null} Objeto do carrinho ou null se não existir.
 */
function getCarrinho(idAtual) {
    inicializarCarrinho(idAtual); // Garante que o carrinho seja inicializado se ainda não foi
    return carrinhos[idAtual];
}

/**
 * Remove um item do carrinho por índice ou por nome/id.
 * @param {string} idAtual
 * @param {object} opts - { index, nome, id }
 */
function removerItemDoCarrinho(idAtual, opts) {
    if (!carrinhos[idAtual]) return false;
    const carro = carrinhos[idAtual];
    if (typeof opts.index === 'number') {
        if (opts.index < 0 || opts.index >= carro.carrinho.length) return false;
        carro.carrinho.splice(opts.index, 1);
        // Recalcula o valor total após remover o item
        valorTotal(idAtual);
    try { events.emit('update', { type: 'remove', id: idAtual, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carro) : carro }); } catch(e){}
        return true;
    }

    if (opts.nome) {
        const idx = carro.carrinho.findIndex(i => (i.nome || '').toLowerCase() === opts.nome.toLowerCase());
        if (idx >= 0) {
            carro.carrinho.splice(idx, 1);
            // Recalcula o valor total após remover o item
            valorTotal(idAtual);
            try { events.emit('update', { type: 'remove', id: idAtual, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carro) : carro }); } catch(e){}
            return true;
        }
        return false;
    }

    if (opts.id) {
        const idx = carro.carrinho.findIndex(i => String(i.id) === String(opts.id));
        if (idx >= 0) {
            carro.carrinho.splice(idx, 1);
            // Recalcula o valor total após remover o item
            valorTotal(idAtual);
            try { events.emit('update', { type: 'remove', id: idAtual, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carro) : carro }); } catch(e){}
            return true;
        }
        return false;
    }

    return false;
}

/**
 * Altera a quantidade de um item no carrinho por índice.
 * Se a nova quantidade for <= 0, remove o item.
 * @param {string} idAtual
 * @param {number} index
 * @param {number} delta - incremento (positivo/negativo)
 */
function atualizarQuantidadeDoItem(idAtual, index, delta) {
    if (!carrinhos[idAtual]) return false;
    const carro = carrinhos[idAtual];
    if (typeof index !== 'number' || index < 0 || index >= carro.carrinho.length) return false;
    const item = carro.carrinho[index];
    const atual = Number(item.quantidade || 0);
    const novo = atual + Number(delta || 0);
    if (isNaN(novo)) return false;
    if (novo <= 0) {
        carro.carrinho.splice(index, 1);
        // Recalcula o valor total após remover o item
        valorTotal(idAtual);
    try { events.emit('update', { type: 'remove', id: idAtual, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carro) : carro }); } catch (e) {}
        return true;
    }
    item.quantidade = parseInt(novo);
    // Recalcula o valor total após alterar a quantidade
    valorTotal(idAtual);
    try { events.emit('update', { type: 'quantity_change', id: idAtual, carrinho: sanitizeCarrinho ? sanitizeCarrinho(carro) : carro }); } catch (e) {}
    return true;
}

/**
 * Gera uma string formatada do pedido para o administrador/motoboy.
 * @param {string} id ID do cliente.
 * @returns {string} String formatada do pedido.
 */
function imprimirPedido(id) {
    if (!carrinhos[id]) {
        return '*Pedido não encontrado para o ID do cliente.*';
    }

    const cliente = carrinhos[id];
    const carrinho = cliente.carrinho;

    // Obtém o valor total já calculado pelo valorTotal() do carrinhoService
    const valorTotalPedido = valorTotal(id);
    const formaDePagamento = cliente.formaDePagamento || 'Não informado';
    const observacao = cliente.observacao || 'Nenhuma';

    // Lógica para Troco: Só exibe se a forma de pagamento for "Dinheiro" E houver um valor de troco definido e maior que 0
    let trocoInfoHtml = '';
    if (formaDePagamento === 'Dinheiro') { // Condicional para forma de pagamento "Dinheiro"
        if (typeof cliente.troco === 'number' && cliente.troco > 0) {
            trocoInfoHtml = `<p><strong>Troco para:</strong> R$ ${cliente.troco.toFixed(2)}</p>`;
        } else if (typeof cliente.troco === 'number' && cliente.troco === 0) { // Valor exato
            trocoInfoHtml = `<p><strong>Troco para:</strong> Valor exato (R$ 0,00)</p>`;
        }
    }

    let tipoEntregaHtml = '';
    let enderecoInfoHtml = '';
    let coordenadasMapaHtml = '';
    let taxaEntregaInfoHtml = '';

    if (cliente.entrega) {
        enderecoInfoHtml = `<p><strong>Endereço:</strong> ${cliente.endereco || 'Não especificado'}</p>';


        if (typeof cliente.valorEntrega === 'number' && cliente.valorEntrega > 0) {
            taxaEntregaInfoHtml = "<p><strong>Taxa de Entrega:</strong> R$ " + cliente.valorEntrega.toFixed(2) + "</p>";
        }
    }
    // Se tipoEntregaHtml continuar vazio, a seção não será renderizada por completo

    let htmlContent = "<html>" +
        "<head>" +
            "<style>" +
                "body {" +
                    "font-size: 12px;" +
                    "font-family: Arial, sans-serif;" +
                    "margin: 0;" +
                    "padding: 0;" +
                    "width: 80mm; /* Largura típica para impressora térmica */" +
                    "box-sizing: border-box;" +
                "}" +
                "h1 {" +
                    "font-size: 16px;" +
                    "text-align: center;" +
                    "margin-bottom: 10px;" +
                    "border-bottom: 1px dashed #000;" +
                    "padding-bottom: 5px;" +
                "}" +
                ".section-title {" +
                    "font-size: 14px;" +
                    "font-weight: bold;" +
                    "margin-top: 10px;" +
                    "margin-bottom: 5px;" +
                    "border-bottom: 1px solid #eee;" +
                "}" +
                "ul {" +
                    "padding-left: 0;" +
                    "list-style-type: none;" +
                    "margin: 0;" +
                "}" +
                "li {" +
                    "font-size: 12px;" +
                    "text-align: left;" +
                    "margin-bottom: 3px;" +
                    "word-wrap: break-word;" +
                "}" +
                "p {" +
                    "font-size: 12px;" +
                    "text-align: left;" +
                    "margin: 2px 0;" +
                "}" +
                ".total {" +
                    "font-size: 14px;" +
                    "font-weight: bold;" +
                    "margin-top: 10px;" +
                    "border-top: 1px dashed #000;" +
                    "padding-top: 5px;" +
                "}" +
            "</style>" +
        "</head>" +
        "<body>" +
            "<h1>PEDIDO RECEBIDO</h1>" +
            "<p><strong>Cliente:</strong> " + (cliente.nome || 'Não informado') + "</p>" +
            "<p><strong>Contato:</strong> " + sanitizeId(id) + "</p>" +
            "<p><strong>Data/Hora:</strong> " + new Date().toLocaleString('pt-BR') + "</p>" +
            
            "<div class=\"section-title\">ITENS DO PEDIDO</div>" +
            "<ul>";

    if (carrinho.length === 0) {
        htmlContent += "<li>Nenhum item no carrinho.</li>";
    } else {
        carrinho.forEach(item => {
            const preparo = item.preparo ? " (" + item.preparo + ")" : "";
            htmlContent += "<li>" + item.quantidade + "x " + item.nome + preparo + " - R$" + item.preco.toFixed(2) + "</li>";
        });
    }

    htmlContent += "</ul>";
    
    if (cliente.entrega || cliente.retirada) {
        htmlContent += "<div class=\"section-title\">DETALHES DA ENTREGA</div>";
        htmlContent += tipoEntregaHtml;
        htmlContent += enderecoInfoHtml;
        htmlContent += coordenadasMapaHtml;
        htmlContent += taxaEntregaInfoHtml;
    }

    htmlContent += "<div class=\"section-title\">PAGAMENTO</div>" +
            "<p><strong>Forma:</strong> " + formaDePagamento + "</p>" +
            trocoInfoHtml;
            
    if (observacao !== 'Nenhuma') {
        htmlContent += "<div class=\"section-title\">OBSERVAÇÃO</div><p>" + observacao + "</p>";
    }

    htmlContent += "<p class=\"total\">VALOR TOTAL: R$" + valorTotalPedido.toFixed(2) + "</p>" +
        "</body>" +
        "</html>";

    return htmlContent;
}

// Gera HTML formatado a partir de um registro de pedido (usado quando o PDF foi removido e queremos servir HTML similar)
function imprimirPedidoFromRecord(pedidoRecord) {
    try {
        const clienteNome = (pedidoRecord.raw && pedidoRecord.raw.nome) || pedidoRecord.numero || 'Não informado';
        const id = pedidoRecord.id || pedidoRecord.numero || 'pedido';
        const ts = pedidoRecord.ts || Date.now();
        const items = pedidoRecord.items || [];
        const total = Number(pedidoRecord.total || 0);
        const endereco = pedidoRecord.endereco || '';
        const entrega = !!pedidoRecord.entrega;
        // calcula subtotal de itens
        const subtotal = items.reduce((s, it) => s + (Number(it.preco || 0) * Number(it.quantidade || 1)), 0);
        const taxaEntrega = Math.max(0, Number((total - subtotal).toFixed(2)));
        const formaPagamento = (pedidoRecord.raw && pedidoRecord.raw.formaDePagamento) || (pedidoRecord.raw && pedidoRecord.raw.formaDePagamento) || (pedidoRecord.raw && pedidoRecord.raw.formaDePagamento) || 'Não informado';
        const observacao = (pedidoRecord.raw && pedidoRecord.raw.observacao) || '';

        let html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Pedido " + id + "</title><style>" +
            "body{font-family:Arial,Helvetica,sans-serif;font-size:12px;margin:0;padding:12px}" +
            "h1{font-size:18px;text-align:center;margin:6px 0;padding-bottom:6px}" +
            ".section-title{font-weight:700;margin-top:8px;border-bottom:1px solid #ddd;padding-bottom:6px}" +
            "ul{list-style:none;padding-left:0;margin:6px 0}" +
            "li{margin-bottom:6px}" +
            ".total{font-weight:700;margin-top:10px}" +
            ".sep{border-top:1px dashed #000;margin:10px 0}" +
        "</style></head><body>";
        html += "<div style=\"text-align:right;font-size:11px;color:#666\">" + new Date(Number(ts)).toLocaleString() + "</div>";
        html += "<h1>PEDIDO RECEBIDO</h1><div class=\"sep\"></div>";
        html += "<p><strong>Cliente:</strong> " + clienteNome + "</p>";
        html += "<p><strong>Contato:</strong> " + String(pedidoRecord.numero||id) + "</p>";
        html += "<p><strong>Data/Hora:</strong> " + new Date(Number(ts)).toLocaleString('pt-BR') + "</p>";
        html += "<div class=\"section-title\">ITENS DO PEDIDO</div><ul>";
        if (!items || items.length === 0) html += "<li>Nenhum item no carrinho.</li>";
        else items.forEach(it => {
            const preparo = it.preparo ? " (" + it.preparo + ")" : "";
            html += "<li>" + (it.quantidade||1) + "x " + (it.nome||it.id) + preparo + " - R$ " + (Number(it.preco)||0).toFixed(2) + "</li>";
        });
        html += "</ul>";
        if (entrega) {
            html += "<div class=\"section-title\">DETALHES DA ENTREGA</div>";
            html += "<p><strong>Endereço:</strong> " + (endereco || 'Não especificado') + "</p>";
            if (taxaEntrega > 0) html += "<p><strong>Taxa de Entrega:</strong> R$ " + taxaEntrega.toFixed(2) + "</p>";
            else html += "<p><strong>Taxa de Entrega:</strong> R$ 0.00</p>";
        }
        html += "<div class=\"section-title\">PAGAMENTO</div>";
        html += "<p><strong>Forma:</strong> " + formaPagamento + "</p>";
        if (observacao && String(observacao).trim().length > 0) {
            html += "<div class=\"section-title\">OBSERVAÇÃO</div><p>" + observacao + "</p>";
        }
        html += "<div class=\"sep\"></div><p class=\"total\">VALOR TOTAL: R$" + total.toFixed(2) + "</p>";
        if (endereco) html += "<div style=\"margin-top:6px;color:#666\">" + endereco + "</div>";
        html += "</body></html>";
        return html;
    } catch (e) { console.error('Erro em imprimirPedidoFromRecord:', e); return '<html><body>Erro ao renderizar pedido</body></html>'; }
}

async function salvarPedido(idAtual, estado) {
    // MODIFICADO: Altera o caminho para ser relativo ao diretório de trabalho atual (writable)
    const ordersDir = path.join(process.cwd(), 'Pedidos');
    const filePath = path.join(ordersDir, idAtual + '.pdf');

    // Cria o diretório se não existir
    if (!fs.existsSync(ordersDir)) {
        try {
            fs.mkdirSync(ordersDir, { recursive: true });
            console.log('Diretório de pedidos criado em: ' + ordersDir);
        } catch (mkdirError) {
            console.error('Erro ao criar diretório de pedidos: ' + mkdirError.message);
            // Se o erro ainda ocorrer, pode ser um problema de permissão ou ambiente
            // Nestes casos, talvez seja necessário configurar a pasta de saída manualmente
            // ou usar um caminho temporário do sistema operacional (os.tmpdir()).
        }
    }

    const htmlContent = imprimirPedido(idAtual) + '<p>' + estado + '</p>'; // Adiciona o estado ao final do HTML para o PDF

    // Tenta localizar um Chrome/Chromium instalado localmente para passar o executablePath
    const chromeCandidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Chromium/chrome.exe'
    ];
    let chromeExecutablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;
    if (!chromeExecutablePath) {
        for (const p of chromeCandidates) {
            try { if (fs.existsSync(p)) { chromeExecutablePath = p; break; } } catch (e) {}
        }
    }

    // Tenta iniciar o Puppeteer com o caminho explícito quando disponível; caso falhe, grava fallback em HTML
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox'],
            executablePath: chromeExecutablePath || undefined
        });

        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        try {
            await page.pdf({
                path: filePath,
                format: 'A4',
                printBackground: true,
                margin: {
                    top: '10mm',
                    right: '10mm',
                    bottom: '10mm',
                    left: '10mm',
                }
            });
            console.log('PDF gerado com Puppeteer:', filePath);
        } catch (pdfError) {
            console.error('Erro ao gerar PDF para ' + idAtual + ': ' + pdfError.message);
        }
    } catch (launchError) {
        console.error('Falha ao iniciar o Puppeteer/Chrome:', launchError && launchError.message ? launchError.message : launchError);
        // Fallback: grava o HTML em vez do PDF para não bloquear o fluxo
        try {
            const fallbackPath = filePath.replace(/\.pdf$/i, '.html');
            fs.writeFileSync(fallbackPath, htmlContent, 'utf8');
            console.log('Fallback: HTML salvo em ' + fallbackPath + '. Instale o Chrome ou rode \'npx puppeteer install chrome\' para habilitar geração de PDF.');
        } catch (writeErr) {
            console.error('Falha ao gravar fallback HTML:', writeErr);
        }
    } finally {
        try { if (browser) await browser.close(); } catch (e) {}
    }

    // Define o caminho para o executável do SumatraPDF
    // Baseado na sua estrutura "src/bin", assumimos que 'bin' será copiado para o root da build
    const sumatraPdfPath = path.join(process.cwd(), 'bin', 'SumatraPDF-3.4.6-32.exe');

    // Imprimir (opcional)
    try {
        const printerName = process.env.PRINTER_NAME || 'DELIVERYX';
        await pdfPrinter.print(filePath, {
            printer: printerName,
            sumatraPdfPath: process.platform === 'win32' ? sumatraPdfPath : undefined
        });
        console.log('Impressão enviada com sucesso.');
    } catch (printError) {
        // Log detalhado para ajudar no diagnóstico
        try { console.error('Erro ao imprimir pedido (pdf-to-printer):', printError); } catch(e) { console.error('Erro ao imprimir pedido (mensagem):', printError && printError.message ? printError.message : printError); }
        // Tenta fallback: invocar diretamente o Sumatra se estiver disponível (Windows)
        try {
            if (process.platform === 'win32' && fs.existsSync(sumatraPdfPath)) {
                const { spawn } = require('child_process');
                const printerName = process.env.PRINTER_NAME || 'DELIVERYX';
                console.log('[PRINT-FALLBACK] printerName=', printerName);
                // list default printers for debugging
                try {
                    const { execSync } = require('child_process');
                    const wmic = execSync('wmic printer get Name,Default /format:csv', { encoding: 'utf8' });
                    console.log('[PRINT-FALLBACK] Impressoras detectadas (wmic):\n' + wmic);
                } catch (wmicErr) { console.warn('[PRINT-FALLBACK] não foi possível listar impressoras via wmic:', wmicErr && wmicErr.message ? wmicErr.message : wmicErr); }
                const args = ['-print-to', printerName, '-silent', filePath];
                console.log('[PRINT-FALLBACK] executando:', sumatraPdfPath, args.join(' '));
                await new Promise((resolve, reject) => {
                    const p = spawn(sumatraPdfPath, args, { windowsHide: true });
                    let stderr = '';
                    let stdout = '';
                    p.stdout && p.stdout.on('data', d => { stdout += String(d); });
                    p.stderr && p.stderr.on('data', d => { stderr += String(d); });
                    p.on('close', async (code) => {
                        if (code === 0) {
                            console.log('[PRINT-FALLBACK] Sumatra finalizou com código 0');
                            return resolve();
                        }
                        console.error('[PRINT-FALLBACK] Sumatra finalizou com código', code, 'stderr:', stderr, 'stdout:', stdout);
                        // Se falhou por não encontrar a impressora, tentar imprimir na impressora padrão
                        const errText = (stderr + stdout).toLowerCase();
                        if (errText.includes('não existe') || errText.includes('nao existe') || errText.includes('printer') || code !== 0) {
                            try {
                                console.log('[PRINT-FALLBACK] Tentando imprimir na impressora padrão via Sumatra (-print-to-default)');
                                const argsDefault = ['-print-to-default', filePath];
                                const p2 = spawn(sumatraPdfPath, argsDefault, { windowsHide: true });
                                let stderr2 = '';
                                let stdout2 = '';
                                p2.stdout && p2.stdout.on('data', d => { stdout2 += String(d); });
                                p2.stderr && p2.stderr.on('data', d => { stderr2 += String(d); });
                                p2.on('close', (code2) => {
                                    if (code2 === 0) {
                                        console.log('[PRINT-FALLBACK] Sumatra (default) finalizou com código 0');
                                        return resolve();
                                    }
                                    console.error('[PRINT-FALLBACK] Sumatra (default) finalizou com código', code2, 'stderr:', stderr2, 'stdout:', stdout2);
                                    return reject(new Error('Sumatra default exited with code ' + code2));
                                });
                                p2.on('error', (err2) => { stderr2 += String(err2); reject(err2); });
                                return;
                            } catch (e) {
                                console.error('[PRINT-FALLBACK] Erro ao tentar imprimir na impressora padrão:', e);
                            }
                        }
                        reject(new Error('Sumatra exited with code ' + code));
                    });
                    p.on('error', (err) => { stderr += String(err); reject(err); });
                });
            } else {
                console.warn('[PRINT-FALLBACK] Sumatra não disponível ou não é Windows, pulando fallback.');
            }
        } catch (fbErr) {
            console.error('[PRINT-FALLBACK] Erro ao tentar fallback de impressão:', fbErr);
        }
    }

    // Persistir o pedido no banco de dados para histórico e cálculos futuros
    try {
        const cliente = carrinhos[idAtual] || {};
        // Sanitize raw object to avoid circular references (timeouts, internals, etc.)
        const rawSanitized = {
            nome: cliente.nome || null,
            endereco: cliente.endereco || null,
            lat: cliente.lat || null,
            lng: cliente.lng || null,
            entrega: !!cliente.entrega,
            valorEntrega: (typeof cliente.valorEntrega === 'number') ? cliente.valorEntrega : null,
            formaDePagamento: cliente.formaDePagamento || null,
            observacao: cliente.observacao || null,
            troco: (typeof cliente.troco !== 'undefined') ? cliente.troco : null,
            valorTotal: valorTotal(idAtual),
            carrinho: Array.isArray(cliente.carrinho) ? cliente.carrinho.map(i => ({ id: i.id, nome: i.nome, quantidade: i.quantidade, preparo: i.preparo, preco: i.preco, tipo: i.tipo })) : []
        };
        const pedidoRecord = {
            id: idAtual,
            ts: Date.now(),
            total: valorTotal(idAtual),
            entrega: !!cliente.entrega,
            endereco: cliente.endereco || null,
            estado: estado || null,
            items: cliente.carrinho || [],
            raw: rawSanitized
        };
        if (typeof adicionarPedido === 'function') {
            adicionarPedido(idAtual.replace(/[^0-9]/g,''), pedidoRecord);
        }
    } catch (dbErr) {
        console.error('Erro ao persistir pedido no DB:', dbErr && dbErr.message ? dbErr.message : dbErr);
    }

    // Após persistir e tentar imprimir, remover arquivos gerados (PDF/HTML) para economizar espaço
    try {
        const pdfExists = fs.existsSync(filePath);
        const htmlFallback = filePath.replace(/\.pdf$/i, '.html');
        const htmlExists = fs.existsSync(htmlFallback);
        if (pdfExists) {
            try { fs.unlinkSync(filePath); console.log('PDF removido:', filePath); } catch(e) { console.warn('Falha ao remover PDF:', e); }
        }
        if (htmlExists) {
            try { fs.unlinkSync(htmlFallback); console.log('HTML fallback removido:', htmlFallback); } catch(e) { console.warn('Falha ao remover HTML fallback:', e); }
        }
    } catch (remErr) {
        console.error('Erro ao tentar remover arquivos gerados:', remErr && remErr.message ? remErr.message : remErr);
    }
    // Retorna uma representação HTML do pedido (útil se arquivo já foi removido)
    try {
        const pedidoFromDb = typeof obterPedidoPorId === 'function' ? obterPedidoPorId(idAtual) : null;
        if (pedidoFromDb) {
            // montar um HTML simples a partir do registro salvo
            let html = "<html><head><meta charset=\"utf-8\"><title>Pedido " + idAtual + "</title></head><body>";
            html += "<h1>Pedido " + idAtual + "</h1>";
            html += "<p><strong>Cliente:</strong> " + (pedidoFromDb.numero || idAtual) + "</p>";
            html += "<p><strong>Data:</strong> " + new Date(Number(pedidoFromDb.ts)||Date.now()).toLocaleString() + "</p>";
            html += "<p><strong>Total:</strong> R$ " + Number(pedidoFromDb.total||0).toFixed(2) + "</p>";
            if (pedidoFromDb.items && Array.isArray(pedidoFromDb.items)) {
                html += "<ul>";
                for (const it of pedidoFromDb.items) {
                    html += "<li>" + (it.quantidade||1) + "x " + (it.nome || it.id) + " - R$ " + (Number(it.preco)||0).toFixed(2) + "</li>";
                }
                html += "</ul>";
            }
            html += "</body></html>";
            return html;
        }
    } catch (e) { /* ignore */ }
    return null;
}


function carrinhoAdm(id) {
    if (!carrinhos[id]) {
        return '*Pedido não encontrado para o ID do cliente.*';
    }

    const marmitas = carrinhos[id].carrinho.filter(item => item.tipo === 'Lanche');
    const bebidas = carrinhos[id].carrinho.filter(item => item.tipo === 'Bebida');
    const adicionais = carrinhos[id].carrinho.filter(item => item.tipo === 'Adicional');
    const acompanhamentos = carrinhos[id].carrinho.filter(item => item.tipo === 'Acompanhamento');
    // A entrega agora é uma flag e um valor separado
    let msgCarrinhoAtual = '*NOVO PEDIDO:*\n';

    if (marmitas.length > 0) {
        msgCarrinhoAtual += '*LANCHES*:\n';
        msgCarrinhoAtual += marmitas.map(item => item.quantidade + "x " + item.nome + " " + (item.preparo ? "(" + item.preparo + ")" : "")).join('\n');
        msgCarrinhoAtual += '\n';
    }

    if (acompanhamentos.length > 0) {
        msgCarrinhoAtual += '*ACOMPANHAMENTOS*:\n';
        msgCarrinhoAtual += acompanhamentos.map(item => item.quantidade + "x " + item.nome + " " + (item.preparo ? "(" + item.preparo + ")" : "")).join('\n');
        msgCarrinhoAtual += '\n';
    }

    if (bebidas.length > 0) {
        msgCarrinhoAtual += '*BEBIDAS*:\n';
        msgCarrinhoAtual += bebidas.map(item => item.quantidade + "x " + item.nome + " " + (item.descricao || "")).join('\n');
        msgCarrinhoAtual += '\n';
    }
    
    if (adicionais.length > 0) {
        msgCarrinhoAtual += '*ADICIONAIS*:\n';
        msgCarrinhoAtual += adicionais.map(item => item.quantidade + "x " + item.nome + " " + item.descricao).join('\n');
        msgCarrinhoAtual += '\n';
    }

    if (carrinhos[id].entrega) {
        msgCarrinhoAtual += "\n*ENDEREÇO DE ENTREGA:*\n";
        msgCarrinhoAtual += "_Endereço: " + (carrinhos[id].endereco || 'Não especificado') + "_";
        if (carrinhos[id].endereco === "LOCALIZAÇÃO" && carrinhos[id].lat && carrinhos[id].lng) {
            const linkLocalizacao = "https://www.google.com/maps/search/?api=1&query=" + carrinhos[id].lat + "," + carrinhos[id].lng;
            msgCarrinhoAtual += "\nVer no Mapa: " + linkLocalizacao + "\n\n";
        }
        // 👉 Adiciona o valor da entrega
        if (typeof carrinhos[id].valorEntrega === 'number' && carrinhos[id].valorEntrega > 0) {
            msgCarrinhoAtual += "\n_Taxa de Entrega: R$ " + carrinhos[id].valorEntrega.toFixed(2) + "_";
        }
        msgCarrinhoAtual += '\n';
    } else if (carrinhos[id].retirada) {
        msgCarrinhoAtual += "\n*MODO DE ENTREGA: RETIRADA NO LOCAL*\n";
    }

    if (carrinhos[id].observacao) {
        msgCarrinhoAtual += "\n*Observação:* _" + carrinhos[id].observacao + "_";
        msgCarrinhoAtual += '\n';
    }

    msgCarrinhoAtual += "\n*Valor Total:* _*R$ " + valorTotal(id).toFixed(2) + "*_ 💰\n";
    msgCarrinhoAtual += "Nome: " + (carrinhos[id].nome || 'Não informado') + "\n";
    msgCarrinhoAtual += "Contato: wa.me/" + sanitizeId(id) + "\n"; // Remove @s.whatsapp.net/@broadcast para o link
    return msgCarrinhoAtual;
}


module.exports = {
    stats,
    adicionarItemAoCarrinho,
    atualizarEstadoDoCarrinho,
    obterInformacoesCliente,
    atualizarEnderecoCliente,
    carrinhos,
    resetCarrinho,
    valorTotal,
    carrinhoView,
    carrinhoAdm, // Mantém carrinhoAdm se for usada em outros lugares, mas imprimirPedido é mais completa para PDF
    inicializarCarrinho,
    initCarrinho,
    getCarrinho,
    removerItemDoCarrinho,
    atualizarQuantidadeDoItem,
    imprimirPedido, // Exporta a função para ser usada onde o PDF é gerado
    salvarPedido,
    imprimirPedidoFromRecord,
    events,
    _emitUpdate,
    buscarItemCardapio, // Função centralizada para busca de itens
};
};
