"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normaliseTask, sha256, taskRecord } = require("./lib");

test("normalises a personal inbox task", () => {
  const input = normaliseTask({ profile: "personal", title: "  Book dentist  ", sourceMessageId: "gmail-1", dueDate: "2026-09-01" });
  assert.equal(input.title, "Book dentist");
  assert.equal(input.priority, "Medium");
  assert.equal(input.due, "2026-09-01");
});

test("builds the current work admin-task shape", () => {
  const input = normaliseTask({ profile: "work", title: "Reply to creator", description: "Confirm timing", sourceMessageId: "gmail-2", sourceUrl: "https://mail.google.com/mail/u/0/#inbox/abc", priority: "High" });
  const task = taskRecord(input, "task-1", 123);
  assert.deepEqual(task.links, [{ id: "task-1-source", label: "Source email", url: "https://mail.google.com/mail/u/0/#inbox/abc" }]);
  assert.equal(task.status, "To do");
  assert.equal(task.capturedBy, "claude-inbox");
});

test("rejects unsafe or malformed input", () => {
  assert.throws(() => normaliseTask({ profile: "work", title: "X", sourceMessageId: "1", sourceUrl: "http://example.com" }), /HTTPS/);
  assert.throws(() => normaliseTask({ profile: "other", title: "X", sourceMessageId: "1" }), /profile/);
  assert.throws(() => normaliseTask({ profile: "work", title: "X", sourceMessageId: "1", dueDate: "tomorrow" }), /YYYY-MM-DD/);
});

test("hashes idempotency material deterministically", () => {
  assert.equal(sha256("work:gmail-1"), sha256("work:gmail-1"));
  assert.notEqual(sha256("work:gmail-1"), sha256("personal:gmail-1"));
});
