/**
 * npm run readme:screener
 *
 * Sends README.md, and nothing else, to a model we run (the rule compiler's Groq model,
 * qwen/qwen3.8-27b, with COMPILER_API_KEY from .env.web) and asks the three questions a
 * screener asks. Prints the answers; a human judges whether they match what Two-Key is.
 */
import { readFileSync } from 'node:fs';

const QUESTIONS = [
  'What is this?',
  'Who is it for?',
  'How do I try it in under two minutes?',
] as const;

const baseUrl = process.env.COMPILER_BASE_URL || 'https://api.groq.com/openai/v1';
const model = process.env.SCREENER_MODEL || process.env.COMPILER_MODEL || 'qwen/qwen3.8-27b';
const apiKey = process.env.COMPILER_API_KEY;
if (!apiKey) {
  console.error('COMPILER_API_KEY is not set (expected in .env.web).');
  process.exit(1);
}

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const prompt = [
  'You are screening a hackathon entry. You have only its README, below, and nothing else.',
  'Answer each question in at most three sentences, using only what the README says.',
  'If the README does not answer a question, say so.',
  '',
  ...QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
  '',
  '--- README.md ---',
  readme,
].join('\n');

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1200,
    temperature: 0.2,
  }),
});
if (!res.ok) {
  console.error(`${model} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const body = (await res.json()) as {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
const answer = (body.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');

console.log(`README screener · ${model} · README.md only (${readme.length} characters)`);
console.log(
  `tokens: ${body.usage?.prompt_tokens ?? '?'} in, ${body.usage?.completion_tokens ?? '?'} out\n`,
);
console.log(answer.trim());
