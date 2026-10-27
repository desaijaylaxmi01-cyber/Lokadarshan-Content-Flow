import Anthropic from '@anthropic-ai/sdk';

export const LANGUAGES = { kn: 'Kannada', mr: 'Marathi', hi: 'Hindi', ur: 'Urdu', kok: 'Konkani', en: 'English' };

const MODEL = process.env.TRANSLATION_MODEL || 'claude-opus-5-5';

const SYSTEM = `You are a senior news desk translator for regional newspapers in Belagavi, Karnataka.
Translate the reporter's story into clear, publication-ready English news copy.

- Preserve every fact, figure, date, quote and attribution exactly. Never add, remove or speculate.
- Transliterate personal names, villages, taluks, organisations and party names in their commonly used English spelling (e.g. Belagavi, Chikkodi, Gokak).
- Keep direct quotes as quotes, translated faithfully.
- Use neutral, concise news style with short paragraphs separated by a blank line.
- If the summary field is empty, write a one or two sentence English summary from the story.
- If text is already in English, lightly copy-edit it rather than rewriting.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'English headline' },
    summary: { type: 'string', description: 'English summary / standfirst' },
    body: { type: 'string', description: 'English story body, paragraphs separated by blank lines' },
  },
  required: ['title', 'summary', 'body'],
  additionalProperties: false,
};

let client;

export function translationAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function translateStory({ title, summary, body, sourceLang }) {
  client ??= new Anthropic();
  const language = LANGUAGES[sourceLang] || 'the source language';
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Source language: ${language}\n\n<title>\n${title}\n</title>\n\n<summary>\n${summary}\n</summary>\n\n<body>\n${body}\n</body>`,
    }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error('The translation service declined this text. Please translate it manually.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The story is too long to translate in one go. Please split it and try again.');
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}
