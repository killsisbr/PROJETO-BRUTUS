// Importa módulos e funções necessárias
const mensagem = require('../../utils/mensagens'); // Módulo de mensagens para respostas padronizadas
const resp = mensagem.mensagem; // Acesso direto às mensagens de resposta
const idChatGrupo = require('../../utils/config').idChatGrupo; // ID do grupo para mensagens de suporte
const { analisarLocalizacao } = require('../menuEndereço'); // Função para gerenciar o fluxo de entrega/retirada
const { retiradaBalcaoConfig } = require('../../utils/config');
const menuEntregaRetirada = require('./menuEntregaRetirada'); // Função para gerenciar escolha entre entrega e retirada
const { obterInformacoesCliente, buscarEnderecoCliente, atualizarEnderecoCliente: atualizarEnderecoClienteDB } = require('../../services/clienteService'); // Serviço para obter informações do cliente
const { atualizarEstadoDoCarrinho, resetCarrinho, carrinhoView, valorTotal, stats } = require('../../services/carrinhoService'); // Serviços de carrinho
const path = require('path'); // Módulo 'path' para lidar com caminhos de arquivo
const fs = require('fs'); // Módulo 'fs' para verificar a existência de arquivos

/**
 * Processa as interações do cliente no menu inicial, gerenciando o estado do carrinho
 * e direcionando para as próximas etapas (pedido, ajuda, finalizar, etc.).
 * @param {string} idAtual O ID do chat (cliente) atual.
 * @param {object} carrinhoAtual O objeto do carrinho do cliente atual.
 * @param {object} msg O objeto da mensagem recebida do WhatsApp.
 * @param {object} client O objeto do cliente WhatsApp para enviar mensagens.
 * @param {object} MessageMedia O módulo MessageMedia para lidar com envio de arquivos.
 */
