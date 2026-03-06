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
    savePushSubscription, deletePushSubscription, syncDailyHints,
    signUpWithEmail, signInWithEmail, signOutUser, getCurrentSession, onAuthStateChange, syncUserData, syncDailyProgress
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
    hintsRevealed: 0, hintsViewed: 1, dateStr: '', hintTimerRef: null,
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
    const record = { ...r, date: S.dateStr, hintsViewed: S.hintsViewed };
    localStorage.setItem(TODAY_KEY, JSON.stringify(record));
    syncDailyProgress(record);
}

// ─────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function showOverlay() { $('overlay').classList.add('open'); }
function hideOverlay() { $('overlay').classList.remove('open'); }
function openModal(id) { showOverlay(); $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); hideOverlay(); }

function updateInputVisibility() {
    const isPlaying = S.status === 'playing';
    const playingArea = $('input-area-playing');
    const completedArea = $('input-area-completed');
    if (playingArea && completedArea) {
        playingArea.classList.toggle('hidden', !isPlaying);
        completedArea.classList.toggle('hidden', isPlaying);

        const guessesContainer = $('guesses-container');
        if (guessesContainer) {
            guessesContainer.classList.toggle('hidden', !isPlaying);
        }

        if (!isPlaying) {
            const msg = $('input-completed-msg');
            if (msg) {
                msg.textContent = S.status === 'won' ? 'You already won! 🏆' : 'Try again tomorrow! 🍀';
            }
        }
    }
}

