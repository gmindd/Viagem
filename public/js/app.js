/* =========================================================================
   Viagem — comportamentos do lado do cliente.
   Tudo é progressivo: sem JS a app continua a funcionar (formulários HTML).
   ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
  initNavToggle();
  initVisibilityToggle();
  initCopyButtons();
  initNativeShare();
  initConfirmActions();
  initCapacityBars();
});

/**
 * Abre e fecha o menu de navegação em ecrãs pequenos,
 * mantendo o estado do aria-expanded sincronizado.
 */
function initNavToggle() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('nav-principal');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Fechar menu' : 'Abrir menu');
  });
}

/**
 * No formulário de evento, mostra o campo da palavra-passe apenas
 * quando a opção "protegido por palavra-passe" está seleccionada.
 */
function initVisibilityToggle() {
  const group = document.querySelector('[data-visibility-group]');
  if (!group) return;

  const options = group.querySelectorAll('[data-visibility-option]');
  const passwordField = group.querySelector('[data-password-field]');
  if (!options.length || !passwordField) return;

  // Reflecte a opção actualmente seleccionada no campo de palavra-passe
  const sync = () => {
    const selected = group.querySelector('[data-visibility-option]:checked');
    passwordField.hidden = selected?.value !== 'password';
  };

  options.forEach((option) => option.addEventListener('change', sync));
  sync();
}

/**
 * Copia para a área de transferência o valor do campo indicado
 * em data-copy-target e mostra confirmação temporária.
 */
function initCopyButtons() {
  const buttons = document.querySelectorAll('[data-copy-button]');

  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const input = document.querySelector(button.dataset.copyTarget);
      const feedback = document.querySelector('[data-copy-feedback]');
      if (!input) return;

      const copied = await copyText(input);
      if (feedback) {
        feedback.textContent = copied ? 'Link copiado!' : 'Não foi possível copiar — copia à mão.';
        setTimeout(() => { feedback.textContent = ''; }, 3000);
      }
    });
  });
}

/**
 * Tenta a Clipboard API e cai para selecção manual do campo
 * quando o browser a bloqueia (contextos sem https, por exemplo).
 */
async function copyText(input) {
  try {
    await navigator.clipboard.writeText(input.value);
    return true;
  } catch {
    input.focus();
    input.select();
    return false;
  }
}

/**
 * Mostra o botão de partilha nativa (telemóvel) apenas quando
 * o browser suporta navigator.share.
 */
function initNativeShare() {
  const button = document.querySelector('[data-share-button]');
  if (!button || !navigator.share) return;

  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.share({
        title: button.dataset.shareTitle,
        url: button.dataset.shareUrl
      });
    } catch {
      // O utilizador cancelou a partilha — não há nada a fazer.
    }
  });
}

/**
 * Pede confirmação antes de submeter acções destrutivas
 * (apagar passeio, remover participante, apagar mensagem).
 */
function initConfirmActions() {
  document.querySelectorAll('[data-confirm]').forEach((button) => {
    button.addEventListener('click', (event) => {
      if (!window.confirm(button.dataset.confirm)) {
        event.preventDefault();
      }
    });
  });
}

/**
 * Anima a barra de vagas ocupadas a partir da percentagem
 * guardada em data-capacity (evita estilos inline no HTML).
 */
function initCapacityBars() {
  document.querySelectorAll('[data-capacity]').forEach((bar) => {
    requestAnimationFrame(() => {
      bar.style.width = `${bar.dataset.capacity}%`;
    });
  });
}
