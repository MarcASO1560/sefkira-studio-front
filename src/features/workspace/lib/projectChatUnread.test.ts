import { describe, expect, it } from "vitest";
import { aggregateProjectChatUnread } from "./projectChatUnread";

describe("unread messages inside folders", () => {
  it("includes nested documents once in every ancestor and ignores deleted documents", () => {
    const totals = aggregateProjectChatUnread({ drawing: 2, animation: 3, root: 4, deleted: 50 }, [
      { id: "parent", parent_id: null }, { id: "child", parent_id: "parent" },
    ], [
      { id: "drawing", folder_id: "parent" }, { id: "animation", folder_id: "child" },
      { id: "root", folder_id: null },
    ]);
    expect(totals).toEqual({ parent: 5, child: 3 });
  });
  it("handles malformed folder cycles without double counting or looping", () => {
    expect(aggregateProjectChatUnread({ drawing: 7 }, [
      { id: "a", parent_id: "b" }, { id: "b", parent_id: "a" },
    ], [{ id: "drawing", folder_id: "a" }])).toEqual({ a: 7, b: 7 });
  });
  it("does not count invalid values or unknown folders", () => {
    expect(aggregateProjectChatUnread({ one: -1, two: NaN, three: 5 }, [{ id: "a" }], [
      { id: "one", folder_id: "a" }, { id: "two", folder_id: "a" }, { id: "three", folder_id: "gone" },
    ])).toEqual({});
  });
});
