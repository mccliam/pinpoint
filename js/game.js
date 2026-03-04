/**
 * game.js — Main game controller for Pinpoint.
 * Imports pure logic from daily.js and cloud ops from supabase.js.
 */

import {
    getDailyCity, buildHints, getDateString,
    getHintsRevealedCount, getNextHintMs, formatCountdown,
} from './daily.js';
import {
    initSupabase, submitScore, fetchDailyLeaderboard,
    checkAndClaimFirstSolver, subscribeToFirstSolver,
} from './supabase.js';

// ─────────────────────────────────────────────────
// Constants & Storage keys
// ─────────────────────────────────────────────────
const MAX_GUESSES = 5;
const STATS_KEY = 'pinpoint_stats';
const TODAY_KEY = 'pinpoint_today';
const NAME_KEY = 'pinpoint_name';
const DARK_KEY = 'pinpoint_dark';

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];
const DIFF_STYLE = {
    Hard: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
    Medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
    Easy: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
};

// ─────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────
const S = {
    city: null, hints: [], allNames: [],
    guessesLeft: MAX_GUESSES, guesses: [], status: 'playing',
    hintsRevealed: 0, dateStr: '', hintTimerRef: null,
    countdownRef: null, playerName: '', pendingScore: null,
};

// ─────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────
function getStats() {
    return JSON.parse(localStorage.getItem(STATS_KEY) || '{"played":0,"won":0,"streak":0,"maxStreak":0,"dist":[0,0,0,0,0]}');
}
function saveStats(st) { localStorage.setItem(STATS_KEY, JSON.stringify(st)); }

function getTodayRecord() {
    const r = JSON.parse(localStorage.getItem(TODAY_KEY) || 'null');
    return r?.date === S.dateStr ? r : null;
}
function saveTodayRecord(r) { localStorage.setItem(TODAY_KEY, JSON.stringify({ ...r, date: S.dateStr })); }

// ─────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function showOverlay() { $('overlay').classList.add('open'); }
function hideOverlay() { $('overlay').classList.remove('open'); }
function openModal(id) { showOverlay(); $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); hideOverlay(); }

function showToast(msg, durationMs = 4000) {
    $('toast-msg').textContent = msg;
    const t = $('toast');
    t.classList.remove('hidden');
    t.style.transform = 'translateY(-8px)';
    setTimeout(() => { t.style.transform = ''; }, 50);
    setTimeout(() => { t.classList.add('hidden'); }, durationMs);
}

function switchNav(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach((b) => {
        const active = b.dataset.nav === name;
        b.classList.toggle('text-primary', active);
        b.classList.toggle('text-slate-400', !active);
        b.classList.toggle('dark:text-slate-500', !active);
        const icon = b.querySelector('.material-symbols-outlined');
        if (icon) icon.style.fontVariationSettings = active ? "'FILL' 1" : "'FILL' 0";
    });
    if (name === 'stats') renderStats();
    if (name === 'leaderboard') loadLeaderboard();
    if (name === 'settings') renderSettings();
}

// ─────────────────────────────────────────────────
// Dark mode
// ─────────────────────────────────────────────────
function applyDark(on) {
    document.documentElement.classList.toggle('dark', on);
    localStorage.setItem(DARK_KEY, on ? '1' : '0');
}
function initDark() {
    const saved = localStorage.getItem(DARK_KEY);
    const dark = saved !== null ? saved === '1' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyDark(dark);
}

