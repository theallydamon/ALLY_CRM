"use strict";

const crypto = require("node:crypto");

const ALLOWED_EMAILS = new Set(["theallydamon@gmail.com", "ally@mama.co.za"]);
const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const VALID_PRIORITIES = new Set(["Low", "Medium", "High"]);

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const today = () => new Date().toISOString().slice(0, 10);

function cleanText(value, field, max, required = false) {
  if (value == null) value = "";
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required.`);
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return result;
}

function validateDate(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error("dueDate must be a real date in YYYY-MM-DD format.");
  }
  return value;
}

function validateHttpsUrl(value) {
  if (value == null || value === "") return "";
  const text = cleanText(value, "sourceUrl", 2000);
  let parsed;
  try { parsed = new URL(text); } catch (_) { throw new Error("sourceUrl must be a valid HTTPS URL."); }
  if (parsed.protocol !== "https:") throw new Error("sourceUrl must use HTTPS.");
  return parsed.toString();
}

function normaliseTask(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task arguments are required.");
  const profile = input.profile;
  if (profile !== "personal" && profile !== "work") throw new Error("profile must be personal or work.");
  const priority = input.priority == null || input.priority === "" ? "Medium" : input.priority;
  if (!VALID_PRIORITIES.has(priority)) throw new Error("priority must be Low, Medium, or High.");
  return {
    profile,
    title: cleanText(input.title, "title", 240, true),
    description: cleanText(input.description, "description", 4000),
    due: validateDate(input.dueDate),
    priority,
    sourceMessageId: cleanText(input.sourceMessageId, "sourceMessageId", 500, true),
    sourceUrl: validateHttpsUrl(input.sourceUrl),
  };
}

function taskRecord(input, id, nowMs = Date.now()) {
  const common = {
    id,
    title: input.title,
    description: input.description,
    status: "To do",
    created: today(),
    due: input.due,
    priority: input.priority,
    lastProgress: null,
    createdAt: nowMs,
    capturedBy: "claude-inbox",
    sourceMessageId: input.sourceMessageId,
  };
  if (input.profile === "work") {
    return {
      ...common,
      links: input.sourceUrl ? [{ id: `${id}-source`, label: "Source email", url: input.sourceUrl }] : [],
    };
  }
  return input.sourceUrl ? { ...common, sourceUrl: input.sourceUrl } : common;
}

module.exports = {
  ALLOWED_EMAILS,
  CLAUDE_REDIRECT_URI,
  normaliseTask,
  randomToken,
  sha256,
  taskRecord,
};
