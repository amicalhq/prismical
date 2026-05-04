// Provider brand logos. SVGs are sourced from svgl.app and live in
// `./svgs/`. Each component is a pure-render wrapper that swaps the
// light- vs dark-theme variant via Tailwind's `dark:` modifier — apps
// using the `dark` class on `<html>` (which is the case here, see
// `theme-provider`) will get the correct image automatically.
//
// Why <img> instead of inline SVG: the SVGs ship with their own
// brand-correct fills (often hardcoded), so theming via `currentColor`
// would lose visual identity. The trade-off is that consumers can't
// recolor these via Tailwind text color utilities — set sizing only.

import { cn } from "@/lib/utils";

import openaiLight from "./svgs/openai.svg";
import openaiDark from "./svgs/openai_dark.svg";
import anthropicLight from "./svgs/anthropic_black.svg";
import anthropicDark from "./svgs/anthropic_white.svg";
import groq from "./svgs/groq.svg";
import openrouterLight from "./svgs/openrouter_light.svg";
import openrouterDark from "./svgs/openrouter_dark.svg";
import ollamaLight from "./svgs/ollama_light.svg";
import ollamaDark from "./svgs/ollama_dark.svg";
import gemini from "./svgs/gemini.svg";
import vercelLight from "./svgs/vercel_light.svg";
import vercelDark from "./svgs/vercel_dark.svg";
import cloudflare from "./svgs/cloudflare.svg";
import cerebrasLight from "./svgs/cerebras_light.svg";
import cerebrasDark from "./svgs/cerebras_dark.svg";

interface LogoProps {
  className?: string;
}

interface ThemedLogoProps extends LogoProps {
  light: string;
  dark: string;
  alt: string;
}

function ThemedLogo({ light, dark, alt, className }: ThemedLogoProps) {
  return (
    <>
      <img
        src={light}
        alt={alt}
        className={cn("block dark:hidden", className)}
      />
      <img
        src={dark}
        alt=""
        aria-hidden
        className={cn("hidden dark:block", className)}
      />
    </>
  );
}

export function OpenAILogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light={openaiLight}
      dark={openaiDark}
      alt="OpenAI"
      className={className}
    />
  );
}

export function AnthropicLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light={anthropicLight}
      dark={anthropicDark}
      alt="Anthropic"
      className={className}
    />
  );
}

// Groq's logo is a brand-fixed red square + white wordmark — no theme variant.
export function GroqLogo({ className }: LogoProps) {
  return <img src={groq} alt="Groq" className={className} />;
}

export function OpenRouterLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light={openrouterLight}
      dark={openrouterDark}
      alt="OpenRouter"
      className={className}
    />
  );
}

export function OllamaLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light={ollamaLight}
      dark={ollamaDark}
      alt="Ollama"
      className={className}
    />
  );
}

export function GeminiLogo({ className }: LogoProps) {
  return <img src={gemini} alt="Google Gemini" className={className} />;
}

export function VercelLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light={vercelLight}
      dark={vercelDark}
      alt="Vercel"
      className={className}
    />
  );
}

// Cloudflare's brand mark is fixed orange/black; no theme variant needed.
export function CloudflareLogo({ className }: LogoProps) {
  return <img src={cloudflare} alt="Cloudflare" className={className} />;
}

export function CerebrasLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light={cerebrasLight}
      dark={cerebrasDark}
      alt="Cerebras"
      className={className}
    />
  );
}
