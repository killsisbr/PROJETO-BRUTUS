const { atualizarEstadoDoCarrinho,carrinhoAdm, salvarPedido, valorTotal, stats } = require('../../services/carrinhoService');
const { adicionarCliente } = require('../../services/clienteService');
const { mensagem } = require('../../utils/mensagens');
const resp = mensagem;
const idChatGrupo = require('../../utils/config').idChatGrupo;



async function menuNome(idAtual, carrinhoAtual, msg, nome, client) {
    if (carrinhoAtual.endereco) {
        carrinhoAtual.nome = nome;
        adicionarCliente(idAtual, nome, carrinhoAtual.endereco);
        msg.reply(`*VALOR TOTAL: ${valorTotal(idAtual)} REAIS.*\n${resp.msgMenuPagamento}`);
        atualizarEstadoDoCarrinho(idAtual, stats.menuPagamento);
    } else {
        carrinhoAtual.nome = nome;
        adicionarCliente(idAtual, nome);
        client.sendMessage(idChatGrupo, `${carrinhoAdm(idAtual)}*RETIRADA*`);
        msg.reply(`*PEDIDO ANOTADO*\n\n${nome}, _ao chegar no restaurante, mensione o pedido em seu Nome para uma atendente_.\n\nCaso queira deixar pago, digite *Pix*.`);
        salvarPedido(idAtual, 'VEM BUSCAR');
    }
}


module.exports = { menuNome };