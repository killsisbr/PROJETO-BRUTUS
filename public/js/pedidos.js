// public/js/pedidos.js - Lógica do painel de pedidos
// Extrair do inline script de pedidos.html + melhorias de UX (toasts, loading states)

const socket = io();
const lista = document.getElementById('lista');
const carrinhos = {};



// Mapa de bebidas para reconhecimento automático
const mapaBebidas = {
  // Coca-Cola
  'coca lata': 31,
  'coca zero': 32,
  'coca lata zero': 32,
  'coca zero lata': 32,
  'coca 2l': 33,
  'coca dois litros': 33,
  'coca 2 litros': 33,
  'coca 2l zero': 34,
  'coca dois litros zero': 34,
  'coca 2 litros zero': 34,
  'coca zero 2l': 34,
  'coca zero dois litros': 34,
  'coca zero 2 litros': 34,
  // guaraná
  'guaraná lata': 35,
  'guarana lata': 35,
  // guaraná 2l
  'guaraná 2l': 36,
  'guaraná dois litros': 36,
  'guaraná 2 litros': 36,
  'guaraná 2 litro': 36,
  'guaraná 2lts': 36,
  'guaraná 2 lt': 36,
  'guaraná 2lt': 36,
  'lata guaraná': 36,
  'lata guarana': 36,
  'guarana 2l': 36,
  '2l guarana': 36,
  '2l guaraná': 36,
  'guarana 2 l': 36,
  'guaraná 2 l': 36
};

// Normaliza IDs/contatos exibidos no painel, removendo sufixos comuns
function sanitizeId(rawId) {
  if (!rawId) return '';
  // remove sufixos conhecidos como '@s.whatsapp.net' e '@broadcast'
  return String(rawId).replace('@s.whatsapp.net', '').replace('@broadcast', '');
}

// Configuration: when true, opening a conversation modal will automatically request
// printing the order (useful for kitchen stations). Can be toggled as needed.
const AUTO_PRINT_ON_OPEN = false;
// Prevent double auto-print for the same order during the session
const autoPrintDone = new Set();

// Flags para ações em andamento (evita cliques duplicados)
let actionsInFlight = new Set(); // ex: 'add', 'remove', 'updateQty', 'finalizar'

function showToast(message, type = 'info') {
  // Cria toast simples no topo da tela
  const toast = document.createElement('div');
  const colors = {
    success: '#2a7',
    error: '#c44',
    warning: '#f59e0b',
    info: '#2ac'
  };
  
  toast.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 10000;
    padding: 12px 16px; border-radius: 8px; color: #fff; font-size: 14px;
    background: ${colors[type] || colors.info};
    box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 300px;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setButtonLoading(buttonId, loading = true) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.innerHTML += ' ⏳'; // Indicador visual simples
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.innerHTML = btn.innerHTML.replace(' ⏳', ''); // Remove spinner
  }
}

// Função para emitir ação com loading e toast
function emitAction(actionType, data, buttonId = null) {
  if (actionsInFlight.has(actionType)) return; // Evita duplicatas
  actionsInFlight.add(actionType);
  if (buttonId) setButtonLoading(buttonId, true);

  socket.emit(actionType, data);

  socket.once('admin:ack', (r) => {
    actionsInFlight.delete(actionType);
    if (buttonId) setButtonLoading(buttonId, false);
    if (r.ok) {
      showToast(`Ação ${actionType} realizada com sucesso!`, 'success');
      // Refresh UI se necessário
      if (data && data.id) setTimeout(() => showConversation(data.id), 100);
    } else {
      // Mapeamento de erros amigáveis
      const friendlyErrors = {
        'not_finalized': 'O pedido precisa estar finalizado antes de marcar como "Saiu para entrega".'
      };
      const msg = (r && r.error && friendlyErrors[r.error]) ? friendlyErrors[r.error] : `Erro em ${actionType}: ${r && r.error ? r.error : 'Desconhecido'}`;
      showToast(msg, 'error');
    }
  });
}

// Função para renderizar um card de pedido
function renderCard(id, data) {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = `card-${id}`;
  
  const sanitizedId = sanitizeId(id);
  const nome = data.nome || 'Cliente';
  const estado = data.estado || 'menuInicial';
  const itens = (data.carrinho && data.carrinho.carrinho) || data.carrinho || data.itens || [];
    const total = (data.carrinho && data.carrinho.valorTotal) || data.valorTotal || data.total || 0;
  const endereco = data.endereco || '';
  
  // Determina a cor do status baseado no estado
  let statusColor = '#95a5a6'; // cinza padrão
  let statusText = estado;
  
  if (estado.includes('menu') || estado.includes('confirmacao')) {
    statusColor = '#f1c40f'; // amarelo
    statusText = 'Pedindo / Em confirmação';
  } else if (estado.includes('endereco') || estado.includes('Endereco')) {
    statusColor = '#3498db'; // azul
    statusText = 'Coletando endereço';
  } else if (estado === 'finalizado' || estado.includes('final')) {
    statusColor = '#2ecc71'; // verde
    statusText = 'Finalizado';
  }
  
  card.innerHTML = `
    <div class="top-row">
      <h3>${nome}</h3>
      <div class="pill" style="background-color: ${statusColor}; color: #fff">${statusText}</div>
    </div>
    <p class="small">ID: ${sanitizedId}</p>
    ${endereco ? `<p class="small">📍 ${endereco}</p>` : ''}
    
    <div class="cart-items">
      ${itens.length === 0 ? '<div class="small">Carrinho vazio</div>' : 
        itens.map((item, index) => `
          <div class="cart-item">
            <div>
              <strong>${item.quantidade || 1}x ${item.nome || item.id || 'Item'}</strong>
              ${item.preparo ? `<br><small class="muted">${item.preparo}</small>` : ''}
            </div>
            <div class="item-actions">
              <button class="qty-btn" onclick="emitUpdateQty('${id}', ${index}, -1)">-</button>
              <span>${item.quantidade || 1}</span>
              <button class="qty-btn" onclick="emitUpdateQty('${id}', ${index}, 1)">+</button>
              <button class="trash-btn" onclick="removeItem('${id}', ${index})">🗑️</button>
            </div>
          </div>
        `).join('')
      }
    </div>
    
    <div style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1)">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
        <strong>Total: R$ ${Number(total).toFixed(2)}</strong>
        <div style="display: flex; gap: 6px">
          <input type="text" id="add-input-${sanitizedId}" placeholder="Adicionar item..." 
                 style="padding: 6px; border-radius: 4px; border: 1px solid #333; background: #0f0f0f; color: #eee; width: 140px; font-size: 12px">
          <button id="add-btn-${sanitizedId}" class="small" onclick="addItemByName('${id}', '${sanitizedId}')">+</button>
        </div>
      </div>
    </div>
    
    <div class="controls">
      <button class="chat-btn" onclick="showConversation('${id}')" title="Conversa WhatsApp">💬</button>
      <button class="final-btn" onclick="finalizar('${id}')" title="Finalizar Pedido">✅</button>
      ${(estado === 'finalizado' || estado.includes('final')) ? 
        `<button class="delivery-btn" onclick="saiuEntrega('${id}')" title="Saiu para Entrega">🚚</button>` : ''}
      <button class="secondary small" onclick="setState('${id}', 'menuInicial')" title="Reiniciar Pedido">🔄</button>
      <button class="danger small" onclick="reset('${id}')" title="Limpar Carrinho">🗑️</button>
      <button class="danger small" onclick="deleteCard('${id}')" title="Excluir Card">❌</button>
    </div>
  `;
  
  return card;
}

// Resto do código extraído (renderAll, addItemByName, etc.)
function renderAll() {
  lista.innerHTML = '';
  const keys = Object.keys(carrinhos).sort();
  for (const id of keys) {
    lista.appendChild(renderCard(id, carrinhos[id]));
  }
}

function showConversation(id) {
  try {
    const modal = document.getElementById('conversation-modal');
    const title = document.getElementById('conv-title');
    const body = document.getElementById('conv-messages');
    const cartEl = document.getElementById('conv-cart');
    const valorEl = document.getElementById('conv-valor');
    const openWa = document.getElementById('conv-open-wa');

    const data = carrinhos[id] || {};
    if (title) title.textContent = `${data.nome || 'Cliente'} — ${sanitizeId(id)}`;

    if (body) {
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '8px';

      const msgs = (data.messages && Array.isArray(data.messages)) ? data.messages.slice(-200) : (data.lastMsg ? [{ fromMe:false, text: data.lastMsg, timestamp: Date.now() }] : []);
      if (msgs.length === 0) {
        body.innerHTML = '<div class="small">Nenhuma mensagem disponível</div>';
      } else {
        for (const m of msgs) {
          const bubble = document.createElement('div');
          bubble.style.display = 'flex';
          bubble.style.flexDirection = 'column';
          bubble.style.alignItems = m.fromMe ? 'flex-end' : 'flex-start';

          const time = document.createElement('div');
          time.style.fontSize = '11px';
          time.style.color = '#999';
          time.style.marginBottom = '4px';
          time.textContent = new Date(m.timestamp || Date.now()).toLocaleString();

          const content = document.createElement('div');
          content.style.maxWidth = '86%';
          content.style.padding = '8px 10px';
          content.style.borderRadius = '12px';
          content.style.background = m.fromMe ? '#2a7' : '#222';
          content.style.color = m.fromMe ? '#042' : '#eee';
          content.innerHTML = (m.text || '').replace(/\n/g, '<br/>');

          bubble.appendChild(time);
          bubble.appendChild(content);
          wrap.appendChild(bubble);
        }
        body.appendChild(wrap);
        setTimeout(()=>{ body.scrollTop = body.scrollHeight; }, 10);
      }
    }

    if (cartEl) {
      cartEl.innerHTML = '';
      const itens = (data.carrinho || []);
      if (itens.length === 0) cartEl.innerHTML = '<div class="small">Carrinho vazio</div>';
      else {
        const agg = {};
        for (let idx = 0; idx < itens.length; idx++) {
          const it = itens[idx];
          const key = `${it.id||''}::${(it.preparo||'').trim()}::${(it.nome||'').trim()}`;
          if (!agg[key]) agg[key] = { ...it, quantidade:0, indices: [] };
          agg[key].quantidade += Number(it.quantidade||1);
          agg[key].indices.push(idx);
        }
        cartEl.innerHTML = Object.keys(agg).map(k => {
          const it = agg[k];
          return it.indices.map((originalIndex) => {
            const qtd = Number(itens[originalIndex].quantidade || 1);
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed rgba(255,255,255,0.03)"><div><strong>${qtd}x</strong> ${it.nome} ${it.preparo ? `(${it.preparo})` : ''}</div><div style="display:flex;gap:6px;align-items:center"><small class="muted">R$ ${Number(it.preco||0).toFixed(2)}</small><button id="qty-minus-${originalIndex}" class="qty-btn" onclick="emitUpdateQty('${id}', ${originalIndex}, -1)">−</button><button id="qty-plus-${originalIndex}" class="qty-btn" onclick="emitUpdateQty('${id}', ${originalIndex}, 1)">+</button><button id="remove-btn-${originalIndex}" style="background:#a22;color:#fff;border:0;padding:6px;border-radius:6px" onclick="removeItem('${id}', ${originalIndex})">Remover</button></div></div>`;
          }).join('');
        }).join('');
      }
    }

    try {
      let total = 0; const itensCalc = (data.carrinho || []);
      for (const it of itensCalc) { total += (Number(it.preco||0) * Number(it.quantidade||1)); }
      let entregaVal = 0; try { if (data.entrega && typeof data.valorEntrega === 'number' && data.valorEntrega > 0) entregaVal = Number(data.valorEntrega); } catch(e) {}
      const produtoTotal = Math.max(0, Number(total) - Number(entregaVal || 0)); if (valorEl) valorEl.textContent = Number(produtoTotal || data.valorTotal || 0).toFixed(2);
      try { const taxaEl = document.getElementById('conv-taxa'); if (taxaEl) taxaEl.textContent = (data.valorEntrega && Number(data.valorEntrega) ? Number(data.valorEntrega).toFixed(2) : '0.00'); } catch(e) {}
    } catch(e) { if (valorEl) valorEl.textContent = Number(data.valorTotal||0).toFixed(2); }

    try { if (openWa) openWa.onclick = () => { window.open(`https://wa.me/${id.replace('@s.whatsapp.net','')}`); }; } catch(e) {}
    try { const closeEl = document.getElementById('conv-close'); if (closeEl) closeEl.onclick = closeConversation; } catch(e) {}

    try { const modal = document.getElementById('conversation-modal'); if (modal) modal.style.display = 'flex'; } catch(e) { console.error('Erro mostrando modal de conversa', e); }

  } catch (e) {
    console.error('showConversation error', e);
    try { const modal = document.getElementById('conversation-modal'); if (modal) modal.style.display = 'flex'; } catch (ee) { console.error('Erro forçando abertura do modal', ee); }
  }
}

