/* =========================================================================
   Viagem — comportamentos do lado do cliente.
   Tudo é progressivo: sem JS a app continua a funcionar (formulários HTML).
   ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
  initNavToggle();
  initPhaseToggle();
  initVisibilityToggle();
  initCopyButtons();
  initNativeShare();
  initConfirmActions();
  initCapacityBars();
  initCalendar();
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
 * Mostra apenas os campos que fazem sentido para a fase escolhida:
 * janela de datas na fase "datas", data marcada nas restantes.
 */
function initPhaseToggle() {
  const group = document.querySelector('[data-phase-group]');
  const sections = document.querySelectorAll('[data-when-phase]');
  if (!group || !sections.length) return;

  // Esconde as secções que não pertencem à fase actualmente seleccionada
  const sync = () => {
    const selected = group.querySelector('[data-phase-option]:checked');
    const phase = selected ? selected.value : 'preparacao';
    sections.forEach((section) => {
      section.hidden = !section.dataset.whenPhase.split(' ').includes(phase);
    });
  };

  group.querySelectorAll('[data-phase-option]').forEach((option) => {
    option.addEventListener('change', sync);
  });
  sync();
}

/**
 * Liga a visibilidade escolhida às formas de entrada possíveis:
 * uma viagem pública é sempre de entrada livre, por isso as outras
 * opções desaparecem e o campo da palavra-passe também.
 */
function initVisibilityToggle() {
  const visibilityGroup = document.querySelector('[data-visibility-group]');
  const joinGroup = document.querySelector('[data-join-group]');
  if (!visibilityGroup || !joinGroup) return;

  const passwordField = joinGroup.querySelector('[data-password-field]');
  const joinCards = joinGroup.querySelectorAll('[data-join-card]');
  const joinNote = joinGroup.querySelector('[data-join-note]');

  // Reflecte visibilidade e política de entrada nos campos visíveis
  const sync = () => {
    const visibility = visibilityGroup.querySelector('[data-visibility-option]:checked')?.value;
    const isPublic = visibility === 'publico';

    // Numa viagem pública só resta a entrada livre
    joinCards.forEach((card) => {
      const allowed = !isPublic || card.dataset.joinCard === 'aberto';
      card.hidden = !allowed;
      const input = card.querySelector('[data-join-option]');
      if (input) input.disabled = !allowed;
    });

    if (isPublic) {
      const open = joinGroup.querySelector('[data-join-option][value="aberto"]');
      if (open) open.checked = true;
    }
    if (joinNote) joinNote.hidden = isPublic;

    const policy = joinGroup.querySelector('[data-join-option]:checked')?.value;
    if (passwordField) passwordField.hidden = policy !== 'palavra_passe';
  };

  visibilityGroup.querySelectorAll('[data-visibility-option]')
    .forEach((option) => option.addEventListener('change', sync));
  joinGroup.querySelectorAll('[data-join-option]')
    .forEach((option) => option.addEventListener('change', sync));

  sync();
}

/**
 * Calendário de disponibilidades: permite arrastar sobre vários dias
 * e desmarcar tudo de uma vez, sem obrigar a clicar dia a dia.
 */
function initCalendar() {
  const calendars = document.querySelector('.calendars');
  if (!calendars) return;

  let painting = false;
  let paintValue = true;

  // Aplica a um dia o mesmo estado do dia onde o arrasto começou
  const paint = (label) => {
    const input = label.querySelector('input[type=checkbox]');
    if (input && input.checked !== paintValue) {
      input.checked = paintValue;
      label.classList.toggle('day--mine', paintValue);
    }
  };

  calendars.addEventListener('pointerdown', (event) => {
    const label = event.target.closest('.day');
    if (!label) return;
    const input = label.querySelector('input[type=checkbox]');
    if (!input) return;
    painting = true;
    // O clique normal já alterna o estado; o arrasto segue esse novo valor
    paintValue = !input.checked;
  });

  calendars.addEventListener('pointerover', (event) => {
    if (!painting) return;
    const label = event.target.closest('.day');
    if (label) paint(label);
  });

  const stop = () => { painting = false; };
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);

  // Botão para limpar todas as marcações de uma vez
  const clearButton = document.querySelector('[data-clear-days]');
  if (clearButton) {
    clearButton.addEventListener('click', () => {
      calendars.querySelectorAll('input[type=checkbox]').forEach((input) => {
        input.checked = false;
      });
    });
  }
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