// ─────────────────────────────────────────────────
// Hint rendering
// ─────────────────────────────────────────────────
function renderHints() {
    const tl = $('hint-timeline');
    const revealed = S.status !== 'playing' ? 8 : S.hintsRevealed;
    tl.innerHTML = '';

    S.hints.forEach((hint, i) => {
        const isRevealed = i < revealed;
        const hour = new Date(); hour.setHours(i, 0, 0, 0);
        const timeStr = hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const card = document.createElement('div');
        card.className = `flex gap-3 p-3.5 rounded-xl border transition-all hint-enter ${isRevealed
            ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm'
            : 'bg-slate-50 dark:bg-slate-900/30 border-dashed border-slate-200 dark:border-slate-700 opacity-50'
            }`;
        card.style.animationDelay = `${i * 40}ms`;

        if (isRevealed) {
            const diffClass = DIFF_STYLE[hint.difficulty] || '';
            card.innerHTML = `
        <div class="flex flex-col items-center shrink-0 pt-0.5">
          <span class="text-[10px] font-bold text-slate-400">${timeStr}</span>
          <div class="w-px flex-1 bg-slate-200 dark:bg-slate-700 my-1"></div>
          <span class="material-symbols-outlined text-primary" style="font-size:16px;font-variation-settings:'FILL' 1">check_circle</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Hint #${i + 1}</span>
            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full ${diffClass}">${hint.difficulty}</span>
          </div>
          <p class="text-sm font-semibold text-slate-800 dark:text-slate-200 leading-snug">${hint.text}</p>
        </div>`;
        } else {
            card.innerHTML = `
        <div class="flex flex-col items-center shrink-0 pt-0.5">
          <span class="text-[10px] font-bold text-slate-400">${timeStr}</span>
          <div class="w-px flex-1 bg-slate-200 dark:bg-slate-700 my-1"></div>
          <span class="material-symbols-outlined text-slate-400" style="font-size:16px">lock</span>
        </div>
        <div class="flex items-center flex-1">
          <p class="text-sm text-slate-400 italic">Unlocks in ${formatCountdown(getNextHintMs() + (i - revealed) * 3_600_000)}</p>
        </div>`;
        }
        tl.appendChild(card);
    });

    $('hint-progress-label').textContent =
        `Hint #${Math.min(revealed, 8)} of 8 revealed`;
    renderGuessBar();
}

function renderGuessBar() {
    const left = S.guessesLeft;
    $('guesses-label').textContent = `${left} / ${MAX_GUESSES}`;
    $('guesses-bar').style.width = `${(left / MAX_GUESSES) * 100}%`;
    $('guesses-bar').className = `h-full rounded-full transition-all duration-500 ${left <= 1 ? 'bg-red-500' : left <= 2 ? 'bg-amber-500' : 'bg-primary'}`;
}

function renderGuessHistory() {
    const hist = $('guess-history');
    hist.innerHTML = '';
    S.guesses.forEach((g) => {
        const el = document.createElement('div');
        el.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800';
        el.innerHTML = `<span class="material-symbols-outlined text-red-500" style="font-size:16px">close</span><span class="text-sm font-medium text-red-700 dark:text-red-400">${g}</span>`;
        hist.appendChild(el);
    });
}

// ─────────────────────────────────────────────────
// Guess handling
// ─────────────────────────────────────────────────
function submitGuess() {
    if (S.status !== 'playing') return;
    const input = $('guess-input');
    const raw = input.value.trim();
    if (!raw) return;

    closeAutocomplete();
    const isCorrect = raw.toLowerCase() === S.city.name.toLowerCase();

    if (isCorrect) {
        const guessNum = MAX_GUESSES - S.guessesLeft + 1;
        S.status = 'won';
        S.pendingScore = guessNum;
        updateStatsWin(guessNum);
        saveTodayRecord({ status: 'won', guesses: S.guesses, guessNum });
        input.value = '';
        renderHints();
        showSuccessModal(guessNum);
        promptNameIfNeeded(guessNum);
    } else {
        S.guesses.push(raw);
        S.guessesLeft--;
        input.value = '';
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 400);
        if (S.guessesLeft === 0) {
            S.status = 'lost';
            updateStatsLoss();
            saveTodayRecord({ status: 'lost', guesses: S.guesses });
            renderHints();
            renderGuessHistory();
            openGameOver();
        } else {
            saveTodayRecord({ status: 'playing', guesses: S.guesses });
            renderHints();
            renderGuessHistory();
        }
    }
}

