// public/js/painel-mensagens.js
const socket = io();

// Elementos principais
const container = document.querySelector('.container');
const mensagensContainer = document.getElementById('mensagens-container');
const btnRefresh = document.getElementById('btn-refresh');
const btnNew = document.getElementById('btn-new');
const searchInput = document.getElementById('search-input');
const filterTipo = document.getElementById('filter-tipo');
const btnEditFluxo = document.getElementById('btn-edit-fluxo');

// Elementos do modal
const editorModal = document.getElementById('editor-modal');
const editorTitle = document.getElementById('editor-title');
const inputChave = document.getElementById('msg-chave');
const inputTitulo = document.getElementById('msg-titulo');
const inputConteudo = document.getElementById('msg-conteudo');
const inputTipo = document.getElementById('msg-tipo');
const btnSave = document.getElementById('editor-save');
const btnCancel = document.getElementById('editor-cancel');

// Elementos de estatísticas
const totalMensagens = document.getElementById('total-mensagens');
const mensagensTexto = document.getElementById('mensagens-texto');
const mensagensMenu = document.getElementById('mensagens-menu');
const mensagensConfirmacao = document.getElementById('mensagens-confirmacao');

let editingId = null; // null => creating
let allMensagens = []; // Armazena todas as mensagens para filtragem

// Função para buscar mensagens
async function fetchMensagens() {
  try {
    const res = await fetch('/api/mensagens');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    allMensagens = data || [];
    updateStats();
    renderMensagens(allMensagens);
  } catch (e) {
    console.error('Erro ao buscar mensagens', e);
    mensagensContainer.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>Erro ao carregar mensagens</h3>
        <p>Não foi possível conectar ao servidor. Tente novamente.</p>
      </div>
    `;
  }
}

// Função para atualizar estatísticas
function updateStats() {
  totalMensagens.textContent = allMensagens.length;
  
  const textoCount = allMensagens.filter(m => m.tipo === 'texto').length;
  const menuCount = allMensagens.filter(m => m.tipo === 'menu').length;
  const confirmacaoCount = allMensagens.filter(m => m.tipo === 'confirmacao').length;
  
  mensagensTexto.textContent = textoCount;
  mensagensMenu.textContent = menuCount;
  mensagensConfirmacao.textContent = confirmacaoCount;
}

// Função para filtrar mensagens
function filterMensagens() {
  const searchTerm = searchInput.value.toLowerCase();
  const tipoFilter = filterTipo.value;
  
  let filtered = allMensagens;
  
  // Filtrar por termo de busca
  if (searchTerm) {
    filtered = filtered.filter(m => 
      (m.chave && m.chave.toLowerCase().includes(searchTerm)) ||
      (m.titulo && m.titulo.toLowerCase().includes(searchTerm)) ||
      (m.conteudo && m.conteudo.toLowerCase().includes(searchTerm))
    );
  }
  
  // Filtrar por tipo
  if (tipoFilter) {
    filtered = filtered.filter(m => m.tipo === tipoFilter);
  }
  
  renderMensagens(filtered);
}

// Função para renderizar mensagens
function renderMensagens(list) {
  if (!Array.isArray(list) || list.length === 0) {
    mensagensContainer.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-inbox"></i>
        <h3>Nenhuma mensagem encontrada</h3>
        <p>${searchInput.value || filterTipo.value ? 
          'Nenhuma mensagem corresponde aos filtros aplicados.' : 
          'Crie sua primeira mensagem clicando no botão "Nova Mensagem"'}</p>
      </div>
    `;
    return;
  }

  mensagensContainer.innerHTML = '';
  
  for (const m of list) {
    const card = document.createElement('div');
    card.className = 'message-card';
    card.innerHTML = `
      <div class="message-card-header">
        <h3 class="message-title">${m.titulo || 'Sem título'}</h3>
        <button class="btn btn-ghost btn-sm" data-id="${m.id}" data-action="edit">
          <i class="fas fa-edit"></i>
        </button>
      </div>
      <div class="message-key">${m.chave || 'sem-chave'}</div>
      <div class="message-content">${(m.conteudo || '').substring(0, 200)}</div>
      <div class="message-footer">
        <span class="message-type type-${m.tipo || 'texto'}">
          <i class="fas fa-${getIconForType(m.tipo)}"></i>
          ${formatTipo(m.tipo)}
        </span>
        <button class="btn btn-danger btn-sm" data-id="${m.id}" data-action="delete">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    mensagensContainer.appendChild(card);
  }
}

// Funções auxiliares para formatação
function getIconForType(tipo) {
  const icons = {
    'texto': 'font',
    'menu': 'list',
    'confirmacao': 'check-circle'
  };
  return icons[tipo] || 'font';
}

function formatTipo(tipo) {
  const tipos = {
    'texto': 'Texto',
    'menu': 'Menu',
    'confirmacao': 'Confirmação'
  };
  return tipos[tipo] || 'Texto';
}

// Função para abrir o editor
function openEditor({id=null, chave='', titulo='', conteudo='', tipo='texto'} = {}){
  editingId = id;
  editorTitle.innerHTML = `<i class="fas fa-${id ? 'edit' : 'plus'}"></i> ${id ? 'Editar Mensagem' : 'Nova Mensagem'}`;
  inputChave.value = chave || '';
  inputTitulo.value = titulo || '';
  inputConteudo.value = conteudo || '';
  inputTipo.value = tipo || 'texto';
  
  // Se estiver editando, desabilitar a chave
  inputChave.disabled = !!id;
  
  editorModal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

// Função para fechar o editor
function closeEditor(){
  editorModal.classList.remove('active');
  document.body.style.overflow = '';
  editingId = null;
  // Limpar campos
  inputChave.value = '';
  inputTitulo.value = '';
  inputConteudo.value = '';
  inputTipo.value = 'texto';
  inputChave.disabled = false;
}

// Função para editar fluxo
function editFluxo() {
  alert('Funcionalidade de edição de fluxo será implementada em breve!\n\nVocê poderá definir a ordem e relacionamentos entre as mensagens.');
}

// Event listeners para os botões do modal
document.querySelectorAll('[data-action="close"]').forEach(btn => {
  btn.addEventListener('click', closeEditor);
});

// Event delegation para ações nas mensagens
mensagensContainer.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  
  const id = btn.getAttribute('data-id');
  const action = btn.getAttribute('data-action');

  if (action === 'edit') {
    // Buscar a mensagem específica
    try {
      const m = allMensagens.find(x => String(x.id) === String(id));
      if (m) openEditor(m);
      else alert('Mensagem não encontrada');
    } catch (e) { 
      console.error(e); 
      alert('Erro ao abrir mensagem') 
    }
  } else if (action === 'delete') {
    if (!confirm('Confirma exclusão desta mensagem?')) return;
    try {
      const res = await fetch(`/api/mensagens/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed');
      fetchMensagens();
    } catch (e) { 
      console.error(e); 
      alert('Erro ao excluir') 
    }
  }
});

