const { Client, LocalAuth, MessageMedia, LegacySessionAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const carrinhoService = require('./src/services/carrinhoService');
// Real-time dashboard server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const clientService = require('./src/services/clienteService');
const mensagensService = require('./src/services/mensagensService');
const atualizarEstadoDoCarrinho = carrinhoService.atualizarEstadoDoCarrinho;
const mensagens = require('./src/utils/mensagens');
const core = require('./src/core/analisePalavras');
const carrinhoView = carrinhoService.carrinhoView;
const atualizarEnderecoCliente = carrinhoService.atualizarEnderecoCliente;
const atualizarNomeCliente = clientService.atualizarNomeCliente;
const printarClientes = clientService.printarClientes;
const obterInformacoesCliente = clientService.obterInformacoesCliente;
const analisarPalavras = core.analisarPalavras;
const separarMensagem = core.separarMensagem;
const resp = mensagens.mensagem;
const carrinhos = carrinhoService.carrinhos;
const events = carrinhoService.events; // EventEmitter para atualizações
const cardapioService = require('./src/services/cardapioService');
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
      // remove propriedades internas/privadas
      if (k && typeof k === 'string' && k.startsWith('_')) continue;
      const val = v[k];
      if (typeof val === 'function') continue;
      // Timeout objects and other native handles can cause circular serialization; skip common ones
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
const analisePorStatus = require('./src/core/analisePorStatus');
const menuInicial = require('./src/core/fluxo/menuGlobal');
const { error } = require('console');
const resetCarrinho = carrinhoService.resetCarrinho;
let obterUnidade = require('./src/utils/obterUnidade').obterUnidade;

// Estado do cliente WhatsApp
let isReady = false;

// Gatilhos personalizados (declaração antecipada para evitar acessos antes da inicialização)
let gatilhosPersonalizados = {};

// Middleware para parsing JSON
app.use(express.json());

// Funções auxiliares para persistência - mensagens agora são salvas automaticamente no banco de dados

function salvarGatilhos() {
  try {
    const gatilhosPath = path.join(__dirname, 'data', 'gatilhos.json');
    
    // Criar diretório data se não existir
    const dataDir = path.dirname(gatilhosPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    fs.writeFileSync(gatilhosPath, JSON.stringify(gatilhosPersonalizados, null, 2), 'utf8');
    console.log('✅ Gatilhos salvos com sucesso');
  } catch (error) {
    console.error('❌ Erro ao salvar gatilhos:', error);
  }
}

function carregarGatilhos() {
  try {
    const gatilhosPath = path.join(__dirname, 'data', 'gatilhos.json');
    if (fs.existsSync(gatilhosPath)) {
      const dados = fs.readFileSync(gatilhosPath, 'utf8');
      gatilhosPersonalizados = JSON.parse(dados);
      console.log('✅ Gatilhos carregados com sucesso');
    }
  } catch (error) {
    console.error('❌ Erro ao carregar gatilhos:', error);
    gatilhosPersonalizados = {};
  }
}

// Helper: tenta obter info do cliente de forma compatível (sync ou callback)
async function obterInformacoesClienteAsync(id) {
  try {
    // Tenta retorno síncrono
    const maybe = obterInformacoesCliente(id);
    if (maybe && typeof maybe === 'object') return maybe;

    // Tenta a versão callback
    return await new Promise((resolve) => {
      let finished = false;
      try {
        obterInformacoesCliente(id, (err, info) => {
          if (finished) return;
          finished = true;
          if (err) return resolve(null);
          return resolve(info || null);
        });
      } catch (e) {
        // Se lançar, não quebra
        finished = true;
        return resolve(null);
      }

      // Fallback timeout rápido
      setTimeout(() => { if (!finished) { finished = true; resolve(null); } }, 300);
    });
  } catch (e) {
    return null;
  }
}

// Função para verificar gatilhos personalizados
async function verificarGatilhosPersonalizados(mensagem, msg, idAtual) {
  // Normaliza texto: minusculas, remove acentos, pontuação e colapsa espaços
  const normalize = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacríticos
    .replace(/[^\w\s]/g, ' ') // substitui pontuação por espaço
    .replace(/\s+/g, ' ')
    .trim();

  const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const normalizedMsg = normalize(mensagem);
  const messageTokens = normalizedMsg.split(/\s+/).filter(Boolean);

  for (const [id, gatilho] of Object.entries(gatilhosPersonalizados)) {
    let encontrou = false;

    for (const palavraRaw of (gatilho.palavras || [])) {
      const palavra = normalize(palavraRaw);
      if (!palavra) continue;

      if (/\s+/.test(palavra)) {
        // frase composta: busca a frase inteira com limites de palavra
        const phrasePattern = '\\b' + palavra.split(/\s+/).map(p => escapeRegex(p)).join('\\s+') + '\\b';
        const re = new RegExp(phrasePattern, 'i');
        if (re.test(normalizedMsg)) { encontrou = true; break; }
      } else {
        // palavra simples: exige igualdade com um token da mensagem (evita includes)
        if (messageTokens.includes(palavra)) { encontrou = true; break; }
      }
    }

    if (!encontrou) continue;

    // Incrementar contador de usos
    gatilho.usos = (gatilho.usos || 0) + 1;
    salvarGatilhos();

    console.log(`[GATILHO] encontrado para ${idAtual} -> palavras=${JSON.stringify(gatilho.palavras)} acao=${gatilho.acao} mensagem=${gatilho.mensagem}`);

    // Resolver a resposta do gatilho (suporte a string ou objeto {conteudo})
    let resposta = null;
    if (mensagens.mensagem && Object.prototype.hasOwnProperty.call(mensagens.mensagem, gatilho.mensagem)) {
      const entry = mensagens.mensagem[gatilho.mensagem];
      if (typeof entry === 'string') resposta = entry;
      else if (entry && typeof entry === 'object' && entry.conteudo) resposta = entry.conteudo;
    }

    // Se não encontramos uma key, talvez o gatilho.mensagem já seja o texto literal
    if (!resposta && typeof gatilho.mensagem === 'string') resposta = gatilho.mensagem;

    // Enviar resposta, substituindo placeholders (tentativa async de obter nome)
    if (resposta) {
      try {
        let nomeCliente = '';
        try {
          const info = await obterInformacoesClienteAsync(idAtual);
          if (info && info.nome) nomeCliente = info.nome;
        } catch (e) { /* ignore se DB não estiver pronto */ }

        const textoFinal = (resposta || '').replace(/@nome/ig, nomeCliente || '');
        try { msg.reply(textoFinal); } catch (e) { console.error('Erro ao enviar resposta de gatilho:', e); }
      } catch (e) {
        console.error('Erro ao preparar resposta de gatilho:', e);
      }
    }

    // Executar ação do gatilho se existir
    if (gatilho.acao) {
      executarAcaoGatilho(gatilho.acao, msg, idAtual);
    }

    return true; // Gatilho encontrado e tratado
  }

  return false; // Nenhum gatilho encontrado
}

// Função para executar ações específicas dos gatilhos
function executarAcaoGatilho(acao, msg, idAtual) {
  switch (acao) {
    case 'transferir_humano':
      console.log('🤝 Transferindo para atendente humano...');
      // Implementar lógica de transferência
      break;
      
    case 'resetar_conversa':
    case 'resetar_carrinho':
    case 'resetar-carrinho':
    case 'resetarCarrinho':
    case 'reset':
      try {
        // Tenta resetar o carrinho do cliente usando o serviço
        if (typeof resetCarrinho === 'function') {
          resetCarrinho(idAtual, carrinhos[idAtual]);
          try { msg.reply('🔄 Carrinho reiniciado. Como posso ajudá-lo?'); } catch (e) {}
          console.log(`[ACAO] reset acionado para ${idAtual}`);
        } else {
          console.warn('[ACAO] reset requisitado, mas resetCarrinho não está disponível');
        }
      } catch (e) {
        console.error('Erro ao executar ação de reset:', e);
      }
      break;
    
    case 'mostrar_cardapio':
      try {
        // evita envios duplicados muito próximos (quando gatilho e análise disparam juntos)
        try {
          const idCheck = msg.from.replace('@c.us','');
          if (!carrinhos[idCheck]) { if (carrinhoService && typeof carrinhoService.initCarrinho === 'function') carrinhoService.initCarrinho(idCheck); }
          const last = (carrinhos[idCheck] && carrinhos[idCheck].lastCardapioSent) || 0;
          const now = Date.now();
          const COOLDOWN = 3000; // ms
          if (now - last < COOLDOWN) {
            console.log(`[ACAO] mostrar_cardapio ignorado (cooldown) para ${idCheck}`);
            break;
          }
          carrinhos[idCheck].lastCardapioSent = now;
        } catch(e) { /* não bloqueia */ }
        // Envia as imagens do cardápio como na análise de palavras
        const cardapioMedia = MessageMedia.fromFilePath('./cardapio.jpg');
        const cardapioMedia2 = MessageMedia.fromFilePath('./cardapio2.jpg');
        // terceiro arquivo opcional
        let cardapioMedia3 = null;
        try { cardapioMedia3 = MessageMedia.fromFilePath('./cardapio3.jpg'); } catch (e) { /* opcional */ }

        // Envia com legenda na primeira imagem
        if (typeof client !== 'undefined' && client) {
          const caption = `Olá! Aqui está o nosso cardápio. Para pedir, basta me dizer o que você gostaria! 🍔`;
          client.sendMessage(msg.from, cardapioMedia, { caption }).then((sent)=>{
            try {
              const id = msg.from.replace('@c.us','');
              if (!carrinhos[id]) { if (carrinhoService && typeof carrinhoService.initCarrinho === 'function') carrinhoService.initCarrinho(id); }
                if (carrinhos[id]) {
                if (!carrinhos[id].messages) carrinhos[id].messages = [];
                carrinhos[id].messages.push({ fromMe: true, text: caption, timestamp: Date.now() });
                if (carrinhos[id].messages.length > 200) carrinhos[id].messages.shift();
                try { events.emit('update', { type: 'message', id, message: { fromMe: true, text: caption, timestamp: Date.now() }, carrinho: sanitizeCarrinho(carrinhos[id]) }); } catch(e){}
              }
            } catch(e){}
          }).catch(()=>{});

          client.sendMessage(msg.from, cardapioMedia2).then((sent)=>{
            try {
              const id = msg.from.replace('@c.us','');
                if (carrinhos[id]) {
                if (!carrinhos[id].messages) carrinhos[id].messages = [];
                carrinhos[id].messages.push({ fromMe: true, text: 'Imagem do cardápio (parte 2)', timestamp: Date.now() });
                if (carrinhos[id].messages.length > 200) carrinhos[id].messages.shift();
                try { events.emit('update', { type: 'message', id, message: { fromMe: true, text: 'Imagem do cardápio (parte 2)', timestamp: Date.now() }, carrinho: sanitizeCarrinho(carrinhos[id]) }); } catch(e){}
              }
            } catch(e){}
          }).catch(()=>{});
          if (cardapioMedia3) client.sendMessage(msg.from, cardapioMedia3).then((sent)=>{
            try {
              const id = msg.from.replace('@c.us','');
                if (carrinhos[id]) {
                if (!carrinhos[id].messages) carrinhos[id].messages = [];
                carrinhos[id].messages.push({ fromMe: true, text: 'Imagem do cardápio (parte 3)', timestamp: Date.now() });
                if (carrinhos[id].messages.length > 200) carrinhos[id].messages.shift();
                try { events.emit('update', { type: 'message', id, message: { fromMe: true, text: 'Imagem do cardápio (parte 3)', timestamp: Date.now() }, carrinho: sanitizeCarrinho(carrinhos[id]) }); } catch(e){}
              }
            } catch(e){}
          }).catch(()=>{});
        } else {
          // Fallback: responde texto caso client não esteja disponível
          msg.reply('Aqui está o cardápio: (imagens indisponíveis no momento).');
        }

        if (carrinhos[idAtual]) carrinhos[idAtual].aprt = true;
      } catch (e) {
        console.error('Erro ao executar ação mostrar_cardapio:', e);
      }
      break;
  }
}

clientService.createBanco();

// Inicializar serviço de mensagens de forma assíncrona
(async () => {
    try {
        await mensagensService.init();
        console.log('[SISTEMA] MensagensService inicializado com sucesso');
    } catch (error) {
        console.error('[SISTEMA] Erro ao inicializar MensagensService:', error);
    }
})();

// Importar sistema de mensagens para invalidar cache
const { refreshMensagens } = require('./src/utils/mensagens');

// Carregar gatilhos personalizados
carregarGatilhos();

// --- Configura servidor de dashboard (admin) ---
const publicDir = path.join(process.cwd(), 'public');

// API simples para recuperar o estado atual dos carrinhos (útil para o dashboard)
app.get('/api/carrinhos', (req, res) => {
  try {
    res.json({ carrinhos });
  } catch (err) {
    res.status(500).json({ error: 'failed to read carrinhos' });
  }
});

// APIs para gerenciar fluxo de mensagens
app.get('/api/fluxo', (req, res) => {
  try {
    // Retornar informações sobre o fluxo de mensagens
    const mensagens = mensagensService.getAllMensagens();
    const gatilhos = mensagensService.getAllGatilhos();
    
    // Organizar o fluxo por tipos de mensagens
    const fluxo = {
      boasVindas: mensagens.filter(m => m.chave.includes('BoasVindas') || m.chave.includes('Apresentacao')),
      menuPrincipal: mensagens.filter(m => m.chave.includes('Menu') && !m.chave.includes('Confirmacao')),
      confirmacoes: mensagens.filter(m => m.chave.includes('Confirmacao')),
      gatilhos: gatilhos
    };
    
    res.json(fluxo);
  } catch (err) {
    console.error('[API] /api/fluxo -> erro:', err);
    res.status(500).json({ error: 'Erro ao buscar fluxo' });
  }
});

// APIs para gerenciar mensagens
app.get('/api/mensagens', (req, res) => {
  console.log('[API] /api/mensagens -> chamada recebida');
  try {
    const mensagens = mensagensService.getAllMensagens();
    console.log('[API] /api/mensagens -> mensagens encontradas:', mensagens.length);
    res.json(mensagens);
  } catch (err) {
    console.error('[API] /api/mensagens -> erro:', err);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

app.post('/api/mensagens', (req, res) => {
  try {
    const { chave, titulo, conteudo, tipo } = req.body;
    if (!chave || !titulo || !conteudo) {
      return res.status(400).json({ error: 'Chave, título e conteúdo são obrigatórios' });
    }
    
    const result = mensagensService.addMensagem({ chave, titulo, conteudo, tipo });
    refreshMensagens(); // Invalidar cache de mensagens
    io.emit('mensagem-atualizada', { id: result.lastInsertRowid, acao: 'criada' });
    
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Erro ao salvar mensagem:', err);
    res.status(500).json({ error: 'Erro ao salvar mensagem' });
  }
});

app.put('/api/mensagens/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, conteudo, tipo, ativo } = req.body;
    
    if (!titulo || !conteudo) {
      return res.status(400).json({ error: 'Título e conteúdo são obrigatórios' });
    }
    
    const result = mensagensService.updateMensagem(id, { titulo, conteudo, tipo, ativo });
    
    if (result.changes > 0) {
      refreshMensagens(); // Invalidar cache de mensagens
      io.emit('mensagem-atualizada', { id, acao: 'atualizada' });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Mensagem não encontrada' });
    }
  } catch (err) {
    console.error('Erro ao atualizar mensagem:', err);
    res.status(500).json({ error: 'Erro ao atualizar mensagem' });
  }
});

app.delete('/api/mensagens/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = mensagensService.deleteMensagem(id);
    
    if (result.changes > 0) {
      refreshMensagens(); // Invalidar cache de mensagens
      io.emit('mensagem-atualizada', { id, acao: 'excluida' });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Mensagem não encontrada' });
    }
  } catch (err) {
    console.error('Erro ao excluir mensagem:', err);
    res.status(500).json({ error: 'Erro ao excluir mensagem' });
  }
});

// APIs para gerenciar gatilhos

app.get('/api/gatilhos', (req, res) => {
  try {
    const gatilhos = mensagensService.getAllGatilhos();
    res.json(gatilhos);
  } catch (err) {
    console.error('Erro ao buscar gatilhos:', err);
    res.status(500).json({ error: 'Erro ao buscar gatilhos' });
  }
});

app.post('/api/gatilhos', (req, res) => {
  try {
    const { palavra, mensagem_id, categoria } = req.body;
    if (!palavra || !mensagem_id) {
      return res.status(400).json({ error: 'Palavra e mensagem são obrigatórios' });
    }
    
    const result = mensagensService.addGatilho({ palavra, mensagem_id, categoria });
    io.emit('gatilho-atualizado', { id: result.lastInsertRowid, acao: 'criado' });
    
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Erro ao salvar gatilho:', err);
    res.status(500).json({ error: 'Erro ao salvar gatilho' });
  }
});

app.put('/api/gatilhos/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { palavra, mensagem_id, categoria, ativo } = req.body;
    
    if (!palavra || !mensagem_id) {
      return res.status(400).json({ error: 'Palavra e mensagem são obrigatórios' });
    }
    
    const result = mensagensService.updateGatilho(id, { palavra, mensagem_id, categoria, ativo });
    
    if (result.changes > 0) {
      io.emit('gatilho-atualizado', { id, acao: 'atualizado' });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Gatilho não encontrado' });
    }
  } catch (err) {
    console.error('Erro ao atualizar gatilho:', err);
    res.status(500).json({ error: 'Erro ao atualizar gatilho' });
  }
});