async function menuInicial(idAtual, carrinhoAtual, msg, client, MessageMedia) {
    // Define o limite máximo de distância para entrega em KM
    const LIMITE_KM = 70; // Exemplo: 70 km - Ajuste conforme sua necessidade

    // Converte a última mensagem do cliente para minúsculas para facilitar a comparação
    const lastMsgLower = carrinhoAtual.lastMsg.toLowerCase();

    // Marca que uma ação no menu inicial foi processada para evitar repetições
    //carrinhoAtual.aprt = true;

    switch (lastMsgLower) {

        // --- Opções para Iniciar/Reiniciar Pedido ---
        case 'novo':
        case 'reiniciar':
        case 'pedir':
            console.log('Iniciando/Reiniciando pedido para o ID:', idAtual);
            resetCarrinho(idAtual, carrinhoAtual); // Limpa o carrinho do cliente

            // Verifica se o carrinho está vazio para dar a mensagem correta
            if (carrinhoAtual.carrinho.length === 0) {
                msg.reply('Seu carrinho foi reiniciado. \n' + resp.msgmenuInicialSub);
            } else {
                msg.reply(`${carrinhoView(idAtual)}\n${resp.msgmenuInicialSub}`);
            }
            // Garante que o estado volte ao menu inicial após reiniciar
            break;

        // --- Opções para Ajuda/Suporte ---
        case 'ajuda':
        case 'socorro':
        case 'help':
            console.log('Cliente solicitando ajuda:', idAtual);
            atualizarEstadoDoCarrinho(idAtual, stats.menuSuporte); // Altera o estado do carrinho para suporte
            msg.reply(resp.msgAjuda); // Envia mensagem de ajuda ao cliente
            // Notifica o grupo de suporte sobre o pedido de ajuda
            client.sendMessage(idChatGrupo, `*Cliente pedindo ajuda !!*\nWa.me/${idAtual}`);
            break;

        // --- Opções para Finalizar Pedido ---
        case 'finalizar':
        case 'f':
            console.log('Cliente finalizando pedido:', idAtual);
            // Verifica se o carrinho está vazio antes de finalizar
            if (carrinhoAtual.carrinho.length === 0) {
                msg.reply('Seu carrinho está vazio. \n' + resp.msgmenuInicialSub);
                return; // Sai da função se o carrinho estiver vazio
            }

            // Verifica se a retirada no balcão está habilitada
            if (retiradaBalcaoConfig.habilitada) {
                // Mostra opções de entrega e retirada
                atualizarEstadoDoCarrinho(idAtual, stats.menuEntregaRetirada);
                msg.reply(resp.msgMenuEntregaRetirada);
                return;
            }
            
            const enderecoSalvo = await buscarEnderecoCliente(idAtual);
            // Normaliza e valida o endereço salvo: pode ser string, objeto {endereco,lat,lng} ou vazio ({}).
            let enderecoValido = false;
            let enderecoTexto = null;
            if (enderecoSalvo) {
                if (typeof enderecoSalvo === 'string') {
                    const s = enderecoSalvo.trim();
                    if (s.length > 0 && s !== '{}' && s !== 'null') {
                        enderecoValido = true;
                        enderecoTexto = s;
                    }
                } else if (typeof enderecoSalvo === 'object') {
                    // objeto vazio => não é válido
                    if (Object.keys(enderecoSalvo).length > 0) {
                        // se tiver campo endereco não vazio, use-o
                        if (typeof enderecoSalvo.endereco === 'string' && enderecoSalvo.endereco.trim().length > 0 && enderecoSalvo.endereco.trim() !== '{}') {
                            enderecoValido = true;
                            enderecoTexto = enderecoSalvo.endereco.trim();
                        } else {
                            // aceita coordenadas apenas se forem números reais
                            const lat = enderecoSalvo.lat;
                            const lng = enderecoSalvo.lng;
                            if (lat !== null && lng !== null && lat !== undefined && lng !== undefined && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
                                enderecoValido = true;
                                enderecoTexto = 'LOCALIZAÇÃO';
                            }
                        }
                    }
                }
            }

            if (enderecoValido) {
                // preserva coords se houver
                if (enderecoSalvo && typeof enderecoSalvo === 'object') {
                    if (enderecoSalvo.lat !== undefined) carrinhoAtual.lat = enderecoSalvo.lat;
                    if (enderecoSalvo.lng !== undefined) carrinhoAtual.lng = enderecoSalvo.lng;
                }
                carrinhoAtual.endereco = enderecoTexto;
                console.log('Endereço encontrado para o cliente:', enderecoTexto);
                // If delivery/address was already confirmed earlier, skip re-confirming and proceed
                // directly to the order confirmation step (observations). This allows admin "finalizar"
                // to resume where the user left off when they already answered 'S'.
                if (carrinhoAtual.entregaConfirmada === true) {
                    try {
                        msg.reply(resp.msgObs);
                    } catch (e) { /* ignore reply errors */ }
                    // Só altera para confirmar pedido se não estiver já finalizado
                    try {
                        const menuFinalizadoStat = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
                        const estadoAtual = carrinhos[idAtual] && carrinhos[idAtual].estado;
                        if (!estadoAtual || String(estadoAtual) !== String(menuFinalizadoStat)) {
                            atualizarEstadoDoCarrinho(idAtual, stats.menuConfirmandoPedido);
                        } else {
                            console.log(`[INFO] Carrinho ${idAtual} já estava finalizado; não alterando estado ao pular endereço.`);
                        }
                    } catch (e) { atualizarEstadoDoCarrinho(idAtual, stats.menuConfirmandoPedido); }
                    return;
                }
                // Se for um endereço do tipo LOCALIZAÇÃO com coords, delega para analisarLocalizacao
                if (enderecoTexto === 'LOCALIZAÇÃO' && carrinhoAtual.lat && carrinhoAtual.lng) {
                    try {
                        analisarLocalizacao(idAtual, carrinhoAtual, msg, client, MessageMedia);
                    } catch (e) { console.error('Erro ao analisar localização salva:', e); }
                } else {
                    // Calcula taxa de entrega e total e mostra uma confirmação como no fluxo quando o usuário envia endereço
                    carrinhoAtual.valorEntrega = 7;
                    let totalGeral = valorTotal(idAtual);
                    carrinhoAtual.valorTotal = totalGeral;
                    msg.reply(
                        `${resp.msgEnderecoConfirma} \n➥ _${carrinhoAtual.endereco}_\n\n` +
                        `_Por favor, caso de interior envie *LOCALIZAÇÃO*._\n` +
                        `💸 Taxa de entrega: R$ ${carrinhoAtual.valorEntrega.toFixed(2)}\n` +
                        `🛒 *VALOR FINAL*: R$ ${totalGeral.toFixed(2)}\n\n` +
                        `Digite *S* para confirmar ou envie outro endereço.`
                    );
                }
                atualizarEstadoDoCarrinho(idAtual, stats.menuEndereço); // Chama o menu de endereço para confirmar com sim ou digitar novo endereço.
                return;
            }
            // Se havia um endereço salvo no DB, mas ele não passou na validação, limpar o valor no DB
            if (enderecoSalvo && !enderecoValido) {
                try {
                    console.warn(`[WARN] Endereço inválido no DB para ${idAtual}:`, enderecoSalvo, ' — limpando registro.');
                    if (typeof atualizarEnderecoClienteDB === 'function') {
                        atualizarEnderecoClienteDB(idAtual, null, null, null);
                    }
                } catch (e) { console.error('Erro ao limpar endereço inválido no DB:', e); }
                // Também garantir que o carrinho não tenha endereço para forçar coleta
                try { carrinhoAtual.endereco = null; } catch (e) {}
            }
            if (carrinhoAtual.endereco === undefined || carrinhoAtual.endereco === null) {
                // Se o endereço não foi definido, solicita ao cliente
                console.log('Solicitando endereço ao cliente:', idAtual);
                msg.reply(resp.msgPedindoEndereco);
                atualizarEstadoDoCarrinho(idAtual, stats.menuEndereço); // Chama o menu
                return; // Sai da função para aguardar o endereço
            }
            //calcular distancia pela longitude e latitude
            if (carrinhoAtual.lat && carrinhoAtual.lng && carrinhoAtual.endereco === 'LOCALIZAÇÃO') {
                analisarLocalizacao(idAtual, carrinhoAtual, msg, client, MessageMedia);
            } else {
                carrinhoAtual.valorEntrega = 7;
                let totalGeral = valorTotal(idAtual);
                carrinhoAtual.valorTotal = totalGeral;
                // Se o endereço não for uma localização, chama o menu de endereço
                msg.reply(
                    `${resp.msgEnderecoConfirma} \n➥ _${carrinhoAtual.endereco}_\n\n` +
                    `_Por favor, caso de interior envie *LOCALIZAÇÃO*._\n` +
                    `💸 Taxa de entrega: R$ ${carrinhoAtual.valorEntrega.toFixed(2)}\n` +
                    `🛒 *VALOR FINAL*: R$ ${totalGeral.toFixed(2)}\n\n` +
                    `Digite *S* para confirmar ou envie outro endereço.`
                );
            }
            atualizarEstadoDoCarrinho(idAtual, stats.menuEndereço); // Chama o menu de endereço
            break; // Fim do 'case 'finalizar''
        // --- Opções para Cancelar Último Item do Carrinho ---
        case 'c':
        case 'cancelar':
            console.log('Cliente cancelando último item do carrinho:', idAtual);
            if (carrinhoAtual.carrinho.length > 0) {
                carrinhoAtual.carrinho.pop(); // Remove o último item do carrinho
                if (carrinhoAtual.carrinho.length === 0) {
                    msg.reply('Seu carrinho está vazio. \n' + resp.msgmenuInicialSub);
                } else {
                    msg.reply(`${carrinhoView(idAtual)}${resp.msgmenuInicialSub}`);
                }
            } else {
                msg.reply('Seu carrinho já está vazio. \n' + resp.msgmenuInicialSub);
            }
            break;
        // --- Opções para o Menu de Bebidas ---
        case 'bebida':
        case 'beber':
        case 'bebidas':
        case 'b':
            console.log('Cliente acessando menu de bebidas:', idAtual);
            atualizarEstadoDoCarrinho(idAtual, stats.menuBebidas); // Altera o estado do carrinho para bebidas
            msg.reply(resp.msgMenuBebidas); // Envia a mensagem do menu de bebidas
            break;

        // --- Default: Exibir Cardápio e Mensagem Inicial ---
        default:
            /**
            if (carrinhoAtual.aprt === false) {
                carrinhoAtual.aprt = true;
                // Usando path.resolve para construir um caminho absoluto robusto para a raiz do projeto
                const rootPath = path.resolve(__dirname, '..', '..', '..');
                const cardapioPath = path.join(rootPath, 'cardapio.jpg');
                const cardapioPath2 = path.join(rootPath, 'cardapio2.jpg');
                const cardapioPath3 = path.join(rootPath, 'cardapio3.jpg');
                try {
                    // Verifica se o arquivo existe antes de tentar carregar
                    if (fs.existsSync(cardapioPath) && fs.existsSync(cardapioPath2) && fs.existsSync(cardapioPath3)) {
                        try {
                            console.log('Verificando arquivos do cardápio:', cardapioPath, cardapioPath2, cardapioPath3);
                            const cardapioMedia3 = MessageMedia.fromFilePath(cardapioPath3);
                            const cardapioMedia = MessageMedia.fromFilePath(cardapioPath);
                            const cardapioMedia2 = MessageMedia.fromFilePath(cardapioPath2);
                            // Envia as imagens do cardápio
                            client.sendMessage(msg.from, cardapioMedia3);
                            client.sendMessage(msg.from, cardapioMedia, { caption: `${resp.msgApresentacao}` });
                            client.sendMessage(msg.from, cardapioMedia2);
                        } catch (mediaError) {
                            console.error('❌ Erro ao serializar/enviar imagens do cardápio:', mediaError);
                            msg.reply(`${resp.msgApresentacao}\n\n[Erro ao processar as imagens do cardápio. Verifique se os arquivos estão íntegros e acessíveis.]`);
                        }
                    } else {
                        // Se o arquivo não existe, lança um erro para ser pego pelo catch
                        throw new Error('Arquivos de cardápio não encontrados no diretório raiz do projeto.');
                    }
                } catch (error) {
                    console.error('❌ Erro ao enviar imagens do cardápio:', error);
                    // Em caso de erro, envia uma mensagem de texto alternativa
                    msg.reply(`${resp.msgApresentacao}\n\n[As imagens do cardápio não puderam ser enviadas. Por favor, verifique se os arquivos estão na pasta correta.]`);
                }
                break;
            }*/
    }
}

/**
 * Retorna a hora atual.
 * @returns {number} A hora atual (0-23).
 */
function Hora() {
    return new Date().getHours();
}

// Exporta a função principal do menu inicial
module.exports = menuInicial;
