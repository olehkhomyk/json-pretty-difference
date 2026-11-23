const nativeInvoke = window.__TAURI__?.core?.invoke;

const state = {
  difference: false,
  diffExpanded: false,
  syncScroll: true,
  lastScrolledSide: "left",
  diffObject: "",
  left: createSideState(),
  right: createSideState(),
};

const pendingSyncedScroll = {
  left: null,
  right: null,
};

function createSideState() {
  return {
    text: "",
    displayText: "",
    lineMap: [1],
    foldRanges: new Map(),
    foldedLines: new Set(),
    valid: false,
    error: "",
    highlights: {},
    timer: null,
    requestId: 0,
  };
}

const elements = {
  workspace: document.getElementById("workspace"),
  toggle: document.getElementById("difference-toggle"),
  syncScrollControl: document.querySelector(".sync-scroll-toggle"),
  syncScrollToggle: document.getElementById("sync-scroll-toggle"),
  rightPanel: document.getElementById("right-panel"),
  compareEmpty: document.getElementById("compare-empty"),
  diffSection: document.getElementById("diff-section"),
  diffOutputWrap: document.getElementById("diff-output-wrap"),
  diffCollapseToggle: document.getElementById("diff-collapse-toggle"),
  diffOutput: document.getElementById("diff-output"),
  diffGutter: document.getElementById("diff-gutter"),
  differenceCount: document.getElementById("difference-count"),
  addedCount: document.getElementById("added-count"),
  removedCount: document.getElementById("removed-count"),
  changedCount: document.getElementById("changed-count"),
  copyDiff: document.getElementById("copy-diff"),
  toast: document.getElementById("toast"),
  left: sideElements("left"),
  right: sideElements("right"),
};

function sideElements(side) {
  return {
    input: document.getElementById(`${side}-input`),
    highlight: document.getElementById(`${side}-highlight`),
    gutter: document.getElementById(`${side}-gutter`),
    status: document.getElementById(`${side}-status`),
    error: document.getElementById(`${side}-error`),
    file: document.getElementById(`${side}-file`),
    panel: document.getElementById(`${side}-panel`),
  };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isNumberStart(text, index) {
  const character = text[index];
  return character === "-" || (character >= "0" && character <= "9");
}

function highlightLine(line, depthState, lineOffset = 0) {
  let output = "";
  let index = 0;

  while (index < line.length) {
    const character = line[index];

    if (character === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < line.length) {
        const current = line[end];
        if (!escaped && current === '"') {
          end += 1;
          break;
        }
        if (!escaped && current === "\\") {
          escaped = true;
        } else {
          escaped = false;
        }
        end += 1;
      }
      const token = line.slice(index, end);
      const remaining = line.slice(end);
      const kind = /^\s*:/.test(remaining) ? "token-key" : "token-string";
      output += `<span class="${kind}">${escapeHtml(token)}</span>`;
      index = end;
      continue;
    }

    if (isNumberStart(line, index)) {
      const match = line.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        output += `<span class="token-number">${match[0]}</span>`;
        index += match[0].length;
        continue;
      }
    }

    const literal = line.slice(index).match(/^(?:true|false|null)\b/);
    if (literal) {
      output += `<span class="token-literal">${literal[0]}</span>`;
      index += literal[0].length;
      continue;
    }

    if (character === "{" || character === "[") {
      const color = depthState.depth % 6;
      output += `<span class="bracket-${color}" data-bracket-index="${lineOffset + index}">${character}</span>`;
      depthState.depth += 1;
      index += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depthState.depth = Math.max(0, depthState.depth - 1);
      const color = depthState.depth % 6;
      output += `<span class="bracket-${color}" data-bracket-index="${lineOffset + index}">${character}</span>`;
      index += 1;
      continue;
    }

    if (character === "…") {
      output += '<span class="fold-placeholder">…</span>';
      index += 1;
      continue;
    }

    if (character === ":" || character === ",") {
      output += `<span class="token-punctuation">${character}</span>`;
      index += 1;
      continue;
    }

    output += escapeHtml(character);
    index += 1;
  }

  return output || "&nbsp;";
}

function renderCode(text, highlights = {}, lineMap = null) {
  const lines = text.split("\n");
  const depthState = { depth: 0 };
  let lineOffset = 0;
  return lines
    .map((line, index) => {
      const sourceLine = lineMap?.[index] || index + 1;
      const style = highlights[String(sourceLine)] || highlights[sourceLine] || "";
      const className = style ? `code-line line-${style}` : "code-line";
      const highlighted = highlightLine(line, depthState, lineOffset);
      lineOffset += line.length + 1;
      return `<span class="${className}">${highlighted}</span>`;
    })
    .join("");
}

