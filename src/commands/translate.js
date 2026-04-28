const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  MessageFlags,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { checkAndConsume } = require('../lib/rateLimiter');

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

const anthropic = new Anthropic();

const LOCALE_TO_LANGUAGE = {
  en: 'English',
  fil: 'Filipino (Tagalog)',
  tl: 'Filipino (Tagalog)',
  id: 'Indonesian',
  ms: 'Malay',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Mandarin Chinese (Simplified)',
  'zh-CN': 'Mandarin Chinese (Simplified)',
  'zh-TW': 'Mandarin Chinese (Traditional)',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ru: 'Russian',
  vi: 'Vietnamese',
  th: 'Thai',
};

const SYSTEM_PROMPT = `You are a translator for a gaming guild's Discord server. Members write in English, Filipino (Tagalog), Cebuano (Bisaya), Indonesian, Malay, Mandarin Chinese, Singlish, and other languages, and frequently mix English with their native language (e.g. Taglish, Bislish, or Singlish particles like "lah", "lor", "leh", "meh", "can or not").

Translate the user's message to the requested target language. Rules:
- Preserve gaming jargon, character names, and proper nouns as-is (don't translate them)
- Match the casual, conversational tone of Discord chat
- If the message is already in the target language, respond with exactly: ALREADY_TARGET
- Do not add explanations, notes, disclaimers, or quotation marks around the translation
- NEVER ask for clarification, context, or what something means — you are a translator, not a chatbot
- For slang, idioms, or ambiguous terms: give your best literal or interpretive translation. If a word has multiple meanings, pick the most likely one for casual gaming chat
- For untranslatable text (gibberish, emoji-only, single ambiguous characters): output the original text unchanged
- Output only the translated text, nothing else`;

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

    const fullLocale = interaction.locale || 'en';
    const baseLocale = fullLocale.split('-')[0];
    const targetLanguage =
      LOCALE_TO_LANGUAGE[fullLocale] ||
      LOCALE_TO_LANGUAGE[baseLocale] ||
      'English';

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Translate to ${targetLanguage}:\n\n${text}`,
        },
      ],
    });

    const translated = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (translated === 'ALREADY_TARGET') {
      await interaction.editReply(`Already in ${targetLanguage}. No translation needed.`);
      return;
    }

    await interaction.editReply(
      `**Translated to ${targetLanguage}**\n${translated}`,
    );
  },
};