// ─────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────
function updateStatsWin(guessNum) {
    const st = getStats();
    st.played++; st.won++; st.streak++;
    if (st.streak > st.maxStreak) st.maxStreak = st.streak;
    if (st.dist && guessNum >= 1 && guessNum <= 5) st.dist[guessNum - 1]++;
    saveStats(st);
}
function updateStatsLoss() {
    const st = getStats();
    st.played++; st.streak = 0;
    saveStats(st);
}

function renderStats() {
    const st = getStats();
    $('stat-played').textContent = st.played;
    $('stat-winpct').textContent = st.played ? Math.round((st.won / st.played) * 100) : 0;
    $('stat-streak').textContent = st.streak;
    $('stat-maxstreak').textContent = st.maxStreak;

    const dist = st.dist || [0, 0, 0, 0, 0];
    const max = Math.max(...dist, 1);
    $('distribution').innerHTML = dist.map((n, i) => `
    <div class="flex items-center gap-3">
      <span class="text-xs font-bold w-4 text-right text-slate-500">${i + 1}</span>
      <div class="flex-1 h-6 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
        <div class="h-full ${n > 0 ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-700'} flex items-center justify-end px-2 transition-all duration-500"
          style="width:${Math.max((n / max) * 100, n > 0 ? 12 : 0)}%">
          ${n > 0 ? `<span class="text-[10px] font-bold text-white">${n}</span>` : ''}
        </div>
      </div>
    </div>`).join('');
}