function findFoldRanges(text) {
  const ranges = new Map();
  const stack = [];
  let line = 1;
  let column = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (!escaped && character === '"') inString = false;
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      stack.push({ character, line, column });
    } else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      const opening = stack.at(-1);
      if (opening?.character === expected) {
        stack.pop();
        if (line > opening.line) {
          ranges.set(opening.line, {
            startLine: opening.line,
            endLine: line,
            openColumn: opening.column,
            closeColumn: column,
            openCharacter: opening.character,
            closeCharacter: character,
          });
        }
      }
    }

    if (character === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }

  return ranges;
}

function buildProjection(sideState) {
  const sourceLines = sideState.text.split("\n");
  const foldRanges = findFoldRanges(sideState.text);

  for (const line of [...sideState.foldedLines]) {
    if (!foldRanges.has(line)) sideState.foldedLines.delete(line);
  }

  const displayLines = [];
  const lineMap = [];
  const controls = [];

  for (let sourceIndex = 0; sourceIndex < sourceLines.length;) {
    const sourceLine = sourceIndex + 1;
    const range = foldRanges.get(sourceLine);
    const collapsed = Boolean(range && sideState.foldedLines.has(sourceLine));

    if (collapsed) {
      const opening = sourceLines[sourceIndex].slice(0, range.openColumn + 1);
      const closingLine = sourceLines[range.endLine - 1] || "";
      const closing = closingLine.slice(range.closeColumn);
      displayLines.push(`${opening} … ${closing}`);
      lineMap.push(sourceLine);
      controls.push({ line: sourceLine, range, collapsed: true });
      sourceIndex = range.endLine;
      continue;
    }

    displayLines.push(sourceLines[sourceIndex]);
    lineMap.push(sourceLine);
    controls.push(range ? { line: sourceLine, range, collapsed: false } : null);
    sourceIndex += 1;
  }

  return {
    text: displayLines.join("\n"),
    lineMap,
    controls,
    foldRanges,
  };
}

function renderEditorGutter(side, projection) {
  elements[side].gutter.innerHTML = projection.lineMap
    .map((sourceLine, index) => {
      const control = projection.controls[index];
      const folding = control
        ? `<button class="fold-toggle${control.collapsed ? "" : " is-expanded"}" type="button" data-side="${side}" data-line="${sourceLine}" aria-expanded="${!control.collapsed}" aria-label="${control.collapsed ? "Expand" : "Collapse"} lines ${sourceLine} to ${control.range.endLine}" title="${control.collapsed ? "Expand" : "Collapse"} object"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"></path></svg></button>`
        : '<span class="fold-spacer"></span>';
      return `<div class="gutter-line">${folding}<span class="line-number">${sourceLine}</span></div>`;
    })
    .join("");
}

function renderGutter(element, lineCount, className = "gutter-line") {
  element.innerHTML = Array.from(
    { length: Math.max(1, lineCount) },
    (_, index) => `<div class="${className}">${index + 1}</div>`,
  ).join("");
}

function renderSide(side) {
  const sideState = state[side];
  const sideElements = elements[side];
  const projection = buildProjection(sideState);
  const selectionStart = sideElements.input.selectionStart || 0;
  const selectionEnd = sideElements.input.selectionEnd || selectionStart;

  sideState.displayText = projection.text;
  sideState.lineMap = projection.lineMap;
  sideState.foldRanges = projection.foldRanges;

  if (sideElements.input.value !== projection.text) {
    sideElements.input.value = projection.text;
    const maximumSelection = projection.text.length;
    sideElements.input.setSelectionRange(
      Math.min(selectionStart, maximumSelection),
      Math.min(selectionEnd, maximumSelection),
    );
  }
  sideElements.input.readOnly = sideState.foldedLines.size > 0;
  sideElements.input.title = sideElements.input.readOnly
    ? "Expand folded objects to edit JSON"
    : "";
  sideElements.highlight.innerHTML = renderCode(projection.text, sideState.highlights, projection.lineMap);
  renderEditorGutter(side, projection);
  syncEditorVisual(side);
  updateStatus(side);
  if (document.activeElement === sideElements.input) requestAnimationFrame(() => updateBracketMatch(side));
}

