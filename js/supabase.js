/**
 * supabase.js — All cloud/database operations.
 * Imports the Supabase JS client via CDN ESM.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://hbcrjxigytzxuhfwqume.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiY3JqeGlneXR6eHVoZndxdW1lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1OTEwMzEsImV4cCI6MjA4ODE2NzAzMX0.4jcRsRyMTjztDAeZ57b_38PD2fzIOizacMdUGfQ6F1Y';

let _client = null;

/** Returns (and lazily creates) the singleton Supabase client. */
export function initSupabase() {
    if (!_client) {
        _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            realtime: { params: { eventsPerSecond: 5 } },
        });
    }
    return _client;
}

// ─────────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────────

/**
 * Push a player's winning score to the leaderboard.
 * @param {string} playerName
 * @param {number} score  — number of guesses used (1 = first try)
 * @param {string} date   — "YYYY-MM-DD"
 */
export async function submitScore(playerName, score, date) {
    const supabase = initSupabase();
    const { error } = await supabase
        .from('leaderboard')
        .insert({ player_name: playerName.trim(), score, puzzle_date: date });

    if (error) console.error('[Pinpoint] submitScore error:', error.message);
    return !error;
}

/**
 * Fetch today's top 10 leaderboard entries.
 * Sorted by fewest guesses, then earliest solve time.
 * @param {string} date — "YYYY-MM-DD"
 * @returns {Array<{player_name, score, solved_at}>}
 */
export async function fetchDailyLeaderboard(date) {
    const supabase = initSupabase();
    const { data, error } = await supabase
        .from('leaderboard')
        .select('player_name, score, solved_at')
        .eq('puzzle_date', date)
        .order('score', { ascending: true })
        .order('solved_at', { ascending: true })
        .limit(10);

    if (error) {
        console.error('[Pinpoint] fetchDailyLeaderboard error:', error.message);
        return [];
    }
    return data ?? [];
}

// ─────────────────────────────────────────────────
// First-solver flag
// ─────────────────────────────────────────────────

/**
 * Attempts to claim the "first solver" flag for today.
 * Strategy:
 *   1. Try to INSERT a new row (succeeds only if this is the very first solver).
 *   2. If the row already exists, try to UPDATE where solved=false (race-condition safe).
 *   3. Read back the row to return who the actual first solver is.
 *
 * @returns {{ isFirst: boolean, firstSolver: string|null }}
 */
export async function checkAndClaimFirstSolver(playerName, date) {
    const supabase = initSupabase();
    const name = playerName.trim() || 'Anonymous';

    // Step 1 — try to create today's row as the first solver
    const { error: insertError } = await supabase
        .from('daily_meta')
        .insert({ puzzle_date: date, solved: true, first_solver: name });

    if (!insertError) {
        // We created the row — we are definitively first
        return { isFirst: true, firstSolver: name };
    }

    // Step 2 — row exists; try to claim it if not yet solved
    const { data: updated, error: updateError } = await supabase
        .from('daily_meta')
        .update({ solved: true, first_solver: name })
        .eq('puzzle_date', date)
        .eq('solved', false)
        .select('first_solver');

    if (!updateError && updated && updated.length > 0) {
        return { isFirst: true, firstSolver: name };
    }

    // Step 3 — already solved; read who got there first
    const { data: meta } = await supabase
        .from('daily_meta')
        .select('first_solver')
        .eq('puzzle_date', date)
        .single();

    return { isFirst: false, firstSolver: meta?.first_solver ?? null };
}

// ─────────────────────────────────────────────────
// Realtime subscription
// ─────────────────────────────────────────────────

/**
 * Subscribe to Postgres changes on daily_meta for today.
 * Fires callback(firstSolverName) when another player solves the puzzle.
 *
 * @param {string} date
 * @param {(name: string) => void} callback
 * @returns The Supabase RealtimeChannel (call .unsubscribe() to clean up)
 */
