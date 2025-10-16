/**
 * Toast Manager - Sistema de Notificações
 * BRUTUS Restaurant Bot
 */

class ToastManager {
  constructor() {
    this.container = null;
    this.init();
  }

  init() {
    // Criar container se não existir
    if (!document.querySelector('.toast-container')) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      this.container.setAttribute('role', 'region');
      this.container.setAttribute('aria-label', 'Notificações');
      document.body.appendChild(this.container);
    } else {
      this.container = document.querySelector('.toast-container');
    }
  }

  /**
   * Mostra um toast
   * @param {string} message - Mensagem principal
   * @param {string} type - Tipo: success, error, warning, info
   * @param {string} title - Título opcional
   * @param {number} duration - Duração em ms (0 = permanente)
   */
  show(message, type = 'info', title = '', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');

    const icons = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle'
    };

    const titles = {
      success: title || 'Sucesso!',
      error: title || 'Erro!',
      warning: title || 'Atenção!',
      info: title || 'Informação'
    };

    toast.innerHTML = `
      <i class="fas ${icons[type]} toast-icon"></i>
      <div class="toast-content">
        <div class="toast-title">${titles[type]}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close" aria-label="Fechar notificação">
        <i class="fas fa-times"></i>
      </button>
    `;

    // Adicionar ao container
    this.container.appendChild(toast);

    // Event listener para fechar
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => this.remove(toast));

    // Auto-remover após duração
    if (duration > 0) {
      setTimeout(() => this.remove(toast), duration);
    }

    // Adicionar animação de entrada
    requestAnimationFrame(() => {
      toast.style.animation = 'slideInRight 0.3s ease-out';
    });

    return toast;
  }

  remove(toast) {
    toast.style.animation = 'slideInRight 0.3s ease-out reverse';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }

  success(message, title = '', duration = 4000) {
    return this.show(message, 'success', title, duration);
  }

  error(message, title = '', duration = 5000) {
    return this.show(message, 'error', title, duration);
  }

  warning(message, title = '', duration = 4500) {
    return this.show(message, 'warning', title, duration);
  }

  info(message, title = '', duration = 4000) {
    return this.show(message, 'info', title, duration);
  }

  clear() {
    const toasts = this.container.querySelectorAll('.toast');
    toasts.forEach(toast => this.remove(toast));
  }
}

// Instância global
const toast = new ToastManager();

// Export para módulos
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ToastManager, toast };
}