// Prompt quick-edit for client name (from card)
function editClientNamePrompt(id) {
  const current = (carrinhos[id] && carrinhos[id].nome) ? carrinhos[id].nome : '';
  const novo = prompt('Novo nome do cliente:', current || '');
  if (novo === null) return; // cancel
  // emit via socket
  socket.emit('admin:updateName', { id, nome: novo });
}

function editClientAddressPrompt(id) {
  const current = (carrinhos[id] && carrinhos[id].endereco) ? carrinhos[id].endereco : '';
  const novo = prompt('Endereço do cliente (ex: Rua, nº, bairro):', current || '');
  if (novo === null) return;
  const novoTrim = String(novo || '').trim();
  if (novoTrim.length < 6) {
    showToast('Endereço muito curto. Informe no mínimo 6 caracteres.', 'error');
    return;
  }
  socket.emit('admin:updateEndereco', { id, endereco: novoTrim });
}

function setState(id, state) {
  emitAction('admin:setState', { id, state }, `reset-btn-${id}`);
}

function reset(id) {
  emitAction('admin:reset', { id }, `clear-btn-${id}`);
}

function finalizar(id) {
  emitAction('admin:finalizar', { id }, `final-btn-${id}`);
}

function saiuEntrega(id) {
  emitAction('admin:saiuEntrega', { id }, `delivery-btn-${id}`);
}

// mapa dinâmico para itens adicionados via modal (nome limpo -> id)
// Será populado a partir do servidor (mappings persistidos no DB)
const mapaCardapio = {};

async function loadCardapioAndMappings() {
  try {
    // fetch mappings first (nome -> itemId)
    const mRes = await fetch('/api/cardapio/mappings');
    const mJson = await mRes.json();
    if (mJson && mJson.ok && mJson.mappings) {
      Object.assign(mapaCardapio, mJson.mappings);
    }
    // optionally fetch items for UI purposes (not strictly needed for mapping)
    try {
      const itRes = await fetch('/api/cardapio');
      const itJson = await itRes.json();
      if (itJson && itJson.ok && Array.isArray(itJson.items)) {
        // if items exist, ensure any mapping referencing a numeric id that doesn't exist yet
        // is left as-is. We won't auto-create mappings here.
      }
    } catch(e) {}
  } catch (e) {
    console.error('Erro carregando cardapio/mappings do servidor', e);
  }
}

// Sistema Unificado de Gerenciamento do Cardápio
class CardapioManager {
  constructor() {
    this.currentTab = 'visualizar';
    this.cardapioData = [];
    this.editingItem = null;
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadCardapioData();
  }

  bindEvents() {
    // Modal principal
    const openBtn = document.getElementById('btn-cardapio');
    const closeBtn = document.getElementById('cardapio-close');
    if (openBtn) openBtn.addEventListener('click', () => this.openModal());
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());

