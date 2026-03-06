/**
 * game.js — Main game controller for Pinpoint.
 * Imports pure logic from daily.js and cloud ops from supabase.js.
 */

import {
    getDailyCity, buildHints, getDateString,
    getHintsRevealedCount, getNextHintMs, formatCountdown,
    IS_SPEED_ROUND,
} from './daily.js';
import {
    initSupabase, submitScore, fetchDailyLeaderboard,
    checkAndClaimFirstSolver, subscribeToFirstSolver, subscribeToLeaderboard,
    savePushSubscription, syncDailyHints
} from './supabase.js';

// ─────────────────────────────────────────────────
// Constants & Storage keys
// ─────────────────────────────────────────────────
const MAX_GUESSES = 5;
const STATS_KEY = 'pinpoint_stats';
const TODAY_KEY = 'pinpoint_today';
const NAME_KEY = 'pinpoint_name';
const DARK_KEY = 'pinpoint_dark';
const PUSH_VAPID_PUBLIC_KEY = 'BEozc8-rcMqA_Xmo-ZO8dbRvPc3gGQoO5php-rPRDlc0OZtXHWmIfMFZEXQwkn8QheWvb2iEc4D3XBM3LYeL5pc';

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
function saveTodayRecord(r) {
    if (IS_SPEED_ROUND) return;
    localStorage.setItem(TODAY_KEY, JSON.stringify({ ...r, date: S.dateStr }));
}

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

    if (IS_SPEED_ROUND) {
        const titleEl = document.querySelector('header h1');
        if (titleEl && !titleEl.innerHTML.includes('SPEED')) {
            titleEl.innerHTML = 'Pinpoint <span class="text-[10px] bg-amber-500 text-white px-1.5 py-0.5 rounded-full ml-1 align-middle">SPEED</span>';
        }
    }

    if (revealed === 0) {
        tl.innerHTML = `
      <div class="flex flex-col items-center justify-center p-8 text-center border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl bg-slate-50/50 dark:bg-slate-900/20">
        <span class="material-symbols-outlined text-slate-300 dark:text-slate-700 mb-3" style="font-size:48px">schedule</span>
        <h3 class="text-sm font-bold text-slate-500 uppercase tracking-wider mb-1">Hints starting soon</h3>
        <p class="text-xs text-slate-400">The first hint unlocks at 8:00 AM</p>
      </div>`;
    }

    S.hints.forEach((hint, i) => {
        if (revealed === 0) return;
        const isRevealed = i < revealed;
        const hour = new Date(); hour.setHours(8 + i, 0, 0, 0);
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
        const target = new Date(now);
        target.setUTCHours(15, 0, 0, 0); // 7:00 AM PST
        if (target <= now) target.setUTCDate(target.getUTCDate() + 1);

        const ms = target - now;
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

    if (isFirst) {
        showToast(`🏆 You're the FIRST solver today, ${S.playerName}!`, 5000);
        // Trigger global push notification for the first solver
        fetch('https://hbcrjxigytzxuhfwqume.supabase.co/functions/v1/send-push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                title: 'First Solver! 🥇',
                body: `🏆 ${S.playerName} just cracked today's puzzle!`
            })
        }).catch(err => console.error('[Push] Failed to trigger first solver notification:', err));
    }
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
    const score = won ? `${MAX_GUESSES - S.guessesLeft}` : 'X';
    return `Pinpoint ${S.dateStr}\n${score}/${MAX_GUESSES}\n${boxes}\nStreak: ${st.streak} 🔥\nhttps://mccliam.github.io/pinpoint/`;
}
async function shareResult(won) {
    const text = buildShareText(won);
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (_) { } }
    await navigator.clipboard.writeText(text).catch(() => { });
    showToast('Result copied to clipboard!');
}