function updateStatus(side) {
  const sideState = state[side];
  const sideElements = elements[side];
  const isEmpty = !sideState.text.trim();

  sideElements.status.className = "validation-status";
  if (isEmpty) {
    sideElements.status.textContent = "Empty";
    sideElements.status.classList.add("empty");
  } else if (sideState.valid) {
    sideElements.status.textContent = "Valid JSON";
  } else {
    sideElements.status.textContent = "Invalid";
    sideElements.status.classList.add("invalid");
  }

  sideElements.error.hidden = !sideState.error || isEmpty;
  sideElements.error.textContent = sideState.error;
}

function syncEditorVisual(side) {
  const sideElements = elements[side];
  const { scrollTop, scrollLeft } = sideElements.input;
  sideElements.highlight.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  sideElements.gutter.scrollTop = scrollTop;
}

function editorLineHeight(input) {
  const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
  return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
}

function visibleRowForSourceLine(lineMap, sourceLine) {
  let low = 0;
  let high = lineMap.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineMap[middle] < sourceLine) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, lineMap.length - 1));
}

function syncEditorFrom(sourceSide) {
  if (!state.difference || !state.syncScroll) return;

  const targetSide = sourceSide === "left" ? "right" : "left";
  const source = elements[sourceSide].input;
  const target = elements[targetSide].input;
  const sourceRow = source.scrollTop / editorLineHeight(source);
  const sourceRowIndex = Math.min(Math.floor(sourceRow), Math.max(0, state[sourceSide].lineMap.length - 1));
  const sourceLine = state[sourceSide].lineMap[sourceRowIndex] || 1;
  const rowRemainder = sourceRow - Math.floor(sourceRow);
  const targetRow = visibleRowForSourceLine(state[targetSide].lineMap, sourceLine);
  const nextTop = Math.min(
    (targetRow + rowRemainder) * editorLineHeight(target),
    Math.max(0, target.scrollHeight - target.clientHeight),
  );
  const nextLeft = Math.min(source.scrollLeft, Math.max(0, target.scrollWidth - target.clientWidth));

  if (Math.abs(target.scrollTop - nextTop) < 0.5 && Math.abs(target.scrollLeft - nextLeft) < 0.5) {
    return;
  }

  const marker = { top: nextTop, left: nextLeft, expiresAt: performance.now() + 150 };
  pendingSyncedScroll[targetSide] = marker;
  target.scrollTop = nextTop;
  target.scrollLeft = nextLeft;
  syncEditorVisual(targetSide);
  setTimeout(() => {
    if (pendingSyncedScroll[targetSide] === marker) pendingSyncedScroll[targetSide] = null;
  }, 160);
}

function handleEditorScroll(side) {
  syncEditorVisual(side);

  const pending = pendingSyncedScroll[side];
  if (
    pending && performance.now() <= pending.expiresAt &&
    Math.abs(elements[side].input.scrollTop - pending.top) < 1 &&
    Math.abs(elements[side].input.scrollLeft - pending.left) < 1
  ) {
    return;
  }

  pendingSyncedScroll[side] = null;
  state.lastScrolledSide = side;
  syncEditorFrom(side);
}

function bracketPairs(text) {
  const pairs = new Map();
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (!escaped && character === '"') inString = false;
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push({ character, index });
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      const opening = stack.at(-1);
      if (opening?.character === expected) {
        stack.pop();
        pairs.set(opening.index, index);
        pairs.set(index, opening.index);
      }
    }
  }

  return pairs;
}

function clearBracketMatch(side) {
  elements[side].highlight.querySelectorAll(".bracket-match").forEach((element) => {
    element.classList.remove("bracket-match");
  });
}

function updateBracketMatch(side) {
  const sideElements = elements[side];
  const text = sideElements.input.value;
  const caret = sideElements.input.selectionStart || 0;
  const candidate = [caret, caret - 1].find((index) => "{}[]".includes(text[index] || ""));
  clearBracketMatch(side);
  if (candidate === undefined) return;

  const matching = bracketPairs(text).get(candidate);
  if (matching === undefined) return;

  for (const index of [candidate, matching]) {
    sideElements.highlight
      .querySelector(`[data-bracket-index="${index}"]`)
      ?.classList.add("bracket-match");
  }
}

