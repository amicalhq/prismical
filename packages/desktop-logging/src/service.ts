import { Context } from "effect";
import type { MainLoggerService } from "./types";

export class MainLogger extends Context.Service<MainLogger, MainLoggerService>()(
  "desktop/MainLogger"
) {}