    // Sistema de abas
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
    });

    // Aba Visualizar & Editar
    const searchInput = document.getElementById('buscar-item-unified');
    const filterSelect = document.getElementById('filtro-tipo-unified');
    const refreshBtn = document.getElementById('refresh-cardapio-unified');
    
    if (searchInput) searchInput.addEventListener('input', () => this.filterItems());
    if (filterSelect) filterSelect.addEventListener('change', () => this.filterItems());
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.refreshCardapio());

    // Aba Adicionar Item
    const saveBtn = document.getElementById('salvar-item-unified');
    const clearBtn = document.getElementById('limpar-form-unified');
    
    console.log('🔧 DEBUG: Botão salvar encontrado:', saveBtn);
    if (saveBtn) {
      console.log('🔧 DEBUG: Adicionando event listener ao botão salvar');
      saveBtn.addEventListener('click', () => {
        console.log('🔧 DEBUG: Botão salvar clicado!');
        this.saveNewItem();
      });
    }
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearForm());

    // Aba Mapeamentos
    const addMappingBtn = document.getElementById('adicionar-mapeamento-unified');
    const addMultipleBtn = document.getElementById('adicionar-multiplos-gatilhos-unified');
    const refreshMappingsBtn = document.getElementById('refresh-mapeamentos-unified');
    
    if (addMappingBtn) addMappingBtn.addEventListener('click', () => this.addMapping());
    if (addMultipleBtn) addMultipleBtn.addEventListener('click', () => this.addMultipleMappings());
    if (refreshMappingsBtn) refreshMappingsBtn.addEventListener('click', () => this.loadMapeamentos());

    // Aba Configurações
    const backupBtn = document.getElementById('backup-cardapio');
    const restoreBtn = document.getElementById('restore-cardapio');
    const resetBtn = document.getElementById('reset-cardapio');
    const syncBtn = document.getElementById('sync-servidor');
    const diagnosticoBtn = document.getElementById('diagnostico-mapeamentos');
    const forcarAtualizarBtn = document.getElementById('forcar-atualizar-mapeamentos');
    
    if (backupBtn) backupBtn.addEventListener('click', () => this.backupCardapio());
    if (restoreBtn) restoreBtn.addEventListener('click', () => this.restoreCardapio());
    if (resetBtn) resetBtn.addEventListener('click', () => this.resetCardapio());
    if (syncBtn) syncBtn.addEventListener('click', () => this.syncWithServer());
    if (diagnosticoBtn) diagnosticoBtn.addEventListener('click', () => this.diagnosticarMapeamentos());
    if (forcarAtualizarBtn) forcarAtualizarBtn.addEventListener('click', () => this.forcarAtualizacaoMapeamentos());
  }

  openModal() {
    const modal = document.getElementById('cardapio-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    this.switchTab('visualizar');
    this.loadCardapioData();
    this.updateStats();
  }

  closeModal() {
    const modal = document.getElementById('cardapio-modal');
    if (!modal) return;
    modal.style.display = 'none';
    this.editingItem = null;
  }

  switchTab(tabName) {
    // Atualizar botões das abas
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
      btn.style.color = 'rgba(255,255,255,0.6)';
      btn.style.borderBottomColor = 'transparent';
    });
    
    const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeBtn) {
      activeBtn.classList.add('active');
      activeBtn.style.color = '#fff';
      activeBtn.style.borderBottomColor = '#3498db';
    }

    // Mostrar/ocultar conteúdo das abas
    document.querySelectorAll('.tab-content').forEach(content => {
      content.style.display = 'none';
    });
    
    const activeContent = document.getElementById(`tab-${tabName}`);
    if (activeContent) {
      activeContent.style.display = 'block';
    }

    this.currentTab = tabName;
    
    // Carregar dados específicos da aba
    switch(tabName) {
      case 'visualizar':
        this.renderCardapioList();
        break;
      case 'mapeamentos':
        this.loadMapeamentos();
        break;
      case 'configuracoes':
        this.updateStats();
        break;
    }
  }

  async loadCardapioData() {
    try {
      // Carregar dados do servidor (banco SQLite)
      const response = await fetch('/api/cardapio');
      const data = await response.json();
      
      if (data && data.ok && Array.isArray(data.items)) {
        this.cardapioData = data.items;
        // Salvar no localStorage como backup
        localStorage.setItem('cardapio', JSON.stringify(this.cardapioData));
      } else {
        // Fallback para localStorage se servidor falhar
        const localData = localStorage.getItem('cardapio');
        if (localData) {
          this.cardapioData = JSON.parse(localData);
        } else {
          this.cardapioData = [];
        }
      }
      
      // Carregar mapeamentos
      await loadCardapioAndMappings();
      this.renderCardapioList();
    } catch (error) {
      console.error('Erro ao carregar dados do cardápio:', error);
      // Fallback para localStorage em caso de erro
      const localData = localStorage.getItem('cardapio');
      if (localData) {
        this.cardapioData = JSON.parse(localData);
        this.renderCardapioList();
      }
      showToast('Erro ao carregar cardápio do servidor, usando dados locais', 'warning');
    }
  }

  renderCardapioList() {
    console.log('🔧 DEBUG: renderCardapioList chamado');
    const container = document.getElementById('lista-cardapio-unified');
    if (!container) {
      console.log('🔧 DEBUG: Container lista-cardapio-unified não encontrado!');
      return;
    }
    console.log('🔧 DEBUG: Container encontrado, dados do cardápio:', this.cardapioData);

    const searchTerm = document.getElementById('buscar-item-unified')?.value.toLowerCase() || '';
    const filterType = document.getElementById('filtro-tipo-unified')?.value || '';
    
    let filteredData = this.cardapioData.filter(item => {
      const matchesSearch = !searchTerm || 
        item.nome.toLowerCase().includes(searchTerm) ||
        (item.descricao && item.descricao.toLowerCase().includes(searchTerm));
      const matchesType = !filterType || item.tipo === filterType;
      return matchesSearch && matchesType;
    });

    if (filteredData.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;color:rgba(255,255,255,0.6);padding:40px;">
          <div style="font-size:48px;margin-bottom:16px;">🍽️</div>
          <div style="font-size:18px;margin-bottom:8px;">Nenhum item encontrado</div>
          <div style="font-size:14px;">Tente ajustar os filtros ou adicionar novos itens</div>
        </div>
      `;
      return;
    }

    const tipoIcons = {
      'Lanche': '🍔',
      'Bebida': '🥤',
      'Adicional': '🧀',
      'Sobremesa': '🍰'
    };

    const tipoColors = {
      'Lanche': '#10b981',
      'Bebida': '#3b82f6',
      'Adicional': '#f59e0b',
      'Sobremesa': '#8b5cf6'
    };

    container.innerHTML = filteredData.map(item => `
      <div class="cardapio-item" data-id="${item.id || item.nome}" style="
        background:rgba(255,255,255,0.05);
        backdrop-filter:blur(10px);
        border:1px solid rgba(255,255,255,0.1);
        border-radius:12px;
        padding:20px;
        transition:all 0.3s ease;
        cursor:pointer;
      " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 25px rgba(0,0,0,0.3)'" onmouseout="this.style.transform='translateY(0)';this.style.boxShadow='none'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <span style="font-size:24px;">${tipoIcons[item.tipo] || '📦'}</span>
              <div>
                <h4 style="margin:0;color:#fff;font-size:18px;font-weight:600;" onclick="cardapioManager.editField('${item.id || item.nome}', 'nome', this)">${item.nome}</h4>
                <span style="
                  background:${tipoColors[item.tipo] || '#6b7280'};
                  color:#fff;
                  padding:4px 12px;
                  border-radius:20px;
                  font-size:12px;
                  font-weight:500;
                ">${item.tipo}</span>
              </div>
            </div>
            ${item.descricao ? `<p style="margin:0 0 8px 0;color:rgba(255,255,255,0.7);font-size:14px;" onclick="cardapioManager.editField('${item.id || item.nome}', 'descricao', this)">${item.descricao}</p>` : ''}
            <div style="display:flex;align-items:center;gap:16px;">
              <div style="color:#10b981;font-weight:bold;font-size:20px;" onclick="cardapioManager.editField('${item.id || item.nome}', 'preco', this)">R$ ${item.preco ? item.preco.toFixed(2) : '0.00'}</div>
              ${item.id ? `<div style="color:rgba(255,255,255,0.5);font-size:12px;">ID: ${item.id}</div>` : ''}
            </div>
            ${item.gatilhos && item.gatilhos.length > 0 ? `
              <div style="margin-top:12px;">
                <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-bottom:4px;">Gatilhos:</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;" onclick="cardapioManager.editField('${item.id || item.nome}', 'gatilhos', this)">
                  ${item.gatilhos.map(g => `<span style="background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);padding:2px 8px;border-radius:12px;font-size:11px;">${g}</span>`).join('')}
                </div>
              </div>
            ` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button onclick="console.log('🔧 DEBUG: Botão editar clicado para item:', '${item.id || item.nome}'); cardapioManager.editItem('${item.id || item.nome}')" style="
              background:linear-gradient(135deg,#3b82f6,#1d4ed8);
              color:#fff;
              border:0;
              padding:8px 12px;
              border-radius:6px;
              cursor:pointer;
              font-size:12px;
              font-weight:500;
            ">✏️ Editar</button>
            <button onclick="(async () => await cardapioManager.viewTriggers('${item.id || item.nome}'))()" style="
              background:linear-gradient(135deg,#8b5cf6,#7c3aed);
              color:#fff;
              border:0;
              padding:8px 12px;
              border-radius:6px;
              cursor:pointer;
              font-size:12px;
              font-weight:500;
            ">🎯 Ver Gatilhos</button>
            <button onclick="cardapioManager.deleteItem('${item.id || item.nome}')" style="
              background:linear-gradient(135deg,#ef4444,#dc2626);
              color:#fff;
              border:0;
              padding:8px 12px;
              border-radius:6px;
              cursor:pointer;
              font-size:12px;
              font-weight:500;
            ">🗑️ Excluir</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  filterItems() {
    this.renderCardapioList();
  }

  refreshCardapio() {
    this.loadCardapioData();
    showToast('🔄 Cardápio atualizado', 'info');
  }

  // Edição inline de campos
  editField(itemId, field, element) {
    const item = this.cardapioData.find(i => (i.id || i.nome) === itemId);
    if (!item) return;

    const currentValue = field === 'gatilhos' ? item[field]?.join(', ') || '' : item[field] || '';
    const input = document.createElement('input');
    input.type = field === 'preco' ? 'number' : 'text';
    input.value = currentValue;
    input.style.cssText = `
      background:rgba(255,255,255,0.1);
      border:1px solid #3498db;
      border-radius:4px;
      padding:4px 8px;
      color:#fff;
      font-size:inherit;
      width:100%;
    `;

    const originalText = element.textContent;
    element.innerHTML = '';
    element.appendChild(input);
    input.focus();
    input.select();

    const saveEdit = () => {
      let newValue = input.value.trim();
      
      if (field === 'preco') {
        newValue = parseFloat(newValue) || 0;
      } else if (field === 'gatilhos') {
        newValue = newValue.split(',').map(g => g.trim()).filter(g => g);
      }
      
      item[field] = newValue;
      this.saveCardapioData();
      this.renderCardapioList();
      showToast(`✅ ${field} atualizado`, 'success');
    };

    const cancelEdit = () => {
      element.textContent = originalText;
    };

    input.addEventListener('blur', saveEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveEdit();
      if (e.key === 'Escape') cancelEdit();
    });
  }

  editItem(itemId) {
    console.log('🔧 DEBUG: editItem chamado com ID:', itemId, 'tipo:', typeof itemId);
    console.log('🔧 DEBUG: cardapioData length:', this.cardapioData.length);
    console.log('🔧 DEBUG: Todos os IDs disponíveis:', this.cardapioData.map(i => i.id));
    const item = this.cardapioData.find(i => i.id == itemId || i.id === parseInt(itemId) || i.id === String(itemId));
    console.log('🔧 DEBUG: Item encontrado:', item);
    console.log('🔧 DEBUG: Primeiros 3 itens:', this.cardapioData.slice(0, 3));
    
    if (!item) {
      console.log('🔧 DEBUG: Item não encontrado!');
      showToast('❌ Item não encontrado', 'error');
      return;
    }

    // Preencher formulário na aba de adicionar
    console.log('🔧 DEBUG: Mudando para aba adicionar');
    this.switchTab('adicionar');
    
    console.log('🔧 DEBUG: Preenchendo formulário');
    document.getElementById('item-nome-unified').value = item.nome || '';
    document.getElementById('item-desc-unified').value = item.descricao || '';
    document.getElementById('item-preco-unified').value = item.preco || '';
    document.getElementById('item-tipo-unified').value = item.tipo || '';
    document.getElementById('item-gatilhos-unified').value = item.gatilhos?.join(', ') || '';
    
    this.editingItem = itemId;
    document.getElementById('salvar-item-unified').textContent = '💾 Atualizar Item';
    console.log('🔧 DEBUG: Modo de edição ativado para item:', itemId);
    showToast('📝 Modo de edição ativado', 'info');
  }

  duplicateItem(itemId) {
    const item = this.cardapioData.find(i => (i.id || i.nome) === itemId);
    if (!item) return;

    const newItem = {
      ...item,
      nome: `${item.nome} (Cópia)`,
      id: Date.now() // Novo ID
    };
    
    this.cardapioData.push(newItem);
    this.saveCardapioData();
    this.renderCardapioList();
    showToast('📋 Item duplicado com sucesso', 'success');
  }

  async viewTriggers(itemId) {
    const item = this.cardapioData.find(i => (i.id || i.nome) === itemId);
    if (!item) {
      showToast('❌ Item não encontrado', 'error');
      return;
    }
    
    // Buscar gatilhos dos mappings do servidor
    let gatilhos = [];
    try {
      const response = await fetch('/api/cardapio/mappings');
      const data = await response.json();
      if (data && data.ok && data.mappings) {
        // Criar mapa reverso: encontrar todos os gatilhos que apontam para este item
        gatilhos = Object.entries(data.mappings)
          .filter(([gatilho, mappedItemId]) => mappedItemId == itemId)
          .map(([gatilho, mappedItemId]) => gatilho);
      }
    } catch (error) {
      console.error('Erro ao carregar gatilhos:', error);
      showToast('⚠️ Erro ao carregar gatilhos do servidor', 'warning');
    }
    
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3000;
    `;
    
    modal.innerHTML = `
      <div style="
        background: rgba(255,255,255,0.1);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255,255,255,0.2);
        color: #fff;
        width: 500px;
        max-width: 95%;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h3 style="margin:0;font-size:20px;font-weight:600;">🎯 Gatilhos do Item</h3>
          <button onclick="this.closest('div').parentElement.remove()" style="
            background:rgba(255,255,255,0.1);
            border:1px solid rgba(255,255,255,0.2);
            color:#fff;
            padding:8px 12px;
            border-radius:8px;
            cursor:pointer;
          ">✕ Fechar</button>
        </div>
        
        <div style="margin-bottom:16px;">
          <h4 style="margin:0 0 8px 0;color:#fff;">${item.nome}</h4>
          <p style="margin:0;color:rgba(255,255,255,0.7);font-size:14px;">ID: ${item.id || 'Auto'} | Tipo: ${item.tipo}</p>
        </div>
        
        <div style="
          background:rgba(255,255,255,0.05);
          border:1px solid rgba(255,255,255,0.1);
          border-radius:12px;
          padding:16px;
          margin-bottom:20px;
        ">
          <h5 style="margin:0 0 12px 0;color:#fff;">Gatilhos Atuais (${gatilhos.length}):</h5>
          ${gatilhos.length > 0 ? 
            gatilhos.map(g => `<span style="
              background:rgba(139,92,246,0.2);
              border:1px solid rgba(139,92,246,0.3);
              color:#c4b5fd;
              padding:6px 12px;
              border-radius:20px;
              font-size:12px;
              margin:4px 4px 4px 0;
              display:inline-block;
            ">${g}</span>`).join('') 
            : '<p style="margin:0;color:rgba(255,255,255,0.5);font-style:italic;">Nenhum gatilho configurado para este item</p>'
          }
        </div>
        
        <div style="display:flex;gap:12px;justify-content:flex-end;">
          <button onclick="cardapioManager.editItem('${itemId}'); this.closest('div').parentElement.remove();" style="
            background:linear-gradient(135deg,#3b82f6,#1d4ed8);
            color:#fff;
            border:0;
            padding:10px 16px;
            border-radius:8px;
            cursor:pointer;
            font-weight:500;
          ">✏️ Editar Item</button>
          <button onclick="this.closest('div').parentElement.remove()" style="
            background:rgba(255,255,255,0.1);
            border:1px solid rgba(255,255,255,0.2);
            color:#fff;
            padding:10px 16px;
            border-radius:8px;
            cursor:pointer;
          ">Fechar</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Fechar modal ao clicar fora
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  async deleteItem(itemId) {
    if (!confirm('Tem certeza que deseja excluir este item?')) return;
    
    try {
      // Tentar remover do servidor primeiro
      const response = await fetch(`/api/cardapio/${encodeURIComponent(itemId)}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        showToast('🗑️ Item excluído do servidor', 'success');
        // Recarregar dados do servidor
        await this.loadCardapioData();
      } else {
        throw new Error('Falha ao excluir do servidor');
      }
    } catch (error) {
      console.error('Erro ao excluir item:', error);
      // Fallback: remover apenas localmente
      this.cardapioData = this.cardapioData.filter(i => (i.id || i.nome) !== itemId);
      this.saveCardapioData();
      this.renderCardapioList();
      showToast('🗑️ Item excluído localmente (erro no servidor)', 'warning');
    }
  }

  async saveNewItem() {
    console.log('🔧 DEBUG: saveNewItem iniciado');
    const nome = document.getElementById('item-nome-unified').value.trim();
    const descricao = document.getElementById('item-desc-unified').value.trim();
    const preco = parseFloat(document.getElementById('item-preco-unified').value) || 0;
    const tipo = document.getElementById('item-tipo-unified').value;
    const gatilhosText = document.getElementById('item-gatilhos-unified').value.trim();
    const gatilhos = gatilhosText ? gatilhosText.split(',').map(g => g.trim()).filter(g => g) : [];

    console.log('🔧 DEBUG: Dados coletados:', { nome, descricao, preco, tipo, gatilhos });

    if (!nome || !tipo) {
      console.log('🔧 DEBUG: Validação falhou - nome ou tipo vazio');
      showToast('❌ Nome e tipo são obrigatórios', 'error');
      return;
    }

    try {
      if (this.editingItem) {
        // Atualizar item existente via API
        console.log('🔧 DEBUG: Atualizando item existente:', this.editingItem);
        const response = await fetch(`/api/cardapio/${encodeURIComponent(this.editingItem)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome, descricao, preco, tipo })
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log('🔧 DEBUG: Item atualizado no servidor:', result);
          
          // Atualizar mapeamentos se houver gatilhos
          if (gatilhos.length > 0) {
            // Primeiro, remover mapeamentos antigos do item
            try {
              await fetch(`/api/cardapio/mappings/${encodeURIComponent(this.editingItem)}`, {
                method: 'DELETE'
              });
            } catch (e) {
              console.warn('Erro ao remover mapeamentos antigos:', e);
            }
            
            // Adicionar novos mapeamentos
            for (const gatilho of gatilhos) {
              try {
                await fetch('/api/cardapio/mappings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ nome: gatilho.toLowerCase(), itemId: this.editingItem })
                });
              } catch (e) {
                console.error('Erro ao adicionar mapeamento:', e);
              }
            }
          }
          
          showToast('✅ Item atualizado com sucesso', 'success');
          // Recarregar dados do servidor
          await this.loadCardapioData();
        } else {
          throw new Error('Falha ao atualizar item no servidor');
        }
      } else {
        // Adicionar novo item via API
        console.log('🔧 DEBUG: Enviando requisição para API');
        const response = await fetch('/api/cardapio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome, descricao, preco, tipo })
        });
        
        console.log('🔧 DEBUG: Resposta recebida:', response.status);
        const result = await response.json();
        console.log('🔧 DEBUG: Resultado da API:', result);
        if (result && result.ok) {
          showToast('✅ Item adicionado ao servidor', 'success');
          
          // Adicionar mapeamentos se houver gatilhos
          if (gatilhos.length > 0) {
            for (const gatilho of gatilhos) {
              try {
                await fetch('/api/cardapio/mappings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ nome: gatilho.toLowerCase(), itemId: result.id })
                });
              } catch (e) {
                console.error('Erro ao adicionar mapeamento:', e);
              }
            }
          }
          
          // Recarregar dados do servidor
          await this.loadCardapioData();
        } else {
          throw new Error('Falha ao adicionar item');
        }
      }
    } catch (error) {
      console.error('🔧 DEBUG: Erro capturado:', error);
      console.error('Erro ao salvar item:', error);
      showToast('❌ Erro ao salvar item', 'error');
      return;
    }

    this.clearForm();
    this.switchTab('visualizar');
  }

  clearForm() {
    document.getElementById('item-nome-unified').value = '';
    document.getElementById('item-desc-unified').value = '';
    document.getElementById('item-preco-unified').value = '';
    document.getElementById('item-tipo-unified').value = '';
    document.getElementById('item-gatilhos-unified').value = '';
    
    this.editingItem = null;
    document.getElementById('salvar-item-unified').textContent = '💾 Salvar Item';
  }

  async loadMapeamentos() {
    const container = document.getElementById('lista-mapeamentos-unified');
    if (!container) return;

    let mapeamentos = {};
    try {
      // Carregar mapeamentos do servidor
      const response = await fetch('/api/cardapio/mappings');
      const data = await response.json();
      if (data && data.ok && data.mappings) {
        mapeamentos = data.mappings;
      }
    } catch (error) {
      console.error('Erro ao carregar mapeamentos do servidor:', error);
      // Fallback para localStorage
      mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
    }
    
    const entries = Object.entries(mapeamentos);

    if (entries.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;color:rgba(255,255,255,0.6);padding:40px;">
          <div style="font-size:48px;margin-bottom:16px;">🔗</div>
          <div style="font-size:18px;margin-bottom:8px;">Nenhum mapeamento encontrado</div>
          <div style="font-size:14px;">Adicione mapeamentos para conectar palavras aos itens</div>
        </div>
      `;
      return;
    }

    container.innerHTML = entries.map(([gatilho, itemId]) => {
      const item = this.cardapioData.find(i => i.id == itemId);
      return `
        <div style="
          background:rgba(255,255,255,0.05);
          border:1px solid rgba(255,255,255,0.1);
          border-radius:8px;
          padding:16px;
          display:flex;
          justify-content:space-between;
          align-items:center;
        ">
          <div>
            <div style="color:#fff;font-weight:600;margin-bottom:4px;">"${gatilho}"</div>
            <div style="color:rgba(255,255,255,0.7);font-size:14px;">
              → ${item ? item.nome : `Item ID: ${itemId}`}
            </div>
          </div>
          <button onclick="cardapioManager.removeMapping('${gatilho}')" style="
            background:#ef4444;
            color:#fff;
            border:0;
            padding:8px 12px;
            border-radius:4px;
            cursor:pointer;
          ">🗑️ Remover</button>
        </div>
      `;
    }).join('');
  }

  async addMapping() {
    const gatilho = prompt('Digite o gatilho (palavra-chave):');
    if (!gatilho) return;

    const itemNome = prompt('Digite o nome do item:');
    if (!itemNome) return;

    const item = this.cardapioData.find(i => i.nome.toLowerCase().includes(itemNome.toLowerCase()));
    if (!item) {
      showToast('❌ Item não encontrado', 'error');
      return;
    }

    try {
      // Adicionar mapeamento via API
      const response = await fetch('/api/cardapio/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: gatilho.toLowerCase(), itemId: item.id })
      });
      
      if (response.ok) {
        showToast('✅ Mapeamento adicionado ao servidor', 'success');
        // Recarregar mapeamentos
        await loadCardapioAndMappings();
        await this.loadMapeamentos();
      } else {
        throw new Error('Falha ao adicionar mapeamento');
      }
    } catch (error) {
      console.error('Erro ao adicionar mapeamento:', error);
      // Fallback: adicionar apenas localmente
      const mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
      mapeamentos[gatilho.toLowerCase()] = item.id;
      localStorage.setItem('mapeamentos', JSON.stringify(mapeamentos));
      this.loadMapeamentos();
      showToast('✅ Mapeamento adicionado localmente (erro no servidor)', 'warning');
    }
  }

  addMultipleMappings() {
    const text = prompt('Digite os gatilhos separados por vírgula:');
    if (!text) return;

    const itemNome = prompt('Digite o nome do item:');
    if (!itemNome) return;

    const item = this.cardapioData.find(i => i.nome.toLowerCase().includes(itemNome.toLowerCase()));
    if (!item) {
      showToast('❌ Item não encontrado', 'error');
      return;
    }

    const gatilhos = text.split(',').map(g => g.trim()).filter(g => g);
    const mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
    
    gatilhos.forEach(gatilho => {
      mapeamentos[gatilho.toLowerCase()] = item.id;
    });
    
    localStorage.setItem('mapeamentos', JSON.stringify(mapeamentos));
    this.loadMapeamentos();
    showToast(`✅ ${gatilhos.length} mapeamentos adicionados`, 'success');
  }

  async removeMapping(gatilho) {
    if (!confirm(`Remover mapeamento "${gatilho}"?`)) return;
    
    try {
      // Remover mapeamento via API
      const response = await fetch(`/api/cardapio/mappings/${encodeURIComponent(gatilho)}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        showToast('🗑️ Mapeamento removido do servidor', 'success');
        // Recarregar mapeamentos
        await loadCardapioAndMappings();
        await this.loadMapeamentos();
      } else {
        throw new Error('Falha ao remover mapeamento');
      }
    } catch (error) {
      console.error('Erro ao remover mapeamento:', error);
      // Fallback: remover apenas localmente
      const mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
      delete mapeamentos[gatilho];
      localStorage.setItem('mapeamentos', JSON.stringify(mapeamentos));
      this.loadMapeamentos();
      showToast('🗑️ Mapeamento removido localmente (erro no servidor)', 'warning');
    }
  }

  updateStats() {
    const totalItens = this.cardapioData.length;
    const mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
    const totalMapeamentos = Object.keys(mapeamentos).length;
    
    const tipos = {};
    this.cardapioData.forEach(item => {
      tipos[item.tipo] = (tipos[item.tipo] || 0) + 1;
    });

    const statsContainer = document.getElementById('stats-cardapio');
    if (statsContainer) {
      statsContainer.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;">
          <div style="background:rgba(255,255,255,0.05);padding:20px;border-radius:8px;text-align:center;">
            <div style="font-size:32px;color:#3498db;font-weight:bold;">${totalItens}</div>
            <div style="color:rgba(255,255,255,0.7);">Total de Itens</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);padding:20px;border-radius:8px;text-align:center;">
            <div style="font-size:32px;color:#10b981;font-weight:bold;">${totalMapeamentos}</div>
            <div style="color:rgba(255,255,255,0.7);">Mapeamentos</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);padding:20px;border-radius:8px;text-align:center;">
            <div style="font-size:32px;color:#f59e0b;font-weight:bold;">${Object.keys(tipos).length}</div>
            <div style="color:rgba(255,255,255,0.7);">Tipos</div>
          </div>
        </div>
        <div style="margin-top:20px;">
          <h4 style="color:#fff;margin-bottom:12px;">Distribuição por Tipo:</h4>
          ${Object.entries(tipos).map(([tipo, count]) => `
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
              <span style="color:rgba(255,255,255,0.8);">${tipo}</span>
              <span style="color:#3498db;font-weight:bold;">${count}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  async backupCardapio() {
    try {
      showToast('📦 Preparando backup...', 'info');
      
      // Buscar mapeamentos do servidor primeiro
      let mapeamentos = {};
      try {
        const response = await fetch('/api/cardapio/mappings');
        const data = await response.json();
        if (data && data.ok && data.mappings) {
          mapeamentos = data.mappings;
        } else {
          // Fallback para localStorage se servidor não responder adequadamente
          mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
        }
      } catch (error) {
        console.error('Erro ao buscar mapeamentos do servidor, usando localStorage:', error);
        mapeamentos = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
      }
      
      const backupData = {
        cardapio: this.cardapioData,
        mapeamentos: mapeamentos,
        timestamp: new Date().toISOString(),
        totalItens: this.cardapioData.length,
        totalMapeamentos: Object.keys(mapeamentos).length
      };
      
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cardapio-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      showToast(`💾 Backup criado: ${backupData.totalItens} itens + ${backupData.totalMapeamentos} mapeamentos`, 'success');
    } catch (error) {
      console.error('Erro ao criar backup:', error);
      showToast('❌ Erro ao criar backup', 'error');
    }
  }

  restoreCardapio() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          showToast('📂 Lendo arquivo de backup...', 'info');
          
          const data = JSON.parse(e.target.result);
          if (!data.cardapio || !data.mapeamentos) {
            showToast('❌ Arquivo de backup inválido', 'error');
            return;
          }
          
          // Restaurar cardápio
          this.cardapioData = data.cardapio;
          localStorage.setItem('cardapio', JSON.stringify(data.cardapio));
          
          // Restaurar mapeamentos no localStorage
          localStorage.setItem('mapeamentos', JSON.stringify(data.mapeamentos));
          
          // Tentar sincronizar mapeamentos com o servidor
          const totalMapeamentos = Object.keys(data.mapeamentos).length;
          let mapeamentosRestaurados = 0;
          let mapeamentosFalhados = 0;
          
          if (totalMapeamentos > 0) {
            showToast(`🔄 Sincronizando ${totalMapeamentos} mapeamentos com servidor...`, 'info');
            
            try {
              // Agrupar mapeamentos por itemId para usar rota /multiple
              const mapeamentosPorItem = {};
              
              for (const [nome, itemId] of Object.entries(data.mapeamentos)) {
                if (!mapeamentosPorItem[itemId]) {
                  mapeamentosPorItem[itemId] = [];
                }
                mapeamentosPorItem[itemId].push(nome);
              }
              
              // Enviar cada grupo de gatilhos para o servidor
              for (const [itemId, gatilhos] of Object.entries(mapeamentosPorItem)) {
                try {
                  const response = await fetch('/api/cardapio/mappings/multiple', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gatilhos, itemId: Number(itemId) })
                  });
                  
                  const result = await response.json();
                  if (result.ok) {
                    mapeamentosRestaurados += gatilhos.length;
                    console.log(`✅ ${gatilhos.length} mapeamentos restaurados para item ${itemId}`);
                  } else {
                    mapeamentosFalhados += gatilhos.length;
                    console.warn(`⚠️ Falha ao restaurar mapeamentos para item ${itemId}:`, result);
                  }
                } catch (error) {
                  mapeamentosFalhados += gatilhos.length;
                  console.error(`❌ Erro ao restaurar mapeamentos para item ${itemId}:`, error);
                }
              }
              
              if (mapeamentosFalhados > 0) {
                showToast(`⚠️ ${mapeamentosRestaurados} restaurados, ${mapeamentosFalhados} falharam`, 'warning');
              }
              
            } catch (error) {
              console.error('Erro ao sincronizar mapeamentos com servidor:', error);
              showToast('⚠️ Mapeamentos restaurados localmente (servidor offline)', 'warning');
            }
          }
          
          // Atualizar interface
          this.renderCardapioList();
          await this.loadMapeamentos();
          this.updateStats();
          
          const totalItens = data.cardapio.length;
          showToast(`📥 Backup restaurado: ${totalItens} itens + ${mapeamentosRestaurados}/${totalMapeamentos} mapeamentos`, 'success');
          
        } catch (error) {
          console.error('Erro ao restaurar backup:', error);
          showToast('❌ Erro ao ler arquivo de backup', 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  async resetCardapio() {
    if (!confirm('⚠️ ATENÇÃO: Isso irá apagar TODOS os dados do cardápio e TODOS os mapeamentos permanentemente.\n\nDeseja continuar?')) return;
    
    // Segunda confirmação para segurança
    if (!confirm('🚨 ÚLTIMA CONFIRMAÇÃO: Tem certeza absoluta? Esta ação não pode ser desfeita!')) return;
    
    try {
      showToast('🗑️ Resetando sistema...', 'info');
      
      // 1. Contar mapeamentos antes de deletar (só para feedback)
      let totalMapeamentos = 0;
      try {
        const response = await fetch('/api/cardapio/mappings');
        const data = await response.json();
        if (data && data.ok && data.mappings) {
          totalMapeamentos = Object.keys(data.mappings).length;
        }
      } catch (error) {
        console.warn('Erro ao contar mapeamentos:', error);
      }
      
      // 2. Remover TODOS os mapeamentos do servidor de uma vez (nova rota)
      showToast(`🔄 Removendo ${totalMapeamentos} mapeamentos do servidor...`, 'info');
      try {
        const deleteResponse = await fetch('/api/cardapio/mappings', {
          method: 'DELETE'
        });
        const deleteData = await deleteResponse.json();
        if (deleteData.ok) {
          console.log('✅ Todos os mapeamentos removidos do servidor');
        } else {
          console.warn('⚠️ Possível erro ao remover mapeamentos do servidor:', deleteData);
        }
      } catch (error) {
        console.error('❌ Erro ao remover mapeamentos do servidor:', error);
        showToast('⚠️ Erro ao limpar servidor, continuando com limpeza local...', 'warning');
      }
      
      // 3. Limpar localStorage
      showToast('🧹 Limpando cache local...', 'info');
      localStorage.removeItem('cardapio');
      localStorage.removeItem('mapeamentos');
      
      // 4. Limpar dados em memória
      this.cardapioData = [];
      
      // 5. Atualizar interface
      this.renderCardapioList();
      await this.loadMapeamentos();
      this.updateStats();
      
      showToast(`✅ Sistema completamente resetado! (${totalMapeamentos} mapeamentos removidos)`, 'success');
      
    } catch (error) {
      console.error('Erro ao resetar sistema:', error);
      showToast('❌ Erro ao resetar sistema', 'error');
    }
  }

  syncWithServer() {
    showToast('🔄 Sincronizando...', 'info');
    loadCardapioAndMappings().then(() => {
      this.loadCardapioData();
      showToast('✅ Sincronização concluída', 'success');
    }).catch(() => {
      showToast('❌ Erro na sincronização', 'error');
    });
  }

  async diagnosticarMapeamentos() {
    const resultDiv = document.getElementById('diagnostico-resultado');
    if (!resultDiv) return;
    
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '🔍 Diagnosticando...\n';
    
    try {
      // 1. Verificar servidor
      const serverResponse = await fetch('/api/cardapio/mappings');
      const serverData = await serverResponse.json();
      const serverMappings = serverData.ok ? serverData.mappings : {};
      const serverTotal = Object.keys(serverMappings).length;
      
      // 2. Verificar localStorage
      const localMappings = JSON.parse(localStorage.getItem('mapeamentos') || '{}');
      const localTotal = Object.keys(localMappings).length;
      
      // 3. Mostrar resultado
      let resultado = '📊 DIAGNÓSTICO DE MAPEAMENTOS\n';
      resultado += '═'.repeat(50) + '\n\n';
      resultado += `🌐 SERVIDOR: ${serverTotal} mapeamentos\n`;
      resultado += `💾 LOCAL STORAGE: ${localTotal} mapeamentos\n\n`;
      
      if (serverTotal > 0) {
        resultado += '📋 Primeiros 10 no servidor:\n';
        Object.entries(serverMappings).slice(0, 10).forEach(([gatilho, itemId]) => {
          resultado += `   - "${gatilho}" → Item ${itemId}\n`;
        });
      } else {
        resultado += '✅ Servidor limpo (sem mapeamentos)\n';
      }
      
      resultado += '\n' + '═'.repeat(50);
      resultDiv.textContent = resultado;
      
      showToast(`📊 Diagnóstico: ${serverTotal} no servidor, ${localTotal} local`, 'info');
      
    } catch (error) {
      resultDiv.textContent = `❌ Erro no diagnóstico:\n${error.message}`;
      showToast('❌ Erro ao diagnosticar', 'error');
    }
  }

  async forcarAtualizacaoMapeamentos() {
    try {
      showToast('🔄 Forçando atualização...', 'info');
      
      // Limpar cache local
      localStorage.removeItem('mapeamentos');
      
      // Recarregar do servidor
      await this.loadMapeamentos();
      
      showToast('✅ Mapeamentos atualizados!', 'success');
      
    } catch (error) {
      console.error('Erro ao forçar atualização:', error);
      showToast('❌ Erro ao atualizar', 'error');
    }
  }

  saveCardapioData() {
    localStorage.setItem('cardapio', JSON.stringify(this.cardapioData));
  }
}

// Instância global do gerenciador
let cardapioManager;

// Helpers para compatibilidade
function openCardapioModal() {
  if (!cardapioManager) cardapioManager = new CardapioManager();
  cardapioManager.openModal();
}

function closeCardapioModal() {
  if (cardapioManager) cardapioManager.closeModal();
}

// Função para mostrar notificações
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const colors = {
    success: '#10b981',
    error: '#ef4444',
    info: '#3b82f6',
    warning: '#f59e0b'
  };
  
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${colors[type] || colors.info};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-weight: 500;
    z-index: 10000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
  `;
  
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Adicionar estilos de animação
if (!document.getElementById('toast-styles')) {
  const style = document.createElement('style');
  style.id = 'toast-styles';
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// Função para carregar mapeamentos no submodal
function loadMapeamentos() {
  const container = document.getElementById('lista-mapeamentos');
  if (!container) return;
  const entries = Object.keys(mapaCardapio).sort();
  if (entries.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#95a5a6;padding:20px;">📝 Nenhum mapeamento definido</div>';
    return;
  }
  container.innerHTML = entries.map(k => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid #f39c12;">
      <div>
        <div style="font-weight:bold;color:#fff;">${k}</div>
        <div style="font-size:12px;color:#95a5a6;">→ ID: ${mapaCardapio[k]}</div>
      </div>
      <button onclick="removeMapping('${k}')" style="background:#e74c3c;color:#fff;border:0;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;">🗑️ Remover</button>
    </div>
  `).join('');
}

// Função para carregar cardápio completo no submodal
function loadCardapioCompleto() {
  const container = document.getElementById('lista-cardapio');
  const filtroTipo = document.getElementById('filtro-tipo').value;
  const busca = document.getElementById('buscar-item').value.toLowerCase();
  
  if (!container) return;
  
  // Simular dados do cardápio (em produção viria do servidor)
  let cardapio = JSON.parse(localStorage.getItem('cardapio') || '[]');
  
  // Aplicar filtros
  if (filtroTipo) {
    cardapio = cardapio.filter(item => item.tipo === filtroTipo);
  }
  
  if (busca) {
    cardapio = cardapio.filter(item => 
      item.nome.toLowerCase().includes(busca) || 
      (item.descricao && item.descricao.toLowerCase().includes(busca))
    );
  }
  
  if (cardapio.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#95a5a6;padding:20px;">🍽️ Nenhum item encontrado</div>';
    return;
  }
  
  const tipoIcons = {
    'Lanche': '🍔',
    'Bebida': '🥤', 
    'Adicional': '🧀',
    'Sobremesa': '🍰'
  };
  
  container.innerHTML = cardapio.map(item => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:16px;margin-bottom:12px;background:rgba(255,255,255,0.03);border-radius:8px;border-left:4px solid #9b59b6;">
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="font-size:20px;">${tipoIcons[item.tipo] || '📦'}</span>
          <span style="font-weight:bold;color:#fff;font-size:16px;">${item.nome}</span>
          <span style="background:${item.tipo === 'Lanche' ? '#2ecc71' : item.tipo === 'Bebida' ? '#3498db' : item.tipo === 'Adicional' ? '#f39c12' : '#9b59b6'};color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;">${item.tipo}</span>
        </div>
        ${item.descricao ? `<div style="color:#95a5a6;font-size:14px;margin-bottom:4px;">${item.descricao}</div>` : ''}
        <div style="color:#2ecc71;font-weight:bold;font-size:16px;">R$ ${item.preco.toFixed(2)}</div>
        ${item.gatilhos && item.gatilhos.length > 0 ? `<div style="margin-top:8px;"><small style="color:#95a5a6;">Gatilhos: ${item.gatilhos.join(', ')}</small></div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="color:#95a5a6;font-size:12px;">ID: ${item.id || 'Auto'}</div>
      </div>
    </div>
  `).join('');
}

function renderCardapioMappings() {
  // Manter compatibilidade com código existente
  loadMapeamentos();
}

function removeMapping(nome) {
  // request server to remove mapping
  socket.emit('admin:removeMapping', { nome });
}

// Evento para adicionar gatilho a partir do modal
function addTriggerFromModal() {
  const nomeEl = document.getElementById('cardapio-nome');
  const idEl = document.getElementById('cardapio-id');
  if (!nomeEl || !idEl) return;
  const nome = (nomeEl.value || '').trim().toLowerCase();
  const id = idEl.value ? Number(idEl.value) : null;
  if (!nome || !id) return showToast('Nome e ID obrigatórios para o gatilho', 'error');
  socket.emit('admin:addMapping', { nome, itemId: id });
}

// Evento para adicionar múltiplos gatilhos a partir do modal
function addMultipleTriggersFromModal() {
  const nomeEl = document.getElementById('cardapio-nome');
  const idEl = document.getElementById('cardapio-id');
  const gatilhosEl = document.getElementById('cardapio-gatilhos');
  if (!nomeEl || !idEl || !gatilhosEl) return;
  
  const nome = (nomeEl.value || '').trim();
  const id = idEl.value ? Number(idEl.value) : null;
  const gatilhosText = (gatilhosEl.value || '').trim();
  
  if (!nome || !id) return showToast('Nome e ID obrigatórios para os gatilhos', 'error');
  if (!gatilhosText) return showToast('Digite pelo menos um gatilho', 'error');
  
  // Processa os gatilhos separados por vírgula
  const gatilhos = gatilhosText.split(',').map(g => g.trim().toLowerCase()).filter(g => g.length > 0);
  
  if (gatilhos.length === 0) return showToast('Nenhum gatilho válido encontrado', 'error');
  
  // Adiciona o nome do item como primeiro gatilho se não estiver na lista
  const nomeNormalizado = nome.toLowerCase();
  if (!gatilhos.includes(nomeNormalizado)) {
    gatilhos.unshift(nomeNormalizado);
  }
  
  // Envia via API REST para melhor controle
  fetch('/api/cardapio/mappings/multiple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gatilhos, itemId: id })
  })
  .then(res => res.json())
  .then(data => {
    if (data.ok) {
      showToast(`${gatilhos.length} gatilhos adicionados com sucesso!`, 'success');
      gatilhosEl.value = ''; // Limpa o campo
      // Recarrega os mapeamentos
      loadCardapioAndMappings().then(() => renderCardapioMappings());
    } else {
      showToast('Erro ao adicionar gatilhos: ' + (data.error || 'unknown'), 'error');
    }
  })
  .catch(err => {
    console.error('Erro ao adicionar múltiplos gatilhos:', err);
    showToast('Erro de conexão ao adicionar gatilhos', 'error');
  });
}

// Save local (keeps mapping in the current page). Could be extended to persist via API/socket
function saveCardapioLocal() {
  // open server modal save: request full cardapio items to be refreshed
  socket.emit('admin:getCardapio');
  showToast('Solicitando sincronização do cardápio ao servidor...', 'info');
}

// Hook buttons (will be wired on load)
document.addEventListener('DOMContentLoaded', () => {
  // Inicializar o CardapioManager automaticamente
  console.log('🔧 DEBUG: Inicializando CardapioManager no DOMContentLoaded');
  if (!cardapioManager) {
    cardapioManager = new CardapioManager();
    console.log('🔧 DEBUG: CardapioManager criado:', cardapioManager);
  } else {
    console.log('🔧 DEBUG: CardapioManager já existe:', cardapioManager);
  }
  
  // Tornar cardapioManager global para debug
  window.cardapioManager = cardapioManager;
  console.log('🔧 DEBUG: cardapioManager disponível globalmente');
  
  const btn = document.getElementById('btn-cardapio');
  if (btn) btn.addEventListener('click', openCardapioModal);
  const closeBtn = document.getElementById('cardapio-close');
  if (closeBtn) closeBtn.addEventListener('click', closeCardapioModal);
  
  // Botões do menu principal
  const btnAdicionarItem = document.getElementById('btn-adicionar-item');
  if (btnAdicionarItem) btnAdicionarItem.addEventListener('click', () => {
    document.getElementById('adicionar-item-modal').style.display = 'flex';
    document.getElementById('cardapio-status').textContent = 'Modo: Adicionar Item';
  });
  
  const btnGerenciarMapeamentos = document.getElementById('btn-gerenciar-mapeamentos');
  if (btnGerenciarMapeamentos) btnGerenciarMapeamentos.addEventListener('click', () => {
    document.getElementById('mapeamentos-modal').style.display = 'flex';
    document.getElementById('cardapio-status').textContent = 'Modo: Gerenciar Mapeamentos';
    loadMapeamentos();
  });
  
  const btnVisualizarCardapio = document.getElementById('btn-visualizar-cardapio');
  if (btnVisualizarCardapio) btnVisualizarCardapio.addEventListener('click', () => {
    document.getElementById('visualizar-cardapio-modal').style.display = 'flex';
    document.getElementById('cardapio-status').textContent = 'Modo: Visualizar Cardápio';
    loadCardapioCompleto();
  });
  
  // Submodal: Adicionar Item
  const adicionarItemClose = document.getElementById('adicionar-item-close');
  if (adicionarItemClose) adicionarItemClose.addEventListener('click', () => {
    document.getElementById('adicionar-item-modal').style.display = 'none';
    document.getElementById('cardapio-status').textContent = 'Sistema pronto';
  });
  
  const salvarItem = document.getElementById('salvar-item');
  if (salvarItem) salvarItem.addEventListener('click', () => {
    const nome = document.getElementById('item-nome').value.trim();
    const desc = document.getElementById('item-desc').value.trim();
    const preco = parseFloat(document.getElementById('item-preco').value) || 0;
    const tipo = document.getElementById('item-tipo').value;
    const id = document.getElementById('item-id').value.trim();
    const gatilhos = document.getElementById('item-gatilhos').value.trim();

    if (!nome) {
      showToast('❌ Nome do item é obrigatório', 'error');
      return;
    }

    if (preco <= 0) {
      showToast('❌ Preço deve ser maior que zero', 'error');
      return;
    }

    const item = {
      nome,
      descricao: desc,
      preco,
      tipo,
      id: id || null,
      gatilhos: gatilhos.split(',').map(g => g.trim()).filter(g => g)
    };

    // Salvar no localStorage
    let cardapio = JSON.parse(localStorage.getItem('cardapio') || '[]');
    cardapio.push(item);
    localStorage.setItem('cardapio', JSON.stringify(cardapio));

    // Adicionar mapeamentos dos gatilhos
    const itemId = id || nome.toLowerCase().replace(/\s+/g, '-');
    if (gatilhos) {
      const triggerList = gatilhos.split(',').map(g => g.trim().toLowerCase()).filter(g => g);
      triggerList.forEach(trigger => {
        if (!mapaCardapio[trigger]) {
          mapaCardapio[trigger] = itemId;
        }
      });
    }

    showToast(`✅ Item "${nome}" adicionado com sucesso!`, 'success');
    
    // Limpar campos
    document.getElementById('item-nome').value = '';
    document.getElementById('item-desc').value = '';
    document.getElementById('item-preco').value = '';
    document.getElementById('item-id').value = '';
    document.getElementById('item-gatilhos').value = '';
    
    // Fechar modal
    document.getElementById('adicionar-item-modal').style.display = 'none';
    document.getElementById('cardapio-status').textContent = 'Item adicionado com sucesso!';
    
    loadCardapioAndMappings();
  });
  
  // Submodal: Gerenciar Mapeamentos
  const mapeamentosClose = document.getElementById('mapeamentos-close');
  if (mapeamentosClose) mapeamentosClose.addEventListener('click', () => {
    document.getElementById('mapeamentos-modal').style.display = 'none';
    document.getElementById('cardapio-status').textContent = 'Sistema pronto';
  });
  
  const refreshMapeamentos = document.getElementById('refresh-mapeamentos');
  if (refreshMapeamentos) refreshMapeamentos.addEventListener('click', () => {
    loadMapeamentos();
    showToast('🔄 Mapeamentos atualizados', 'info');
  });
  
  const adicionarMapeamento = document.getElementById('adicionar-mapeamento');
  if (adicionarMapeamento) adicionarMapeamento.addEventListener('click', () => {
    const gatilho = document.getElementById('novo-gatilho').value.trim().toLowerCase();
    const itemId = document.getElementById('novo-item-id').value.trim();
    
    if (!gatilho || !itemId) {
      showToast('❌ Preencha gatilho e ID do item', 'error');
      return;
    }
    
    if (mapaCardapio[gatilho]) {
      showToast('⚠️ Gatilho já existe', 'warning');
      return;
    }
    
    mapaCardapio[gatilho] = itemId;
    showToast(`✅ Mapeamento adicionado: "${gatilho}" → ${itemId}`, 'success');
    
    // Limpar campos
    document.getElementById('novo-gatilho').value = '';
    document.getElementById('novo-item-id').value = '';
    
    loadMapeamentos();
  });
  
  // Submodal: Visualizar Cardápio
  const visualizarCardapioClose = document.getElementById('visualizar-cardapio-close');
  if (visualizarCardapioClose) visualizarCardapioClose.addEventListener('click', () => {
    document.getElementById('visualizar-cardapio-modal').style.display = 'none';
    document.getElementById('cardapio-status').textContent = 'Sistema pronto';
  });
  
  const refreshCardapio = document.getElementById('refresh-cardapio');
  if (refreshCardapio) refreshCardapio.addEventListener('click', () => {
    loadCardapioCompleto();
    showToast('🔄 Cardápio atualizado', 'info');
  });
  
  const filtroTipo = document.getElementById('filtro-tipo');
  if (filtroTipo) filtroTipo.addEventListener('change', () => {
    loadCardapioCompleto();
  });
  
  const buscarItem = document.getElementById('buscar-item');
  if (buscarItem) buscarItem.addEventListener('input', () => {
    loadCardapioCompleto();
  });
  // request mappings from server on load
  // prefer REST load, but also listen for socket broadcasts
  loadCardapioAndMappings().then(() => { try { renderCardapioMappings(); showToast('Mapeamentos carregados do servidor', 'success'); } catch(e){} });
  socket.emit('admin:getMappings');
  socket.once('admin:mappings', (r) => {
    if (!r || !r.ok) return;
    try { Object.assign(mapaCardapio, r.mappings || {}); renderCardapioMappings(); } catch(e){}
  });
  // listen for broadcast updates
  socket.on('admin:mappings', (r) => {
    if (!r || !r.ok) return;
    try { Object.assign(mapaCardapio, r.mappings || {}); renderCardapioMappings(); } catch(e){}
  });
});

function limparTexto(texto) {
  return String(texto).toLowerCase().replace(/[.,!?]/g, '').trim();
}

function addItemByName(id, contato) {
  const input = document.getElementById(`add-input-${contato}`);
  if (!input) return;
  const raw = input.value && input.value.trim();
  if (!raw) return showToast('Digite o nome do item.', 'error');
  let quantidade = 1;
  let nome = raw;
  let preparo = '';
  const match = raw.match(/^\s*(\d+)\s+(.+)$/);
  if (match) {
    quantidade = parseInt(match[1]);
    nome = match[2];
  }
  const prepMatch = raw.match(/\b(sem|com)\s+([a-zçãéíóúâêôãõ0-9\- ]+)\b/i);
  if (prepMatch) {
    preparo = prepMatch[0].trim();
    let nomeBase = raw.replace(prepMatch[0], '').trim();
    const matchQtd = nomeBase.match(/^\s*(\d+)\s+(.+)$/);
    if (matchQtd) {
      nomeBase = matchQtd[2];
    }
    nome = nomeBase;
  }
  const bebidaId = mapaBebidas[limparTexto(nome)];
  if (bebidaId) {
    console.log('emit admin:addItem (bebida)', { id, itemId: bebidaId, quantidade, nome, tipo: 'Bebida' });
    emitAction('admin:addItem', { id, itemId: bebidaId, quantidade, nome, tipo: 'Bebida' }, `add-btn-${contato}`);
    input.value = '';
    return;
  }
  // check dynamic cardapio map as fallback
  const mapaId = mapaCardapio[limparTexto(nome)];
  if (mapaId) {
    console.log('emit admin:addItem (mapaCardapio)', { id, itemId: mapaId, quantidade, nome });
    emitAction('admin:addItem', { id, itemId: mapaId, quantidade, nome }, `add-btn-${contato}`);
    input.value = '';
    return;
  }
  console.log('emit admin:addItem', { id, itemName: nome, quantidade, preparo });
  emitAction('admin:addItem', { id, itemName: nome, quantidade, preparo }, `add-btn-${contato}`);
  input.value = '';
}

function removeItem(id, index) {
  emitAction('admin:removeItem', { id, index });
}

socket.on('initial', (payload) => {
  // Limpa carrinhos antigos e carrega os novos do payload
  for (const k of Object.keys(carrinhos)) delete carrinhos[k];
  const novos = payload.carrinhos || {};
  for (const k of Object.keys(novos)) carrinhos[k] = novos[k];
  renderAll();
  // ensure totals are loaded after initial data
  try { fetchTotaisDoDia(); } catch(e) { console.error('erro fetchTotaisDoDia after initial', e); }
  // update dashboard if open
  try { if (typeof updateDashboardIfOpen === 'function') updateDashboardIfOpen(); } catch (e) { console.error('erro atualizando dashboard after initial', e); }
});

socket.on('carrinho:update', (payload) => {
  try {
    if (!payload || !payload.id) return;
    const id = payload.id;
    // payload.carrinho pode conter o carrinho inteiro
    if (payload.carrinho) {
      // If the new estado signals 'saiu'/'entregue' (but not 'escolhendo_entrega_retirada'), move it to entregues (remove from main view)
      const estado = (payload.carrinho && payload.carrinho.estado) ? String(payload.carrinho.estado).toLowerCase() : '';
      if (estado.includes('saiu') || (estado.includes('entreg') && !estado.includes('escolhendo_entrega_retirada'))) {
        // Remove from main in-memory list
        try { delete carrinhos[id]; } catch(e) { carrinhos[id] = undefined; }
        // Refresh main UI
        renderAll();
        // Refresh entregues modal list and open it so operator sees it
        fetchEntregues().then(list => { renderEntreguesList(list); openEntreguesModal(); }).catch(e => console.error('Erro ao atualizar entregues (carrinho:update)', e));
        return; // don't continue with normal rendering for this id
      }
      carrinhos[id] = payload.carrinho;
    } else {
      // mesclar campos
      carrinhos[id] = Object.assign({}, carrinhos[id] || {}, payload);
    }
    renderAll();
    // Se o modal estiver aberto para esse id, atualiza o conteúdo em tempo real
    const modal = document.getElementById('conversation-modal');
    if (modal && modal.style.display === 'flex') {
      const currentTitle = document.getElementById('conv-title').textContent || '';
      if (currentTitle.includes(id.replace('@s.whatsapp.net',''))) {
        // re-render modal content
        try { showConversation(id); } catch(e) { console.error(e); }
      }
    }
  } catch (e) { console.error(e); }
});

socket.on('admin:ack', (r) => {
  if (!r) return;
  // O emitAction já cuida do toast aqui; este listener é legado, mas mantém para compat
  if (r.ok) {
    console.log('Ação admin concluída', r);
  } else {
    showToast('Erro na ação administrativa: ' + (r.error || 'unknown'), 'error');
  }
});

// Local cache para entregues (permite atualização imediata quando server emite pedido salvo)
let entreguesCache = [];

// Atualiza lista de entregues automaticamente quando servidor notifica que um pedido foi salvo
socket.on('pedido:salvo', (p) => {
  try {
  console.log('pedido:salvo recebido', p);
    // Se o servidor enviou o objeto do pedido, usamos ele para atualizar o cache local
    try {
      if (p && p.pedido) {
        const incoming = p.pedido;
        entreguesCache = entreguesCache || [];
        const incomingId = String(incoming.id || incoming.numero || '');
        const exists = entreguesCache.find(x => String(x.id || x.numero) === incomingId);
        if (!exists) {
          // only add to cache if estado indicates 'saiu'/'entreg' OR if it's not present (safety)
          const estado = (incoming.estado || '').toString().toLowerCase();
          if (estado.includes('saiu') || estado.includes('entreg')) {
            entreguesCache.unshift(incoming);
          } else {
            // if incoming doesn't have entrega state, still add but at the end (fallback)
            entreguesCache.push(incoming);
          }
        }
      }
    } catch (e) { console.error('pedido:salvo cache update error', e); }

    // Atualiza a UI: se modal aberto, renderiza; se não, abre o modal para destacar o pedido
    try {
      const modal = document.getElementById('entregues-modal');
      // Only auto-open when the saved pedido clearly signals 'saiu'/'entreg'
      const savedEstado = (p && p.pedido && (p.pedido.estado || '')).toString().toLowerCase();
      renderEntreguesList(entreguesCache);
      if ((savedEstado.includes('saiu') || savedEstado.includes('entreg')) && modal && modal.style.display !== 'flex') {
        openEntreguesModal();
      }
  // update header totals in real-time
  try { fetchTotaisDoDia(); } catch (e) { console.error('erro atualizando totais do dia', e); }
  // update dashboard if open
  try { if (typeof updateDashboardIfOpen === 'function') updateDashboardIfOpen(); } catch (e) { console.error('erro atualizando dashboard', e); }
    } catch (e) { console.error('pedido:salvo render error', e); }
  } catch (e) { console.error('pedido:salvo handler error', e); }
});

// Funções para abrir/fechar modal de conversa
function showConversation(id) {
  const modal = document.getElementById('conversation-modal');
  const titleText = document.getElementById('conv-title-text');
  const body = document.getElementById('conv-messages');
  const cartEl = document.getElementById('conv-cart');
  const valorEl = document.getElementById('conv-valor');
  const openWa = document.getElementById('conv-open-wa');
  
  // Elementos de informação do cliente
  const clientName = document.getElementById('conv-client-name');
  const clientAddress = document.getElementById('conv-client-address');
  const clientPhone = document.getElementById('conv-client-phone');

  const data = carrinhos[id] || {};
  
  // Atualiza título
  if (titleText) titleText.textContent = `${data.nome || 'Cliente'} — ${sanitizeId(id)}`;
  
  // Atualiza informações do cliente
  if (clientName) clientName.textContent = data.nome || 'Sem nome';
  if (clientAddress) {
    const endereco = data.endereco || data.enderecoCompleto || '';
    clientAddress.textContent = endereco || 'Não informado';
    clientAddress.style.color = endereco ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)';
  }
  if (clientPhone) {
    const phoneFormatted = sanitizeId(id);
    clientPhone.textContent = phoneFormatted;
  }

  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '8px';

  const msgs = (data.messages && Array.isArray(data.messages)) ? data.messages.slice(-200) : (data.lastMsg ? [{ fromMe:false, text: data.lastMsg, timestamp: Date.now() }] : []);
  if (msgs.length === 0) {
    body.innerHTML = '<div class="small">Nenhuma mensagem disponível</div>';
  } else {
    for (const m of msgs) {
      const bubble = document.createElement('div');
      bubble.style.display = 'flex';
      bubble.style.flexDirection = 'column';
      bubble.style.alignItems = m.fromMe ? 'flex-end' : 'flex-start';

      const time = document.createElement('div');
      time.style.fontSize = '11px';
      time.style.color = '#999';
      time.style.marginBottom = '4px';
      time.textContent = new Date(m.timestamp || Date.now()).toLocaleString();

      const content = document.createElement('div');
      content.style.maxWidth = '86%';
      content.style.padding = '8px 10px';
      content.style.borderRadius = '12px';
      content.style.background = m.fromMe ? '#2a7' : '#222';
      content.style.color = m.fromMe ? '#042' : '#eee';
      content.innerHTML = (m.text || '').replace(/\n/g, '<br/>');

      bubble.appendChild(time);
      bubble.appendChild(content);
      wrap.appendChild(bubble);
    }
    body.appendChild(wrap);
    // autoscroll para o fim
    setTimeout(()=>{ body.scrollTop = body.scrollHeight; }, 10);
  }

  // Carrinho
  cartEl.innerHTML = '';
  const itens = (data.carrinho || []);
  if (itens.length === 0) cartEl.innerHTML = '<div class="small">Carrinho vazio</div>';
  else {
    // agrega itens por id+preparo para visual mais limpo, preservando todos índices
    const agg = {};
    for (let idx = 0; idx < itens.length; idx++) {
      const it = itens[idx];
      const key = `${it.id||''}::${(it.preparo||'').trim()}::${(it.nome||'').trim()}`;
      if (!agg[key]) {
        agg[key] = {
          ...it,
          quantidade: 0,
          indices: []
        };
      }
      agg[key].quantidade += Number(it.quantidade||1);
      agg[key].indices.push(idx);
    }
    // Renderiza cada ocorrência individualmente para manter referência correta de índice
    cartEl.innerHTML = Object.keys(agg).map(k => {
      const it = agg[k];
      return it.indices.map((originalIndex, i) => {
        // Para cada ocorrência, mostra 1x e permite ação individual
        const qtd = Number(itens[originalIndex].quantidade || 1);
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed rgba(255,255,255,0.03)">
          <div><strong>${qtd}x</strong> ${it.nome} ${it.preparo ? `(${it.preparo})` : ''}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <small class="muted">R$ ${Number(it.preco||0).toFixed(2)}</small>
            <button id="qty-minus-${originalIndex}" class="qty-btn" onclick="emitUpdateQty('${id}', ${originalIndex}, -1)">−</button>
            <button id="qty-plus-${originalIndex}" class="qty-btn" onclick="emitUpdateQty('${id}', ${originalIndex}, 1)">+</button>
            <button id="remove-btn-${originalIndex}" style="background:#a22;color:#fff;border:0;padding:6px;border-radius:6px" onclick="removeItem('${id}', ${originalIndex})">Remover</button>
          </div>
        </div>`;
      }).join('');
    }).join('');
  }
  // calcula valor total a partir dos itens caso data.valorTotal não esteja presente
  (function(){
    let total = 0;
    try {
  // conv-saiu removed from modal; main tab still has the 'Saiu' button
      const itensCalc = (data.carrinho || []);
      for (const it of itensCalc) {
        const preco = Number(it.preco || 0);
        const qtd = Number(it.quantidade || 1);
        total += preco * qtd;
      }
    } catch(e) { total = Number(data.valorTotal||0); }
    
    // Mostrar o valor total (produtos + entrega)
    let entregaVal = 0;
    try { if (data.entrega && typeof data.valorEntrega === 'number' && data.valorEntrega > 0) entregaVal = Number(data.valorEntrega); } catch(e) {}
    const valorTotal = Number(total) + Number(entregaVal || 0);
    valorEl.textContent = Number(valorTotal || data.valorTotal || 0).toFixed(2);
    // set delivery fee display in modal
    try { document.getElementById('conv-taxa').textContent = (data.valorEntrega && Number(data.valorEntrega) ? Number(data.valorEntrega).toFixed(2) : '0.00'); } catch(e) {}
  })();

  openWa.onclick = () => { window.open(`https://wa.me/${id.replace('@s.whatsapp.net','')}`); };
  document.getElementById('conv-close').onclick = closeConversation;
  // prepara o input de envio para este chat
  const convInput = document.getElementById('conv-input');
  const convSend = document.getElementById('conv-send');
  if (convInput) convInput.value = '';
  if (convInput) convInput.dataset.targetId = id; // guarda id alvo
  if (convSend) convSend.onclick = () => {
    const text = (convInput && convInput.value) ? convInput.value.trim() : '';
    if (!text) return;
    emitAction('admin:sendMessage', { id, text }, 'conv-send');
    if (convInput) convInput.value = '';
  };

  // Wire modal quick-action buttons
  const convReset = document.getElementById('conv-reset');
  const convClear = document.getElementById('conv-clear');
  const convAdd = document.getElementById('conv-add');
  const convAddInput = document.getElementById('conv-add-input');
  const convEditName = document.getElementById('conv-edit-name');

  if (convReset) convReset.onclick = () => {
    if (!confirm('Confirma resetar o carrinho deste cliente?')) return;
    emitAction('admin:reset', { id }, 'conv-reset');
  };
  if (convClear) convClear.onclick = () => {
    if (!confirm('Confirma limpar (reset) o carrinho deste cliente?')) return;
    emitAction('admin:reset', { id }, 'conv-clear');
  };
    if (convAdd) convAdd.onclick = () => {
    const raw = (convAddInput && convAddInput.value) ? convAddInput.value.trim() : '';
    if (!raw) return showToast('Digite o item a adicionar (ex: 1 dallas, sem bacon)', 'error');
    // tenta extrair quantidade e preparo como feito na função addItemByName
    let quantidade = 1;
    let nome = raw;
    let preparo = '';
    const match = raw.match(/^\s*(\d+)\s+(.+)$/);
    if (match) {
      quantidade = parseInt(match[1]);
      nome = match[2];
    }
    const prepMatch = raw.match(/\b(sem|com)\s+([a-zçãéíóúâêôãõ0-9\- ]+)\b/i);
    if (prepMatch) {
      preparo = prepMatch[0].trim();
      let nomeBase = raw.replace(prepMatch[0], '').trim();
      const matchQtd = nomeBase.match(/^\s*(\d+)\s+(.+)$/);
      if (matchQtd) nomeBase = matchQtd[2];
      nome = nomeBase;
    }
    // mapear bebidas conhecidas para itemId
    try {
      const bebidaId = mapaBebidas[limparTexto(nome)];
      if (bebidaId) {
        emitAction('admin:addItem', { id, itemId: bebidaId, quantidade, nome, tipo: 'Bebida' }, 'conv-add');
        if (convAddInput) convAddInput.value = '';
        return;
      }
    } catch (e) { /* ignore */ }
    emitAction('admin:addItem', { id, itemName: nome, quantidade, preparo }, 'conv-add');
    if (convAddInput) convAddInput.value = '';
  };
  if (convEditName) convEditName.onclick = () => {
    const idTarget = id;
    const current = (carrinhos[idTarget] && carrinhos[idTarget].nome) ? carrinhos[idTarget].nome : '';
    const novo = prompt('Novo nome do cliente:', current || '');
    if (novo === null) return;
    socket.emit('admin:updateName', { id: idTarget, nome: novo });
  };
  
  // botão editar endereço dentro do modal
  const convEditAddress = document.getElementById('conv-edit-address');
  if (convEditAddress) convEditAddress.onclick = () => {
    const idTarget = id;
    const current = (carrinhos[idTarget] && carrinhos[idTarget].endereco) ? carrinhos[idTarget].endereco : '';
    const novo = prompt('Endereço do cliente (ex: Rua, nº, bairro):', current || '');
    if (novo === null) return;
    const novoTrim = String(novo || '').trim();
    if (novoTrim.length > 0 && novoTrim.length < 6) {
      showToast('Endereço muito curto. Informe no mínimo 6 caracteres.', 'error');
      return;
    }
    socket.emit('admin:updateEndereco', { id: idTarget, endereco: novoTrim });
  };

  // botão finalizar dentro do modal
  const convFinalizar = document.getElementById('conv-finalizar');
  if (convFinalizar) convFinalizar.onclick = () => {
    if (!confirm('Confirma finalizar o pedido deste cliente?')) return;
    emitAction('admin:finalizarCarrinho', { id }, 'conv-finalizar');
  };

  // botão imprimir dentro do modal
  const convPrint = document.getElementById('conv-print');
  if (convPrint) convPrint.onclick = () => {
    if (!confirm('Deseja gerar e abrir o PDF deste pedido? (Só funciona se o pedido estiver totalmente finalizado)')) return;
    // Emite a ação que pede ao servidor para gerar/servir o PDF
    // O servidor responderá via 'admin:ack' com { ok:true, url: '/pedidos/<id>.pdf' }
    actionsInFlight.add('imprimir');
    setButtonLoading('conv-print', true);
    socket.emit('admin:imprimirPedido', { id });
    socket.once('admin:ack', (r) => {
      actionsInFlight.delete('imprimir');
      setButtonLoading('conv-print', false);
      if (r && r.ok && r.url) {
          // Try to print silently by loading the PDF in a hidden iframe and calling print()
          try {
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = r.url;
            document.body.appendChild(iframe);
            // When iframe loads, try to trigger print
            iframe.onload = () => {
              try {
                // Some browsers allow iframe.contentWindow.print() when same origin
                iframe.contentWindow.focus();
                iframe.contentWindow.print();
                setTimeout(() => { try { document.body.removeChild(iframe); } catch(e){} }, 3000);
              } catch (e) {
                // Fallback: open in new tab
                window.open(r.url, '_blank');
              }
            };
            showToast('PDF gerado. Impressão solicitada.', 'success');
          } catch (e) {
            window.open(r.url, '_blank');
            showToast('PDF gerado e aberto.', 'success');
          }
      } else {
        showToast('Não foi possível imprimir: ' + (r && r.error ? r.error : 'Pedido não finalizado'), 'error');
      }
    });
  };

  modal.style.display = 'flex';
  // Auto-print on open (if enabled) — only once per session per order
  try {
    if (AUTO_PRINT_ON_OPEN && data && data.estado && String(data.estado) === 'finalizado') {
      if (!autoPrintDone.has(id)) {
        autoPrintDone.add(id);
        // Emit imprimirPedido with forcePrint so server will invoke the printer even if PDF exists
        socket.emit('admin:imprimirPedido', { id, forcePrint: true });
        socket.once('admin:ack', (r) => {
          if (r && r.ok && r.url) {
            try {
              const iframe = document.createElement('iframe');
              iframe.style.display = 'none';
              iframe.src = r.url;
              document.body.appendChild(iframe);
              iframe.onload = () => {
                try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { window.open(r.url, '_blank'); }
                setTimeout(() => { try { document.body.removeChild(iframe); } catch(e){} }, 3000);
              };
              showToast('Impressão automática solicitada.', 'success');
            } catch (e) {
              window.open(r.url, '_blank');
              showToast('Impressão automática: arquivo aberto.', 'success');
            }
          } else {
            showToast('Impressão automática falhou: ' + (r && r.error ? r.error : 'unknown'), 'error');
          }
        });
      }
    }
  } catch (e) { console.error('auto-print error', e); }
}

