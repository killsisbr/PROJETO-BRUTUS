const { carrinhoView, atualizarEstadoDoCarrinho, obterCarrinho, valorTotal } = require('../../services/carrinhoService');
const { stats } = require('../../services/carrinhoService');
const { retiradaBalcaoConfig } = require('../../utils/config');
const resp = require('../../utils/mensagens');
const esperarResposta = require('../../utils/obterResposta').esperarResposta;
const { calcularDistanciaKm, calcularValorEntrega } = require('../../core/menuEndereço');

/**
 * Menu para escolha entre entrega e retirada no balcão
 * @param {string} idAtual - ID do cliente
 * @param {object} carrinhoAtual - Carrinho atual do cliente
 * @param {object} msg - Objeto da mensagem do WhatsApp
 * @param {object} client - Cliente do WhatsApp
 */
async function menuEntregaRetirada(idAtual, carrinhoAtual, msg, client) {
    // Marca como entrega por padrão (retirada desativada)
    carrinhoAtual.entrega = true;
    carrinhoAtual.retirada = false;
    
    // Vai para o menu de endereço
    atualizarEstadoDoCarrinho(idAtual, stats.menuEndereço);
    
    // Verifica se já tem endereço salvo
    if (carrinhoAtual.endereco) {
        // Calcular distância e valor de entrega para endereço salvo
        let valorEntrega = 0;
        if (carrinhoAtual.lat && carrinhoAtual.lng) {
            const distanciaKm = await calcularDistanciaKm(carrinhoAtual.lat, carrinhoAtual.lng);
            // Tratar caso de distância inválida
            if (isNaN(distanciaKm) || distanciaKm === 0) {
                valorEntrega = calcularValorEntrega(0); // Valor mínimo
            } else {
                valorEntrega = calcularValorEntrega(distanciaKm);
            }
        } else {
            // Se não tiver coordenadas, usar valor mínimo
            valorEntrega = calcularValorEntrega(0);
        }
        
        // Aplicar validações de segurança
        if (valorEntrega > 65 || isNaN(valorEntrega)) {
            valorEntrega = 7;
        }
        
        // Atualizar valores no carrinho
        carrinhoAtual.valorEntrega = valorEntrega;
        const totalCarrinho = valorTotal(idAtual);
        
        const enderecoTexto = typeof carrinhoAtual.endereco === 'string' 
            ? carrinhoAtual.endereco 
            : `${carrinhoAtual.endereco.endereco || 'Localização'} (${carrinhoAtual.lat}, ${carrinhoAtual.lng})`;
        
        msg.reply(`🚚 *Entrega selecionada!*

Endereço salvo: ${enderecoTexto}

` +
                 `💸 Taxa de entrega: R$ ${carrinhoAtual.valorEntrega.toFixed(2)}\n` +
                 `🛒 *VALOR FINAL*: R$ ${totalCarrinho.toFixed(2)}\n\n` +
                 `*S* - Confirmar este endereço\nCaso esteja errado, digite novamente.`);

        // Aguardar confirmação do endereço antes de prosseguir
        return;
    } else {
        msg.reply('🚚 *Entrega selecionada!*\n\nPor favor, digite seu endereço completo para calcularmos a taxa de entrega:');
    }
}

module.exports = menuEntregaRetirada;