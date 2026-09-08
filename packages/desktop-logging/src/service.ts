import { Context } from "effect";
import type { MainLoggerService } from "./types";

export class MainLogger extends Context.Tag("desktop/MainLogger")<
  MainLogger,
  MainLoggerService
>() {}
