import { FormattingProvider, FormatParams } from "../../core/pipeline-types";
import { logger } from "../../../main/logger";

export class MockFormatter implements FormattingProvider {
  readonly name = "mock";

  constructor(private readonly model: string) {}

  async format(params: FormatParams): Promise<string> {
    logger.pipeline.debug("Mock formatter passthrough", {
      model: this.model,
      length: params.text.length,
    });
    return params.text;
  }
}
