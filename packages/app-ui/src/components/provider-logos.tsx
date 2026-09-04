// Provider brand logos. SVGs are sourced from svgl.app and live in
// `public/provider-logos/`. Each component is a pure-render wrapper that
// swaps the light- vs dark-theme variant via Tailwind's `dark:` modifier —
// apps using the `dark` class on `<html>` get the correct image automatically.
//
// Mirrors the desktop `renderer/main/components/logos/index.tsx`. We use
// plain <img> (not next/image) for the same reason the desktop does: the
// SVGs carry their own brand-correct fills, so theming via `currentColor`
// would lose visual identity. (In app-ui the Next-only no-img-element rule
// isn't active, so no inline disables are needed here.)

import { cn } from "../lib/utils"

interface LogoProps {
  className?: string
}

interface ThemedLogoProps extends LogoProps {
  light: string
  dark: string
  alt: string
}

function ThemedLogo({ light, dark, alt, className }: ThemedLogoProps) {
  return (
    <>
      <img src={light} alt={alt} className={cn("block dark:hidden", className)} />
      <img
        src={dark}
        alt=""
        aria-hidden
        className={cn("hidden dark:block", className)}
      />
    </>
  )
}

export function OpenAILogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/openai.svg"
      dark="/provider-logos/openai_dark.svg"
      alt="OpenAI"
      className={className}
    />
  )
}

export function AnthropicLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/anthropic_black.svg"
      dark="/provider-logos/anthropic_white.svg"
      alt="Anthropic"
      className={className}
    />
  )
}

// Groq's logo is a brand-fixed red square + white wordmark — no theme variant.
export function GroqLogo({ className }: LogoProps) {
  return (
    <img src="/provider-logos/groq.svg" alt="Groq" className={className} />
  )
}

export function OpenRouterLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/openrouter_light.svg"
      dark="/provider-logos/openrouter_dark.svg"
      alt="OpenRouter"
      className={className}
    />
  )
}

export function OllamaLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/ollama_light.svg"
      dark="/provider-logos/ollama_dark.svg"
      alt="Ollama"
      className={className}
    />
  )
}

export function GeminiLogo({ className }: LogoProps) {
  return (
    <img
      src="/provider-logos/gemini.svg"
      alt="Google Gemini"
      className={className}
    />
  )
}

export function VercelLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/vercel_light.svg"
      dark="/provider-logos/vercel_dark.svg"
      alt="Vercel"
      className={className}
    />
  )
}

// Cloudflare's brand mark is fixed orange/black; no theme variant needed.
export function CloudflareLogo({ className }: LogoProps) {
  return (
    <img
      src="/provider-logos/cloudflare.svg"
      alt="Cloudflare"
      className={className}
    />
  )
}

export function CerebrasLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/cerebras_light.svg"
      dark="/provider-logos/cerebras_dark.svg"
      alt="Cerebras"
      className={className}
    />
  )
}

export function AppleLogo({ className }: LogoProps) {
  return (
    <ThemedLogo
      light="/provider-logos/apple.svg"
      dark="/provider-logos/apple_dark.svg"
      alt="Apple"
      className={className}
    />
  )
}

export function GoogleCalendarLogo({ className }: LogoProps) {
  return (
    <img
      src="/provider-logos/google-calendar.svg"
      alt="Google Calendar"
      className={className}
    />
  )
}
