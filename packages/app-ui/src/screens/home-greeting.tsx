"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";

type GreetingPeriod = "morning" | "afternoon" | "evening";

function getGreetingPeriod(date: Date): GreetingPeriod {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

// Time-of-day greeting. Was a `force-dynamic` RSC that
// computed the greeting from the SERVER clock at request time; re-expressed as a
// client component so the greeting reflects the VIEWER's local time and `/home`
// prerenders statically (no build-time date baked in, no force-dynamic). Computed
// after mount so the static shell and the viewer's clock never disagree during
// hydration; the 👋 renders immediately, the words fill in on the same frame.
export function HomeGreeting() {
  const { t } = useTranslation();
  const [period, setPeriod] = React.useState<GreetingPeriod | null>(null);
  React.useEffect(() => {
    setPeriod(getGreetingPeriod(new Date()));
  }, []);

  return (
    <h1 className="text-xl font-bold">
      👋 {period ? t(`home.greeting.${period}`) : ""}
    </h1>
  );
}
