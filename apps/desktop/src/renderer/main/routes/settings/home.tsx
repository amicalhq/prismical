import { createFileRoute } from "@tanstack/react-router";
import HomePage from "../../pages/settings/home";

export const Route = createFileRoute("/settings/home")({
  component: HomePage,
});
