// Final damage conversion from the game client (playercommonleveltable._Cfinaldamage).
// Mirrors aftl-raid/src/gear-calc.js; keep both in sync.

const DEFAULT_LEVEL = 70;

// Raw FD that equals 100% of the curve (x = 1, i.e. 60% FD) per character level.
const FD_DIVISOR = {
  40: 1943, 41: 1982, 42: 2058, 43: 2136, 44: 2216, 45: 2296, 46: 2378, 47: 2461, 48: 2546, 49: 2631,
  50: 2718, 51: 2867, 52: 2960, 53: 3055, 54: 3151, 55: 3249, 56: 3349, 57: 3450, 58: 3552, 59: 3656,
  60: 3762, 61: 4353, 62: 4478, 63: 4604, 64: 4732, 65: 4863, 66: 4994, 67: 5128, 68: 5264, 69: 5401,
  70: 5540, 71: 5681, 72: 5824, 73: 5968, 74: 6114, 75: 6263, 76: 6412, 77: 6564, 78: 6718, 79: 6873,
  80: 7030,
};

function divisorFor(level) {
  return FD_DIVISOR[level] || FD_DIVISOR[DEFAULT_LEVEL];
}

// Linear to 45% at 0.5625 of the divisor, then 240/7 % per divisor.
function fdToPercent(rawFd, level = DEFAULT_LEVEL) {
  const x = Math.max(0, Number(rawFd) || 0) / divisorFor(level);
  return x <= 0.5625 ? 80 * x : 45 + (240 / 7) * (x - 0.5625);
}

function fdForPercent(percent, level = DEFAULT_LEVEL) {
  const c = divisorFor(level);
  return percent <= 45 ? (percent / 80) * c : (0.5625 + (percent - 45) * 7 / 240) * c;
}

module.exports = { DEFAULT_LEVEL, FD_DIVISOR, fdToPercent, fdForPercent };
