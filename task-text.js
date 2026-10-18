/* Task descriptions stay Markdown strings, preserving existing CRM/API/search compatibility. */
(function () {
  "use strict";
  const tags = ["p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "del", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "hr", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td"];
  function clean(html) {
    return DOMPurify.sanitize(html || "", {
      ALLOWED_TAGS: tags, ALLOWED_ATTR: ["href", "title", "colspan", "rowspan", "align", "start"],
      ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[#/])/i,
    });
  }
  const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  converter.use(turndownPluginGfm.tables);
  converter.use(turndownPluginGfm.strikethrough);
  function fromHtml(html) {
    const root = document.createElement("div");
    root.innerHTML = clean(html);
    // Spreadsheet clipboard tables often use td for the header too. GFM needs a header row.
    root.querySelectorAll("table").forEach((table) => {
      const row = table.rows[0];
      if (row && !table.querySelector("th")) Array.from(row.cells).forEach((cell) => {
        const th = document.createElement("th"); th.innerHTML = cell.innerHTML; cell.replaceWith(th);
      });
    });
    return converter.turndown(root).trim();
  }
  function render(value) {
    const root = document.createElement("div");
    root.innerHTML = clean(marked.parse(String(value || ""), { gfm: true, breaks: true, async: false }));
    root.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
    return root.innerHTML;
  }
  function fromClipboard(html, text) {
    // Prefer the original Markdown when supplied, otherwise convert the rich clipboard.
    if (!html || /(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/.test(text || "")) return String(text || "");
    return fromHtml(html);
  }
  window.TaskText = { clean, render, fromHtml, fromClipboard };
})();