export function subscribeToFirstSolver(date, callback) {
    const supabase = initSupabase();

    return supabase
        .channel(`daily_meta_${date}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'daily_meta',
                filter: `puzzle_date=eq.${date}`,
            },
            (payload) => {
                if (payload.new?.solved && payload.new?.first_solver) {
                    callback(payload.new.first_solver);
                }
            }
        )
        .subscribe();
}

/**
 * Subscribe to Postgres changes on leaderboard for today.
 * Fires callback() when a new score is added or updated.
 *
 * @param {string} date
 * @param {() => void} callback
 * @returns The Supabase RealtimeChannel
 */
export function subscribeToLeaderboard(date, callback) {
    const supabase = initSupabase();

    return supabase
        .channel(`leaderboard_${date}`)
        .on(
            'postgres_changes',
            {
                event: '*', // Listen for INSERT, UPDATE, DELETE
                schema: 'public',
                table: 'leaderboard',
                filter: `puzzle_date=eq.${date}`,
            },
            () => {
                callback();
            }
        )
        .subscribe();
}

// ─────────────────────────────────────────────────
// Push Notifications
// ─────────────────────────────────────────────────

/**
 * Saves a Web Push subscription to the database.
 * @param {object} subscription — The PushSubscription object
 */
export async function savePushSubscription(subscription) {
    const supabase = initSupabase();
    const { error } = await supabase
        .from('push_subscriptions')
        .upsert({
            subscription: subscription,
            updated_at: new Date().toISOString()
        }, { on_conflict: 'subscription' });

    if (error) console.error('[Pinpoint] savePushSubscription error:', error.message);
    return !error;
}

/**
 * Syncs the day's hints to daily_meta so the Edge Function can send 
 * them in push notifications.
 * @param {string} date
 * @param {string[]} hints - Array of 8 hint strings
 */
export async function syncDailyHints(date, hints) {
    const supabase = initSupabase();
    // Use upsert to create or update today's metadata with the hint strings
    const { error } = await supabase
        .from('daily_meta')
        .upsert({ puzzle_date: date, hints: hints }, { on_conflict: 'puzzle_date' });
    if (error) console.error('[Pinpoint] syncDailyHints error:', error.message);
    return !error;
}

// ─────────────────────────────────────────────────
// Auth & User Data Sync
// ─────────────────────────────────────────────────

/**
 * Sign up a new user with email and password.
     */
export async function signUpWithEmail(email, password) {
    const supabase = initSupabase();
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
    });
    if (error) {
        console.error('[Pinpoint] signUp error:', error.message);
        return { success: false, error: error.message };
    }
    return { success: true, data };
}

/**
 * Sign in an existing user.
 */
export async function signInWithEmail(email, password) {
    const supabase = initSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });
    if (error) {
        console.error('[Pinpoint] signIn error:', error.message);
        return { success: false, error: error.message };
    }
    return { success: true, data };
}

/**
 * Sign out the current user.
 */
export async function signOutUser() {
    const supabase = initSupabase();
    const { error } = await supabase.auth.signOut();
    if (error) console.error('[Pinpoint] signOut error:', error.message);
}

/**
 * Get the current active session.
 */
export async function getCurrentSession() {
    const supabase = initSupabase();
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) console.error('[Pinpoint] getSession error:', error.message);
    return session;
}

/**
 * Listen for auth state changes (e.g., login, logout).
 */
export function onAuthStateChange(callback) {
    const supabase = initSupabase();
    return supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

/**
 * Sync local stats and name up to the user's Supabase metadata.
 */
export async function syncUserData(stats, playerName) {
    const supabase = initSupabase();
    const session = await getCurrentSession();
    if (!session) return false;

    const { error } = await supabase.auth.updateUser({
        data: {
            pinpoint_stats: stats,
            pinpoint_name: playerName
        }
    });

    if (error) {
        console.error('[Pinpoint] syncUserData error:', error.message);
        return false;
    }
    return true;
}
