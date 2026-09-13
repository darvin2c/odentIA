import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client";
import { ssrFetchOptions } from "../lib/guards";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { data } = await authClient.getSession({
      fetchOptions: ssrFetchOptions(),
    });
    throw redirect({ to: data ? "/app/branches" : "/login" });
  },
});
