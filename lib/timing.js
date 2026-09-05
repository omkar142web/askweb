"use strict";

// Shared run-phase timing so every provider reports the same breakdown:
// >> [timing] browser=1.1s, ready=3.6s, write=21.3s, send=0.0s,
//              generate=5.0s, extract=0.1s, save=0.0s | total=31.1s
// markPhase itself never logs; main() prints once via printTimings().
// Importing this module from tests is harmless - phases only accumulate.

const T0 = Date.now();
const PHASES = [];

function markPhase(name) {
    PHASES.push([name, Date.now() - T0]);
}

function printTimings() {
    if (PHASES.length === 0) return;
    const parts = [];
    for (let i = 0; i < PHASES.length; i++) {
        const start = i === 0 ? 0 : PHASES[i - 1][1];
        parts.push(`${PHASES[i][0]}=${((PHASES[i][1] - start) / 1000).toFixed(1)}s`);
    }
    console.log(`>> [timing] ${parts.join(", ")} | total=${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

module.exports = {
    markPhase,
    printTimings,
};
