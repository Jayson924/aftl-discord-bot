// Class hierarchy mirror of CLASS_FAMILIES from aftl-raid/src/constants.js.
// Kept in sync manually — if classes change in the web app, update here too.

const CLASS_FAMILIES = {
  warrior: {
    name: 'Warrior',
    specializations: {
      swordmaster: { name: 'Swordmaster', classes: ['Moon Lord', 'Gladiator'] },
      mercenary:   { name: 'Mercenary',   classes: ['Barbarian', 'Destroyer'] },
    },
  },
  archer: {
    name: 'Archer',
    specializations: {
      bowmaster: { name: 'Bowmaster', classes: ['Sniper', 'Artillery'] },
      acrobat:   { name: 'Acrobat',   classes: ['Tempest', 'Wind Walker'] },
    },
  },
  sorceress: {
    name: 'Sorceress',
    specializations: {
      elementalist: { name: 'Elemental Lord', classes: ['Elestra', 'Saleana'] },
      forceuser:    { name: 'Force User',     classes: ['Majesty', 'Smasher'] },
    },
  },
  cleric: {
    name: 'Cleric',
    specializations: {
      paladin: { name: 'Paladin', classes: ['Guardian', 'Crusader'] },
      priest:  { name: 'Priest',  classes: ['Saint', 'Inquisitor'] },
    },
  },
  academic: {
    name: 'Academic',
    specializations: {
      engineer:  { name: 'Engineer',  classes: ['Gear Master', 'Shooting Star'] },
      alchemist: { name: 'Alchemist', classes: ['Physician', 'Adept'] },
    },
  },
  kali: {
    name: 'Kali',
    specializations: {
      screamer: { name: 'Screamer', classes: ['Dark Summoner', 'Soul Eater'] },
      dancer:   { name: 'Dancer',   classes: ['Blade Dancer', 'Spirit Dancer'] },
    },
  },
};

function getFamilyOptions() {
  return Object.entries(CLASS_FAMILIES).map(([key, fam]) => ({
    label: fam.name,
    value: key,
  }));
}

function getSpecOptions(familyKey) {
  const fam = CLASS_FAMILIES[familyKey];
  if (!fam) return [];
  return Object.entries(fam.specializations).map(([key, spec]) => ({
    label: spec.name,
    value: key,
  }));
}

function getFinalClassOptions(familyKey, specKey) {
  const spec = CLASS_FAMILIES[familyKey]?.specializations?.[specKey];
  if (!spec) return [];
  return spec.classes.map(name => ({ label: name, value: name }));
}

module.exports = { CLASS_FAMILIES, getFamilyOptions, getSpecOptions, getFinalClassOptions };