function toggleFold(side, sourceLine) {
  const sideState = state[side];
  if (!sideState.foldRanges.has(sourceLine)) return;

  if (sideState.foldedLines.has(sourceLine)) sideState.foldedLines.delete(sourceLine);
  else sideState.foldedLines.add(sourceLine);

  renderSide(side);
  const visibleRow = visibleRowForSourceLine(sideState.lineMap, sourceLine);
  elements[side].input.scrollTop = Math.max(0, (visibleRow - 1) * editorLineHeight(elements[side].input));
  syncEditorVisual(side);
  syncEditorFrom(side);
}

function fallbackFormat(input) {
  if (!input.trim()) {
    return { valid: false, formatted: "", error: "Paste JSON or drop a .json file here" };
  }
  try {
    return { valid: true, formatted: JSON.stringify(JSON.parse(input), null, 2), error: null };
  } catch (error) {
    return { valid: false, formatted: input, error: error.message };
  }
}

function pathForKey(parent, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function fallbackChanges(left, right, path = "$", changes = []) {
  if (JSON.stringify(left) === JSON.stringify(right)) return changes;
  if (
    left && right && typeof left === "object" && typeof right === "object" &&
    !Array.isArray(left) && !Array.isArray(right)
  ) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const childPath = pathForKey(path, key);
      if (!(key in left)) changes.push({ path: childPath, operation: "added", after: right[key] });
      else if (!(key in right)) changes.push({ path: childPath, operation: "removed", before: left[key] });
      else fallbackChanges(left[key], right[key], childPath, changes);
    }
    return changes;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= left.length) changes.push({ path: childPath, operation: "added", after: right[index] });
      else if (index >= right.length) changes.push({ path: childPath, operation: "removed", before: left[index] });
      else fallbackChanges(left[index], right[index], childPath, changes);
    }
    return changes;
  }
  changes.push({ path, operation: "changed", before: left, after: right });
  return changes;
}

function findLinesForPath(text, path) {
  const keyMatch = path.match(/\.([A-Za-z_][A-Za-z0-9_]*)$/);
  const indexMatch = path.match(/\[(\d+)\]$/);
  const lines = text.split("\n");
  if (keyMatch) {
    const needle = `${JSON.stringify(keyMatch[1])}:`;
    const index = lines.findIndex((line) => line.includes(needle));
    return index >= 0 ? [index + 1] : [];
  }
  if (indexMatch) {
    const index = Number(indexMatch[1]);
    return index < lines.length ? [index + 2] : [];
  }
  return [1];
}

function fallbackDiff(leftInput, rightInput) {
  const leftResult = fallbackFormat(leftInput);
  const rightResult = fallbackFormat(rightInput);
  if (!leftResult.valid || !rightResult.valid) {
    return {
      valid: false,
      prettyLeft: leftInput,
      prettyRight: rightInput,
      errorLeft: leftResult.error,
      errorRight: rightResult.error,
      changes: [],
      diffObject: "",
      leftHighlights: {},
      rightHighlights: {},
    };
  }
  const changes = fallbackChanges(JSON.parse(leftInput), JSON.parse(rightInput));
  const leftHighlights = {};
  const rightHighlights = {};
  for (const change of changes) {
    if (change.operation === "added") {
      for (const line of findLinesForPath(rightResult.formatted, change.path)) rightHighlights[line] = "added";
    } else if (change.operation === "removed") {
      for (const line of findLinesForPath(leftResult.formatted, change.path)) leftHighlights[line] = "removed";
    } else {
      for (const line of findLinesForPath(leftResult.formatted, change.path)) leftHighlights[line] = "changed-before";
      for (const line of findLinesForPath(rightResult.formatted, change.path)) rightHighlights[line] = "changed-after";
    }
  }
  const summary = {
    total: changes.length,
    added: changes.filter((change) => change.operation === "added").length,
    removed: changes.filter((change) => change.operation === "removed").length,
    changed: changes.filter((change) => change.operation === "changed").length,
  };
  return {
    valid: true,
    prettyLeft: leftResult.formatted,
    prettyRight: rightResult.formatted,
    errorLeft: null,
    errorRight: null,
    changes,
    diffObject: JSON.stringify({ equal: changes.length === 0, summary, changes }, null, 2),
    leftHighlights,
    rightHighlights,
  };
}

async function invoke(command, args) {
  if (nativeInvoke) return nativeInvoke(command, args);
  if (command === "format_json") return fallbackFormat(args.input);
  if (command === "diff_json") return fallbackDiff(args.left, args.right);
  throw new Error(`Unknown command: ${command}`);
}