function closeConversation() {
  document.getElementById('conversation-modal').style.display = 'none';
}

// --- Delivered orders modal logic ---
async function fetchEntregues() {
  try {
    const res = await fetch('/api/pedidos/entregues');
    const j = await res.json();
    if (!j.ok) return entreguesCache || [];
    // If server returned empty but we have local cache from recent "pedido:salvo" events,
    // prefer the cache to avoid the race where DB GET happens before persistence finished.
    const serverList = j.pedidos || [];
    if ((!serverList || serverList.length === 0) && entreguesCache && entreguesCache.length > 0) {
      return entreguesCache;
    }
    // Atualiza o cache com os dados do servidor
    entreguesCache = serverList;
    return serverList;
  } catch (e) { console.error('fetchEntregues error', e); return []; }
}

function renderEntreguesList(items) {
  const container = document.getElementById('entregues-body');
  if (!container) return;
  container.innerHTML = '';
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="small">Nenhum pedido entregue encontrado para hoje.<br><small style="opacity:0.7;">Apenas pedidos registrados hoje são exibidos nesta lista.</small></div>';
    return;
  }
  for (const p of items) {
    const el = document.createElement('div');
    el.style.padding = '10px'; el.style.borderBottom = '1px solid rgba(255,255,255,0.03)'; el.style.display='flex'; el.style.justifyContent='space-between';
    const left = document.createElement('div');
    // Try to show known cliente info (name, endereco) by fetching /api/cliente/:numero when possible
    const clienteNumero = p.cliente || p.numero || '';
    let clienteHTML = '';
    try {
      // Fire-and-forget: fetch info but render placeholders first
      fetch(`/api/cliente/${encodeURIComponent(clienteNumero)}`).then(res => res.json()).then(json => {
        try {
          const info = (json && json.cliente) ? json.cliente : null;
          const target = document.getElementById(`cliente-info-${p.id || clienteNumero}`);
          if (target) {
            target.innerHTML = info && info.nome ? `<strong>${info.nome}</strong> &mdash; ${clienteNumero}` : `${clienteNumero}`;
            const addrEl = document.getElementById(`cliente-endereco-${p.id || clienteNumero}`);
            if (addrEl) addrEl.textContent = info && info.endereco ? info.endereco : '';
          }
        } catch (e) { /* ignore */ }
      }).catch(()=>{});
    } catch(e) {}
    left.innerHTML = `<div style="font-weight:700" id="cliente-info-${p.id || clienteNumero}">Pedido ${p.id || p.numero || ''} — Cliente: ${clienteNumero}</div><div class="small" id="cliente-endereco-${p.id || clienteNumero}">Data: ${new Date(Number(p.ts||Date.now())).toLocaleString()} — Total: R$ ${Number(p.total||0).toFixed(2)}</div>`;
    const right = document.createElement('div');
  const openBtn = document.createElement('button');
  openBtn.className = 'icon-btn'; openBtn.textContent = 'Abrir';
  openBtn.onclick = () => { openPedidoDetail(p); };
    right.appendChild(openBtn);
    // Add conversation (wa.me) button
    if (clienteNumero) {
      const conv = document.createElement('button');
      conv.className = 'icon-btn'; conv.style.marginLeft = '8px'; conv.textContent = 'Conversa';
      conv.onclick = () => { window.open(`https://wa.me/${clienteNumero.replace(/[^0-9]/g,'')}`, '_blank'); };
      right.appendChild(conv);
    }
    el.appendChild(left); el.appendChild(right);
    container.appendChild(el);
  }
}

  function openPedidoDetail(pedido) {
    try {
      const modal = document.getElementById('pedido-detail-modal');
      const body = document.getElementById('pedido-detail-body');
      const title = document.getElementById('pedido-detail-title');
      if (!modal || !body || !title) return;
      const id = pedido.id || pedido.numero || (pedido.idpedido || '(unknown)');
      const cliente = pedido.cliente || pedido.numero || ''; 
      title.textContent = `Pedido ${id} — ${cliente}`;
      // If items absent, try to fetch full pedido by id from server
      const render = (pd) => {
        let html = '';
        html += `<p><strong>Cliente:</strong> ${pd.cliente || cliente}</p>`;
        html += `<p><strong>Data:</strong> ${new Date(Number(pd.ts || Date.now())).toLocaleString()}</p>`;
        html += `<p><strong>Total:</strong> R$ ${Number(pd.total || 0).toFixed(2)}</p>`;
        if (pd.endereco) html += `<p><strong>Endereço:</strong> ${pd.endereco}</p>`;
        const items = pd.items || pd.itens || pd.itemsPedido || [];
        if (Array.isArray(items) && items.length > 0) {
          html += `<div style="margin-top:12px"><strong>Itens:</strong><div style="margin-top:8px">`;
          html += items.map(it => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,0.03)"><div>${(it.quantidade||it.qtd||1)}x ${it.nome || it.id || ''} ${it.preparo?`(${it.preparo})`:''}</div><div>R$ ${(Number(it.preco)||0).toFixed(2)}</div></div>`).join('');
          html += `</div></div>`;
        } else {
          html += `<div class="small">Nenhum item encontrado no registro do pedido.</div>`;
        }
        body.innerHTML = html;
        modal.style.display = 'flex';
      };

      const items = pedido.items || pedido.itens || pedido.itemsPedido || [];
      if (Array.isArray(items) && items.length > 0) {
        render(pedido);
      } else {
        // try fetch
        fetch(`/api/pedidos/${encodeURIComponent(id)}`).then(r => r.json()).then(j => {
          if (j && j.ok && j.pedido) render(j.pedido);
          else render(pedido); // best-effort
        }).catch(e => { console.error('fetch pedido by id error', e); render(pedido); });
      }
    } catch (e) { console.error('openPedidoDetail error', e); }
  }

  function closePedidoDetail() { const m = document.getElementById('pedido-detail-modal'); if (m) m.style.display = 'none'; }

  document.addEventListener('DOMContentLoaded', () => {
    const close = document.getElementById('pedido-detail-close'); if (close) close.onclick = closePedidoDetail;
  });

