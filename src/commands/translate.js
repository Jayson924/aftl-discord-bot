const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  MessageFlags,
} = require('discord.js');
const { checkAndConsume } = require('../lib/rateLimiter');

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Translate')
    .setType(ApplicationCommandType.Message),

  async execute(interaction) {
    const rate = checkAndConsume(interaction.user.id, RATE_LIMIT);
    if (!rate.allowed) {
      const seconds = Math.ceil(rate.retryAfterMs / 1000);
      await interaction.reply({
        content: `You're translating too fast. Try again in ${seconds}s.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const text = interaction.targetMessage.content;
    if (!text || !text.trim()) {
      await interaction.reply({
        content: 'That message has no text to translate.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = (interaction.locale || 'en').split('-')[0];

    const url = new URL('https://translation.googleapis.com/language/translate/v2');
    url.searchParams.set('key', process.env.GOOGLE_TRANSLATE_API_KEY);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target, format: 'text' }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Google Translate error:', res.status, body);
      await interaction.editReply('Translation failed. Try again later.');
      return;
    }

    const data = await res.json();
    const result = data.data?.translations?.[0];
    if (!result) {
      await interaction.editReply('Translation failed. Try again later.');
      return;
    }

    const detected = result.detectedSourceLanguage;
    const translated = result.translatedText;

    if (detected === target) {
      await interaction.editReply(`Already in ${target}. No translation needed.`);
      return;
    }

    await interaction.editReply(
      `**${detected} → ${target}**\n${translated}`,
    );
  },
};