// ─────────────────────────────────────────────────
// Weather
// ─────────────────────────────────────────────────
async function fetchWeather(cityName) {
    try {
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`);
        const geoData = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) return;
        const { latitude, longitude } = geoData.results[0];

        const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`);
        const weatherData = await weatherRes.json();
        if (!weatherData.current) return;

        const temp = Math.round(weatherData.current.temperature_2m);
        const code = weatherData.current.weather_code;

        $('weather-temp').textContent = `${temp}°C`;
        $('weather-display').classList.remove('hidden');

        const weatherMap = {
            0: { icon: 'sunny', desc: 'Clear' },
            1: { icon: 'partly_cloudy_day', desc: 'Mainly Clear' },
            2: { icon: 'partly_cloudy_day', desc: 'Partly Cloudy' },
            3: { icon: 'cloud', desc: 'Overcast' },
            45: { icon: 'foggy', desc: 'Foggy' },
            51: { icon: 'rainy', desc: 'Drizzle' },
            61: { icon: 'rainy', desc: 'Rain' },
            71: { icon: 'ac_unit', desc: 'Snow' },
            95: { icon: 'thunderstorm', desc: 'Thunderstorm' },
        };

        let info = weatherMap[code];
        if (!info) {
            if (code >= 1 && code <= 3) info = weatherMap[1];
            else if (code >= 51 && code <= 67) info = weatherMap[61];
            else if (code >= 71 && code <= 77) info = weatherMap[71];
            else if (code >= 80 && code <= 82) info = weatherMap[80] || weatherMap[61];
            else info = { icon: 'device_thermostat', desc: 'Weather' };
        }

        $('weather-icon').textContent = info.icon;
        $('weather-desc').textContent = info.desc;
    } catch (err) {
        console.warn('[Weather] Fetch failed:', err);
    }
}

// ─────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────
function renderSettings() {
    $('settings-name').value = S.playerName;
    updatePushToggleUI();
}

function updatePushToggleUI() {
    const active = Notification.permission === 'granted';
    const btn = $('btn-push-toggle');
    btn.classList.toggle('bg-primary', active);
    btn.querySelector('span').classList.toggle('translate-x-6', active);
}

async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        showToast('Push not supported on this device/browser');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showToast('Notification permission denied');
            return;
        }

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: PUSH_VAPID_PUBLIC_KEY
        });

        const success = await savePushSubscription(subscription);
        if (success) {
            showToast('Lock screen notifications enabled! 🔔');
            updatePushToggleUI();
        } else {
            showToast('Failed to save subscription to server');
        }
    } catch (err) {
        console.error('[Pinpoint] Push subscription error:', err);
        showToast('Error enabling notifications');
    }
}

// ─────────────────────────────────────────────────
// Hint reveal timer
// ─────────────────────────────────────────────────
function startHintTimer() {
    function updateCountdown() {
        const ms = getNextHintMs();
        const newCount = getHintsRevealedCount();

        if (newCount >= 8) {
            $('next-hint-countdown').textContent = 'Next city tonight';
            $('next-hint-badge').classList.add('opacity-50');
        } else {
            $('next-hint-countdown').textContent = formatCountdown(ms);
            $('next-hint-badge').classList.remove('opacity-50');
        }

        if (newCount > S.hintsRevealed) {
            S.hintsRevealed = newCount;
            renderHints();
        }
        if (newCount >= 8) $('next-hint-badge').classList.add('hidden');

        // Auto-refresh city in speed round if 2-minute block changes
        if (IS_SPEED_ROUND) {
            const currentBlock = Math.floor(Date.now() / 120000);
            if (!S._lastBlock) S._lastBlock = currentBlock;
            if (currentBlock !== S._lastBlock) window.location.reload();
        }
    }
    updateCountdown();
    setInterval(updateCountdown, IS_SPEED_ROUND ? 1000 : 10000); // refresh every 1s in speed round
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

        // Sync hints to Supabase for the push notification service
        syncDailyHints(S.dateStr, S.hints);

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

        // Realtime — leaderboard updates
        subscribeToLeaderboard(S.dateStr, () => {
            // Only reload if they are actively looking at the leaderboard
            if ($('screen-leaderboard').classList.contains('active')) {
                loadLeaderboard();
            }
        });

        // Render initial state
        renderHints();
        renderGuessHistory();
        startHintTimer();
        fetchWeather(S.city.name);

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
        const now = new Date();
        const target = new Date(now);
        target.setUTCHours(15, 0, 0, 0); // 7:00 AM PST
        if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
        $('howtoplay-nextcity').textContent = `Next city in ${formatCountdown(target - now)}`;
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
    $('btn-push-toggle').addEventListener('click', subscribeToPush);

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[SW]', e));
    }

    // Show how-to-play on very first visit
    if (!localStorage.getItem(STATS_KEY)) openModal('modal-howtoplay');

    // Prevent zooming on iOS (pinch-to-zoom)
    document.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    init();
});