// Event listeners para os botões principais
btnRefresh.addEventListener('click', () => fetchMensagens());
btnNew.addEventListener('click', () => openEditor());
btnEditFluxo.addEventListener('click', editFluxo);

// Event listeners para o formulário
btnSave.addEventListener('click', async () => {
  const chave = inputChave.value.trim();
  const titulo = inputTitulo.value.trim();
  const conteudo = inputConteudo.value.trim();
  const tipo = inputTipo.value;

  if (!chave || !titulo || !conteudo) {
    alert('Chave, título e conteúdo são obrigatórios');
    return;
  }

  try {
    if (editingId) {
      const res = await fetch(`/api/mensagens/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titulo, conteudo, tipo })
      });
      if (!res.ok) throw new Error('failed');
    } else {
      const res = await fetch('/api/mensagens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chave, titulo, conteudo, tipo })
      });
      if (!res.ok) throw new Error('failed');
    }
    closeEditor();
    fetchMensagens();
  } catch (e) {
    console.error('Erro ao salvar', e);
    alert('Erro ao salvar mensagem');
  }
});

// Event listeners para busca e filtros
searchInput.addEventListener('input', filterMensagens);
filterTipo.addEventListener('change', filterMensagens);

// Socket: atualizar quando mensagens mudarem
socket.on('mensagem-atualizada', (data) => {
  console.log('mensagem-atualizada', data);
  fetchMensagens();
});

// Fechar modal ao clicar no backdrop
editorModal.addEventListener('click', (e) => {
  if (e.target === editorModal) {
    closeEditor();
  }
});

// Fechar modal com ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editorModal.classList.contains('active')) {
    closeEditor();
  }
});

// Inicializar
fetchMensagens();