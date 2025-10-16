/**
 * Modal Manager - Sistema de Modais Modernos
 * BRUTUS Restaurant Bot
 */

class ModalManager {
  constructor() {
    this.activeModals = [];
    this.init();
  }

  init() {
    // Event listener global para fechar com ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.activeModals.length > 0) {
        this.close(this.activeModals[this.activeModals.length - 1]);
      }
    });
  }

  /**
   * Abre um modal
   * @param {string|HTMLElement} modalId - ID do modal ou elemento
   */
  open(modalId) {
    const modal = typeof modalId === 'string' 
      ? document.getElementById(modalId) 
      : modalId;

    if (!modal) {
      console.error('Modal não encontrado:', modalId);
      return;
    }

    // Adicionar classe active
    modal.classList.add('active');
    modal.style.display = 'flex';

    // Adicionar à lista de modais ativos
    if (!this.activeModals.includes(modal)) {
      this.activeModals.push(modal);
    }

    // Focar no primeiro elemento focável
    this.trapFocus(modal);

    // Prevenir scroll do body
    document.body.style.overflow = 'hidden';

    // Event listener para fechar ao clicar no backdrop
    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close(modal), { once: true });
    }

    // Event listeners para botões de fechar
    const closeButtons = modal.querySelectorAll('.modal-close, [data-modal-close]');
    closeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.close(modal), { once: true });
    });

    // Emitir evento customizado
    modal.dispatchEvent(new CustomEvent('modal:opened'));
  }

  /**
   * Fecha um modal
   * @param {string|HTMLElement} modalId - ID do modal ou elemento
   */
  close(modalId) {
    const modal = typeof modalId === 'string' 
      ? document.getElementById(modalId) 
      : modalId;

    if (!modal) return;

    // Remover classe active
    modal.classList.remove('active');
    
    // Adicionar animação de saída
    setTimeout(() => {
      modal.style.display = 'none';
    }, 300);

    // Remover da lista de modais ativos
    const index = this.activeModals.indexOf(modal);
    if (index > -1) {
      this.activeModals.splice(index, 1);
    }

    // Restaurar scroll se não houver mais modais
    if (this.activeModals.length === 0) {
      document.body.style.overflow = '';
    }

    // Emitir evento customizado
    modal.dispatchEvent(new CustomEvent('modal:closed'));
  }

  /**
   * Alterna visibilidade do modal
   * @param {string|HTMLElement} modalId - ID do modal ou elemento
   */
  toggle(modalId) {
    const modal = typeof modalId === 'string' 
      ? document.getElementById(modalId) 
      : modalId;

    if (!modal) return;

    if (modal.classList.contains('active')) {
      this.close(modal);
    } else {
      this.open(modal);
    }
  }

  /**
   * Fecha todos os modais
   */
  closeAll() {
    [...this.activeModals].forEach(modal => this.close(modal));
  }

  /**
   * Trap focus dentro do modal (acessibilidade)
   */
  trapFocus(modal) {
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    // Focar no primeiro elemento
    setTimeout(() => firstElement.focus(), 100);

    // Trap focus
    modal.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    });
  }

  /**
   * Cria um modal dinamicamente
   * @param {Object} options - Opções do modal
   */
  create(options = {}) {
    const {
      id = `modal-${Date.now()}`,
      title = 'Modal',
      content = '',
      size = 'md',
      footer = null,
      closeButton = true,
      backdrop = true
    } = options;

    const modal = document.createElement('div');
    modal.id = id;
    modal.className = `modal modal-${size}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', `${id}-title`);
    modal.setAttribute('aria-modal', 'true');

    const footerHTML = footer ? `
      <div class="modal-footer">
        ${footer}
      </div>
    ` : '';

    const closeButtonHTML = closeButton ? `
      <button class="modal-close" aria-label="Fechar modal">
        <i class="fas fa-times"></i>
      </button>
    ` : '';

    modal.innerHTML = `
      ${backdrop ? '<div class="modal-backdrop"></div>' : ''}
      <div class="modal-container">
        <div class="modal-header">
          <h2 id="${id}-title" class="modal-title">${title}</h2>
          ${closeButtonHTML}
        </div>
        <div class="modal-body">
          ${content}
        </div>
        ${footerHTML}
      </div>
    `;

    document.body.appendChild(modal);
    return modal;
  }

  /**
   * Gerenciamento de abas dentro do modal
   */
  initTabs(modalId) {
    const modal = typeof modalId === 'string' 
      ? document.getElementById(modalId) 
      : modalId;

    if (!modal) return;

    const tabs = modal.querySelectorAll('.modal-tab');
    const contents = modal.querySelectorAll('.modal-tab-content');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        // Remover active de todas as abas
        tabs.forEach(t => t.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));

        // Adicionar active na aba clicada
        tab.classList.add('active');
        
        // Mostrar conteúdo correspondente
        const targetContent = modal.querySelector(`#tab-${target}`);
        if (targetContent) {
          targetContent.classList.add('active');
        }

        // Emitir evento
        modal.dispatchEvent(new CustomEvent('modal:tab-changed', {
          detail: { tab: target }
        }));
      });
    });
  }

  /**
   * Confirmar ação com modal
   */
  confirm(options = {}) {
    const {
      title = 'Confirmar',
      message = 'Tem certeza?',
      confirmText = 'Confirmar',
      cancelText = 'Cancelar',
      type = 'warning'
    } = options;

    return new Promise((resolve) => {
      const modal = this.create({
        id: 'modal-confirm',
        title,
        size: 'sm',
        content: `
          <div style="text-align: center; padding: var(--spacing-6);">
            <i class="fas fa-exclamation-triangle" style="font-size: 48px; color: var(--${type}-400); margin-bottom: var(--spacing-4);"></i>
            <p style="font-size: var(--font-lg); color: var(--text-primary);">${message}</p>
          </div>
        `,
        footer: `
          <button class="btn btn-secondary" data-action="cancel">${cancelText}</button>
          <button class="btn btn-${type}" data-action="confirm">${confirmText}</button>
        `,
        closeButton: false
      });

      this.open(modal);

      // Event listeners
      modal.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        this.close(modal);
        setTimeout(() => modal.remove(), 400);
        resolve(false);
      });

      modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        this.close(modal);
        setTimeout(() => modal.remove(), 400);
        resolve(true);
      });
    });
  }

  /**
   * Loading modal
   */
  showLoading(message = 'Carregando...') {
    const modal = this.create({
      id: 'modal-loading',
      title: '',
      size: 'sm',
      content: `
        <div style="text-align: center; padding: var(--spacing-8);">
          <div class="spinner spinner-lg" style="margin: 0 auto var(--spacing-4);"></div>
          <p style="font-size: var(--font-base); color: var(--text-secondary);">${message}</p>
        </div>
      `,
      closeButton: false,
      backdrop: true
    });

    this.open(modal);
    return modal;
  }

  hideLoading() {
    const loadingModal = document.getElementById('modal-loading');
    if (loadingModal) {
      this.close(loadingModal);
      setTimeout(() => loadingModal.remove(), 400);
    }
  }
}

// Instância global
const modalManager = new ModalManager();

// Export para módulos
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ModalManager, modalManager };
}
