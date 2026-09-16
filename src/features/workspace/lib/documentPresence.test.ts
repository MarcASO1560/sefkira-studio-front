import { describe, expect, it } from "vitest";

import type { ProjectPresenceMember } from "../../../lib/realtime";
import { getDocumentPresenceMembers } from "./documentPresence";

const member = (
  id: string,
  overrides: Partial<ProjectPresenceMember> = {},
): ProjectPresenceMember => ({
  id,
  email: `${id}@example.com`,
  resource_id: "image-1",
  ...overrides,
});

describe("getDocumentPresenceMembers", () => {
  it("excludes the current user from the counter and puts them first in the list", () => {
    const self = member("self", { username: "Zoe" });
    const other = member("other", { username: "Alex" });

    expect(getDocumentPresenceMembers([other, self], "self")).toEqual({
      members: [self, other],
      others: [other],
    });
  });

  it("does not count another tab belonging to the current user", () => {
    const firstTab = member("self", {
      client_id: "own-first-tab",
      online_at: "2026-09-16T08:00:00Z",
    });
    const secondTab = member("self", {
      client_id: "own-second-tab",
      online_at: "2026-09-16T08:01:00Z",
    });

    expect(getDocumentPresenceMembers([firstTab, secondTab], "self")).toEqual({
      members: [secondTab],
      others: [],
    });
  });

  it("deduplicates remote tabs by user id and keeps the latest presence", () => {
    const older = member("other", {
      username: "Old name",
      client_id: "remote-old-tab",
      online_at: "2026-09-16T08:00:00Z",
    });
    const latest = member("other", {
      username: "Updated name",
      client_id: "remote-new-tab",
      online_at: "2026-09-16T08:01:00Z",
    });

    expect(getDocumentPresenceMembers([latest, older], "self")).toEqual({
      members: [latest],
      others: [latest],
    });
  });

  it("compares presence timestamps chronologically even with different offsets", () => {
    const older = member("other", { online_at: "2026-09-16T10:00:00+02:00" });
    const latest = member("other", { online_at: "2026-09-16T08:01:00Z" });

    expect(getDocumentPresenceMembers([latest, older], "self").others).toEqual([
      latest,
    ]);
  });

  it("waits for the current user's identity before exposing the presence list", () => {
    expect(getDocumentPresenceMembers([member("self"), member("other")], "")).toEqual({
      members: [],
      others: [],
    });
  });

  it("includes quiet users without recent activity or an online timestamp", () => {
    const quiet = member("quiet");

    expect(getDocumentPresenceMembers([quiet], "self")).toEqual({
      members: [quiet],
      others: [quiet],
    });
  });

  it("returns an empty list when the document has no presence members", () => {
    expect(getDocumentPresenceMembers([], "self")).toEqual({
      members: [],
      others: [],
    });
  });

  it("sorts people by display name, falling back to email and id, without mutating input", () => {
    const zoe = member("zoe", { username: "Zoe" });
    const email = member("email", { username: null, email: "bob@example.com" });
    const id = member("charlie", { username: "", email: "" });
    const alexTwo = member("alex-2", { username: "Alex" });
    const alexOne = member("alex-1", { username: "Alex" });
    const input = [zoe, id, alexTwo, email, alexOne];
    const result = getDocumentPresenceMembers(input, "self");

    expect(result.others).toEqual([alexOne, alexTwo, email, id, zoe]);
    expect(result.members).toEqual(result.others);
    expect(input).toEqual([zoe, id, alexTwo, email, alexOne]);
    expect(getDocumentPresenceMembers([...input].reverse(), "self").others).toEqual(
      result.others,
    );
  });
});