async function formatSide(side, options = {}) {
  const sideState = state[side];
  const inputText = sideState.text;
  const requestId = ++sideState.requestId;

  if (!inputText.trim()) {
    sideState.valid = false;
    sideState.error = "";
    sideState.highlights = {};
    renderSide(side);
    refreshCompareVisibility();
    return;
  }

  try {
    const result = await invoke("format_json", { input: inputText });
    if (requestId !== sideState.requestId || inputText !== sideState.text) return;
    sideState.valid = result.valid;
    sideState.error = result.error || "";
    if (result.valid && (options.force || options.auto !== false)) {
      sideState.text = result.formatted;
    }
    sideState.highlights = {};
    renderSide(side);
    if (state.difference) scheduleCompare();
  } catch (error) {
    sideState.valid = false;
    sideState.error = String(error);
    renderSide(side);
  }
}

let compareTimer = null;

function scheduleCompare(delay = 120) {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(runComparison, delay);
}

async function runComparison() {
  if (!state.difference) return;
  if (!state.left.text.trim() || !state.right.text.trim()) {
    refreshCompareVisibility();
    return;
  }

  try {
    const result = await invoke("diff_json", {
      left: state.left.text,
      right: state.right.text,
    });

    state.left.valid = !result.errorLeft;
    state.right.valid = !result.errorRight;
    state.left.error = result.errorLeft || "";
    state.right.error = result.errorRight || "";

    if (!result.valid) {
      state.left.highlights = {};
      state.right.highlights = {};
      renderSide("left");
      renderSide("right");
      refreshCompareVisibility();
      return;
    }

    state.left.text = result.prettyLeft;
    state.right.text = result.prettyRight;
    state.left.highlights = result.leftHighlights || {};
    state.right.highlights = result.rightHighlights || {};
    state.diffObject = result.diffObject;
    renderSide("left");
    renderSide("right");
    renderDiff(result);
  } catch (error) {
    showToast(`Could not compare: ${error}`);
  }
}

function renderDiff(result) {
  const changes = result.changes || [];
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) counts[change.operation] += 1;

  const diffDepth = { depth: 0 };
  elements.diffOutput.innerHTML = result.diffObject
    .split("\n")
    .map((line) => highlightLine(line, diffDepth))
    .join("\n");
  renderGutter(elements.diffGutter, result.diffObject.split("\n").length, "diff-gutter-line");
  elements.differenceCount.textContent = `${changes.length} ${changes.length === 1 ? "change" : "changes"}`;
  elements.addedCount.textContent = `+${counts.added}`;
  elements.removedCount.textContent = `−${counts.removed}`;
  elements.changedCount.textContent = `~${counts.changed}`;
  elements.compareEmpty.hidden = true;
  elements.diffSection.hidden = false;
  setDiffExpanded(state.diffExpanded);
}

function setDiffExpanded(expanded) {
  state.diffExpanded = expanded;
  elements.diffOutputWrap.hidden = !expanded;
  elements.diffCollapseToggle.setAttribute("aria-expanded", String(expanded));
  elements.diffCollapseToggle.querySelector("span").textContent = expanded ? "Hide details" : "Show details";
}

function refreshCompareVisibility() {
  if (!state.difference) {
    elements.compareEmpty.hidden = true;
    elements.diffSection.hidden = true;
    return;
  }
  const ready = state.left.valid && state.right.valid && state.left.text.trim() && state.right.text.trim();
  elements.compareEmpty.hidden = Boolean(ready);
  if (!ready) elements.diffSection.hidden = true;
}

function setDifferenceMode(enabled) {
  state.difference = enabled;
  if (!enabled) setDiffExpanded(false);
  elements.toggle.checked = enabled;
  elements.syncScrollControl.hidden = !enabled;
  elements.rightPanel.hidden = !enabled;
  elements.workspace.classList.toggle("single-mode", !enabled);
  document.getElementById("left-title").textContent = enabled ? "Original JSON" : "JSON";
  state.left.highlights = {};
  state.right.highlights = {};
  renderSide("left");
  renderSide("right");
  refreshCompareVisibility();
  if (enabled) {
    requestAnimationFrame(() => syncEditorFrom(state.lastScrolledSide));
    if (state.left.valid && state.right.valid) scheduleCompare(20);
    else if (!state.right.text.trim()) setTimeout(() => elements.right.input.focus(), 80);
  }
}