function openEntreguesModal() {
  const modal = document.getElementById('entregues-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  // load list
  fetchEntregues().then(list => renderEntreguesList(list));
}

function closeEntreguesModal() { document.getElementById('entregues-modal').style.display = 'none'; }

document.addEventListener('DOMContentLoaded', () => {
  // wire header button
  try {
    const btn = document.getElementById('btn-entregues');
    if (btn) btn.onclick = openEntreguesModal;
    const closeBtn = document.getElementById('entregues-close'); if (closeBtn) closeBtn.onclick = closeEntreguesModal;
    const refreshBtn = document.getElementById('entregues-refresh'); if (refreshBtn) refreshBtn.onclick = () => { 
      // Limpa o cache para forçar busca no servidor
      entreguesCache = [];
      fetchEntregues().then(list => renderEntreguesList(list)); 
    };
  } catch (e) {}
});

// Totals widget: fetch and render totals for the day
async function fetchTotaisDoDia() {
  try {
  console.log('fetchTotaisDoDia -> solicitando /api/pedidos/totais-dia');
  const res = await fetch('/api/pedidos/totais-dia');
  const j = await res.json();
  console.log('fetchTotaisDoDia -> resposta', j);
  if (!j || !j.ok) return;
  try { document.getElementById('header-total-produtos').textContent = Number(j.totalProdutos || 0).toFixed(2); } catch(e){}
  try { document.getElementById('header-total-entregues').textContent = Number(j.totalEntregues || 0).toFixed(2); } catch(e){}
  } catch (e) { console.error('fetchTotaisDoDia error', e); }
}

// refresh totals on load and when relevant events occur
document.addEventListener('DOMContentLoaded', () => { fetchTotaisDoDia(); });

// Emite atualização de quantidade para o servidor
function emitUpdateQty(id, index, delta) {
  const btnId = delta > 0 ? `qty-plus-${index}` : `qty-minus-${index}`;
  emitAction('admin:updateQuantity', { id, index, delta }, btnId);
}

// Função para excluir um card
function deleteCard(id) {
  if (confirm('Tem certeza que deseja excluir este card? Esta ação removerá o card do painel.')) {
    // Remove o card do DOM
    const card = document.getElementById(`card-${id}`);
    if (card) {
      card.remove();
    }
    
    // Remove o carrinho da memória local
    if (carrinhos[id]) {
      delete carrinhos[id];
    }
    
    showToast('Card excluído com sucesso', 'success');
  }
}

// Inicialização (chamado no final do HTML)
document.addEventListener('DOMContentLoaded', () => {
  renderAll(); // Render inicial se necessário
});