// ─────────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────────
async function loadLeaderboard() {
    const list = $('leaderboard-list');
    $('lb-date').textContent = new Date().toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
    list.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">Loading…</div>';

    const rows = await fetchDailyLeaderboard(S.dateStr);
    if (!rows.length) {
        list.innerHTML = '<div class="text-center text-slate-400 py-12 text-sm">No solvers yet today — be the first! 🌍</div>';
        return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = rows.map((r, i) => `
    <div class="flex items-center gap-3 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm">
      <span class="text-lg w-8 text-center">${medals[i] || `#${i + 1}`}</span>
      <div class="flex-1 min-w-0">
        <p class="font-bold text-sm truncate">${r.player_name}</p>
        <p class="text-xs text-slate-400">${new Date(r.solved_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      </div>
      <div class="text-right shrink-0">
        <p class="text-lg font-bold text-primary">${r.score}</p>
        <p class="text-[10px] text-slate-400 uppercase tracking-wide">${r.score === 1 ? 'guess' : 'guesses'}</p>
      </div>
    </div>`).join('');
}

// ─────────────────────────────────────────────────
// Success / Game Over modals
// ─────────────────────────────────────────────────
function showSuccessModal(guessNum) {
    const st = getStats();
    $('success-city-name').textContent = `${S.city.name}, ${S.city.continent}`;
    $('success-attempt').textContent = ORDINALS[guessNum - 1] + ' Try';
    $('success-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('success-streak').textContent = st.streak;
    $('success-maxstreak').textContent = st.maxStreak;
    openModal('modal-success');
    startSuccessCountdown('success-countdown');
}

function openGameOver() {
    $('gameover-city-name').textContent = S.city.name;
    $('gameover-city-type').textContent = `${S.city.type} · ${S.city.continent}`;
    openModal('modal-gameover');
    startSuccessCountdown('gameover-countdown');
}

function startSuccessCountdown(elemId) {
    function tick() {
        const now = new Date();
        const midnight = new Date(now); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
        const ms = midnight - now;
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        $(elemId).textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    tick();
    setInterval(tick, 1000);
}

// ─────────────────────────────────────────────────
// Name prompt & leaderboard submission
// ─────────────────────────────────────────────────
function promptNameIfNeeded(guessNum) {
    if (!S.playerName) {
        setTimeout(() => openModal('modal-name'), 1500);
    } else {
        doSubmitScore(S.playerName, guessNum);
    }
}

async function doSubmitScore(name, score) {
    S.playerName = name.trim() || 'Anonymous';
    localStorage.setItem(NAME_KEY, S.playerName);
    await submitScore(S.playerName, score, S.dateStr);
    const { isFirst, firstSolver } = await checkAndClaimFirstSolver(S.playerName, S.dateStr);
    if (isFirst) showToast(`🏆 You're the FIRST solver today, ${S.playerName}!`, 5000);
}

// ─────────────────────────────────────────────────
// Autocomplete
// ─────────────────────────────────────────────────
function renderAutocomplete(query) {
    const list = $('autocomplete-list');
    if (query.length < 2) { list.classList.add('hidden'); return; }
    const matches = S.allNames.filter((n) => n.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6);
    if (!matches.length) { list.classList.add('hidden'); return; }
    list.innerHTML = matches.map((n) =>
        `<div class="px-4 py-3 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer border-b border-slate-100 dark:border-slate-700 last:border-0 transition-colors" data-city="${n}">${n}</div>`
    ).join('');
    list.classList.remove('hidden');
}
function closeAutocomplete() { $('autocomplete-list').classList.add('hidden'); }

// ─────────────────────────────────────────────────
// Share result
// ─────────────────────────────────────────────────
function buildShareText(won) {
    const st = getStats();
    const boxes = won
        ? '🟩'.repeat(MAX_GUESSES - S.guessesLeft) + '⬜'.repeat(S.guessesLeft)
        : '🟥'.repeat(MAX_GUESSES);
    return `Pinpoint ${S.dateStr}\n${won ? `${MAX_GUESSES - S.guessesLeft + 1}/${MAX_GUESSES}` : 'X/5'} ${S.city.name}\n${boxes}\nStreak: ${st.streak} 🔥\npinpoint.app`;
}
async function shareResult(won) {
    const text = buildShareText(won);
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (_) { } }
    await navigator.clipboard.writeText(text).catch(() => { });
    showToast('Result copied to clipboard!');
}

// ─────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────
function renderSettings() {
    $('settings-name').value = S.playerName;
}

// ─────────────────────────────────────────────────
// Hint reveal timer
// ─────────────────────────────────────────────────
function startHintTimer() {
    function updateCountdown() {
        const ms = getNextHintMs();
        const newCount = getHintsRevealedCount();
        $('next-hint-countdown').textContent = formatCountdown(ms);
        if (newCount > S.hintsRevealed) {
            S.hintsRevealed = newCount;
            renderHints();
        }
        if (newCount >= 8) $('next-hint-badge').classList.add('hidden');
    }
    updateCountdown();
    setInterval(updateCountdown, 10_000); // refresh every 10s
}

// ─────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────
async function init() {
    initDark();
    initSupabase();

    try {
        const [locRes, hintRes] = await Promise.all([
            fetch('./Databases/locations_database.json'),
            fetch('./Databases/hints_database.json'),
        ]);
        const { locations } = await locRes.json();
        const { hints } = await hintRes.json();

        S.allNames = locations.map((l) => l.name);
        S.dateStr = getDateString();
        S.city = getDailyCity(locations);
        S.hints = buildHints(S.city, hints);
        S.playerName = localStorage.getItem(NAME_KEY) || '';

        // Restore today's progress
        const saved = getTodayRecord();
        if (saved) {
            S.guesses = saved.guesses || [];
            S.guessesLeft = MAX_GUESSES - S.guesses.length;
            S.status = saved.status || 'playing';
        }

        S.hintsRevealed = getHintsRevealedCount();

        // Realtime — first-solver notifications
        subscribeToFirstSolver(S.dateStr, (solverName) => {
            if (solverName !== S.playerName) showToast(`🏆 ${solverName} just cracked today's puzzle!`);
        });

        // Render initial state
        renderHints();
        renderGuessHistory();
        startHintTimer();

        if (S.status === 'won') setTimeout(() => showSuccessModal(getTodayRecord()?.guessNum || 1), 600);
        if (S.status === 'lost') setTimeout(() => openGameOver(), 600);
    } catch (err) {
        console.error('[Pinpoint] Init failed:', err);
    }

    $('loading').style.opacity = '0';
    $('loading').style.transition = 'opacity .4s';
    setTimeout(() => $('loading').classList.add('hidden'), 400);
}

// ─────────────────────────────────────────────────
// Event listeners (wired after DOM ready)
// ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Nav buttons
    document.querySelectorAll('.nav-btn').forEach((b) =>
        b.addEventListener('click', () => switchNav(b.dataset.nav))
    );
    document.querySelectorAll('.nav-back').forEach((b) =>
        b.addEventListener('click', () => switchNav('game'))
    );

    // Header buttons
    $('btn-open-stats').addEventListener('click', () => switchNav('stats'));
    $('btn-open-howtoplay').addEventListener('click', () => {
        const midnight = new Date(); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
        $('howtoplay-nextcity').textContent = `Next city in ${formatCountdown(midnight - new Date())}`;
        openModal('modal-howtoplay');
    });

    // Modal close buttons
    $('btn-close-howtoplay').addEventListener('click', () => closeModal('modal-howtoplay'));
    $('overlay').addEventListener('click', () => {
        ['modal-howtoplay', 'modal-success', 'modal-gameover'].forEach(closeModal);
    });

    // Guess input
    $('guess-btn').addEventListener('click', submitGuess);
    $('guess-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGuess(); });
    $('guess-input').addEventListener('input', (e) => renderAutocomplete(e.target.value));
    $('guess-input').addEventListener('blur', () => setTimeout(closeAutocomplete, 150));
    $('autocomplete-list').addEventListener('click', (e) => {
        const city = e.target.closest('[data-city]')?.dataset.city;
        if (city) { $('guess-input').value = city; closeAutocomplete(); }
    });

    // Share buttons
    $('btn-share-result').addEventListener('click', () => shareResult(true));
    $('btn-share-gameover').addEventListener('click', () => shareResult(false));
    $('btn-share-stats').addEventListener('click', () => {
        const st = getStats();
        const text = `My Pinpoint Stats 🌍\nPlayed: ${st.played} | Win%: ${st.played ? Math.round((st.won / st.played) * 100) : 0}\nStreak: ${st.streak} 🔥 | Best: ${st.maxStreak}`;
        if (navigator.share) { navigator.share({ text }).catch(() => { }); }
        else { navigator.clipboard.writeText(text).then(() => showToast('Stats copied!')); }
    });

    // Leaderboard refresh
    $('btn-refresh-lb').addEventListener('click', loadLeaderboard);

    // Name entry modal
    $('btn-submit-name').addEventListener('click', () => {
        const n = $('name-input').value.trim();
        if (!n) return;
        closeModal('modal-name');
        doSubmitScore(n, S.pendingScore);
    });
    $('btn-skip-name').addEventListener('click', () => {
        closeModal('modal-name');
        doSubmitScore('Anonymous', S.pendingScore);
    });

    // Settings
    $('btn-save-name').addEventListener('click', () => {
        const n = $('settings-name').value.trim();
        if (n) { S.playerName = n; localStorage.setItem(NAME_KEY, n); showToast('Name saved!'); }
    });
    $('btn-dark-toggle').addEventListener('click', () =>
        applyDark(!document.documentElement.classList.contains('dark'))
    );

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[SW]', e));
    }

    // Show how-to-play on very first visit
    if (!localStorage.getItem(STATS_KEY)) openModal('modal-howtoplay');

    init();
});
