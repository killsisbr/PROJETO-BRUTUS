const mensagens = require('../utils/mensagens');
const carrinhoService = require('../services/carrinhoService');
const resp = mensagens.mensagem;
const atualizarEstadoDoCarrinho = carrinhoService.atualizarEstadoDoCarrinho;
const menuInicial = require('./fluxo/menuGlobal');
const menuTroco = require('./fluxo/menuTroco').menuTroco;
const menuSuporte = require('./fluxo/menuSuporte').menuSuporte;
const { menuFinalizado } = require('./fluxo/menuFinalizado');
const { menuNome } = require('./fluxo/menuNome');
const { obterObservacao } = require('./fluxo/menuObservação');
const { analisarEndereço, analisarLocalizacao } = require('./menuEndereço');
const menuEntregaRetirada = require('./fluxo/menuEntregaRetirada');
const adicionarItemAoCarrinho = carrinhoService.adicionarItemAoCarrinho;
const menuFormaPagamento = require('./fluxo/menuPagamento').menuPagamento;
const carrinhoView = carrinhoService.carrinhoView;
const stats = carrinhoService.stats;
const esperarResposta = require('../utils/obterResposta').esperarResposta;

async function analisePorStatus(carrinhoAtual, msg, idAtual, client, MessageMedia) {
    try {
        
        switch (carrinhoAtual.estado) { //tratamento da mensagem por estado do carrinho.
            case stats.menuInicial:
                menuInicial(idAtual, carrinhoAtual, msg, client, MessageMedia);
                break;
            case stats.menuBebidas: //escolhe qual bebida
                let idBebida = await esperarResposta(carrinhoAtual);
                switch (idBebida) {
                    case 'n':
                    case 'N':
                    case 'Não':
                    case 'Nao':
                    case 'não':
                    case 'voltar':
                    case 'v':
                    case 'volta':
                    case 'retornar':
                        atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
                        msg.reply(`${carrinhoView(idAtual)}${resp.msgmenuInicialSub}`);
                        break;
                    default:
                        if (!isNaN(idBebida) && idBebida !== null) {
                            if (carrinhoAtual.alertIdBebida !== true) {
                                msg.reply(resp.msgQuantidade);
                                carrinhoAtual.idSelect = parseInt(idBebida);
                                atualizarEstadoDoCarrinho(idAtual, stats.menuUnidadeBebida);
                                carrinhoAtual.alertIdBebida = true;
                            }
                        } else {
                            msg.reply('Digite um número referente a bebida!');
                        }
                        break;
                }
                break;
            case stats.menuUnidadeBebida: //escolhe quantas dessa bebida
                let unidadeBebida = await esperarResposta(carrinhoAtual);
                if (!isNaN(unidadeBebida) && unidadeBebida !== null) {
                    adicionarItemAoCarrinho(idAtual, carrinhoAtual.idSelect, unidadeBebida, "", 'Bebida');
                    //console.log(carrinhoAtual.carrinho)
                    atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
                    msg.reply(`${carrinhoView(idAtual)}${resp.msgmenuInicialSub}`);
                } else {
                    if (carrinhoAtual.alertUnidadeBebida !== true) {
                        msg.reply("Você precisa digitar uma quantia valida!");
                        carrinhoAtual.alertUnidadeBebida = true;
                    }
                }
                break;
            case stats.menuEntregaRetirada:
                menuEntregaRetirada(idAtual, carrinhoAtual, msg, client);
                break;
            case stats.menuEndereço:
                let endereço = await esperarResposta(carrinhoAtual);
                analisarEndereço(idAtual, carrinhoAtual, endereço, msg);
        
                break;
            case stats.menuQuantidadeAdicionais:
                let quantidadeAdicionais = await esperarResposta(carrinhoAtual);
                if (!isNaN(quantidadeAdicionais) && quantidadeAdicionais !== null) {
                    adicionarItemAoCarrinho(idAtual, carrinhoAtual.idSelect, quantidadeAdicionais, '', 'Adicional');
                    msg.reply(`${carrinhoView(idAtual)}${resp.msgmenuInicialSub}`);
                    console.log(carrinhoAtual.carrinho);
                    atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
                } else {
                    msg.reply("Digite um número válido para a quantidade de adicionais.");
                }
                break;
            case stats.menuConfirmandoPedido:
                let observacao = await esperarResposta(carrinhoAtual);
                obterObservacao(idAtual, carrinhoAtual, observacao, msg, client);
                break;
            case stats.menuPagamento:
                let formaDePagamento = await esperarResposta(carrinhoAtual);
                menuFormaPagamento(idAtual, carrinhoAtual, formaDePagamento, msg, client);
                break;
            case stats.menuFinalizado:
                let msgfinal = await esperarResposta(carrinhoAtual);
                menuFinalizado(idAtual, carrinhoAtual, msg, msgfinal, client);
                break;
            case stats.menuSuporte: //menu suporte
                let suporte = await esperarResposta(carrinhoAtual);
                menuSuporte(msg, idAtual, suporte);
                break;
            case stats.menuNome: //resposta do nome
                let nome = await esperarResposta(carrinhoAtual);
                menuNome(idAtual, carrinhoAtual, msg, nome, client);
                break;
            case stats.menuTroco:
                let troco = await esperarResposta(carrinhoAtual);
                menuTroco(idAtual, carrinhoAtual, troco, msg, client);
                break;
        };
    } catch (error) {
        console.error('Erro ao analisar o estado do carrinho:', error);
    }
}
module.exports = analisePorStatus;