import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { FormattingProvider, FormatParams } from "../../core/pipeline-types";
import { logger } from "../../../main/logger";
import { getUserAgent } from "../../../utils/http-client";
import { extractFormattedText } from "./extract-formatted-text";
import { constructFormatterPrompt } from "./formatter-prompt";

export class OpenAICompatibleFormatter implements FormattingProvider {
  readonly name = "openai-compatible";

  private provider: ReturnType<typeof createOpenAICompatible>;
  private baseURL: string;

  constructor(
    apiKey: string,
    baseURL: string,
    private model: string,
  ) {
    this.baseURL = baseURL;
    this.provider = createOpenAICompatible({
      apiKey,
      baseURL,
      name: "openai-compatible",
      headers: {
        "User-Agent": getUserAgent(),
      },
      // Newer OpenAI models (o-series, gpt-5) reject `max_tokens` and require
      // `max_completion_tokens`. Renaming unconditionally is safe: OpenAI accepts
      // the new name for all chat models.
      transformRequestBody: (body) => {
        if (typeof body.max_tokens !== "number") return body;
        const { max_tokens, ...rest } = body;
        return { ...rest, max_completion_tokens: max_tokens };
      },
    });
  }

  async format(params: FormatParams): Promise<string> {
    try {
      const { text, context } = params;
      const { systemPrompt, userPrompt } = constructFormatterPrompt(context);
      const userPromptContent = userPrompt(text);

      logger.pipeline.info("Formatting request", {
        provider: this.name,
        endpoint: `${this.baseURL}/chat/completions`,
        model: this.model,
      });

      const { text: aiResponse } = await generateText({
        model: this.provider(this.model),
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPromptContent,
          },
        ],
        temperature: 0.1,
        maxOutputTokens: 2000,
      });

      const extraction = extractFormattedText(aiResponse, text);

      if (extraction.usedFallback) {
        logger.pipeline.warn(
          {
            model: this.model,
            reason: extraction.reason,
            rawResponsePreview: aiResponse.substring(0, 200),
          },
          "Formatting XML extraction failed, returning original text",
        );
      }

      return extraction.text;
    } catch (error) {
      logger.pipeline.error("Formatting failed:", error);
      return params.text;
    }
  }
}
