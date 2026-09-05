import { describe, expect, it, vi } from "vitest";
import {
  AskSessionChangedError,
  buildAskRequest,
  exactSessionAskHeaders,
  askHeadersForPlatform,
  MAX_REQUEST_MESSAGES,
} from "./transport";
import type { UIMessage } from "ai";
import type { AuthPort, SessionView } from "@prismical/app-contracts";

const userMsg = (text: string): UIMessage =>
  ({ id: "m1", role: "user", parts: [{ type: "text", text }] }) as never;

const msg = (role: "user" | "assistant", text: string): UIMessage =>
  ({ id: text, role, parts: [{ type: "text", text }] }) as never;

describe("buildAskRequest", () => {
  it("reshapes UIMessages to {role,content} and attaches scope + auth header", () => {
    const out = buildAskRequest({
      messages: [userMsg("hi there")],
      scope: { noteIds: ["nt_1"] },
      conversationId: undefined,
      headers: { Authorization: "Bearer abc" },
    });
    expect(out.body).toEqual({
      messages: [
        {
          role: "user",
          content: "hi there",
          parts: [{ type: "text", text: "hi there" }],
        },
      ],
      scope: { noteIds: ["nt_1"] },
      suggestFollowups: true,
    });
    expect(out.headers).toEqual({ Authorization: "Bearer abc" });
  });

  it("omits scope when undefined (global)", () => {
    const out = buildAskRequest({
      messages: [userMsg("q")],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect(out.body).toEqual({
      messages: [{ role: "user", content: "q", parts: [{ type: "text", text: "q" }] }],
      // The app clients ALWAYS opt in to follow-up chips; /v1 consumers never send it.
      suggestFollowups: true,
    });
    expect("scope" in (out.body as object)).toBe(false);
  });

  it("includes conversationId when present, omits it when undefined", () => {
    const withId = buildAskRequest({
      messages: [userMsg("q")],
      scope: undefined,
      conversationId: "cnv_abc",
      headers: {},
    });
    expect(withId.body).toEqual({
      messages: [{ role: "user", content: "q", parts: [{ type: "text", text: "q" }] }],
      conversationId: "cnv_abc",
      suggestFollowups: true,
    });
    const without = buildAskRequest({
      messages: [userMsg("q")],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect("conversationId" in (without.body as object)).toBe(false);
  });

  it("keeps a text-less (tool-only) turn as a placeholder so approval resume round-trips", () => {
    // A turn that is ONLY tool activity (no text parts) is NOT dropped — it rides
    // along as "[tool activity]" with its parts intact, so tool calls + approval
    // responses survive the reshape (dropping it would break the approval resume).
    const empty = { id: "m0", role: "assistant", parts: [{ type: "step-start" }] } as never;
    const out = buildAskRequest({
      messages: [empty, userMsg("real")],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect(out.body).toEqual({
      messages: [
        {
          role: "assistant",
          content: "[tool activity]",
          parts: [{ type: "step-start" }],
        },
        { role: "user", content: "real", parts: [{ type: "text", text: "real" }] },
      ],
      suggestFollowups: true,
    });
  });

  it("windows a long resumed thread to the most-recent MAX_REQUEST_MESSAGES, keeping the last user turn", () => {
    // A resumed conversation can seed up to 100 messages into useChat; sending them all would exceed
    // the backend's max(50). Build 60 turns ending with a fresh user question.
    const long: UIMessage[] = [];
    for (let i = 0; i < 30; i++) {
      long.push(msg("user", `q${i}`), msg("assistant", `a${i}`));
    }
    long.push(msg("user", "newest question"));
    const out = buildAskRequest({
      messages: long,
      scope: undefined,
      conversationId: "cnv_x",
      headers: {},
    });
    const sent = (out.body as { messages: { role: string; content: string }[] }).messages;
    expect(sent.length).toBe(MAX_REQUEST_MESSAGES);
    expect(sent.length).toBeLessThanOrEqual(50); // backend askRequestSchema cap
    expect(sent.at(-1)).toEqual({
      role: "user",
      content: "newest question",
      parts: [{ type: "text", text: "newest question" }],
    });
  });

  it("drops non user/assistant roles (e.g. system)", () => {
    const sys = { id: "s0", role: "system", parts: [{ type: "text", text: "ignore me" }] } as never;
    const out = buildAskRequest({
      messages: [sys, userMsg("q")],
      scope: undefined,
      conversationId: undefined,
      headers: {},
    });
    expect(out.body).toEqual({
      messages: [{ role: "user", content: "q", parts: [{ type: "text", text: "q" }] }],
      suggestFollowups: true,
    });
  });
});

describe("exactSessionAskHeaders", () => {
  const supportView: SessionView = {
    state: "signed-in",
    accounts: [
      {
        sub: "user_1",
        sessionKey: "support_session_1",
        email: "target@example.com",
        activeOrgId: "org_1",
      },
    ],
    activeSub: "user_1",
    activeSessionKey: "support_session_1",
  };
  const ordinaryView: SessionView = {
    state: "signed-in",
    accounts: [
      {
        sub: "user_1",
        sessionKey: "user_1",
        email: "target@example.com",
        activeOrgId: "org_1",
      },
    ],
    activeSub: "user_1",
    activeSessionKey: "user_1",
  };

  function authPort(
    getView: () => SessionView,
    getToken: AuthPort["getToken"],
    getTokenForSession: AuthPort["getTokenForSession"] = async () => getToken(),
  ): AuthPort {
    return {
      getSession: getView,
      getToken,
      getTokenForSession,
      onSessionChanged: () => () => {},
      signIn: async () => {},
      addAccount: async () => {},
      signOut: async () => {},
      switchAccount: () => {},
      switchOrg: () => {},
    };
  }

  it("pins Ask and tool-approval requests to the owner session token and org", async () => {
    const auth = authPort(
      () => supportView,
      async () => "support-token",
    );

    await expect(exactSessionAskHeaders(auth, "support_session_1", "org_1")).resolves.toEqual({
      Authorization: "Bearer support-token",
      "x-active-org-id": "org_1",
      "x-prismical-ask-error-format": "envelope",
    });
  });

  it("rejects a pending approval resume after same-user support falls back to ordinary", async () => {
    let view = supportView;
    const auth = authPort(
      () => view,
      async () => {
        view = ordinaryView;
        return "ordinary-token";
      },
    );

    await expect(exactSessionAskHeaders(auth, "support_session_1", "org_1")).rejects.toBeInstanceOf(
      AskSessionChangedError,
    );
  });

  it("does not even read the ordinary token for an already-stale support chat", async () => {
    let tokenReads = 0;
    const auth = authPort(
      () => ordinaryView,
      async () => {
        tokenReads += 1;
        return "ordinary-token";
      },
    );

    await expect(exactSessionAskHeaders(auth, "support_session_1", "org_1")).rejects.toBeInstanceOf(
      AskSessionChangedError,
    );
    expect(tokenReads).toBe(0);
  });

  it("rejects when the bearer seam changes before the reactive session view publishes", async () => {
    let ordinaryTokenReads = 0;
    const auth = authPort(
      () => supportView,
      async () => {
        ordinaryTokenReads += 1;
        return "ordinary-token";
      },
      async () => null,
    );

    await expect(exactSessionAskHeaders(auth, "support_session_1", "org_1")).rejects.toBeInstanceOf(
      AskSessionChangedError,
    );
    expect(ordinaryTokenReads).toBe(0);
  });

  it("rejects a delayed approval when the same exact login switches organizations", async () => {
    let view = supportView;
    const auth = authPort(
      () => view,
      async () => {
        view = {
          ...supportView,
          accounts: supportView.accounts.map((account) => ({
            ...account,
            activeOrgId: "org_2",
          })),
        };
        return "support-token";
      },
    );

    await expect(exactSessionAskHeaders(auth, "support_session_1", "org_1")).rejects.toBeInstanceOf(
      AskSessionChangedError,
    );
  });

  it("rejects an org seam change before the reactive session view publishes", async () => {
    const auth = authPort(
      () => supportView,
      async () => "support-token",
      async (_sessionKey, expectedOrgId) => (expectedOrgId === "org_2" ? "support-token" : null),
    );

    await expect(exactSessionAskHeaders(auth, "support_session_1", "org_1")).rejects.toBeInstanceOf(
      AskSessionChangedError,
    );
  });

  it("keeps desktop Ask token-free for main-owned IPC authentication", async () => {
    const tokenReads = vi.fn(async () => "must-not-cross");
    const exactTokenReads = vi.fn(async () => "must-not-cross");
    const auth = authPort(() => supportView, tokenReads, exactTokenReads);

    await expect(
      askHeadersForPlatform("desktop", auth, "support_session_1", "org_1"),
    ).resolves.toEqual({});
    expect(tokenReads).not.toHaveBeenCalled();
    expect(exactTokenReads).not.toHaveBeenCalled();
  });
});