app.delete('/api/gatilhos/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = mensagensService.deleteGatilho(id);
    
    if (result.changes > 0) {
      io.emit('gatilho-atualizado', { id, acao: 'excluido' });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Gatilho não encontrado' });
    }
  } catch (err) {
    console.error('Erro ao excluir gatilho:', err);
    res.status(500).json({ error: 'Erro ao excluir gatilho' });
  }
});

// API para estatísticas
app.get('/api/estatisticas', (req, res) => {
  try {
    const hoje = new Date().toDateString();
    const totalCarrinhos = Object.keys(carrinhos).length;
    
    res.json({
      totalMensagens: Object.keys(mensagens.mensagem || {}).length,
      totalGatilhos: Object.keys(gatilhosPersonalizados).length,
      mensagensHoje: 0, // Implementar contador de mensagens por dia
      usuariosAtivos: totalCarrinhos
    });
  } catch (err) {
    res.status(500).json({ error: 'failed to read estatisticas' });
  }
});

// Cardapio REST API
app.get('/api/cardapio', async (req, res) => {
  try {
    await cardapioService.init();
    const items = cardapioService.getItems();
    res.json({ ok: true, items });
  } catch (e) { console.error('/api/cardapio GET error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/api/cardapio', async (req, res) => {
  try {
    const { nome, descricao, preco, tipo } = req.body || {};
    if (!nome) return res.status(400).json({ ok: false, error: 'missing_nome' });
    await cardapioService.init();
    const id = cardapioService.addItem({ nome, descricao, preco, tipo });
    if (!id) return res.status(500).json({ ok: false, error: 'insert_failed' });
    // broadcast items update
    try { const items = cardapioService.getItems(); io.emit('admin:cardapio', { ok: true, items }); } catch(e){}
    res.json({ ok: true, id });
  } catch (e) { console.error('/api/cardapio POST error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

app.put('/api/cardapio/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, descricao, preco, tipo } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    if (!nome) return res.status(400).json({ ok: false, error: 'missing_nome' });
    await cardapioService.init();
    
    // Verificar se o item existe
    const items = cardapioService.getItems();
    const existingItem = items.find(item => item.id === Number(id));
    if (!existingItem) return res.status(404).json({ ok: false, error: 'item_not_found' });
    
    // Atualizar o item
    const updatedItem = { ...existingItem, nome, descricao, preco, tipo };
    const ok = cardapioService.updateItem(Number(id), updatedItem);
    
    if (ok) {
      // broadcast items update
      try { const items = cardapioService.getItems(); io.emit('admin:cardapio', { ok: true, items }); } catch(e){}
      res.json({ ok: true, item: updatedItem });
    } else {
      res.status(500).json({ ok: false, error: 'update_failed' });
    }
  } catch (e) { console.error('/api/cardapio PUT error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

app.delete('/api/cardapio/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    await cardapioService.init();
    const ok = cardapioService.removeItem(Number(id));
    try { const items = cardapioService.getItems(); io.emit('admin:cardapio', { ok: true, items }); } catch(e){}
    res.json({ ok: !!ok });
  } catch (e) { console.error('/api/cardapio DELETE error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// mappings REST
app.get('/api/cardapio/mappings', async (req, res) => {
  try {
    await cardapioService.init();
    const mappings = cardapioService.getMappings();
    res.json({ ok: true, mappings });
  } catch (e) { console.error('/api/cardapio/mappings GET error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// Rota para verificar se um item com o mesmo nome já existe
app.get('/api/cardapio/check-name/:nome', async (req, res) => {
  try {
    const nome = req.params.nome;
    const excludeId = req.query.excludeId; // ID a ser excluído da verificação (para edição)
    
    if (!nome) return res.status(400).json({ ok: false, error: 'missing_nome' });
    
    await cardapioService.init();
    const existingItem = cardapioService.findItemByName(nome, excludeId);
    
    res.json({ ok: true, exists: !!existingItem, item: existingItem || null });
  } catch (e) { 
    console.error('/api/cardapio/check-name GET error', e); 
    res.status(500).json({ ok: false, error: String(e) }); 
  }
});

app.post('/api/cardapio/mappings', async (req, res) => {
  try {
    const { nome, itemId } = req.body || {};
    if (!nome || !itemId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    await cardapioService.init();
    const ok = cardapioService.addMapping(nome, Number(itemId));
    // broadcast
    try { const mappings = cardapioService.getMappings(); io.emit('admin:mappings', { ok: true, mappings }); } catch(e){}
    res.json({ ok: !!ok });
  } catch (e) { console.error('/api/cardapio/mappings POST error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// API para adicionar múltiplos gatilhos de uma vez
app.post('/api/cardapio/mappings/multiple', async (req, res) => {
  try {
    const { gatilhos, itemId } = req.body || {};
    if (!Array.isArray(gatilhos) || !itemId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    await cardapioService.init();
    const ok = cardapioService.addMultipleMappings(gatilhos, Number(itemId));
    // broadcast
    try { const mappings = cardapioService.getMappings(); io.emit('admin:mappings', { ok: true, mappings }); } catch(e){}
    res.json({ ok: !!ok });
  } catch (e) { console.error('/api/cardapio/mappings/multiple POST error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// API para obter gatilhos de um item específico
app.get('/api/cardapio/mappings/item/:id', async (req, res) => {
  try {
    const itemId = req.params.id;
    if (!itemId) return res.status(400).json({ ok: false, error: 'missing_id' });
    await cardapioService.init();
    const gatilhos = cardapioService.getMappingsByItemId(Number(itemId));
    res.json({ ok: true, gatilhos });
  } catch (e) { console.error('/api/cardapio/mappings/item GET error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

app.delete('/api/cardapio/mappings/:nome', async (req, res) => {
  try {
    const nome = req.params.nome;
    if (!nome) return res.status(400).json({ ok: false, error: 'missing_nome' });
    await cardapioService.init();
    const ok = cardapioService.removeMapping(nome);
    try { const mappings = cardapioService.getMappings(); io.emit('admin:mappings', { ok: true, mappings }); } catch(e){}
    res.json({ ok: !!ok });
  } catch (e) { console.error('/api/cardapio/mappings DELETE error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// DELETE all mappings (reset)
app.delete('/api/cardapio/mappings', async (req, res) => {
  try {
    await cardapioService.init();
    const ok = cardapioService.clearAllMappings();
    try { io.emit('admin:mappings', { ok: true, mappings: {} }); } catch(e){}
    res.json({ ok: !!ok, message: 'All mappings cleared' });
  } catch (e) { console.error('/api/cardapio/mappings DELETE (all) error', e); res.status(500).json({ ok: false, error: String(e) }); }
});

// API: listar pedidos por estado (genérico). Útil para painel admin (ex: entregues)
app.get('/api/pedidos', async (req, res) => {
  try {
    const estado = req.query.estado || null;
    const pedidos = clientService.obterPedidosPorEstado ? clientService.obterPedidosPorEstado(estado) : [];
    res.json({ ok: true, pedidos });
  } catch (err) {
    console.error('Erro /api/pedidos', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Conveniência: rota específica para "entregues" (saiu_para_entrega)
app.get('/api/pedidos/entregues', async (req, res) => {
  try {
    // Buscar de forma mais tolerante: se houver estado query, use ele; caso contrário, retorna pedidos
    // cujo estado contenha 'saiu' ou 'entreg' (cobre variações como 'saiu_para_entrega' ou 'entregue')
    const qEstado = req.query.estado || null;
    let pedidos = [];
    if (qEstado && clientService.obterPedidosPorEstado) {
      pedidos = clientService.obterPedidosPorEstado(qEstado);
    } else if (clientService.obterPedidosPorEstado) {
      // busca todos e filtra localmente para ser mais permissivo
      const all = clientService.obterPedidosPorEstado(null);
      pedidos = (all || []).filter(p => {
        if (!p || !p.estado) return false;
        const e = String(p.estado).toLowerCase();
        return e.includes('saiu') || e.includes('entreg');
      });
    }

    // NOVO: Filtrar apenas pedidos de hoje
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const todayEnd = todayStart + (24 * 60 * 60 * 1000) - 1;
    
    pedidos = pedidos.filter(p => {
      if (!p || !p.ts) return false;
      const pedidoTime = new Date(p.ts).getTime();
      return pedidoTime >= todayStart && pedidoTime <= todayEnd;
    });
    try {
      // Debug: log how many pedidos were found for entregues and the first few ids
      const ids = (pedidos || []).slice(0, 10).map(p => p && (p.id || p.numero || p.idpedido || '(unknown)'));
      console.log(`[API] /api/pedidos/entregues -> encontrados ${ (pedidos || []).length } pedidos. amostra ids: ${JSON.stringify(ids)}`);
    } catch (e) { console.error('[API] erro logando entregues debug', e); }
    // If DB returned empty, try in-memory fallback from carrinhos to avoid UI races
    if ((!pedidos || pedidos.length === 0) && carrinhos && Object.keys(carrinhos).length > 0) {
      try {
        const fallback = [];
        for (const k of Object.keys(carrinhos)) {
          try {
            const c = carrinhos[k];
            const estado = (c && c.estado) ? String(c.estado).toLowerCase() : '';
            if (estado.includes('saiu') || estado.includes('entreg')) {
              const carrinhoTime = (c && c.ts) || Date.now();
              // Filtrar apenas carrinhos de hoje
              if (carrinhoTime >= todayStart && carrinhoTime <= todayEnd) {
                fallback.push({ id: c._pedidoId || `${k}_${carrinhoTime}`, cliente: k.replace(/@s\.whatsapp\.net$/,'').replace(/@c\.us$/,''), ts: carrinhoTime, total: Number(c.valorTotal||0), endereco: c.endereco || null, estado: c.estado, items: c.carrinho || [] });
              }
            }
          } catch (e) { /* per-item ignore */ }
        }
        if (fallback.length > 0) {
          try { console.log('[API] /api/pedidos/entregues -> usando fallback em-mem com', fallback.length, 'itens'); } catch(e){}
          return res.json({ ok: true, pedidos: fallback });
        }
      } catch (e) { console.error('[API] entregues fallback error', e); }
    }
    res.json({ ok: true, pedidos });
  } catch (err) {
    console.error('Erro /api/pedidos/entregues', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API para obter estatísticas do sistema
app.get('/api/estatisticas', (req, res) => {
  try {
    // Obter todos os pedidos
    const allPedidos = clientService.obterPedidosPorEstado ? clientService.obterPedidosPorEstado(null) : [];
    
    // Calcular estatísticas
    const hoje = new Date();
    const inicioHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).getTime();
    
    // Pedidos de hoje
    const pedidosHoje = allPedidos.filter(p => {
      if (!p || !p.ts) return false;
      const pedidoTime = new Date(p.ts).getTime();
      return pedidoTime >= inicioHoje;
    }).length;
    
    // Pedidos deste mês
    const pedidosMes = allPedidos.filter(p => {
      if (!p || !p.ts) return false;
      const pedidoTime = new Date(p.ts).getTime();
      return pedidoTime >= inicioMes;
    }).length;
    
    // Ticket médio
    let ticketMedio = 0;
    if (allPedidos.length > 0) {
      const totalValor = allPedidos.reduce((sum, p) => sum + (parseFloat(p.total) || 0), 0);
      ticketMedio = totalValor / allPedidos.length;
    }
    
    // Média de pedidos por dia (últimos 30 dias)
    let mediaPedidosDia = 0;
    const inicio30Dias = new Date(hoje);
    inicio30Dias.setDate(hoje.getDate() - 30);
    
    const pedidos30Dias = allPedidos.filter(p => {
      if (!p || !p.ts) return false;
      const pedidoTime = new Date(p.ts).getTime();
      return pedidoTime >= inicio30Dias.getTime();
    });
    
    if (pedidos30Dias.length > 0) {
      mediaPedidosDia = pedidos30Dias.length / 30;
    }
    
    res.json({
      totalMensagens: Object.keys(mensagens.mensagem || {}).length,
      totalGatilhos: Object.keys(gatilhosPersonalizados).length,
      mensagensHoje: 0, // Implementar contador de mensagens por dia
      usuariosAtivos: Object.keys(carrinhos).length,
      pedidosHoje,
      pedidosMes,
      ticketMedio,
      mediaPedidosDia: mediaPedidosDia.toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: 'failed to read estatisticas' });
  }
});

// API para backup do banco de dados
app.get('/api/backup', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Caminho do banco de dados
    const dbPath = clientService.caminhoBanco;
    
    if (!dbPath || !fs.existsSync(dbPath)) {
      return res.status(404).json({ ok: false, error: 'Banco de dados não encontrado' });
    }
    
    // Ler o arquivo do banco de dados
    const dbData = fs.readFileSync(dbPath);
    
    // Definir cabeçalhos para download
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="backup-clientes-${timestamp}.db"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Enviar o arquivo
    res.send(dbData);
  } catch (err) {
    console.error('Erro ao fazer backup:', err);
    res.status(500).json({ ok: false, error: 'Erro ao fazer backup' });
  }
});

// API: totais do dia para o dashboard (total em produtos e total de entregas finalizadas hoje)
app.get('/api/pedidos/totais-dia', (req, res) => {
  try {
    console.log('[API] /api/pedidos/totais-dia -> chamada recebida');
    const all = (clientService && typeof clientService.obterPedidosPorEstado === 'function') ? clientService.obterPedidosPorEstado(null) : [];
    console.log('[API] /api/pedidos/totais-dia -> pedidos encontrados:', all.length);
    const today = new Date();
    const todayKey = today.toDateString();
    let totalProdutos = 0;
    let totalEntregues = 0;
    let countProdutos = 0;
    let countEntregues = 0;

    // Processar pedidos do banco de dados
    for (const p of all) {
      try {
        if (!p || !p.ts) continue;
        const pDate = new Date(p.ts);
        if (pDate.toDateString() !== todayKey) continue;
        
        const valorTotal = parseFloat(p.total) || 0;
        const temEntrega = p.entrega === 1;
        
        if (p.estado === 'saiu_para_entrega' || p.estado === 'entregue' || p.estado === 'finalizado') {
          // Para pedidos finalizados/entregues, separar valor de produtos e entrega
          if (temEntrega) {
            // Estimar taxa de entrega (assumindo R$ 7,00 como padrão se não especificado)
            const taxaEntrega = 7.00; // Pode ser ajustado conforme necessário
            const valorProdutos = Math.max(0, valorTotal - taxaEntrega);
            totalProdutos += valorProdutos;
            totalEntregues += taxaEntrega;
            countEntregues++;
          } else {
            // Pedido sem entrega (retirada), todo valor vai para produtos
            totalProdutos += valorTotal;
            countProdutos++;
          }
        } else {
          // Pedidos em outros estados - todo valor conta como produtos
          totalProdutos += valorTotal;
          countProdutos++;
        }
      } catch (e) {
        console.error('[API] Erro ao processar pedido:', e);
      }
    }

    let payload = {
      ok: true,
      totalProdutos: parseFloat(totalProdutos.toFixed(2)),
      totalEntregues: parseFloat(totalEntregues.toFixed(2)),
      countProdutos,
      countEntregues
    };

    // Fallback para dados em memória se o banco retornar zeros
    if (totalProdutos === 0 && totalEntregues === 0 && carrinhos) {
      console.log('[API] Usando fallback para dados em memória');
      let memTotalProdutos = 0;
      let memTotalEntregues = 0;
      let memCountProdutos = 0;
      let memCountEntregues = 0;

      for (const [key, carrinho] of Object.entries(carrinhos)) {
        try {
          if (!carrinho || !carrinho.ts) continue;
          const cDate = new Date(carrinho.ts);
          if (cDate.toDateString() !== todayKey) continue;

          const valorTotal = parseFloat(carrinho.valorTotal) || 0;
          const valorEntrega = parseFloat(carrinho.valorEntrega) || 0;
          const temEntrega = carrinho.entrega || valorEntrega > 0;
          
          if (carrinho.estado === 'saiu_para_entrega' || carrinho.estado === 'entregue' || carrinho.estado === 'finalizado') {
            // Para pedidos finalizados/entregues, separar valor de produtos e entrega
            if (temEntrega) {
              const taxaEntrega = valorEntrega > 0 ? valorEntrega : 7.00;
              const valorProdutos = Math.max(0, valorTotal - taxaEntrega);
              memTotalProdutos += valorProdutos;
              memTotalEntregues += taxaEntrega;
              memCountEntregues++;
            } else {
              // Pedido sem entrega (retirada), todo valor vai para produtos
              memTotalProdutos += valorTotal;
              memCountProdutos++;
            }
          } else {
            // Pedidos em outros estados - todo valor conta como produtos
            memTotalProdutos += valorTotal;
            memCountProdutos++;
          }
        } catch (e) {
          console.error('[API] Erro ao processar carrinho em memória:', e);
        }
      }

      payload = {
        ok: true,
        totalProdutos: parseFloat(memTotalProdutos.toFixed(2)),
        totalEntregues: parseFloat(memTotalEntregues.toFixed(2)),
        countProdutos: memCountProdutos,
        countEntregues: memCountEntregues
      };
    }

    console.log('[API] /api/pedidos/totais-dia -> resposta:', payload);
    res.json(payload);
  } catch (err) {
    console.error('[API] Erro em /api/pedidos/totais-dia:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API: obter pedido por id (tenta DB, senão fallback em memória)
app.get('/api/pedidos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    let pedido = null;
    try {
      if (clientService && typeof clientService.obterPedidoPorId === 'function') {
        pedido = clientService.obterPedidoPorId(id);
      }
    } catch (e) { pedido = null; }
    // fallback: try in-memory carrinhos looking for matching _pedidoId or id pattern
    if (!pedido && carrinhos) {
      for (const k of Object.keys(carrinhos)) {
        try {
          const c = carrinhos[k];
          if (!c) continue;
          if (c._pedidoId && String(c._pedidoId) === String(id)) { pedido = { id: c._pedidoId, cliente: k.replace(/@s\.whatsapp\.net$/,'').replace(/@c\.us$/,''), ts: c.ts || Date.now(), total: c.valorTotal || 0, endereco: c.endereco || null, estado: c.estado, items: c.carrinho || [] }; break; }
          // also match composed ids like "{numero}_{ts}"
          if (String(id).startsWith(String(k))) {
            pedido = { id: id, cliente: k.replace(/@s\.whatsapp\.net$/,'').replace(/@c\.us$/,''), ts: c.ts || Date.now(), total: c.valorTotal || 0, endereco: c.endereco || null, estado: c.estado, items: c.carrinho || [] };
            break;
          }
        } catch (e) {}
      }
    }
    if (!pedido) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, pedido });
  } catch (err) { console.error('/api/pedidos/:id error', err); res.status(500).json({ ok: false, error: String(err) }); }
});

// API: obter informacoes basicas de um cliente (nome, endereco) por numero
app.get('/api/cliente/:numero', async (req, res) => {
  try {
    const numero = req.params.numero;
    if (!numero) return res.status(400).json({ ok: false, error: 'missing_numero' });
    let info = null;
    try { info = await obterInformacoesClienteAsync(numero); } catch (e) { info = null; }
    res.json({ ok: true, cliente: info });
  } catch (err) {
    console.error('Erro /api/cliente/:numero', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// APIs para Estatísticas e Análises

// API: Estatísticas gerais de vendas
app.get('/api/estatisticas/vendas', async (req, res) => {
  try {
    const periodo = req.query.periodo || 'hoje'; // hoje, semana, mes, todos
    let dataInicio, dataFim;
    const agora = new Date();
    
    switch (periodo) {
      case 'hoje':
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
        dataFim = dataInicio + (24 * 60 * 60 * 1000) - 1;
        break;
      case 'semana':
        const inicioSemana = new Date(agora);
        inicioSemana.setDate(agora.getDate() - agora.getDay());
        dataInicio = new Date(inicioSemana.getFullYear(), inicioSemana.getMonth(), inicioSemana.getDate()).getTime();
        dataFim = dataInicio + (7 * 24 * 60 * 60 * 1000) - 1;
        break;
      case 'mes':
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();
        dataFim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59).getTime();
        break;
      default:
        dataInicio = 0;
        dataFim = Date.now();
    }

    let pedidos = [];
    try {
      if (clientService && typeof clientService.obterPedidosPorEstado === 'function') {
        pedidos = clientService.obterPedidosPorEstado(null); // todos os pedidos
      }
    } catch (e) {
      console.error('Erro ao obter pedidos:', e);
    }

    // Filtrar por período
    pedidos = pedidos.filter(p => p.ts >= dataInicio && p.ts <= dataFim);

    // Calcular estatísticas
    const totalVendas = pedidos.length;
    const receitaTotal = pedidos.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
    const ticketMedio = totalVendas > 0 ? receitaTotal / totalVendas : 0;

    // Análise de itens vendidos
    const itensVendidos = {};
    let totalItens = 0;

    pedidos.forEach(pedido => {
      try {
        const items = typeof pedido.items === 'string' ? JSON.parse(pedido.items) : pedido.items;
        if (Array.isArray(items)) {
          items.forEach(item => {
            const nome = item.nome || item.title || 'Item desconhecido';
            const quantidade = Number(item.quantidade) || 1;
            const preco = Number(item.preco) || 0;
            
            if (!itensVendidos[nome]) {
              itensVendidos[nome] = { quantidade: 0, receita: 0 };
            }
            itensVendidos[nome].quantidade += quantidade;
            itensVendidos[nome].receita += preco * quantidade;
            totalItens += quantidade;
          });
        }
      } catch (e) {
        console.error('Erro ao processar items do pedido:', e);
      }
    });

    // Top 10 itens mais vendidos
    const topItens = Object.entries(itensVendidos)
      .map(([nome, dados]) => ({ nome, ...dados }))
      .sort((a, b) => b.quantidade - a.quantidade)
      .slice(0, 10);

    const estatisticas = {
      periodo,
      dataInicio,
      dataFim,
      totalVendas,
      receitaTotal: Math.round(receitaTotal * 100) / 100,
      ticketMedio: Math.round(ticketMedio * 100) / 100,
      totalItens,
      topItens,
      pedidosPorEstado: {}
    };

    // Contar pedidos por estado
    pedidos.forEach(p => {
      const estado = p.estado || 'indefinido';
      estatisticas.pedidosPorEstado[estado] = (estatisticas.pedidosPorEstado[estado] || 0) + 1;
    });

    res.json({ ok: true, estatisticas });
  } catch (err) {
    console.error('Erro /api/estatisticas/vendas', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API: Análise de entregas
app.get('/api/estatisticas/entregas', async (req, res) => {
  try {
    const periodo = req.query.periodo || 'hoje';
    let dataInicio, dataFim;
    const agora = new Date();
    
    switch (periodo) {
      case 'hoje':
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
        dataFim = dataInicio + (24 * 60 * 60 * 1000) - 1;
        break;
      case 'semana':
        const inicioSemana = new Date(agora);
        inicioSemana.setDate(agora.getDate() - agora.getDay());
        dataInicio = new Date(inicioSemana.getFullYear(), inicioSemana.getMonth(), inicioSemana.getDate()).getTime();
        dataFim = dataInicio + (7 * 24 * 60 * 60 * 1000) - 1;
        break;
      case 'mes':
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();
        dataFim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59).getTime();
        break;
      default:
        dataInicio = 0;
        dataFim = Date.now();
    }

    let pedidos = [];
    try {
      if (clientService && typeof clientService.obterPedidosPorEstado === 'function') {
        pedidos = clientService.obterPedidosPorEstado(null);
      }
    } catch (e) {
      console.error('Erro ao obter pedidos:', e);
    }

    // Filtrar por período
    pedidos = pedidos.filter(p => p.ts >= dataInicio && p.ts <= dataFim);

    // Separar entregas e retiradas
    const entregas = pedidos.filter(p => p.entrega === 1 || p.entrega === true);
    const retiradas = pedidos.filter(p => p.entrega === 0 || p.entrega === false);

    // Análise de regiões (baseado no endereço)
    const regioes = {};
    entregas.forEach(pedido => {
      if (pedido.endereco) {
        const endereco = String(pedido.endereco).toLowerCase();
        let regiao = 'Outros';
        
        // Identificar bairros/regiões comuns (pode ser customizado)
        if (endereco.includes('centro')) regiao = 'Centro';
        else if (endereco.includes('jardim')) regiao = 'Jardim';
        else if (endereco.includes('vila')) regiao = 'Vila';
        else if (endereco.includes('bairro')) regiao = 'Bairro';
        
        if (!regioes[regiao]) {
          regioes[regiao] = { quantidade: 0, receita: 0 };
        }
        regioes[regiao].quantidade += 1;
        regioes[regiao].receita += Number(pedido.total) || 0;
      }
    });

    const analiseEntregas = {
      periodo,
      dataInicio,
      dataFim,
      totalPedidos: pedidos.length,
      totalEntregas: entregas.length,
      totalRetiradas: retiradas.length,
      percentualEntregas: pedidos.length > 0 ? Math.round((entregas.length / pedidos.length) * 100) : 0,
      receitaEntregas: Math.round(entregas.reduce((sum, p) => sum + (Number(p.total) || 0), 0) * 100) / 100,
      receitaRetiradas: Math.round(retiradas.reduce((sum, p) => sum + (Number(p.total) || 0), 0) * 100) / 100,
      ticketMedioEntregas: entregas.length > 0 ? Math.round((entregas.reduce((sum, p) => sum + (Number(p.total) || 0), 0) / entregas.length) * 100) / 100 : 0,
      ticketMedioRetiradas: retiradas.length > 0 ? Math.round((retiradas.reduce((sum, p) => sum + (Number(p.total) || 0), 0) / retiradas.length) * 100) / 100 : 0,
      regioes: Object.entries(regioes).map(([nome, dados]) => ({ nome, ...dados })).sort((a, b) => b.quantidade - a.quantidade)
    };

    res.json({ ok: true, analise: analiseEntregas });
  } catch (err) {
    console.error('Erro /api/estatisticas/entregas', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API: Dashboard consolidado
app.get('/api/estatisticas/dashboard', async (req, res) => {
  try {
    const periodo = req.query.periodo || 'hoje';
    
    // Fazer chamadas para as outras APIs
    const vendasResponse = await fetch(`http://localhost:${PORT}/api/estatisticas/vendas?periodo=${periodo}`);
    const entregasResponse = await fetch(`http://localhost:${PORT}/api/estatisticas/entregas?periodo=${periodo}`);
    
    const vendas = await vendasResponse.json();
    const entregas = await entregasResponse.json();
    
    const dashboard = {
      periodo,
      timestamp: Date.now(),
      vendas: vendas.ok ? vendas.estatisticas : null,
      entregas: entregas.ok ? entregas.analise : null
    };
    
    res.json({ ok: true, dashboard });
  } catch (err) {
    console.error('Erro /api/estatisticas/dashboard', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API específica para valor do motoboy
app.get('/api/motoboy/valor', async (req, res) => {
  try {
    const periodo = req.query.periodo || 'hoje';
    let dataInicio, dataFim;
    const agora = new Date();
    
    switch (periodo) {
      case 'hoje':
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
        dataFim = dataInicio + (24 * 60 * 60 * 1000) - 1;
        break;
      case 'semana':
        const inicioSemana = new Date(agora);
        inicioSemana.setDate(agora.getDate() - agora.getDay());
        dataInicio = new Date(inicioSemana.getFullYear(), inicioSemana.getMonth(), inicioSemana.getDate()).getTime();
        dataFim = dataInicio + (7 * 24 * 60 * 60 * 1000) - 1;
        break;
      case 'mes':
        dataInicio = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();
        dataFim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59).getTime();
        break;
      default:
        dataInicio = 0;
        dataFim = Date.now();
    }

    let pedidos = [];
    try {
      if (clientService && typeof clientService.obterPedidosPorEstado === 'function') {
        pedidos = clientService.obterPedidosPorEstado(null);
      }
    } catch (e) {
      console.error('Erro ao obter pedidos:', e);
    }

    // Filtrar por período e apenas entregas
    const entregas = pedidos.filter(p => 
      (p.entrega === 1 || p.entrega === true) && 
      p.ts >= dataInicio && 
      p.ts <= dataFim
    );

    // Função para extrair valor real de entrega de cada pedido
    function extrairValorEntrega(pedido) {
      try {
        // Usar campo valorEntrega do banco se disponível
        if (pedido.valorEntrega && typeof pedido.valorEntrega === 'number' && pedido.valorEntrega > 0) {
          return pedido.valorEntrega;
        }
        
        // Tentar extrair do raw_json
        if (pedido.raw_json) {
          const raw = typeof pedido.raw_json === 'string' ? JSON.parse(pedido.raw_json) : pedido.raw_json;
          if (raw.valorEntrega && typeof raw.valorEntrega === 'number' && raw.valorEntrega > 0) {
            return raw.valorEntrega;
          }
        }
        
        // Calcular baseado nos itens vs total
        if (pedido.items && pedido.total) {
          const items = typeof pedido.items === 'string' ? JSON.parse(pedido.items) : pedido.items;
          let totalItens = 0;
          if (Array.isArray(items)) {
            for (const item of items) {
              totalItens += (Number(item.preco) || 0) * (Number(item.quantidade) || 1);
            }
          }
          const valorEntrega = Number(pedido.total) - totalItens;
          if (valorEntrega > 0 && valorEntrega <= 100) { // Validação: entre 0 e 100 reais
            return valorEntrega;
          }
        }
        
        // Fallback para valor mínimo
        return 7.00;
      } catch (e) {
        console.error('Erro ao extrair valor de entrega do pedido:', pedido.id, e);
        return 7.00;
      }
    }

    // Calcular valores reais de entrega
    let valorTotalMotoboy = 0;
    const valoresEntrega = [];
    
    entregas.forEach(pedido => {
      const valorEntrega = extrairValorEntrega(pedido);
      valorTotalMotoboy += valorEntrega;
      valoresEntrega.push(valorEntrega);
    });

    const quantidadeEntregas = entregas.length;
    const valorMedio = quantidadeEntregas > 0 ? valorTotalMotoboy / quantidadeEntregas : 0;

    // Análise por horário (para identificar picos)
    const entregasPorHora = {};
    entregas.forEach(pedido => {
      const hora = new Date(pedido.ts).getHours();
      const valorEntrega = extrairValorEntrega(pedido);
      if (!entregasPorHora[hora]) {
        entregasPorHora[hora] = { quantidade: 0, valor: 0 };
      }
      entregasPorHora[hora].quantidade += 1;
      entregasPorHora[hora].valor += valorEntrega;
    });

    // Últimas entregas (para acompanhamento em tempo real)
    const ultimasEntregas = entregas
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 10)
      .map(p => ({
        id: p.id,
        cliente: p.cliente || 'Cliente',
        valor: extrairValorEntrega(p),
        endereco: p.endereco || 'Endereço não informado',
        horario: new Date(p.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      }));

    const resultado = {
      periodo,
      dataInicio,
      dataFim,
      valorTotalMotoboy: Math.round(valorTotalMotoboy * 100) / 100,
      quantidadeEntregas,
      valorMedioEntrega: Math.round(valorMedio * 100) / 100,
      entregasPorHora: Object.entries(entregasPorHora).map(([hora, dados]) => ({
        hora: parseInt(hora),
        quantidade: dados.quantidade,
        valor: Math.round(dados.valor * 100) / 100
      })).sort((a, b) => a.hora - b.hora),
      ultimasEntregas,
      ultimaAtualizacao: new Date().toLocaleString('pt-BR')
    };

    console.log(`[API] /api/motoboy/valor -> ${quantidadeEntregas} entregas, valor total: R$ ${resultado.valorTotalMotoboy}`);
    res.json({ ok: true, dados: resultado });
  } catch (err) {
    console.error('Erro /api/motoboy/valor', err);
    res.status(500).json({ ok: false, error: 'Erro interno do servidor' });
  }
});

// APIs para QR Code WhatsApp
let currentQRCode = null;

// API: obter QR Code atual para conexão WhatsApp
app.get('/api/whatsapp/qrcode', async (req, res) => {
  try {
    if (!currentQRCode) {
      return res.status(404).json({ ok: false, error: 'QR Code não disponível' });
    }
    
    // Converter QR Code string para base64
    const qrCodeBase64 = await qrcode.toDataURL(currentQRCode, {
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    // Remover o prefixo data:image/png;base64,
    const base64Data = qrCodeBase64.replace(/^data:image\/png;base64,/, '');
    
    res.json({ ok: true, qrcode: base64Data });
  } catch (err) {
    console.error('Erro /api/whatsapp/qrcode', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API: obter status de conexão WhatsApp
app.get('/api/whatsapp/status', (req, res) => {
  try {
    const status = {
      connected: isReady,
      needsQR: !isReady && !currentQRCode,
      hasQR: !!currentQRCode,
      timestamp: Date.now()
    };
    res.json({ ok: true, status });
  } catch (err) {
    console.error('Erro /api/whatsapp/status', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API: forçar nova geração de QR Code (reinicializar cliente)
app.post('/api/whatsapp/restart', (req, res) => {
  try {
    if (client) {
      currentQRCode = null;
      isReady = false;
      client.destroy().then(() => {
        setTimeout(() => {
          client.initialize();
        }, 2000);
      }).catch(err => {
        console.error('Erro ao reinicializar cliente:', err);
      });
    }
    res.json({ ok: true, message: 'Cliente reiniciando...' });
  } catch (err) {
    console.error('Erro /api/whatsapp/restart', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API para obter todos os clientes
app.get('/api/clientes', async (req, res) => {
  try {
    // Verificar se o serviço de cliente está disponível
    if (!clientService || typeof clientService.obterTodosClientes !== 'function') {
      // Se não existir a função, vamos criá-la temporariamente
      const clientes = [];
      
      // Tentar obter todos os clientes diretamente do banco
      if (clientService.db) {
        try {
          const stmt = clientService.db.prepare('SELECT * FROM clientes');
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          res.json({ ok: true, clientes: rows });
          return;
        } catch (dbError) {
          console.error('Erro ao buscar clientes do banco:', dbError);
        }
      }
      
      res.status(500).json({ ok: false, error: 'Serviço de clientes não disponível' });
      return;
    }
    
    // Se a função existir, usá-la
    const clientes = clientService.obterTodosClientes();
    res.json({ ok: true, clientes });
  } catch (err) {
    console.error('Erro /api/clientes', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// API para atualizar informações de um cliente
app.put('/api/clientes/:numero', async (req, res) => {
  try {
    const { numero } = req.params;
    const { nome, endereco, lat, lng } = req.body;
    
    if (!numero) {
      return res.status(400).json({ ok: false, error: 'Número do cliente é obrigatório' });
    }
    
    // Verificar se o serviço de cliente está disponível
    if (!clientService || typeof clientService.atualizarCliente !== 'function') {
      // Tentar atualizar diretamente no banco
      if (clientService.db) {
        try {
          const stmt = clientService.db.prepare('UPDATE clientes SET nome = ?, endereco = ?, latitude = ?, longitude = ? WHERE numero = ?');
          const result = stmt.run([nome, endereco, lat, lng, numero]);
          stmt.free();
          
          if (result.changes > 0) {
            // Salvar as alterações
            try {
              const saveStmt = clientService.db.prepare('SELECT * FROM clientes WHERE numero = ?');
              const updatedClient = saveStmt.getAsObject([numero]);
              saveStmt.free();
              clientService.saveDatabase();
              res.json({ ok: true, cliente: updatedClient });
              return;
            } catch (saveError) {
              console.error('Erro ao salvar banco:', saveError);
            }
          }
          
          res.json({ ok: result.changes > 0, message: result.changes > 0 ? 'Cliente atualizado' : 'Nenhuma alteração realizada' });
          return;
        } catch (dbError) {
          console.error('Erro ao atualizar cliente no banco:', dbError);
          res.status(500).json({ ok: false, error: String(dbError) });
          return;
        }
      }
      
      res.status(500).json({ ok: false, error: 'Serviço de clientes não disponível' });
      return;
    }
    
    // Se a função existir, usá-la
    const result = clientService.atualizarCliente(numero, { nome, endereco, lat, lng });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Erro /api/clientes/:numero', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Rota para servir o PDF/HTML do pedido gerado (visualizar/baixar)
app.get('/pedidos/:id', (req, res) => {
  try {
    const id = req.params.id;
    // Segurança: não permita caminhos com ../
    if (id.includes('..') || id.includes('/')) return res.status(400).send('invalid id');
    const ordersDir = path.join(process.cwd(), 'Pedidos');
    const pdfPath = path.join(ordersDir, `${id}.pdf`);
    const htmlPath = path.join(ordersDir, `${id}.html`);
    if (fs.existsSync(pdfPath)) return res.sendFile(pdfPath);
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    // fallback: tentar obter registro do pedido no DB e gerar HTML on-the-fly com o mesmo formato usado para PDF
    try {
      const clienteService = require('./src/services/clienteService');
      const carrinhoService = require('./src/services/carrinhoService');
      if (clienteService && typeof clienteService.obterPedidoPorId === 'function') {
        const pedido = clienteService.obterPedidoPorId(id);
        if (pedido) {
          if (carrinhoService && typeof carrinhoService.imprimirPedidoFromRecord === 'function') {
            const html = carrinhoService.imprimirPedidoFromRecord(pedido);
            return res.send(html);
          }
          // fallback simple html if helper missing
          let html = `<!doctype html><html><head><meta charset="utf-8"><title>Pedido ${id}</title></head><body>`;
          html += `<h1>Pedido ${id}</h1>`;
          html += `<p><strong>Cliente:</strong> ${pedido.numero || id}</p>`;
          html += `<p><strong>Data:</strong> ${new Date(Number(pedido.ts)||Date.now()).toLocaleString()}</p>`;
          html += `<p><strong>Total:</strong> R$ ${Number(pedido.total||0).toFixed(2)}</p>`;
          if (pedido.items && Array.isArray(pedido.items)) {
            html += '<ul>';
            for (const it of pedido.items) html += `<li>${(it.quantidade||1)}x ${it.nome || it.id} - R$ ${(Number(it.preco)||0).toFixed(2)}</li>`;
            html += '</ul>';
          }
          html += '</body></html>';
          return res.send(html);
        }
      }
    } catch (e) { /* ignore and fallthrough */ }
    return res.status(404).send('Pedido não encontrado');
  } catch (err) {
    console.error('Erro ao servir pedido:', err);
    return res.status(500).send('erro interno');
  }
});

// Rota para o painel de mensagens
app.get('/painel-mensagens', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'painel-mensagens.html'));
});

// Rota para painel de pedidos (conversas + carrinhos em tempo real)
app.get('/pedidos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pedidos.html'));
});

// Rota para página do QR Code WhatsApp
app.get('/qrcode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qrcode.html'));
});

// Rota para página de estatísticas do restaurante
app.get('/estatisticas', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'estatisticas.html'));
});

// Rota para página do dashboard do motoboy
app.get('/motoboy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'motoboy.html'));
});

// Middleware para servir arquivos estáticos (deve vir após as rotas da API)
app.use(express.static(publicDir));

io.on('connection', async (socket) => {
  // Helper to detect group ids
  const isGroupId = (x) => /@g\.us$/i.test(String(x || ''));
  // Finalizar carrinho (simula cliente digitando 'F')
  socket.on('admin:finalizarCarrinho', (data) => {
    try {
      const { id } = data || {};
      if (!id) return;
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      // If the cart is already in the finalizado state, ignore this admin action
      try {
        const menuFinalizadoStat = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
        const estadoAtual = carrinhos[idNorm] && carrinhos[idNorm].estado;
        if (estadoAtual && String(estadoAtual) === String(menuFinalizadoStat)) {
          console.log(`[ADMIN] Pedido ${idNorm} já está finalizado; ignorando ação de finalizar.`);
          socket.emit('admin:ack', { ok: false, error: 'already_finalized', id: idNorm });
          return;
        }
      } catch (e) { /* ignore guard errors */ }
      // Em vez de finalizar diretamente, simula o cliente digitando 'finalizar'
      if (carrinhos[idNorm]) {
        try {
          // atualiza campos que o fluxo espera
          carrinhos[idNorm].lastMsg = 'finalizar';
          carrinhos[idNorm].respUser = 'finalizar';

          // Cria um objeto msg mínimo com reply() que usa o client para enviar mensagens
          const fakeMsg = {
            from: idNorm + '@c.us',
            body: 'finalizar',
            reply: async (text) => {
              try { await client.sendMessage(idNorm + '@c.us', text); } catch (e) { console.error('[ADMIN] erro ao enviar reply simulado:', e); }
            }
          };

          // Chama o mesmo fluxo que o cliente acionaria ao digitar 'finalizar'
          try { menuInicial(idNorm, carrinhos[idNorm], fakeMsg, client, MessageMedia); } catch (e) { console.error('[ADMIN] erro ao executar menuInicial:', e); }

          // Notifica painel sobre a ação do admin
          try { events.emit('update', { type: 'admin_action', action: 'finalizar_trigger', id: idNorm, carrinho: sanitizeCarrinho(carrinhos[idNorm]) }); } catch (e) {}
        } catch (e) { console.error('[ADMIN] erro ao processar finalizar por admin:', e); }
      }
    } catch (e) { console.log('[ADMIN] erro ao finalizar carrinho', e); }
  });
  console.log('[dashboard] cliente conectado', socket.id);
  // Envia estado atual dos carrinhos ao conectar, filtrando chats de grupo (@g.us)
  const filteredCarrinhos = {};
  for (const k of Object.keys(carrinhos)) {
    if (isGroupId(k)) continue;
    // If the cart is already marked as delivered / saiu_para_entrega, don't include it
    // in the initial dashboard snapshot so a page refresh doesn't bring it back to the main panel.
    try {
      const estado = (carrinhos[k] && carrinhos[k].estado) ? String(carrinhos[k].estado).toLowerCase() : '';
      if (estado.includes('saiu') || estado.includes('entreg')) continue;
    } catch (e) {
      // ignore and include the cart by default
    }
    // Shallow copy so we can augment without mutating original
    filteredCarrinhos[k] = Object.assign({}, carrinhos[k]);
  }
  // Attempt to enrich with client name from DB where available
  try {
    const ids = Object.keys(filteredCarrinhos);
    await Promise.all(ids.map(async (cid) => {
      try {
        const info = await obterInformacoesClienteAsync(cid);
        if (info) {
          if (info.nome) filteredCarrinhos[cid].nome = info.nome;
          if (info.endereco) filteredCarrinhos[cid].endereco = info.endereco;
          if (typeof info.lat !== 'undefined') filteredCarrinhos[cid].lat = info.lat;
          if (typeof info.lng !== 'undefined') filteredCarrinhos[cid].lng = info.lng;
        }
      } catch (e) { /* ignore per-id errors */ }
    }));
  } catch (e) { /* ignore enrichment errors */ }
  // Emit sanitized snapshot to avoid sending internal timers/handles
  const sanitizedSnapshot = {};
  for (const k of Object.keys(filteredCarrinhos)) sanitizedSnapshot[k] = sanitizeCarrinho(filteredCarrinhos[k]);
  socket.emit('initial', { carrinhos: sanitizedSnapshot });

  // Comandos do dashboard: alterar estado de um carrinho
  socket.on('admin:setState', (data) => {
    try {
      const { id, state } = data || {};
  if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      if (id && state && carrinhoService && typeof carrinhoService.atualizarEstadoDoCarrinho === 'function') {
        carrinhoService.atualizarEstadoDoCarrinho(id, state);
        socket.emit('admin:ack', { ok: true, id, state });
      } else {
        socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      }
    } catch (err) {
      socket.emit('admin:ack', { ok: false, error: String(err) });
    }
  });

  // Comando do dashboard: resetar carrinho
  socket.on('admin:reset', (data) => {
    try {
      const { id } = data || {};
  if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      if (id && carrinhoService && typeof carrinhoService.resetCarrinho === 'function') {
        carrinhoService.resetCarrinho(id, carrinhos[id]);
        socket.emit('admin:ack', { ok: true, id });
      } else {
        socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      }
    } catch (err) {
      socket.emit('admin:ack', { ok: false, error: String(err) });
    }
  });

  // Comando do dashboard: imprimir pedido (gera PDF e envia URL) - só se finalizado
  socket.on('admin:imprimirPedido', async (data) => {
    try {
      const { id } = data || {};
      if (!id) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      if (isGroupId(idNorm)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      const carrinho = carrinhos[idNorm];
      if (!carrinho) return socket.emit('admin:ack', { ok: false, error: 'not_found' });
      // If a PDF or fallback HTML already exists for this order, return it regardless of state
      const ordersDir = path.join(process.cwd(), 'Pedidos');
      const pdfPath = path.join(ordersDir, `${idNorm}.pdf`);
      const htmlPath = path.join(ordersDir, `${idNorm}.html`);
      try {
        const pdfExists = fs.existsSync(pdfPath);
        const htmlExists = fs.existsSync(htmlPath);
        // If a PDF/HTML exists and forcePrint is NOT set, return it without regenerating/printing
        if ((pdfExists || htmlExists) && !data.forcePrint) {
          console.log(`[ADMIN] PDF/HTML existente para ${idNorm}, retornando URL sem checar estado.`);
          const url = `/pedidos/${encodeURIComponent(idNorm)}`;
          return socket.emit('admin:ack', { ok: true, url });
        }
      } catch (e) { /* ignore fs errors and continue to state check */ }

      const finalState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
      const saiuState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.saiuParaEntrega) || 'saiu_para_entrega';
      if (!carrinho.estado || (String(carrinho.estado) !== String(finalState) && String(carrinho.estado) !== String(saiuState))) {
        // allow printing when already marked as saiu_para_entrega as well
        return socket.emit('admin:ack', { ok: false, error: 'not_finalized' });
      }
      // Attempt to save/generate the PDF (salvarPedido returns after trying to create PDF)
      try {
        if (carrinhoService && typeof carrinhoService.salvarPedido === 'function') {
          // salvarPedido will generate the PDF and try to print; pass state so file annotates it
          await carrinhoService.salvarPedido(idNorm, carrinho.estado || finalState);
        }
      } catch (err) {
        console.error('[ADMIN] Erro ao gerar o PDF:', err);
        return socket.emit('admin:ack', { ok: false, error: 'pdf_error' });
      }
      // On success, reply with URL where the file can be downloaded/printed
      const url = `/pedidos/${encodeURIComponent(idNorm)}`;
      socket.emit('admin:ack', { ok: true, url });
    } catch (err) {
      console.error('Erro em admin:imprimirPedido', err);
      socket.emit('admin:ack', { ok: false, error: String(err) });
    }
  });

  // Comando do dashboard: adicionar item manualmente
  socket.on('admin:addItem', async (data) => {
    try {
      console.log('[ADMIN] addItem recebido:', data);
      const { id } = data || {};
  if (!id) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
  if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      // Normaliza id (remove sufixos @c.us / @s.whatsapp.net se presentes)
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');

      // If actions array is provided, accept that pattern directly
      if (Array.isArray(data.actions) && data.actions.length > 0) {
        for (const act of data.actions) {
          try {
            const itemId = act.idSelect || act.id || act.itemId;
            const quantidade = act.quantidade || 1;
            const preparo = Array.isArray(act.descricao) ? act.descricao.join(' ').trim() : (act.preparo || '');
            const nome = act.tamanho || act.nome || '';
            if (!itemId) {
              console.log('[ADMIN] ação sem idSelect, pulando:', act);
              continue;
            }
            console.log(`[ADMIN] adicionando (action) item ${itemId} ao carrinho ${idNorm} q=${quantidade} preparo=${preparo}`);
            carrinhoService.adicionarItemAoCarrinho(idNorm, itemId, quantidade, preparo, act.tipo || 'Lanche', (act.nome || nome || String(itemId)));
          } catch (e) { console.log('[ADMIN] erro ao processar action', e); }
        }
        return socket.emit('admin:ack', { ok: true, id: idNorm });
      }

      // backward compat: single itemName/itemId payload
      const { itemId, itemName, quantidade, preparo, tipo } = data || {};
      let resolvedId = itemId;
      let nomeParaExibir = itemName || '';
      let preparoFinal = preparo || '';
      if (!resolvedId && itemName) {
        try {
          const analise = require('./src/core/analisePalavras');
          const parsed = analise.parseItemInput(itemName);
          if (parsed) {
            nomeParaExibir = parsed.itemName;
            if (!preparoFinal && parsed.preparo) preparoFinal = parsed.preparo;
            resolvedId = await analise.getItemIdByName(parsed.itemName) || null;
          }
        } catch (e) { resolvedId = null; }
      }

      if (!resolvedId) {
        console.log('[ADMIN] item não encontrado para nome:', itemName);
        return socket.emit('admin:ack', { ok: false, error: 'item_not_found' });
      }

  if (carrinhoService && typeof carrinhoService.adicionarItemAoCarrinho === 'function') {
  console.log(`[ADMIN] adicionando item ${resolvedId} ao carrinho ${idNorm}`);
    // parâmetros: (clienteId, itemId, quantidade, AnotarPreparo, tipagem, displayName)
    carrinhoService.adicionarItemAoCarrinho(idNorm, resolvedId, quantidade || 1, (preparoFinal || ''), tipo || 'Lanche', nomeParaExibir || '');
  // schedule follow-up in case client stops responding after adding
  try { scheduleFollowupForClient(idNorm); } catch(e) {}
  socket.emit('admin:ack', { ok: true, id: idNorm, itemId: resolvedId });
      } else {
        socket.emit('admin:ack', { ok: false, error: 'service_unavailable' });
      }
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });

  // Cardápio: obter lista de itens
  socket.on('admin:getCardapio', async (data) => {
    try {
      await cardapioService.init();
      const items = cardapioService.getItems();
      socket.emit('admin:cardapio', { ok: true, items });
    } catch (e) { console.error('[ADMIN] getCardapio error', e); socket.emit('admin:cardapio', { ok: false, error: String(e) }); }
  });

  socket.on('admin:addCardapioItem', async (data) => {
    try {
      const { nome, descricao, preco, tipo, id } = data || {};
      if (!nome) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      await cardapioService.init();
      const insertedId = cardapioService.addItem({ nome, descricao, preco, tipo, id });
      socket.emit('admin:ack', { ok: !!insertedId, id: insertedId });
    } catch (e) { console.error('[ADMIN] addCardapioItem error', e); socket.emit('admin:ack', { ok: false, error: String(e) }); }
  });

  socket.on('admin:removeCardapioItem', async (data) => {
    try {
      const { itemId } = data || {};
      if (!itemId) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      await cardapioService.init();
      const ok = cardapioService.removeItem(itemId);
      socket.emit('admin:ack', { ok: !!ok });
    } catch (e) { console.error('[ADMIN] removeCardapioItem error', e); socket.emit('admin:ack', { ok: false, error: String(e) }); }
  });

  // Mappings (gatilhos)
  socket.on('admin:getMappings', async () => {
    try {
      await cardapioService.init();
      const mappings = cardapioService.getMappings();
      socket.emit('admin:mappings', { ok: true, mappings });
    } catch (e) { console.error('[ADMIN] getMappings', e); socket.emit('admin:mappings', { ok: false, error: String(e) }); }
  });

  socket.on('admin:addMapping', async (data) => {
    try {
      const { nome, itemId } = data || {};
      if (!nome || !itemId) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      await cardapioService.init();
      const ok = cardapioService.addMapping(nome, itemId);
      socket.emit('admin:ack', { ok: !!ok });
      // broadcast updated mappings to all clients
      const mappings = cardapioService.getMappings();
      io.emit('admin:mappings', { ok: true, mappings });
    } catch (e) { console.error('[ADMIN] addMapping', e); socket.emit('admin:ack', { ok: false, error: String(e) }); }
  });

  socket.on('admin:removeMapping', async (data) => {
    try {
      const { nome } = data || {};
      if (!nome) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      await cardapioService.init();
      const ok = cardapioService.removeMapping(nome);
      socket.emit('admin:ack', { ok: !!ok });
      const mappings = cardapioService.getMappings();
      io.emit('admin:mappings', { ok: true, mappings });
    } catch (e) { console.error('[ADMIN] removeMapping', e); socket.emit('admin:ack', { ok: false, error: String(e) }); }
  });

  // Comando: informar que o pedido saiu para entrega
  socket.on('admin:saiuEntrega', async (data) => {
    try {
      const { id, message } = data || {};
      if (!id) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      const carrinho = carrinhos[idNorm];
      if (!carrinho) return socket.emit('admin:ack', { ok: false, error: 'not_found' });
      // Só permite notificar que 'saiu para entrega' se o pedido estiver finalizado
      try {
        const finalState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
        if (!carrinho.estado || String(carrinho.estado) !== String(finalState)) {
          return socket.emit('admin:ack', { ok: false, error: 'not_finalized' });
        }
      } catch (e) { /* se falhar na checagem, não bloqueia por segurança */ }

      // update state para 'saiu_para_entrega'
      try { atualizarEstadoDoCarrinho(idNorm, (carrinhoService && carrinhoService.stats && carrinhoService.stats.saiuParaEntrega) || 'saiu_para_entrega'); } catch (e) {}
      
      // Aguardar o banco estar pronto antes de persistir
      if (clientService && clientService.dbReady && typeof clientService.dbReady.then === 'function') {
        try {
          await clientService.dbReady;
          console.log('[ADMIN] Banco de dados pronto para salvar pedido');
        } catch (e) {
          console.error('[ADMIN] Erro ao aguardar banco estar pronto:', e);
        }
      }
      
      // Persistir pedido no banco com estado 'saiu_para_entrega' para histórico / lista de entregues
      let ackPedido = null;
      try {
        if (clientService && typeof clientService.adicionarPedido === 'function') {
          // If we've already saved a pedido for this cart, update its state instead of creating duplicate
          if (carrinho._pedidoSalvo && carrinho._pedidoId) {
            // Update the existing pedido state to 'saiu_para_entrega'
            try {
              if (clientService && typeof clientService.atualizarEstadoPedido === 'function') {
                clientService.atualizarEstadoPedido(carrinho._pedidoId, 'saiu_para_entrega');
                console.log('[ADMIN] Estado do pedido atualizado para saiu_para_entrega:', carrinho._pedidoId);
              }
            } catch (e) { console.error('[ADMIN] Erro ao atualizar estado do pedido:', e); }
            
            let saved = null;
            try { saved = clientService.obterPedidoPorId(carrinho._pedidoId); } catch (e) { saved = null; }
            if (!saved) saved = { id: carrinho._pedidoId, ts: Date.now(), total: carrinho.valorTotal || 0, endereco: carrinho.endereco || null, estado: 'saiu_para_entrega', items: carrinho.carrinho || [] };
            try { io.emit('pedido:salvo', { ok:true, pedido: saved, cliente: idNorm }); } catch(e) { console.error('[ADMIN] erro emitindo pedido:salvo (reused)', e); }
            ackPedido = saved;
          } else {
            // montar objeto de pedido simplificado
            const items = Array.isArray(carrinho.carrinho) ? carrinho.carrinho.map(it => ({ id: it.id, nome: it.nome, quantidade: it.quantidade, preco: it.preco, preparo: it.preparo })) : [];
            let totalCalc = 0;
            for (const it of items) totalCalc += (Number(it.preco)||0) * (Number(it.quantidade)||1);
            // considerar valorEntrega se presente
            const entregaVal = (typeof carrinho.valorEntrega !== 'undefined' && carrinho.valorEntrega) ? Number(carrinho.valorEntrega) : (carrinho.entrega && Number(carrinho.entrega) ? Number(carrinho.entrega) : 0);
            totalCalc = totalCalc + (Number(entregaVal) || 0);
            const pedidoRecord = {
              id: `${idNorm}_${Date.now()}`,
              ts: Date.now(),
              total: totalCalc,
              entrega: entregaVal ? 1 : 0,
              endereco: carrinho.endereco || null,
              estado: (carrinhoService && carrinhoService.stats && carrinhoService.stats.saiuParaEntrega) || 'saiu_para_entrega',
              items,
              valorEntrega: entregaVal || 0
            };
            const savedId = clientService.adicionarPedido(idNorm, pedidoRecord);
            console.log('[ADMIN] adicionarPedido returned id =', savedId);
            // mark as saved on the in-memory cart
            try { carrinho._pedidoSalvo = true; carrinho._pedidoId = savedId || pedidoRecord.id; } catch (e) {}
            try {
              let saved = null;
              try { if (clientService && typeof clientService.obterPedidoPorId === 'function') saved = clientService.obterPedidoPorId(savedId || pedidoRecord.id); } catch(e) { saved = null; }
              if (!saved) saved = Object.assign({}, pedidoRecord, { id: savedId || pedidoRecord.id });
              try { io.emit('pedido:salvo', { ok:true, pedido: saved, cliente: idNorm }); } catch(e) { console.error('[ADMIN] erro emitindo pedido:salvo', e); }
              ackPedido = saved;
            } catch (e) { console.error('[ADMIN] Erro ao persistir/emitir pedido como saiu_para_entrega:', e); }
          }
        }
      } catch (e) { console.error('[ADMIN] Erro ao persistir pedido como saiu_para_entrega:', e); }
      // send message to client via WhatsApp client
      try {
        const texto = message || 'Seu pedido saiu para entrega! Em breve chegará.';
        if (client) {
          await client.sendMessage(`${idNorm}@s.whatsapp.net`, texto);
        }
      } catch (e) { console.error('[ADMIN] erro ao enviar mensagem saiuEntrega:', e); }
      // include saved pedido in the ack when available to avoid races on the client-side
      socket.emit('admin:ack', { ok: true, id: idNorm, pedido: ackPedido });
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });

  // Comando do dashboard: enviar mensagem para cliente como admin
  socket.on('admin:sendMessage', async (data) => {
    try {
      const { id, text } = data || {};
      if (!id || !text) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
  if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      // envia via WhatsApp client
      try {
        if (typeof client !== 'undefined' && client) {
          await client.sendMessage(`${idNorm}@s.whatsapp.net`, text);
        }
      } catch (e) { console.error('[ADMIN] erro ao enviar mensagem via client:', e); }

         // Note: do not add message to carrinhos here -- the whatsapp client will emit message_create
         // which is already handled elsewhere and will emit the update once.

      socket.emit('admin:ack', { ok: true, id: idNorm });
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });

  // Comando do dashboard: remover item por nome/id/index
  socket.on('admin:removeItem', (data) => {
    try {
      const { id, index, nome, itemId } = data || {};
      console.log('[ADMIN] removeItem recebido:', data);
      if (!id) return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
  if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
  const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      if (carrinhoService && typeof carrinhoService.removerItemDoCarrinho === 'function') {
        const ok = carrinhoService.removerItemDoCarrinho(idNorm, { index, nome, id: itemId });
        socket.emit('admin:ack', { ok: !!ok, id: idNorm });
      } else {
        socket.emit('admin:ack', { ok: false, error: 'service_unavailable' });
      }
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });

  // Comando do dashboard: atualizar/definir nome do cliente
  socket.on('admin:updateName', (data) => {
    try {
      const { id, nome } = data || {};
      if (!id || typeof nome === 'undefined') return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      // Atualiza DB (se disponível)
      try {
        if (clientService && typeof clientService.atualizarNomeCliente === 'function') {
          clientService.atualizarNomeCliente(idNorm, String(nome).trim());
        }
      } catch (e) { console.error('[ADMIN] Erro ao atualizar nome no DB:', e); }
      // Atualiza carrinho em memória e notifica painel
      try {
        if (!carrinhos[idNorm]) carrinhos[idNorm] = { carrinho: [], estado: 'menu-inicial' };
        carrinhos[idNorm].nome = String(nome).trim();
  try { events.emit('update', { type: 'admin_action', action: 'update_name', id: idNorm, carrinho: sanitizeCarrinho(carrinhos[idNorm]) }); } catch (e) {}
      } catch (e) { console.error('[ADMIN] erro ao setar nome em memória:', e); }

      socket.emit('admin:ack', { ok: true, id: idNorm });
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });

  // Comando do dashboard: atualizar/definir endereço do cliente
  socket.on('admin:updateEndereco', (data) => {
    try {
      const { id, endereco } = data || {};
      if (!id || typeof endereco === 'undefined') return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
      if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
      const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      // Persistir no DB
      try { if (clientService && typeof clientService.atualizarEnderecoCliente === 'function') clientService.atualizarEnderecoCliente(idNorm, String(endereco).trim()); } catch (e) { console.error('[ADMIN] Erro ao atualizar endereco no DB:', e); }
      // Atualizar carrinho em memória e notificar painel
      try {
        if (!carrinhos[idNorm]) carrinhos[idNorm] = { carrinho: [], estado: 'menu-inicial' };
        carrinhos[idNorm].endereco = String(endereco).trim();
  try { events.emit('update', { type: 'admin_action', action: 'update_endereco', id: idNorm, carrinho: sanitizeCarrinho(carrinhos[idNorm]) }); } catch (e) {}
      } catch (e) { console.error('[ADMIN] erro ao setar endereco em memória:', e); }

      socket.emit('admin:ack', { ok: true, id: idNorm });
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });

  // Comando do dashboard: atualizar quantidade de item (index, delta)
  socket.on('admin:updateQuantity', (data) => {
    try {
      const { id, index, delta } = data || {};
      if (!id || typeof index === 'undefined' || typeof delta === 'undefined') return socket.emit('admin:ack', { ok: false, error: 'invalid_payload' });
  if (isGroupId(id)) return socket.emit('admin:ack', { ok: false, error: 'group_ignored' });
  const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
      if (carrinhoService && typeof carrinhoService.atualizarQuantidadeDoItem === 'function') {
        const ok = carrinhoService.atualizarQuantidadeDoItem(idNorm, Number(index), Number(delta));
        return socket.emit('admin:ack', { ok: !!ok, id: idNorm });
      }
      socket.emit('admin:ack', { ok: false, error: 'service_unavailable' });
    } catch (err) { socket.emit('admin:ack', { ok: false, error: String(err) }); }
  });
});

// Escuta eventos do carrinhoService e retransmite por socket.io
if (events && typeof events.on === 'function') {
  events.on('update', (payload) => {
    try {
      // Se payload.id é um group id (@g.us), ignore para não renderizar no dashboard
      const id = payload && payload.id ? String(payload.id) : '';
      if (/@g\.us$/i.test(id)) return;
      // If the cart just changed state to finalizado or saiu_para_entrega, clear any scheduled followups
      try {
        const finalState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
        const saiuState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.saiuParaEntrega) || 'saiu_para_entrega';
        if (payload && payload.type === 'state_change' && (String(payload.estado) === String(finalState) || String(payload.estado) === String(saiuState))) {
          try { clearFollowupForClient(id); } catch(e) {}
          // Persist pedido automaticamente when state reaches finalizado (but not when changing from finalizado to saiu_para_entrega)
          try {
            const idNorm = id;
            const c = carrinhos[idNorm];
            // Only save automatically when reaching 'finalizado' state, not when changing to 'saiu_para_entrega'
            if (c && !c._pedidoSalvo && String(payload.estado) === String(finalState)) {
              // build pedido record
              const items = Array.isArray(c.carrinho) ? c.carrinho.map(it => ({ id: it.id, nome: it.nome, quantidade: it.quantidade, preco: it.preco, preparo: it.preparo })) : [];
              let totalCalc = 0;
              for (const it of items) totalCalc += (Number(it.preco)||0) * (Number(it.quantidade)||1);
              const entregaVal = (typeof c.valorEntrega !== 'undefined' && c.valorEntrega) ? Number(c.valorEntrega) : (c.entrega && Number(c.entrega) ? Number(c.entrega) : 0);
              totalCalc = totalCalc + (Number(entregaVal) || 0);
              const pedidoRecord = {
                id: `${idNorm}_${Date.now()}`,
                ts: Date.now(),
                total: totalCalc,
                entrega: entregaVal ? 1 : 0,
                endereco: c.endereco || null,
                estado: String(payload.estado) || (carrinhoService && carrinhoService.stats && carrinhoService.stats.saiuParaEntrega) || 'saiu_para_entrega',
                items,
                valorEntrega: entregaVal || 0
              };
              try {
                const savedId = clientService && typeof clientService.adicionarPedido === 'function' ? clientService.adicionarPedido(idNorm, pedidoRecord) : null;
                console.log('[AUTO-PERSIST] adicionarPedido returned id =', savedId);
                // mark as saved to prevent duplicate saves and store the saved id on the cart
                try { c._pedidoSalvo = true; c._pedidoId = savedId || pedidoRecord.id; } catch (e) {}
                // emit for frontend (fetch fresh record when possible)
                let saved = null;
                try { if (clientService && typeof clientService.obterPedidoPorId === 'function') saved = clientService.obterPedidoPorId(c._pedidoId); } catch(e) { saved = null; }
                if (!saved) saved = Object.assign({}, pedidoRecord, { id: c._pedidoId });
                try { io.emit('pedido:salvo', { ok:true, pedido: saved, cliente: idNorm }); } catch(e) {}
              } catch (e) { console.error('[AUTO-PERSIST] erro ao salvar pedido:', e); }
            }
          } catch (e) { console.error('[AUTO-PERSIST] erro geral:', e); }
        }
      } catch(e) {}
      // sanitize payload.carrinho before emitting to avoid circular structures and binary detection issues
      const out = Object.assign({}, payload);
      if (payload && payload.carrinho) out.carrinho = sanitizeCarrinho(payload.carrinho);
      // Also sanitize any embedded carrinho under payload.carrinho
      try { 
        io.emit('carrinho:update', out); 
      } catch (e) { console.error('[ERROR] Erro ao emitir carrinho:update:', e); }
      // Se o payload contém carrinho com itens, agendar follow-up para esse cliente
      try {
        if (out.carrinho && Array.isArray(out.carrinho) && out.carrinho.length > 0) {
          try { scheduleFollowupForClient(id); } catch (e) {}
        }
      } catch (e) { /* ignore */ }
    } catch (e) { }
  });
}

// Inicia o servidor em porta 3001 se não houver variáveis de ambiente, mas só após o DB estar pronto
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3001;
try {
  if (clientService && clientService.dbReady && typeof clientService.dbReady.then === 'function') {
    clientService.dbReady.then(async () => {
      // optionally migrate cardapio maps into DB on startup when flag set
      try {
        const should = String(process.env.MIGRATE_CARDAPIO_ON_START||'').toLowerCase();
        if (should === '1' || should === 'true') {
          try {
            const migrate = require('./src/scripts/migrateCardapio');
            await migrate();
            console.log('[startup] migrateCardapio executed');
          } catch (e) { console.error('[startup] migrateCardapio failed', e); }
        }
      } catch(e) {}
      server.listen(DASHBOARD_PORT, () => console.log(`[dashboard] servindo ${publicDir} em http://localhost:${DASHBOARD_PORT} (DB ready)`));
    }).catch((e) => {
      console.error('dbReady rejected, iniciando servidor de qualquer forma:', e);
      server.listen(DASHBOARD_PORT, () => console.log(`[dashboard] servindo ${publicDir} em http://localhost:${DASHBOARD_PORT} (DB ready failed)`));
    });
  } else {
    server.listen(DASHBOARD_PORT, () => console.log(`[dashboard] servindo ${publicDir} em http://localhost:${DASHBOARD_PORT}`));
  }
} catch (e) {
  console.error('Erro ao aguardar dbReady:', e);
  server.listen(DASHBOARD_PORT, () => console.log(`[dashboard] servindo ${publicDir} em http://localhost:${DASHBOARD_PORT} (fallback)`));
}


// Função para checar se Chrome está instalado no caminho padrão do Windows
function getChromePath() {
  const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (fs.existsSync(chromePath)) {
    console.log('✅ Chrome encontrado no caminho padrão.');
    return chromePath;
  } else {
    console.warn('⚠️ Chrome não encontrado no caminho padrão.');
    return null;
  }
}

const chromeExecutablePath = getChromePath();
const client = new Client({
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    headless: true,
    executablePath: chromeExecutablePath || undefined,
    timeout: 90000,
    defaultViewport: null
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  authStrategy: new LocalAuth({
    clientId: 'bot-assist',
    dataPath: path.join(__dirname, 'Auth') // Salvar dados de autenticação na pasta Auth
  }),
  takeoverOnConflict: true,
  takeoverTimeoutMs: 15000,
  qrMaxRetries: 5
});

client.initialize();

// Eventos com melhor debugging
client.on('qr', (qr) => {
  console.log('📱 QR Code recebido! Escaneie com WhatsApp...');
  
  // Armazenar QR Code para API
  currentQRCode = qr;
  
  // Emitir QR Code via Socket.IO para clientes conectados
  io.emit('whatsapp:qrcode', { qrcode: qr, timestamp: Date.now() });
  
  qrcode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
    if (err) {
      console.error('❌ Erro ao gerar QR code:', err);
    } else {
      console.log(url);
      console.log('⏰ QR Code exibido. Aguardando escaneamento...');
    }
  });
});

client.on('ready', () => {
  console.log('🎉 Cliente WhatsApp está pronto e conectado!');
  isReady = true;
  currentQRCode = null; // Limpar QR Code quando conectado
  
  // Emitir status de conexão via Socket.IO
  io.emit('whatsapp:status', { connected: true, timestamp: Date.now() });
});

client.on('authenticated', () => {
  console.log('🔐 Autenticação WhatsApp realizada com sucesso!');
  currentQRCode = null; // Limpar QR Code quando autenticado
  
  // Emitir status de autenticação via Socket.IO
  io.emit('whatsapp:authenticated', { timestamp: Date.now() });
});

client.on('loading_screen', (percent, message) => {
  console.log(`📊 Carregando WhatsApp Web: ${percent}% - ${message}`);
  
  // Emitir progresso de carregamento via Socket.IO
  io.emit('whatsapp:loading', { percent, message, timestamp: Date.now() });
});

client.on('change_state', (state) => {
  console.log('🔄 Estado do cliente mudou para:', state);
  
  // Emitir mudança de estado via Socket.IO
  io.emit('whatsapp:state_change', { state, timestamp: Date.now() });
});

client.on('auth_failure', msg => {
  console.error('❌ Falha na autenticação WhatsApp:', msg);
  currentQRCode = null;
  isReady = false;
  
  // Emitir falha de autenticação via Socket.IO
  io.emit('whatsapp:auth_failure', { message: msg, timestamp: Date.now() });
  
  process.exit(1);
});

client.on('disconnected', (reason) => {
  console.log('⚠️ Cliente WhatsApp desconectado:', reason);
  isReady = false;
  currentQRCode = null;
  
  // Emitir desconexão via Socket.IO
  io.emit('whatsapp:disconnected', { reason, timestamp: Date.now() });
});

// Adicionar tratamento global de erros
process.on('unhandledRejection', (reason, promise) => {
  console.log('❌ Rejeição não tratada em:', promise, 'motivo:', reason);
});

process.on('uncaughtException', (error) => {
  console.log('❌ Exceção não capturada:', error);
});


client.on('message_create', async (msg) => {
  // Verifica se a mensagem foi enviada por você
  if (msg.fromMe) {
    try {


      //console.log('Mensagem enviada por você:', msg.body);
      let idAtual = msg.to.replace('@c.us', ''); // Obtém o destinatário da mensagem

      // Garantir carrinho e histórico
      try {
        if (!carrinhos[idAtual]) {
          if (carrinhoService && typeof carrinhoService.initCarrinho === 'function') {
            carrinhoService.initCarrinho(idAtual);
          } else {
            carrinhos[idAtual] = carrinhos[idAtual] || { carrinho: [], estado: 'menu-inicial', valorTotal: 0 };
          }
        }
        if (!carrinhos[idAtual].messages) carrinhos[idAtual].messages = [];
        const ts = Date.now();
        carrinhos[idAtual].messages.push({ fromMe: true, text: msg.body, timestamp: ts });
        if (carrinhos[idAtual].messages.length > 200) carrinhos[idAtual].messages.shift();
  try { events.emit('update', { type: 'message', id: idAtual, message: { fromMe: true, text: msg.body, timestamp: ts }, carrinho: sanitizeCarrinho(carrinhos[idAtual]) }); } catch(e) {}
      } catch(e) { /* não bloqueia fluxo */ }

      // Exemplo: Verifica se a mensagem enviada começa com "Endereço"
      if (msg.body.startsWith('Endereço ')) {
        let endereco = msg.body.replace('Endereço ', '').trim(); // Extrai o endereço

        // Atualiza o endereço no carrinho do cliente
        atualizarEnderecoCliente(idAtual, endereco); // Atualiza no banco de dados, se necessário
        console.log(`Endereço atualizado para o cliente ${idAtual}: ${endereco}`);
        if (carrinhos[idAtual]) {
          carrinhos[idAtual].endereco = endereco;
        }
      }
      if (msg.body.toLowerCase() === 'c') {
        if (carrinhos[idAtual].carrinho.length > 0) {
          carrinhos[idAtual].carrinho.pop();
          if (carrinhos[idAtual].carrinho.length === 0) {
            msg.reply('Seu carrinho está vazio. \n' + resp.msgmenuInicialSub);
          } else {
            msg.reply(`${carrinhoView(idAtual)}\n${resp.msgmenuInicialSub}`);
          }
        } else {
          msg.reply('Seu carrinho está vazio. \n' + resp.msgmenuInicialSub);
        }
      }

    } catch (error) {
      console.error('❌ Erro no client.on("message_create") fromMe:', error);
    }
    return;
  }

  // Verifica se é uma mensagem recebida (não enviada por você)
  if (!msg.fromMe) {
    try {
  // Obter informações de cliente e carrinho atual
  let idAtual = msg.from.replace('@c.us', '');
  let carrinhoAtual = carrinhos[idAtual];

      console.log(`${carrinhoAtual?.estado || ''} >> ${msg.body}`)

      if (!carrinhoAtual) {
        // Compatibilidade: use initCarrinho se disponível, caso contrário caia para inicializarCarrinho
        if (carrinhoService && typeof carrinhoService.initCarrinho === 'function') {
          carrinhoAtual = carrinhoService.initCarrinho(idAtual);
          carrinhos[idAtual] = carrinhoAtual;
        } else if (carrinhoService && typeof carrinhoService.initCarrinho === 'function') {
          // usa o wrapper initCarrinho (padronizado)
          carrinhoAtual = carrinhoService.initCarrinho(idAtual);
          carrinhos[idAtual] = carrinhoAtual;
        } else if (carrinhoService && typeof carrinhoService.getCarrinho === 'function') {
          // último recurso: tenta obter ou criar um carrinho mínimo
          try { carrinhoAtual = carrinhoService.getCarrinho(idAtual); } catch (e) { carrinhoAtual = null; }
          if (!carrinhoAtual) {
            carrinhoAtual = { carrinho: [], estado: (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuInicial) || 'menu-inicial', valorTotal: 0 };
            carrinhos[idAtual] = carrinhoAtual;
          }
        } else {
          // fallback simples para manter o fluxo funcionando
          carrinhoAtual = { carrinho: [], estado: 'menu-inicial', valorTotal: 0 };
          carrinhos[idAtual] = carrinhoAtual;
        }
      }

      // Tenta enriquecer o carrinho com o nome do cliente (se existir no DB)
      try {
        const info = await obterInformacoesClienteAsync(idAtual);
        if (info) {
          if (info.nome) {
            if (!carrinhoAtual.nome || String(carrinhoAtual.nome).trim() !== String(info.nome).trim()) {
              carrinhoAtual.nome = info.nome;
            }
          }
          if (info.endereco && (!carrinhoAtual.endereco || String(carrinhoAtual.endereco).trim() === '')) {
            carrinhoAtual.endereco = info.endereco;
          }
          if (typeof info.lat !== 'undefined' && (typeof carrinhoAtual.lat === 'undefined' || carrinhoAtual.lat === null)) carrinhoAtual.lat = info.lat;
          if (typeof info.lng !== 'undefined' && (typeof carrinhoAtual.lng === 'undefined' || carrinhoAtual.lng === null)) carrinhoAtual.lng = info.lng;
        }
      } catch (e) { /* não bloqueia o fluxo se DB não responder */ }

 

        // --- Primeiro contato do dia: envia saudação e cardápio ---
        try {
          const today = new Date().toISOString().slice(0,10);
          if (!carrinhoAtual.lastGreetingDate || carrinhoAtual.lastGreetingDate !== today) {
            carrinhoAtual.lastGreetingDate = today;
            // Busca mensagem de apresentação do banco de dados
            let saudacao = null;
            try {
              const msgApresentacao = mensagensService.getMensagemByChave('msgApresentação') || 
                                    mensagensService.getMensagemByChave('msgApresentacao');
              if (msgApresentacao && msgApresentacao.ativo) {
                saudacao = msgApresentacao.conteudo;
              }
            } catch (e) { 
              console.error('[BOT] Erro ao buscar mensagem de apresentação:', e);
            }
            
            // Fallback para mensagens util se não encontrar no banco
            if (!saudacao) {
              saudacao = (mensagens && mensagens.mensagem && (mensagens.mensagem.msgApresentacao || mensagens.mensagem['msgApresentação'])) || null;
            }
            if (!saudacao) saudacao = '🍔 BEM-VINDO AO BRUTUS BURGER!';

            // Busca nome do cliente para personalizar a saudação
            let nomeCliente = '';
            try {
              const info = await obterInformacoesClienteAsync(idAtual);
              if (info && info.nome) nomeCliente = info.nome;
            } catch (e) { /* ignore */ }

            let textoSaudacao = saudacao;
            if (nomeCliente) {
              if (/@nome/i.test(textoSaudacao)) textoSaudacao = textoSaudacao.replace(/@nome/ig, nomeCliente);
              else textoSaudacao = `Olá ${nomeCliente}!\n\n${textoSaudacao}`;
            }

            try { await msg.reply(textoSaudacao); } catch (e) { console.error('[SAUDACAO] erro ao enviar saudacao', e); }

            // Envia imagens do cardápio (se existirem)
            try { const cardapio = MessageMedia.fromFilePath('./cardapio.jpg'); client.sendMessage(msg.from, cardapio); } catch (e) {}
            try { const cardapio2 = MessageMedia.fromFilePath('./cardapio2.jpg'); client.sendMessage(msg.from, cardapio2); } catch (e) {}
            try { const cardapio3 = MessageMedia.fromFilePath('./cardapio3.jpg'); client.sendMessage(msg.from, cardapio3); } catch (e) {}

            try { events.emit('update', { type: 'greeting', id: idAtual, carrinho: sanitizeCarrinho(carrinhoAtual) }); } catch (e) {}
          }
        } catch (e) { /* não bloqueia fluxo */ }


      carrinhoAtual.lastMsg = msg.body.toLowerCase().replace('brutos ', 'brutus ');
      carrinhoAtual.respUser = msg.body;

      // Armazenar mensagem no histórico do carrinho para visualização no painel
      try {
        if (!carrinhoAtual.messages) carrinhoAtual.messages = [];
        const ts = Date.now();
        carrinhoAtual.messages.push({ fromMe: false, text: msg.body, timestamp: ts });
        if (carrinhoAtual.messages.length > 200) carrinhoAtual.messages.shift();
  try { events.emit('update', { type: 'message', id: idAtual, message: { fromMe: false, text: msg.body, timestamp: ts }, carrinho: sanitizeCarrinho(carrinhoAtual) }); } catch(e) {}
  // Reset and reschedule follow-up: client is active now (only if not finalized)
  try { 
    clearFollowupForClient(idAtual); 
    const finalState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
    const saiuState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.saiuParaEntrega) || 'saiu_para_entrega';
    const suporteState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuSuporte) || 'suporte';
    // Only schedule follow-up if the order is not finalized, delivered, or in support
    if (carrinhoAtual.estado !== finalState && carrinhoAtual.estado !== saiuState && carrinhoAtual.estado !== suporteState) {
      scheduleFollowupForClient(idAtual);
    }
  } catch(e) {}
      } catch(e) { /* não bloqueia fluxo */ }

      if (msg.body.toLowerCase() === 'c') {
        if (carrinhoAtual.carrinho.length > 0) {
          carrinhoAtual.carrinho.pop();
          const msgFinal = carrinhoAtual.carrinho.length === 0
            ? 'Seu carrinho está vazio. \n' + resp.msgmenuInicialSub
            : `${carrinhoView(idAtual)}\n${resp.msgmenuInicialSub}`;
          msg.reply(msgFinal);
        } else {
          msg.reply('Seu carrinho está vazio. \n' + resp.msgmenuInicialSub);
        }
        return;
      }

      if (msg.body === '...') {
        msg.reply(`${carrinhoView(idAtual)}\n${resp.msgmenuInicialSub}`);
        return;
      }

      if (msg.body.toLowerCase() === 'b') {
        msg.reply(`${mensagens.mensagem.msgMenuBebidas}`);
        return;
      }

      if (msg.body.toLowerCase() === 'reiniciar') {
        msg.reply(`Seu carrinho foi reiniciado. \n` + resp.msgmenuInicialSub);
        resetCarrinho(idAtual, carrinhoAtual);
        atualizarEstadoDoCarrinho(idAtual, stats.menuInicial);
        return;
      }

      if (msg.body.startsWith('. ')) {
        const pedido = msg.body.replace('. ', '').trim();
        const palavras = separarMensagem(pedido);
        analisarPalavras(palavras, carrinhoAtual, msg, idAtual);
        return;
      }

      let palavras = separarMensagem(msg.body);
      palavras = palavras.filter(p => ![ 'cola', 'di', 'de'].includes(p.toLowerCase()));
      palavras = palavras.map(p => p.toLowerCase().replace('brutos', 'brutus'));

      // Se estivermos em um estado sensível (ex: coletando endereço/nome/pagamento),
      // deixe o fluxo de estado tratar a mensagem e NÃO execute gatilhos ou auto-análise
      try {
        const sensitiveStates = [
          (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuEndereço) || 'coletando_endereco',
          (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuNome) || 'coletando_nome',
          (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuConfirmandoPedido) || 'confirmandoPedido',
          (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuPagamento) || 'formar_de_pagamento',
          (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuUnidadeBebida) || 'menu-quantidade-bebidas',
          (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuQuantidadeAdicionais) || 'quantidade_adicionais'
        ];
        if (sensitiveStates.includes(carrinhoAtual.estado)) {
          console.log(`[SENSITIVE] estado sensível detectado para ${idAtual}: ${carrinhoAtual.estado} — processando apenas por status`);
          try {
            await analisePorStatus(carrinhoAtual, msg, idAtual, client, MessageMedia);
          } catch (e) { console.error('Erro ao processar estado sensível:', e); }
          return; // Não continua com gatilhos/auto-análise
        }
      } catch (e) { /* se falhar, continua normalmente */ }

      // Priorizar gatilhos personalizados: se um gatilho corresponder, responder e parar processamento
      let gatilhoDisparado = false;
      try {
        gatilhoDisparado = await verificarGatilhosPersonalizados(msg.body, msg, idAtual);
        console.log(`[GATILHO] verificação retornou: ${gatilhoDisparado} para ${idAtual}`);
        if (gatilhoDisparado) return;
      } catch (e) {
        console.error('Erro ao verificar gatilhos:', e);
      }

      // Se nenhum gatilho respondeu, executa autoatendimento
      // Análise por palavras (adiciona itens, responde cardápio, etc)
      let acoes = [];
      try {
        console.log('Analisando mensagem', palavras);
        acoes = analisarPalavras(palavras, carrinhoAtual, msg, idAtual, client, MessageMedia) || [];
        console.log('Ações:', acoes);
      } catch (e) {
        console.error('Erro na análise de palavras:', e);
      }

      // Sempre analisa por status (fluxo conversacional)
      try {
        console.log('Analisando por status');
        analisePorStatus(carrinhoAtual, msg, idAtual, client, MessageMedia);
      } catch (e) {
        console.error('Erro na análise por status:', e);
      }

    } catch (error) {
      console.error('❌ Erro no client.on("message"):', error);
    }
  }
});

// Import do stats corrigido
const stats = {
  menuInicial: 'menu_inicial',
  menuFinalizado: 'menu_finalizado',
  menuAdicionais: 'menu_adicionais',
  menuNome: 'menu_nome',
  menuObservacao: 'menu_observacao',
  menuPagamento: 'menu_pagamento',
  menuTroco: 'menu_troco',
  menuEndereco: 'menu_endereco',
  menuSuporte: 'menu_suporte'
};

// ---- Follow-up helper: se cliente parou de responder por X minutos após adicionar itens
function clearFollowupForClient(id) {
  try {
    const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
    const c = carrinhos[idNorm];
    if (c && c._followupTimeout) {
      clearTimeout(c._followupTimeout);
      c._followupTimeout = null;
    }
    if (c) c._followupSent = false;
  } catch (e) { /* ignore */ }
}

function scheduleFollowupForClient(id, delayMs = 10 * 60 * 1000) {
  try {
    const idNorm = String(id).replace(/@c\.us$|@s\.whatsapp\.net$/i, '');
    const c = carrinhos[idNorm];
    if (!c) return;
    if (c._followupTimeout) { clearTimeout(c._followupTimeout); c._followupTimeout = null; }
    const hasItems = Array.isArray(c.carrinho) && c.carrinho.length > 0;
    const finalState = (carrinhoService && carrinhoService.stats && carrinhoService.stats.menuFinalizado) || 'finalizado';
    if (!hasItems) return;
    if (c._followupSent) return;

    c._followupTimeout = setTimeout(async () => {
      try {
        const current = carrinhos[idNorm];
        if (!current) return;
        const stillHasItems = Array.isArray(current.carrinho) && current.carrinho.length > 0;
        if (!stillHasItems) return;
        if (current.estado && String(current.estado) === String(finalState)) return;
        if (current._followupSent) return;

        const texto = (mensagens && mensagens.mensagem && mensagens.mensagem.msgFollowup) || 'Olá! Notei que você começou um pedido e não respondeu. Precisa de ajuda para finalizar ou quer continuar pedindo?';
        try {
          if (client) await client.sendMessage(idNorm + '@s.whatsapp.net', texto);
          current._followupSent = true;
          try { events.emit('update', { type: 'followup_sent', id: idNorm, carrinho: sanitizeCarrinho(current) }); } catch (e) {}
        } catch (e) { console.error('[FOLLOWUP] erro ao enviar follow-up:', e); }
      } catch (e) { /* ignore */ }
    }, delayMs);
  } catch (e) { /* ignore */ }
}
