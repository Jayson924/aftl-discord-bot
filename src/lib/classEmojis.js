// Custom Discord emoji IDs for class icons.
//
// To populate: in your Discord server, type a backslash before the emoji
// (e.g. `\:Gladiator:`) and send it — Discord will reveal the raw form
// `<:Gladiator:1234567890123456789>`. Copy the digits into the `id` field.
//
// Animated emojis: set `animated: true` (renders as `<a:name:id>`).
// Leave `id` empty to disable a specific entry — helpers below will return ''.

const CLASS_EMOJIS = {
  // ─── Base classes ───
  'Warrior':        { name: 'Warrior',        id: '1500201283351609564' },
  'Archer':         { name: 'Archer',         id: '1500201240460525719' },
  'Sorceress':      { name: 'Sorceress',      id: '1500201278125379624' },
  'Cleric':         { name: 'Cleric',         id: '1500201248354205778' },
  'Academic':       { name: 'Academic',       id: '1500201234924175543' },
  'Kali':           { name: 'Kali',           id: '1500201264078655579' },

  // ─── Specializations ───
  'Swordmaster':    { name: 'Swordmaster',    id: '1500201281141215413' },
  'Mercenary':      { name: 'Mercenary',      id: '1500201266230464652' },
  'Bowmaster':      { name: 'Bowmaster',      id: '1500201246915559574' },
  'Acrobat':        { name: 'Acrobat',        id: '1500201236669005954' },
  'Elemental Lord': { name: 'ElementalLord',  id: '1500201254079434843' },
  'Force User':     { name: 'ForceUser',      id: '1500201258672193596' },
  'Paladin':        { name: 'Paladin',        id: '1500201268319355044' },
  'Priest':         { name: 'Priest',         id: '1500201270126842016' },
  'Engineer':       { name: 'Engineer',       id: '1500201257300787431' },
  'Alchemist':      { name: 'Alchemist',      id: '1500201239257022615' },
  'Screamer':       { name: 'Screamer',       id: '1500201274359025834' },
  'Dancer':         { name: 'Dancer',         id: '1500201250904608918' },

  // ─── Final classes ───
  'Gladiator':      { name: 'Gladiator',      id: '1500201260798971904' },
  'Moon Lord':      { name: 'MoonLord',       id: '1500201267107205271' },
  'Barbarian':      { name: 'Barbarian',      id: '1500201243728023592' },
  'Destroyer':      { name: 'Destroyer',      id: '1500201253429575711' },
  'Sniper':         { name: 'Sniper',         id: '1500201277261615205' },
  'Artillery':      { name: 'Artillery',      id: '1500201242276659301' },
  'Wind Walker':    { name: 'WindWalker',     id: '1500201284475687054' },
  'Tempest':        { name: 'Tempest',        id: '1500201282152038512' },
  'Saleana':        { name: 'Saleana',        id: '1500201272509206648' },
  'Elestra':        { name: 'Elestra',        id: '1500201255656620102' },
  'Smasher':        { name: 'Smasher',        id: '1500201276372160703' },
  'Majesty':        { name: 'Majesty',        id: '1500201265165238343' },
  'Crusader':       { name: 'Crusader',       id: '1500201249906102482' },
  'Guardian':       { name: 'Guardian',       id: '1500201261797212240' },
  'Saint':          { name: 'Saint',          id: '1500201271251046440' },
  'Inquisitor':     { name: 'Inquisitor',     id: '1500201262963233063' },
  'Shooting Star':  { name: 'ShootingStar',   id: '1500201275310997595' },
  'Gear Master':    { name: 'GearMaster',     id: '1500201259540680824' },
  'Adept':          { name: 'Adept',          id: '1500201237801467904' },
  'Physician':      { name: 'Physician',      id: '1500201269133054072' },
  'Dark Summoner':  { name: 'DarkSummoner',   id: '1500201252603166983' },
  'Soul Eater':     { name: 'SoulEater',      id: '1500201279237132411' },
  'Blade Dancer':   { name: 'BladeDancer',    id: '1500201246051795206' },
  'Spirit Dancer':  { name: 'SpiritDancer',   id: '1500201280134451262' },
};

/**
 * Returns the inline emoji tag for use inside message content/embeds.
 * Returns empty string if the class has no emoji configured.
 *
 *   getClassEmojiTag('Gladiator') → '<:Gladiator:1234567890>' or ''
 */
function getClassEmojiTag(className) {
  const e = CLASS_EMOJIS[className];
  if (!e || !e.id) return '';
  const prefix = e.animated ? 'a' : '';
  return `<${prefix}:${e.name}:${e.id}>`;
}

/**
 * Returns the emoji descriptor object for use on select-menu options
 * (StringSelectMenuOptionBuilder accepts `{ id, name, animated? }`).
 * Returns undefined if not configured — safe to spread into option object.
 *
 *   .addOptions({ label: 'Gladiator', value: 'Gladiator', emoji: getClassEmojiData('Gladiator') })
 */
function getClassEmojiData(className) {
  const e = CLASS_EMOJIS[className];
  if (!e || !e.id) return undefined;
  return { id: e.id, name: e.name, animated: !!e.animated };
}

module.exports = { CLASS_EMOJIS, getClassEmojiTag, getClassEmojiData };