function getTimeUntilNextCityMs() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(15, 0, 0, 0); // 15:00 UTC = 7:00 AM PST
    if (now >= next) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next - now;
}

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
    const revealed = S.hintsRevealed;
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
            const hasViewed = i < S.hintsViewed;
            const diffClass = DIFF_STYLE[hint.difficulty] || '';

            if (hasViewed) {
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
            } else if (S.status === 'playing') {
                // Unlocked but not viewed, and still playing
                card.innerHTML = `
        <div class="flex flex-col items-center shrink-0 pt-0.5">
          <span class="text-[10px] font-bold text-slate-400">${timeStr}</span>
          <div class="w-px flex-1 bg-slate-200 dark:bg-slate-700 my-1"></div>
          <span class="material-symbols-outlined text-primary" style="font-size:16px">lock_open</span>
        </div>
        <div class="flex items-center flex-1">
           <button class="btn-reveal-hint border border-primary/30 bg-primary/10 text-primary font-bold text-xs py-2 px-4 rounded-lg active:scale-95 transition-all w-full">
               Reveal Hint (-500 pts)
           </button>
        </div>`;
            } else {
                // Unlocked but not viewed, and game is over
                card.innerHTML = `
        <div class="flex flex-col items-center shrink-0 pt-0.5">
          <span class="text-[10px] font-bold text-slate-400">${timeStr}</span>
          <div class="w-px flex-1 bg-slate-200 dark:bg-slate-700 my-1"></div>
          <span class="material-symbols-outlined text-slate-400" style="font-size:16px">lock_clock</span>
        </div>
        <div class="flex items-center flex-1">
          <p class="text-sm text-slate-400 italic">Game finished — Reveal locked</p>
        </div>`;
            }
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

    // Attach listener to reveal buttons
    tl.querySelectorAll('.btn-reveal-hint').forEach((btn) => {
        btn.addEventListener('click', () => {
            S.hintsViewed++;
            saveTodayRecord({ status: S.status, guesses: S.guesses });
            renderHints();
        });
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
function calculatePoints(guessNum) {
    const base = 10000;
    const guessPenalty = (guessNum - 1) * 500;
    const hintPenalty = Math.max(0, S.hintsViewed - 1) * 500;

    // Time penalty: -1 point per 10 seconds since 7:00 AM PST
    const now = new Date();
    const boundaries = new Date(now);
    boundaries.setUTCHours(15, 0, 0, 0); // 7:00 AM PST (15:00 UTC)
    if (now < boundaries) boundaries.setUTCDate(boundaries.getUTCDate() - 1);

    const secondsSinceReset = Math.floor((now - boundaries) / 1000);
    const timePenalty = Math.max(0, Math.floor(secondsSinceReset / 10));

    return Math.max(0, base - guessPenalty - hintPenalty - timePenalty);
}

function submitGuess() {
    if (S.status !== 'playing') return;
    const input = $('guess-input');
    const raw = input.value.trim();
    if (!raw) return;

    closeAutocomplete();
    const isCorrect = raw.toLowerCase() === S.city.name.toLowerCase();

    if (isCorrect) {
        const guessNum = MAX_GUESSES - S.guessesLeft + 1;
        const points = calculatePoints(guessNum);
        S.status = 'won';
        S.pendingScore = points;
        updateStatsWin(guessNum);
        saveTodayRecord({ status: 'won', guesses: S.guesses, guessNum, points });
        input.value = '';
        renderHints();
        showSuccessModal(guessNum, points);
        promptNameIfNeeded(points);
        updateInputVisibility();
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
            updateInputVisibility();
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
    syncUserData(st, S.playerName);
}
function updateStatsLoss() {
    const st = getStats();
    st.played++; st.streak = 0;
    saveStats(st);
    syncUserData(st, S.playerName);
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
    const lbDate = $('lb-date');
    const list = $('leaderboard-list');
    lbDate.textContent = 'Loading...';
    list.innerHTML = '<div class="flex justify-center p-8"><div class="w-8 h-8 rounded-full border-4 border-slate-200 dark:border-slate-800 border-t-primary animate-spin"></div></div>';

    fetchDailyLeaderboard(S.dateStr).then((data) => {
        lbDate.textContent = S.dateStr;
        list.innerHTML = '';
        if (data.length === 0) {
            list.innerHTML = '<div class="text-center p-8 text-slate-500 text-sm">No one has solved it yet today.<br>Be the first!</div>';
            return;
        }
        data.forEach((entry, i) => {
            const isMe = entry.player_name === S.playerName;
            const timeStr = new Date(entry.solved_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const html = `
        <div class="flex items-center gap-3 p-3 rounded-xl border ${isMe ? 'bg-primary/5 border-primary/30 ring-1 ring-primary/20' : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800'
                }">
          <div class="w-8 h-8 flex items-center justify-center font-bold text-sm ${i === 0 ? 'text-amber-500 bg-amber-50 dark:bg-amber-500/10 rounded-full'
                    : i === 1 ? 'text-slate-400 bg-slate-50 dark:bg-slate-400/10 rounded-full'
                        : i === 2 ? 'text-orange-400 bg-orange-50 dark:bg-orange-400/10 rounded-full'
                            : 'text-slate-400'
                }">${i + 1}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-bold text-sm truncate ${isMe ? 'text-primary' : ''}">${entry.player_name}</span>
              ${isMe ? '<span class="text-[10px] font-bold bg-primary text-white px-1.5 py-0.5 rounded-full uppercase tracking-widest">You</span>' : ''}
            </div>
            <div class="text-[11px] font-medium text-slate-500 mt-0.5 flex items-center gap-2">
              <span>${timeStr}</span>
            </div>
          </div>
          <div class="text-right shrink-0 px-2">
            <div class="font-bold text-lg leading-none">${entry.score}</div>
            <div class="text-[10px] font-bold uppercase tracking-widest text-slate-400">Pts</div>
          </div>
        </div>`;
            list.insertAdjacentHTML('beforeend', html);
        });
    });
}

// ─────────────────────────────────────────────────
// Success / Game Over modals
// ─────────────────────────────────────────────────
function showSuccessModal(guessNum, points) {
    if (!points) {
        // Fallback calculation for older clients reading local storage
        points = calculatePoints(guessNum);
    }
    const st = getStats();
    $('success-city-name').textContent = S.city.name;
    $('success-points').textContent = points.toLocaleString();
    $('success-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('success-streak').textContent = st.streak;
    $('success-maxstreak').textContent = st.maxStreak;
    openModal('modal-success');
    startPostGameCountdown('success-countdown');
}

function openGameOver() {
    $('gameover-city-name').textContent = S.city.name;
    $('gameover-city-type').textContent = `${S.city.type} · ${S.city.continent}`;
    openModal('modal-gameover');
    startPostGameCountdown('gameover-countdown');
}

function startPostGameCountdown(elemId) {
    if (S.countdownRef) clearInterval(S.countdownRef);
    const tick = () => {
        const ms = getTimeUntilNextCityMs();
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const str = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

        if ($(elemId)) $(elemId).textContent = str;
        if ($('input-countdown')) $('input-countdown').textContent = str;
    };
    tick();
    S.countdownRef = setInterval(tick, 1000);
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

async function updatePushToggleUI() {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    const active = !!sub;
    const btn = $('btn-push-toggle');
    if (btn) {
        btn.classList.toggle('bg-primary', active);
        btn.querySelector('span').classList.toggle('translate-x-6', active);
    }
}

async function togglePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        showToast('Push not supported on this device/browser');
        return;
    }

    try {
        const registration = await navigator.serviceWorker.ready;
        const existingSub = await registration.pushManager.getSubscription();

        if (existingSub) {
            // Already subscribed, so turn it OFF
            const { success, error } = await deletePushSubscription(existingSub.endpoint);
            if (success) {
                await existingSub.unsubscribe();
                showToast('Lock screen notifications disabled');
                updatePushToggleUI();
            } else {
                showToast(`Server error: ${error}`);
            }
        } else {
            // Not subscribed, so turn it ON
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                showToast('Notification permission denied');
                return;
            }

            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: PUSH_VAPID_PUBLIC_KEY
            });

            const { success, error } = await savePushSubscription(subscription);
            if (success) {
                showToast('Lock screen notifications enabled! 🔔');
                updatePushToggleUI();
            } else {
                // If DB save fails, cleanup the browser subscription
                await subscription.unsubscribe();
                showToast(`Server error: ${error}`);
                updatePushToggleUI();
            }
        }
    } catch (err) {
        console.error('[Pinpoint] Push toggle error:', err);
        showToast('Error toggling notifications');
    }
}

async function sendTestNotification() {
    showToast('Sending test notification...');
    try {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (!sub) return showToast('Please enable notifications first');

        const response = await fetch('https://hbcrjxigytzxuhfwqume.supabase.co/functions/v1/send-push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                title: 'Test Notification 🎯',
                body: 'It works! You will now receive hints on your lock screen.'
            })
        });

        if (response.ok) {
            showToast('Test notification sent!');
        } else {
            const errorData = await response.text();
            console.error('[Push] Test failed:', response.status, errorData);
            showToast(`Fail: ${response.status} - ${errorData.substring(0, 30)}`);
        }
    } catch (err) {
        console.error('[Push] Test exception:', err);
        showToast(`Error: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────
// Auth & Sync
// ─────────────────────────────────────────────────
function initAuth() {
    onAuthStateChange(async (event, session) => {
        if (session && session.user) {
            // Logged in
            $('auth-logged-out').classList.add('hidden');
            $('auth-logged-in').classList.remove('hidden');
            $('auth-current-email').textContent = session.user.email;

            // Merge stats on sign in or init if available
            const meta = session.user.user_metadata || {};
            let local = getStats();
            let changed = false;

            if (meta.pinpoint_stats && meta.pinpoint_stats.played > local.played) {
                saveStats(meta.pinpoint_stats);
                changed = true;
            }
            if (meta.pinpoint_name && meta.pinpoint_name !== S.playerName) {
                S.playerName = meta.pinpoint_name;
                localStorage.setItem(NAME_KEY, S.playerName);
                $('settings-name').value = S.playerName;
                changed = true;
            }

            // Check daily progress
            const localToday = getTodayRecord();
            const cloudToday = meta.pinpoint_today;

            if (cloudToday && cloudToday.date === S.dateStr) {
                const localGuesses = localToday ? (localToday.guesses?.length || 0) : 0;
                const cloudGuesses = cloudToday.guesses?.length || 0;
                const cloudStatus = cloudToday.status || 'playing';

                // FORCE RESTORE if cloud is ahead OR cloud is finished (even if local is same count)
                if (cloudGuesses > localGuesses || (cloudStatus !== 'playing' && (!localToday || localToday.status === 'playing'))) {
                    localStorage.setItem(TODAY_KEY, JSON.stringify(cloudToday));
                    window.location.reload();
                    return;
                } else if (localGuesses > cloudGuesses) {
                    syncDailyProgress(localToday);
                }
            }

            // If local stats was actually ahead, sync it back up
            if (local.played > (meta.pinpoint_stats?.played || 0)) {
                syncUserData(local, S.playerName);
            }

            if (changed) {
                renderStats(); // re-render if we grabbed cloud stats
            }
        } else {
            // Logged out
            $('auth-logged-in').classList.add('hidden');
            $('auth-logged-out').classList.remove('hidden');
        }
    });

    $('btn-signup').addEventListener('click', async () => {
        const e = $('auth-email').value.trim();
        const p = $('auth-password').value.trim();
        if (!e || !p) return showToast('Enter email and password');
        $('btn-signup').textContent = '...';
        const { success, error } = await signUpWithEmail(e, p);
        $('btn-signup').textContent = 'Sign Up';
        if (success) {
            showToast('Account created! You are logged in.');
            syncUserData(getStats(), S.playerName); // Push initial stats
            $('auth-email').value = '';
            $('auth-password').value = '';
        }
        else showToast(error || 'Sign up failed');
    });

    $('btn-login').addEventListener('click', async () => {
        const e = $('auth-email').value.trim();
        const p = $('auth-password').value.trim();
        if (!e || !p) return showToast('Enter email and password');
        $('btn-login').textContent = '...';
        const { success, error } = await signInWithEmail(e, p);
        $('btn-login').textContent = 'Log In';
        if (success) {
            showToast('Logged in successfully!');
            $('auth-email').value = '';
            $('auth-password').value = '';
        }
        else showToast(error || 'Login failed');
    });

    $('btn-logout').addEventListener('click', async () => {
        await signOutUser();
        showToast('Logged out');
    });
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
            S.hintsViewed = saved.hintsViewed || 1;
        }

        S.hintsRevealed = getHintsRevealedCount();

        // Realtime — first-solver notifications
        subscribeToFirstSolver(S.dateStr, (solverName) => {
            if (solverName !== S.playerName) showToast(`🏆 ${solverName} just cracked today's puzzle!`);
        });

        // Auth
        initAuth();

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
        updatePushToggleUI();
        updateInputVisibility();

        if (S.status === 'won' || S.status === 'lost') {
            updateInputVisibility();
            startPostGameCountdown(); // updates input-countdown
        }

        if (S.status === 'won') setTimeout(() => showSuccessModal(getTodayRecord()?.guessNum || 1, getTodayRecord()?.points), 600);
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
        if (n) {
            S.playerName = n;
            localStorage.setItem(NAME_KEY, n);
            showToast('Name saved!');
            syncUserData(getStats(), n);
        }
    });
    $('btn-dark-toggle').addEventListener('click', () =>
        applyDark(!document.documentElement.classList.contains('dark'))
    );
    $('btn-push-toggle').addEventListener('click', togglePush);
    $('btn-push-test').addEventListener('click', sendTestNotification);

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
