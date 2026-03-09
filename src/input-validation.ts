import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const MAX_INPUT_LENGTH = 240;

const PROFANITY_PATTERN =
  /\b(fuck|fucking|shit|bitch|cunt|asshole|motherfucker|dick|pussy|bastard|slut|whore|nigger|nigga|retard)\b/i;

const INVALID_INPUT_MESSAGE =
  'Please enter a real product, service, or business use case. For example: "social media scheduler for agencies".';

export class InvalidSearchInputError extends Error {
  constructor(message: string = INVALID_INPUT_MESSAGE) {
    super(message);
    this.name = "InvalidSearchInputError";
  }
}

interface ValidationResult {
  is_valid: boolean;
  reason?: string;
}

function looksLikeValidUrl(input: string): boolean {
  try {
    const candidate = input.startsWith("http://") || input.startsWith("https://")
      ? input
      : `https://${input}`;
    const url = new URL(candidate);
    return Boolean(url.hostname && url.hostname.includes(".") && url.hostname !== "localhost");
  } catch {
    return false;
  }
}

function hasMinimumSignal(input: string): boolean {
  const letters = (input.match(/[a-z]/gi) ?? []).length;
  return letters >= 3;
}

function parseValidationResponse(content: string): ValidationResult {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  const parsed = JSON.parse(jsonStr) as ValidationResult;
  return {
    is_valid: Boolean(parsed?.is_valid),
    reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : undefined,
  };
}

async function validateWithAI(userInput: string): Promise<ValidationResult> {
  const key = requireOpenAIKey();
  const systemPrompt = `You validate search queries for a B2B lead discovery tool.

Accept inputs that describe a real:
- product
- SaaS
- service
- agency
- tool
- business workflow
- business use case
- company URL or product URL

Reject inputs that are:
- profanity or abusive
- generic nouns with no business use case (example: "dog")
- random words, gibberish, or overly vague topics
- obviously not something with potential customers looking for solutions

Return JSON only with this exact shape:
{ "is_valid": true/false, "reason": "short reason" }`;

  const userPrompt = `Input: "${userInput.trim()}"

Would this be a valid search for finding potential customers on Reddit?`;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error?.message) throw new Error(`OpenAI: ${data.error.message}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content for input validation");
  return parseValidationResponse(content);
}

export async function validateUserInput(userInput: string): Promise<void> {
  const trimmed = userInput.trim();
  if (!trimmed) throw new InvalidSearchInputError();
  if (trimmed.length > MAX_INPUT_LENGTH) throw new InvalidSearchInputError();
  if (!hasMinimumSignal(trimmed)) throw new InvalidSearchInputError();
  if (PROFANITY_PATTERN.test(trimmed)) throw new InvalidSearchInputError();

  // Legitimate URLs/domains should pass without forcing a brittle LLM validation step.
  if (looksLikeValidUrl(trimmed)) return;

  const result = await validateWithAI(trimmed);
  if (!result.is_valid) throw new InvalidSearchInputError();
}
