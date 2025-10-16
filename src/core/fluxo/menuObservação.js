const { mensagem } = require('../../utils/mensagens');
const resp = mensagem;
const { adicionarItemAoCarrinho, atualizarEstadoDoCarrinho, salvarPedido, carrinhoAdm, carrinhoView, stats, valorTotal } = require('../../services/carrinhoService');
const { obterInformacoesCliente } = require('../../services/clienteService');
const idChatGrupo = require('../../utils/config').idChatGrupo;


async function obterObservacao(idAtual, carrinhoAtual, observacao, msg, client) {
    if (observacao.toLowerCase() === 'voltar') { // Corrected to use function call .toLowerCase()
        if (carrinhoAtual.status !== 'finalizado') {
            if (carrinhoAtual.carrinho.length === 0) {
                msg.reply("Seu carrinho está vazio. Vamos começar um novo pedido!");
                msg.reply(resp.msgMenuMarmitas);
                atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
            } else {
                let mensagemCarrinhoAtualizada = carrinhoAtual.carrinho.map(item => `${item.quantidade}x ${item.nome} ${item.preparo}`).join('\n');
                msg.reply(`Seu Carrinho Atualizado:\n${mensagemCarrinhoAtualizada} \n${resp.msgmenuInicialSub}`);
                atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
            }
        } else {
            msg.reply('Você já finalizou seu pedido, pode pedir novamente: \nDigite *Novo*');
        }
        return; // Exit the function after handling 'voltar'
    }

    carrinhoAtual.observacaoConfirmada = true;
    carrinhoAtual.observacao = observacao;

    obterInformacoesCliente(idAtual, (err, dados) => {
        // First, check for an error returned by obterInformacoesCliente
        if (err) {
            console.error("Error obtaining client information:", err);
            msg.reply("Ocorreu um erro ao buscar suas informações. Por favor, tente novamente.");
            // Decide what state to set here, perhaps back to asking for name or initial menu
            atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
            return;
        }

        // Now, safely check if 'dados' is null or undefined before accessing properties
        if (dados && dados.nome) { // This safely checks if dados is not null/undefined AND if dados.nome exists
            carrinhoAtual.nome = dados.nome;
            
            // Verificar se é entrega ou retirada
            if (carrinhoAtual.entrega) {
                // É entrega, ir para pagamento
                msg.reply(`*VALOR TOTAL: ${valorTotal(idAtual)} REAIS.*\n${resp.msgMenuPagamento}`);
                atualizarEstadoDoCarrinho(idAtual, stats.menuPagamento);
            } else {
                // É retirada, finalizar diretamente
                carrinhoAtual.status = 'finalizado';
                carrinhoAtual.retirada = true;
                atualizarEstadoDoCarrinho(idAtual, stats.menuFinalizado);
                
                console.log('Pedido finalizado - retirada: ' + carrinhoAtual.retirada + ', status: ' + carrinhoAtual.status);
                msg.reply(`*PEDIDO ANOTADO* ✍🏻\n ${carrinhoAtual.nome}, ${resp.msgPedidoAnotado} \nChave pix: ${resp.msgChavePix}`);
                client.sendMessage(idChatGrupo, `${carrinhoAdm(idAtual)} *VEM BUSCAR*`);
                salvarPedido(idAtual, "VEM BUSCAR");
            }
        } else {
            // If 'dados' is null/undefined or 'dados.nome' is missing
            msg.reply(`${resp.msgPedindoNome}`);
            atualizarEstadoDoCarrinho(idAtual, stats.menuNome);
        }
    });
}

module.exports = { obterObservacao };