import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

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

Your job is to decide whether the input is a valid search for finding potential customers on Reddit.

ACCEPT only if the input clearly refers to at least one of these:
- a product
- a SaaS
- a software tool
- a service
- an agency offering
- a productized service
- a business workflow
- a business use case
- a company URL or product URL

REJECT if the input is:
- a generic noun or broad topic with no clear business use case
- something a founder cannot realistically sell or offer
- profanity, abuse, or sexual content
- random text, gibberish, or meme/joke input
- too vague to infer a concrete business offer or customer pain point

VERY IMPORTANT:
- Be reasonably strict, but do not over-reject.
- Accept broad but valid product or service categories if they plausibly describe something a business could sell.
- Reject clearly generic consumer nouns and topics with no business offer behind them.
- Single generic nouns should usually be rejected unless they clearly describe a sellable product or service category.
- URLs should be accepted only if they plausibly look like a company/product site.

Examples to REJECT:
- "dog"
- "marketing"
- "money"
- "reddit"
- "hello"
- profanity

Examples to ACCEPT:
- "social media scheduler"
- "social media scheduler for agencies"
- "invoice automation for accountants"
- "AI headshots for teams"
- "SEO content writing service"
- "https://headshotpro.com"

Return JSON only with this exact shape:
{ "is_valid": true/false, "reason": "short reason" }`;

  const userPrompt = `Input: "${userInput.trim()}"

Would this be a valid search for finding potential customers on Reddit?

Allow broad but legitimate product/service categories. Reject only if the input is clearly too generic, abusive, nonsensical, or unrelated to something a business could actually offer.`;

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

  const result = await validateWithAI(trimmed);
  if (!result.is_valid) throw new InvalidSearchInputError();
}
