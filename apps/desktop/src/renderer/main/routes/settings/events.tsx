import { createFileRoute } from "@tanstack/react-router";
import EventsPage from "../../pages/settings/events";

export const Route = createFileRoute("/settings/events")({
  component: EventsPage,
});
