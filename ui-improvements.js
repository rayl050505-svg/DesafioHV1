// ═══════════════════════════════════════════════════════════
//  STUDY QUEST PRO — UI IMPROVEMENTS
//  Acordeones, Tema, Tutorial, Mini-perfil
// ═══════════════════════════════════════════════════════════

// ── Acordeones colapsables ──────────────────────────────
function toggleCollapse(id) {
    const body = document.getElementById('collapse-' + id);
    const icon = document.getElementById('chevron-' + id);
    if (!body) return;
    const isOpen = !body.classList.contains('collapsed');
    body.classList.toggle('collapsed', isOpen);
    if (icon) icon.textContent = isOpen ? '▶' : '▼';
    // Guardar estado
    const states = JSON.parse(localStorage.getItem('collapseStates') || '{}');
    states[id] = !isOpen;
    localStorage.setItem('collapseStates', JSON.stringify(states));
}

function restoreCollapseStates() {
    const states = JSON.parse(localStorage.getItem('collapseStates') || '{}');
    Object.entries(states).forEach(([id, isOpen]) => {
        const body = document.getElementById('collapse-' + id);
        const icon = document.getElementById('chevron-' + id);
        if (!body) return;
        body.classList.toggle('collapsed', !isOpen);
        if (icon) icon.textContent = isOpen ? '▼' : '▶';
    });
}

// ── Tema claro / oscuro ─────────────────────────────────
function setTheme(light) {
    document.body.classList.toggle('light-theme', light);
    localStorage.setItem('lightTheme', light ? '1' : '0');
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = light ? '🌙' : '☀️';
}

function initTheme() {
    const isLight = localStorage.getItem('lightTheme') === '1';
    setTheme(isLight);
}

// ── Mini perfil flotante ────────────────────────────────
function updateMiniProfile() {
    const el = document.getElementById('mini-profile-bar');
    if (!el) return;
    el.innerHTML = `
        <div class="mini-avatar" onclick="goToProfile()">
            <span class="mini-avatar-icon">👤</span>
        </div>
        <div class="mini-info" onclick="goToProfile()">
            <span class="mini-name">${appState.userName || 'Jugador'}</span>
            <span class="mini-level">Nv.${appState.currentLevel} · ${appState.currentRank}</span>
        </div>
        <div class="mini-resources">
            <span>🥇${appState.lingotes||0}</span>
            <span>💎${appState.gemas||0}</span>
            <span>🎰${appState.fichas||0}</span>
        </div>`;
}

function goToProfile() {
    document.querySelector('.nav-item[data-target="perfil"]')?.click();
}

// ── Tutorial inicial ────────────────────────────────────
const TUTORIAL_STEPS = [
    { target: '[data-target="estudio"]',   title: '📚 Estudio',    text: 'Aquí registras tus sesiones de estudio y ganas XP, puntos y recursos.' },
    { target: '[data-target="ejercicios"]', title: '💪 Ejercicios', text: 'Registra tu entrenamiento diario para ganar recompensas extra.' },
    { target: '[data-target="casino"]',    title: '🎲 Casino',     text: 'Usa tus Fichas para apostar en slots, botellas y buscaminas.' },
    { target: '[data-target="ranking"]',   title: '🏆 Ranking',    text: 'Conecta con amigos por ID, crea desafíos y participa en la Semana Infernal.' },
    { target: '[data-target="pase-hv"]',   title: '✨ Pase HV',    text: 'Sube de nivel el Pase con XP para desbloquear recompensas exclusivas.' },
    { target: '[data-target="tienda"]',    title: '🛒 Tienda',     text: 'Compra boosts, cofres y más con tus Lingotes y Gemas.' },
    { target: '[data-target="perfil"]',    title: '👤 Perfil',     text: '¡Eso es todo! Revisa tu progreso, logros y estandartes aquí.' },
];
let tutorialStep = 0;

function initTutorial() {
    if (localStorage.getItem('tutorialDone')) return;
    tutorialStep = 0;
    showTutorialStep();
}

function showTutorialStep() {
    const overlay = document.getElementById('tutorial-overlay');
    if (!overlay) return;
    if (tutorialStep >= TUTORIAL_STEPS.length) {
        overlay.style.display = 'none';
        localStorage.setItem('tutorialDone', '1');
        return;
    }
    const step = TUTORIAL_STEPS[tutorialStep];
    const target = document.querySelector(step.target);
    overlay.style.display = 'flex';

    const box = document.getElementById('tutorial-box');
    document.getElementById('tutorial-title').textContent = step.title;
    document.getElementById('tutorial-text').textContent  = step.text;
    document.getElementById('tutorial-step-count').textContent = `${tutorialStep+1} / ${TUTORIAL_STEPS.length}`;

    // Highlight target
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('tutorial-highlight'));
    if (target) target.classList.add('tutorial-highlight');

    // Position tooltip near target
    if (target && box) {
        const rect = target.getBoundingClientRect();
        box.style.bottom = (window.innerHeight - rect.top + 12) + 'px';
        box.style.left = Math.max(8, rect.left - 8) + 'px';
    }
}

function nextTutorialStep() {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('tutorial-highlight'));
    tutorialStep++;
    showTutorialStep();
}

function skipTutorial() {
    document.getElementById('tutorial-overlay').style.display = 'none';
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('tutorial-highlight'));
    localStorage.setItem('tutorialDone', '1');
}

// ── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        initTheme();
        restoreCollapseStates();
        updateMiniProfile();
        initTutorial();
    }, 600);
});
