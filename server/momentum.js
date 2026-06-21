// momentum.js
// Core real-data signal derivation. NO randomness here. Everything is computed
// deterministically from the ESPN commentary/keyEvents timeline.
//
// Each event is assigned a signed "thrust" toward the team that performed it,
// weighted by danger. Positive = home attacking, negative = away attacking.
// momentum(t) = exponentially time-decayed running sum of thrusts up to match
// time t, with a half-life of ~4 minutes, then squashed to roughly [-1, 1].

export const HALF_LIFE_SECONDS = 4 * 60; // 4 minutes
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_SECONDS; // exp decay constant
const SQUASH_SCALE = 8; // tanh divisor — tunes how quickly momentum saturates

// Map an ESPN play-type string -> { base thrust magnitude, sign convention }.
// `sign` is +1 when the thrust points toward the acting team (attacking),
// -1 when it points away from the acting team (e.g. a card is bad for them).
function thrustForType(typeText) {
  switch (typeText) {
    case 'Goal':
    case 'Goal - Header':
    case 'Goal - Penalty':
      return { mag: 10, attacking: true };
    case 'Shot On Target':
      return { mag: 5, attacking: true };
    case 'Shot Hit Woodwork':
      return { mag: 5, attacking: true };
    case 'Shot Blocked':
    case 'Shot Off Target':
      return { mag: 3, attacking: true };
    case 'Corner Awarded':
      return { mag: 2, attacking: true };
    case 'Offside':
      return { mag: 1, attacking: true }; // attacking team was pushing
    case 'Foul':
      // A foul is awarded against the acting team; the *other* team gets a free
      // kick. We treat fouls as mild pressure toward the non-acting team only if
      // committed in their defensive third — but ESPN doesn't give location
      // reliably, so we apply a small thrust toward the fouled (other) team.
      return { mag: 1, attacking: false };
    case 'Yellow Card':
      return { mag: 0.5, attacking: false }; // bad for carded team
    case 'Red Card':
      return { mag: 2, attacking: false }; // strongly bad for carded team
    default:
      return null; // Substitution, Halftime, Start Delay, VAR, etc. -> no thrust
  }
}

// Classify an event into a coarse pulse-event type for the frontend blooms.
function pulseType(typeText) {
  if (!typeText) return null;
  if (typeText.startsWith('Goal')) return 'goal';
  if (typeText === 'Shot On Target' || typeText === 'Shot Hit Woodwork') return 'shotOn';
  if (typeText === 'Shot Blocked' || typeText === 'Shot Off Target') return 'shotOff';
  if (typeText === 'Corner Awarded') return 'corner';
  if (typeText === 'Red Card') return 'red';
  if (typeText === 'Yellow Card') return 'yellow';
  return null;
}

// Build a clean, ordered list of timeline events from a summary payload.
// homeName / awayName are the team displayNames used to resolve side.
// Returns [{ t, side: 'home'|'away', typeText, thrust, pulse, text }]
export function buildTimeline(summary, homeName, awayName) {
  const events = [];
  const commentary = Array.isArray(summary?.commentary) ? summary.commentary : [];

  for (const c of commentary) {
    const play = c.play;
    if (!play || !play.type) continue;
    const typeText = play.type.text;
    const teamName = play.team?.displayName || play.team?.name;
    // match-time in seconds: prefer play.clock.value, fall back to time.value
    const t = typeof play.clock?.value === 'number'
      ? play.clock.value
      : (typeof c.time?.value === 'number' ? c.time.value : null);
    if (t == null || !teamName) continue;

    let side = null;
    if (teamName === homeName) side = 'home';
    else if (teamName === awayName) side = 'away';
    if (!side) continue;

    const spec = thrustForType(typeText);
    let thrust = 0;
    if (spec) {
      // Resolve which side the thrust points to.
      // attacking=true -> toward acting side; false -> toward the OTHER side.
      const actingSign = side === 'home' ? 1 : -1;
      const dir = spec.attacking ? actingSign : -actingSign;
      thrust = dir * spec.mag;
    }

    events.push({
      t,
      side,
      typeText,
      thrust,
      pulse: pulseType(typeText),
      text: c.text || play.text || typeText,
    });
  }

  // Fallback: if commentary had no usable plays, derive from keyEvents.
  if (events.length === 0 && Array.isArray(summary?.keyEvents)) {
    for (const k of summary.keyEvents) {
      const typeText = k.type?.text;
      const teamName = k.team?.displayName || k.team?.name;
      if (!typeText || !teamName) continue;
      // keyEvents clock is "9'" style — parse to seconds
      const m = /(\d+)/.exec(k.clock?.displayValue || k.clock?.value || '');
      const t = m ? parseInt(m[1], 10) * 60 : null;
      if (t == null) continue;
      let side = null;
      if (teamName === homeName) side = 'home';
      else if (teamName === awayName) side = 'away';
      if (!side) continue;
      const spec = thrustForType(typeText);
      let thrust = 0;
      if (spec) {
        const actingSign = side === 'home' ? 1 : -1;
        const dir = spec.attacking ? actingSign : -actingSign;
        thrust = dir * spec.mag;
      }
      events.push({ t, side, typeText, thrust, pulse: pulseType(typeText), text: k.text || typeText });
    }
  }

  events.sort((a, b) => a.t - b.t);
  return events;
}

// Compute decayed momentum at match-time `now` (seconds) from a timeline.
// Only events with t <= now contribute (so this works for replay too).
export function momentumAt(timeline, now) {
  let sum = 0;
  for (const e of timeline) {
    if (e.t > now) break;
    if (e.thrust === 0) continue;
    const age = now - e.t;
    sum += e.thrust * Math.exp(-DECAY_LAMBDA * age);
  }
  // Squash to roughly [-1, 1].
  return Math.tanh(sum / SQUASH_SCALE);
}

// Build a momentum series (curve) sampled every `stepSec` up to `now`.
export function momentumSeries(timeline, now, stepSec = 30, maxPoints = 120) {
  const pts = [];
  const start = Math.max(0, now - stepSec * maxPoints);
  for (let t = start; t <= now; t += stepSec) {
    pts.push({ t, value: momentumAt(timeline, t) });
  }
  // always include the exact current instant
  if (pts.length === 0 || pts[pts.length - 1].t < now) {
    pts.push({ t: now, value: momentumAt(timeline, now) });
  }
  return pts;
}