function handleInput(side) {
  const sideState = state[side];
  sideState.foldedLines.clear();
  sideState.text = elements[side].input.value;
  sideState.error = "";
  sideState.valid = false;
  sideState.highlights = {};
  clearTimeout(sideState.timer);
  renderSide(side);
  sideState.timer = setTimeout(() => formatSide(side, { auto: true }), 620);
  refreshCompareVisibility();
}

async function readFile(side, file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    showToast("This file is larger than 25 MB");
    return;
  }
  state[side].text = await file.text();
  state[side].foldedLines.clear();
  state[side].error = "";
  state[side].highlights = {};
  renderSide(side);
  await formatSide(side, { force: true });
  showToast(`Opened ${file.name}`);
}

async function copyText(text, successMessage) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = text;
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.appendChild(temporary);
    temporary.select();
    document.execCommand("copy");
    temporary.remove();
  }
  showToast(successMessage);
}

let toastTimer = null;

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 1800);
}

for (const side of ["left", "right"]) {
  elements[side].input.addEventListener("input", () => handleInput(side));
  elements[side].input.addEventListener("scroll", () => handleEditorScroll(side));
  elements[side].input.addEventListener("click", () => requestAnimationFrame(() => updateBracketMatch(side)));
  elements[side].input.addEventListener("keyup", () => updateBracketMatch(side));
  elements[side].input.addEventListener("select", () => updateBracketMatch(side));
  elements[side].input.addEventListener("blur", () => clearBracketMatch(side));
  elements[side].input.addEventListener("keydown", (event) => {
    if (!elements[side].input.readOnly) return;
    const modifiesText = event.key.length === 1 || ["Backspace", "Delete", "Enter"].includes(event.key) ||
      ((event.metaKey || event.ctrlKey) && ["v", "x"].includes(event.key.toLowerCase()));
    if (modifiesText) showToast("Expand folded objects to edit JSON");
  });
  elements[side].gutter.addEventListener("click", (event) => {
    const button = event.target.closest(".fold-toggle");
    if (!button) return;
    toggleFold(side, Number(button.dataset.line));
    elements[side].input.focus({ preventScroll: true });
  });
  elements[side].file.addEventListener("change", (event) => {
    readFile(side, event.target.files?.[0]);
    event.target.value = "";
  });

  const dropSurface = document.querySelector(`.drop-surface[data-side="${side}"]`);
  dropSurface.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropSurface.classList.add("is-dragging");
  });
  dropSurface.addEventListener("dragleave", () => dropSurface.classList.remove("is-dragging"));
  dropSurface.addEventListener("drop", (event) => {
    event.preventDefault();
    dropSurface.classList.remove("is-dragging");
    readFile(side, event.dataTransfer?.files?.[0]);
  });
}

document.querySelectorAll(".open-button").forEach((button) => {
  button.addEventListener("click", () => elements[button.dataset.side].file.click());
});

document.querySelectorAll(".format-button").forEach((button) => {
  button.addEventListener("click", () => formatSide(button.dataset.side, { force: true }));
});

document.querySelectorAll(".copy-button").forEach((button) => {
  button.addEventListener("click", () => copyText(state[button.dataset.side].text, "JSON copied"));
});

document.querySelectorAll(".clear-button").forEach((button) => {
  button.addEventListener("click", () => {
    const side = button.dataset.side;
    state[side] = createSideState();
    renderSide(side);
    refreshCompareVisibility();
    elements[side].input.focus();
  });
});

elements.toggle.addEventListener("change", () => setDifferenceMode(elements.toggle.checked));
elements.syncScrollToggle.addEventListener("change", () => {
  state.syncScroll = elements.syncScrollToggle.checked;
  pendingSyncedScroll.left = null;
  pendingSyncedScroll.right = null;
  if (state.syncScroll) {
    requestAnimationFrame(() => syncEditorFrom(state.lastScrolledSide));
  }
});
elements.copyDiff.addEventListener("click", () => copyText(state.diffObject, "Difference object copied"));
elements.diffCollapseToggle.addEventListener("click", () => setDiffExpanded(!state.diffExpanded));

document.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey;
  if (command && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    const side = document.activeElement === elements.right.input ? "right" : "left";
    formatSide(side, { force: true });
  } else if (command && event.key.toLowerCase() === "d") {
    event.preventDefault();
    setDifferenceMode(!state.difference);
  } else if (command && event.key === "Enter") {
    event.preventDefault();
    if (state.difference) runComparison();
  }
});

renderSide("left");
renderSide("right");
elements.syncScrollToggle.checked = state.syncScroll;
setDifferenceMode(false);

