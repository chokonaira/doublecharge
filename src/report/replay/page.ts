// The Replay's page: draws a case from what logic.ts works out, and plays it back. Every node is built
// through the DOM with textContent; nothing from a trace, a reply or a model's code is ever parsed as HTML.
import {
  answerView,
  attemptOf,
  buildLayout,
  caseFromHash,
  caseLabel,
  choiceCount,
  codeOwner,
  describe,
  filterChoices,
  intro,
  laneOf,
  ledger,
  ledgerTotal,
  nameOf,
  prettyJson,
  serviceOf,
  shortCall,
  shortResult,
  stampFor,
  stepCase,
  subtitle,
  tone,
  visibleIds,
  type Episode,
  type Filters,
  type Layout,
  type ReplayData,
  type TraceEntry,
  type Words,
} from "./logic.ts";

// ---- DOM helpers ------------------------------------------------------------------------------------

/** The page's element with this id, checked to be of the expected kind. */
function $(id: string): HTMLElement;
function $<T extends HTMLElement>(id: string, kind: new () => T): T;
function $(id: string, kind: new () => HTMLElement = HTMLElement): HTMLElement {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) throw new Error(`the page has no #${id} of the expected kind`);
  return found;
}

interface Props {
  className?: string;
  text?: string;
  title?: string;
  /** CSS properties and custom properties, set with style.setProperty. */
  style?: Record<string, string>;
  attrs?: Record<string, string>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [name, value] of Object.entries(props.style ?? {})) node.style.setProperty(name, value);
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const words = (parts: Words): (Node | string)[] =>
  parts.map((part) => (typeof part === "string" ? part : "strong" in part ? el("b", { text: part.strong }) : el("code", { text: part.code })));

// ---- State ------------------------------------------------------------------------------------------

const DATA = JSON.parse($("data").textContent ?? "{}") as ReplayData;
const byId = new Map(DATA.episodes.map((e) => [e.id, e]));
const featured = new Map(DATA.featured.map((f) => [f.id, f]));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LANE_COLORS = 6;

let ep: Episode = byId.get(DATA.featured[0]!.id)!;
let layout: Layout = buildLayout(ep);
let step = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const laneColor = (lane: string) => `var(--lane-${(layout.lanes.indexOf(lane) % LANE_COLORS) + 1})`;
const playing = () => timer !== undefined;

// ---- Drawing a case ---------------------------------------------------------------------------------

function row(e: TraceEntry, index: number): HTMLDivElement {
  const node = el("div", { className: "row", attrs: { "data-i": String(index) } });
  if (e.call === "trace cut") {
    node.append(el("div", { className: "note-row", text: e.result }));
    return node;
  }
  const lane = laneOf(e.actor);
  const color = laneColor(lane);
  const from = layout.col(lane);
  const attempt = attemptOf(e.actor);
  if (attempt) node.append(el("span", { className: "who", text: attempt, style: { "--c": color } }));
  if (e.call === "instance killed") {
    node.append(el("div", { className: "kill", style: { "grid-column": String(from) } }, el("i", { text: "✕", attrs: { "aria-hidden": "true" } }), "server killed"));
    return node;
  }
  if (e.call === "answer") {
    const view = answerView(e, ep);
    node.append(
      el(
        "div",
        { className: "msg left", style: { "grid-column": `1 / ${from + 1}`, "--c": color, "--span": String(from), "--from": "right" } },
        el("div", { className: "call", text: view.label }),
        el("div", { className: "line" }),
        el("div", { className: `res${view.wrong ? " bad" : ""}`, text: view.text }),
      ),
    );
    return node;
  }
  const service = serviceOf(e.call);
  const to = service ? layout.col(service) : from;
  const call = el("div", { className: "call", text: shortCall(e.call) });
  if (e.times) call.append(el("b", { className: "times", text: ` ×${e.times}` }));
  node.append(
    el(
      "div",
      {
        className: "msg right",
        title: `${e.call}\n→ ${e.result}${e.times ? `\n${e.times} times in a row` : ""}`,
        style: { "grid-column": `${from} / ${to + 1}`, "--c": color, "--span": String(to - from + 1) },
      },
      call,
      el("div", { className: "line" }),
      el("div", { className: `res ${tone(e)}`.trim(), text: shortResult(e) }),
    ),
  );
  return node;
}

const STATEMENT: Record<string, [string, string]> = {
  checkout: ["Card statement", "What PayCo charged the customer’s card, as it happens"],
  "wallet-withdraw": ["Bank and wallet", "What PayCo paid out to the user’s bank, as it happens"],
  "webhook-handler": ["Shipments", "What Shipping sent out, as it happens"],
};

function openCase(id: string, { play = true }: { play?: boolean } = {}): void {
  stop();
  ep = byId.get(id) ?? byId.get(DATA.featured[0]!.id)!;
  layout = buildLayout(ep);
  const f = featured.get(ep.id);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".case-btn")) button.setAttribute("aria-current", String(button.dataset.id === ep.id));
  $("pick", HTMLSelectElement).value = ep.id;
  try {
    history.replaceState(null, "", `#${ep.id}`);
  } catch {
    // a sandboxed frame may refuse; the page works without it
  }

  const chips = [ep.part === 1 ? "Part 1: writing" : "Part 2: reviewing", ep.task, `trial ${ep.trial}`];
  if (ep.part === 1) chips.splice(1, 0, `code by ${nameOf(ep.model)}`);
  else chips.splice(1, 0, `reviewer ${nameOf(ep.model)}`, `code: ${codeOwner(ep)}`);
  $("chips").replaceChildren(...chips.map((c) => el("span", { className: "chip", text: c })));
  $("title").textContent = f ? f.title : ep.part === 1 ? (ep.scenario ?? ep.id) : `${nameOf(ep.model)} attacks ${codeOwner(ep)}`;
  $("caption").textContent = f
    ? f.caption
    : ep.part === 1
      ? `A scenario ${nameOf(ep.model)}’s ${ep.task} code failed in Part 1.`
      : ep.summary
        ? `The reviewer’s claim, in its own words: ${ep.summary}`
        : "";

  $("court").hidden = ep.part !== 2;
  if (ep.part === 2) {
    $("claim").textContent = `${nameOf(ep.model)}: unsafe`;
    $("claim-words").textContent = ep.summary ?? "";
    $("claim-words").title = ep.summary ?? "";
    $("claim-words").hidden = !ep.summary;
    $("evidence").textContent = `An attack the grader ran ${ep.how === "in another interleaving" ? "in another interleaving of its requests" : "as written"}`;
    $("ruling").textContent = ep.outcome === "broken" ? "Confirmed: a rule broke" : "Overruled: every rule held";
    $("ruling").className = `v ${ep.outcome}`;
  }

  $("diagram").style.setProperty("--cols", String(layout.cols.length));
  $("lanes").replaceChildren(
    ...layout.cols.map((name, i) => {
      const isLane = layout.lanes.includes(name);
      const head = el("div", { className: `lane-head${layout.isService(name) ? " svc" : ""}`, text: name, style: isLane ? { color: laneColor(name) } : {} });
      if (i === 0) head.append(el("small", { text: "who is waiting" }));
      else if (isLane) head.append(el("small", { text: "request" }));
      return head;
    }),
  );
  $("lifelines").replaceChildren(...layout.cols.map((name) => el("span", { className: layout.isService(name) ? "svc" : "" })));
  $("rows").replaceChildren(...ep.trace.map(row));

  const [title, sub] = STATEMENT[ep.task] ?? ["Ledger", ""];
  $("st-title").textContent = title;
  $("st-sub").textContent = sub;

  $("code").textContent = DATA.codes[ep.code] ?? "";
  $("code-note").textContent = ep.part === 1 ? `The code ${nameOf(ep.model)} wrote for ${ep.task}, trial ${ep.trial}, exactly as graded.` : `The code under review: ${codeOwner(ep)}.`;
  $("t-attack").hidden = ep.part !== 2;
  if (ep.part !== 2 && $("t-attack").getAttribute("aria-selected") === "true") selectTab("code");
  $("attack").textContent = ep.attack ? prettyJson(ep.attack) : "";
  $("attack-note").textContent = ep.part === 2 ? `The attack ${nameOf(ep.model)} wrote to prove its claim, in DoubleCharge’s attack language.` : "";
  $("trace").textContent = ep.trace.map((e) => `${e.actor.padEnd(24)} ${e.call}${e.times ? `  ×${e.times}` : ""}\n${" ".repeat(25)}→ ${e.result}`).join("\n");

  $("scrub", HTMLInputElement).max = String(ep.trace.length);
  $("diagram-scroll").scrollTop = 0;
  if (player.open) labelPlayer();
  fitDiagram();
  if (play && !reduced) {
    seek(0);
    start();
  } else seek(ep.trace.length, { quiet: true });
}

function seek(target: number, { quiet = false }: { quiet?: boolean } = {}): void {
  const previous = step;
  step = Math.max(0, Math.min(target, ep.trace.length));
  const rows = [...$("rows").children] as HTMLElement[];
  rows.forEach((r, i) => {
    const shown = i < step;
    r.hidden = !shown;
    r.classList.toggle("current", i === step - 1);
    r.classList.toggle("enter", shown && !quiet && i >= previous && i === step - 1);
  });
  const current = rows[step - 1];
  if (current && !quiet) follow(current);
  $("scrub", HTMLInputElement).value = String(step);
  $("stepcount").textContent = `${step} / ${ep.trace.length}`;
  if (!playing()) $("b-play").textContent = step >= ep.trace.length ? "Replay" : "Play";
  narrate();
  drawLedger(quiet ? -1 : previous);
  drawVerdict(!quiet && step === ep.trace.length && previous < step);
}

/** Keeps the newest row in sight by scrolling the diagram alone: the page never moves on its own. */
function follow(row: HTMLElement): void {
  const box = $("diagram-scroll");
  const view = box.getBoundingClientRect();
  const at = row.getBoundingClientRect();
  // The lane heads stay at the top of the diagram, over the rows that scroll under them, and a
  // horizontal scrollbar takes the bottom.
  const covered = $("lanes").offsetHeight;
  const bottom = view.top + box.clientHeight;
  const behavior = reduced ? "auto" : "smooth";
  if (at.bottom > bottom) box.scrollBy({ top: at.bottom - bottom + 8, behavior });
  else if (at.top < view.top + covered) box.scrollBy({ top: at.top - view.top - covered - 8, behavior });
}

/**
 * Sizes the diagram to end at the bottom of the first screen, and no taller than its whole trace, so a
 * case plays where the viewer landed: its rows scroll inside the diagram, which keeps one size while it
 * plays, and the page scrolls only when the viewer scrolls it. Where the diagram starts too low for that,
 * it keeps the stylesheet's height, and plays once it is scrolled into view.
 */
const FIT_MIN = 200;
function fitDiagram(): void {
  const box = $("diagram-scroll");
  const rows = [...$("rows").children] as HTMLElement[];
  const hidden = rows.map((r) => r.hidden);
  box.style.height = "";
  for (const r of rows) r.hidden = false;
  const full = box.scrollHeight;
  rows.forEach((r, i) => (r.hidden = hidden[i]!));
  const room = innerHeight - (box.getBoundingClientRect().top + scrollY) - 20;
  // Either way the height is fixed while a case plays, so the page below never moves as rows appear.
  const most = room >= FIT_MIN ? room : parseFloat(getComputedStyle(box).maxHeight) || full;
  box.style.height = `${Math.min(full, most)}px`;
}
// A phone's address bar showing and hiding changes the height as the viewer scrolls; only a real change
// of the window refits the diagram.
const coarse = matchMedia("(pointer: coarse)").matches;
let fitted = { width: innerWidth, height: innerHeight };
let fitQueued = false;
addEventListener("resize", () => {
  const grew = Math.abs(innerHeight - fitted.height);
  if (fitQueued || (innerWidth === fitted.width && coarse && grew < 160)) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitted = { width: innerWidth, height: innerHeight };
    fitDiagram();
  });
});
void document.fonts?.ready.then(fitDiagram);

function narrate(): void {
  const narration = $("narration");
  if (step === 0) {
    narration.replaceChildren("Press ", el("b", { text: "Play" }), " to watch the run call by call.");
    return;
  }
  const e = ep.trace[step - 1]!;
  narration.replaceChildren(...(e.call === "trace cut" ? [] : [el("b", { text: e.actor }), " "]), ...words(describe(e)));
  // On a wide stage it is held to two lines; the whole of a long step is its tooltip.
  narration.title = narration.textContent ?? "";
}

function drawLedger(previous: number): void {
  const l = ledger(ep, step);
  $("lines").replaceChildren(
    ...(l.lines.length === 0
      ? [el("li", { className: "empty", text: "Nothing yet." })]
      : l.lines.map((line) =>
          el(
            "li",
            { className: `${line.kind}${previous >= 0 && line.step >= previous ? " enter" : ""}`.trim() },
            el("span", { text: line.text }),
            el("span", { className: "amt", text: line.amount }),
          ),
        )),
  );
  const total = ledgerTotal(ep.task, l);
  const node = $("total");
  node.className = `total${total.bad ? " bad" : ""}`;
  node.replaceChildren(el("span", { text: total.label }), el("span", { text: total.value }));
}

function drawVerdict(land: boolean): void {
  const stampEl = $("stamp");
  const done = step === ep.trace.length;
  $("withdrawn").hidden = !(done && ep.overturned);
  if (!done) {
    stampEl.className = "stamp pending";
    stampEl.textContent = "Plays at the end";
    $("words").textContent = "";
    return;
  }
  const stamp = stampFor(ep);
  stampEl.className = `stamp${stamp.held ? " held" : ""}${ep.overturned ? " withdrawn" : ""}${land ? " land" : ""}`;
  stampEl.textContent = stamp.text;
  $("words").textContent = `The grader’s words: ${ep.detail}${ep.how ? ` (found ${ep.how})` : ""}`;
  if (ep.overturned) $("withdrawn").textContent = `Withdrawn. ${ep.overturned}`;
  if (land) {
    const sheet = $("stage-sheet");
    sheet.classList.remove("shake");
    void sheet.offsetWidth;
    if (ep.outcome === "broken" && !ep.overturned) sheet.classList.add("shake");
  }
}

// ---- Playback ---------------------------------------------------------------------------------------

function start(): void {
  if (step >= ep.trace.length) seek(0);
  $("b-play").textContent = "Pause";
  const tick = () => {
    if (step >= ep.trace.length) return stop();
    seek(step + 1);
    timer = setTimeout(tick, Number($("speed", HTMLSelectElement).value));
  };
  timer = setTimeout(tick, 250);
}

function stop(): void {
  clearTimeout(timer);
  timer = undefined;
  $("b-play").textContent = step >= ep.trace.length ? "Replay" : "Play";
}

$("b-play").addEventListener("click", () => (playing() ? stop() : start()));
/** Stops playback and goes to a step. */
function goTo(target: number): void {
  stop();
  seek(target);
}
$("b-start").addEventListener("click", () => goTo(0));
$("b-end").addEventListener("click", () => goTo(ep.trace.length));
$("b-back").addEventListener("click", () => goTo(step - 1));
$("b-fwd").addEventListener("click", () => goTo(step + 1));
$("scrub", HTMLInputElement).addEventListener("input", (event) => {
  stop();
  seek(Number((event.target as HTMLInputElement).value), { quiet: true });
  drawVerdict(false);
});

document.addEventListener("keydown", (event) => {
  const target = event.target as Element;
  // [ and ] also work from the rail's radios, and with Option or AltGr, which type them on German keyboards.
  const caseKey = event.key === "[" || event.key === "]";
  if (target.closest(caseKey ? "input:not([type=radio]), select, textarea" : "input, select, textarea")) return;
  if (event.metaKey || (!caseKey && (event.ctrlKey || event.altKey))) return;
  if (event.key === " ") {
    if (target.closest("button, a, [role=tab]")) return;
    event.preventDefault();
    if (playing()) stop();
    else start();
  } else if (event.key === "ArrowRight") goTo(step + 1);
  else if (event.key === "ArrowLeft") goTo(step - 1);
  else if (event.key === "Home") goTo(0);
  else if (event.key === "End") goTo(ep.trace.length);
  else if (caseKey) {
    const next = stepCase(listedIds(), ep.id, event.key === "]");
    if (next) openCase(next);
  }
});

// ---- Tabs -------------------------------------------------------------------------------------------

const TABS = ["code", "attack", "trace"] as const;
function selectTab(name: (typeof TABS)[number]): void {
  for (const tab of TABS) {
    $(`t-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`p-${tab}`).hidden = tab !== name;
  }
}
for (const tab of TABS) $(`t-${tab}`).addEventListener("click", () => selectTab(tab));

// ---- The list of cases ------------------------------------------------------------------------------

function caseButton(e: Episode, label: string, sub: string): HTMLLIElement {
  const dot = e.overturned ? "withdrawn" : e.outcome === "held" ? "held" : "";
  const button = el(
    "button",
    { className: "case-btn", attrs: { type: "button", "data-id": e.id } },
    el("span", { className: `dot ${dot}`.trim(), attrs: { "aria-hidden": "true" } }),
    el("b", { text: label }),
    el("small", { text: sub }),
  );
  button.addEventListener("click", () => openCase(e.id));
  return el("li", {}, button);
}

// The rail lists either the seven featured cases or every case; the filters narrow every case, and each
// choice says how many cases it would list, so a choice that lists none is plain before it is picked.
// The radios opt out of the browser's form restore: restored after this script has drawn the rail, they
// would show one list while [ and ] stepped through another.
type View = "start" | "all";
const FILTER_KEYS = ["part", "model", "outcome"] as const;
const rail = $("rail");
const railHead = $("rail-head");
const checkedValue = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "";
const view = (): View => (checkedValue("view") === "all" ? "all" : "start");
const filters = (): Filters => ({ part: checkedValue("f-part"), model: checkedValue("f-model"), outcome: checkedValue("f-outcome") });
/** The cases [ and ] step through: what the rail lists, or every case where a phone's picker stands in for it. */
const listedIds = (): string[] =>
  getComputedStyle(rail).display === "none"
    ? DATA.episodes.map((e) => e.id)
    : view() === "start"
      ? DATA.featured.map((f) => f.id)
      : visibleIds(DATA.episodes, filters());

const choiceInputs = new Map<string, { input: HTMLInputElement; label: string; count: HTMLElement }>();
for (const [key, choices] of Object.entries(filterChoices(DATA.episodes)) as [keyof Filters, [string, string][]][]) {
  $(`f-${key}`).replaceChildren(
    ...choices.map(([value, label]) => {
      const input = el("input", { attrs: { type: "radio", name: `f-${key}`, value, autocomplete: "off" } });
      input.checked = value === "";
      const count = el("i", { attrs: { "aria-hidden": "true" } });
      choiceInputs.set(`${key}=${value}`, { input, label, count });
      return el("label", { className: "opt" }, input, el("span", {}, label, " ", count));
    }),
  );
}

/** Scrolls the rail to the open case, below the filters that stay on top of the list. */
function revealCurrent(): void {
  const button = document.querySelector<HTMLElement>(`#${view() === "all" ? "all" : "featured"} .case-btn[aria-current="true"]`);
  const covered = getComputedStyle(railHead).position === "sticky" ? railHead.offsetHeight : 0;
  rail.scrollTop = button ? button.offsetTop - covered - 8 : 0;
}

function drawList(): void {
  const f = filters();
  const ids = visibleIds(DATA.episodes, f);
  const all = view() === "all";
  $("all").replaceChildren(
    ...ids.map((id) => {
      const e = byId.get(id)!;
      const { label, sub } = caseLabel(e);
      return caseButton(e, label, sub);
    }),
  );
  for (const key of FILTER_KEYS) {
    for (const [value] of filterChoices(DATA.episodes)[key]) {
      const n = choiceCount(DATA.episodes, f, key, value);
      const choice = choiceInputs.get(`${key}=${value}`)!;
      choice.count.textContent = String(n);
      choice.input.setAttribute("aria-label", `${choice.label}, ${n} ${n === 1 ? "case" : "cases"}`);
      choice.input.closest("label")!.classList.toggle("empty", n === 0);
    }
  }
  const narrowed = FILTER_KEYS.some((key) => f[key] !== "");
  $("count").textContent = narrowed ? `${ids.length} of ${DATA.episodes.length} cases` : `All ${DATA.episodes.length} cases`;
  $("clear").hidden = !narrowed;
  $("featured").hidden = all;
  $("note-start").hidden = all;
  $("facets").hidden = !all;
  $("all").hidden = !all;
  $("none").hidden = !all || ids.length > 0;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".case-btn")) button.setAttribute("aria-current", String(button.dataset.id === ep.id));
  fitScrollPadding();
}

/** A case reached by Tab stops below the filters, not under them; on a short screen they scroll away instead. */
function fitScrollPadding(): void {
  rail.style.scrollPaddingTop = getComputedStyle(railHead).position === "sticky" ? `${railHead.offsetHeight + 8}px` : "";
}
addEventListener("resize", fitScrollPadding);

// ---- The rail's width ------------------------------------------------------------------------------

const RAIL = { min: 240, normal: 320, max: 560, key: "doublecharge-replay-rail" };
// The stage widths the stylesheet's container query and the diagram's lanes need.
const STAGE = { wide: 860, min: 640 };
const layoutBox = document.querySelector<HTMLElement>(".layout")!;
const resizer = $("rail-resize");
/** The width the viewer chose, and the width the window allows it now. */
let railChosen = RAIL.normal;
let railWidth = RAIL.normal;
/**
 * The widest the rail can be: wide enough to keep the case file beside the diagram, where the screen
 * has room for both at the usual width, and otherwise to leave the stage a diagram of five lanes.
 */
function railMax(): number {
  const room = layoutBox.clientWidth - 28; // the handle and the gaps either side of it
  // Where the case file fits beside the diagram at the usual width, it stays there; on a narrower screen the
  // rail can narrow, but not widen past the usual width, so a wider window never allows a narrower rail.
  const max = room - RAIL.normal >= STAGE.wide ? room - STAGE.wide : Math.min(room - STAGE.min, RAIL.normal);
  return Math.max(RAIL.min, Math.min(RAIL.max, max));
}

/** Applies the chosen width within what the window allows; a narrow window does not change the choice. */
function setRail(width: number, { save = false, fit = true }: { save?: boolean; fit?: boolean } = {}): void {
  railChosen = Math.round(Math.max(RAIL.min, Math.min(railMax(), width)));
  applyRail({ fit });
  if (save) {
    try {
      if (railChosen === RAIL.normal) localStorage.removeItem(RAIL.key);
      else localStorage.setItem(RAIL.key, String(railChosen));
    } catch {
      // Storage can be off; the width then lasts until the page is closed.
    }
  }
}

function applyRail({ fit = true }: { fit?: boolean } = {}): void {
  railWidth = Math.round(Math.max(RAIL.min, Math.min(railMax(), railChosen)));
  layoutBox.style.setProperty("--rail-w", `${railWidth}px`);
  resizer.setAttribute("aria-valuemin", String(RAIL.min));
  resizer.setAttribute("aria-valuemax", String(railMax()));
  resizer.setAttribute("aria-valuenow", String(railWidth));
  fitScrollPadding();
  if (fit) fitDiagram();
}

resizer.addEventListener("pointerdown", (down) => {
  if (down.button !== 0) return;
  down.preventDefault();
  resizer.setPointerCapture(down.pointerId);
  resizer.classList.add("dragging");
  document.documentElement.classList.add("resizing");
  const from = railWidth;
  // The diagram is refitted once, when the drag ends, not on every move.
  const move = (event: PointerEvent) => setRail(from + event.clientX - down.clientX, { fit: false });
  const end = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", end);
    resizer.removeEventListener("pointercancel", end);
    resizer.removeEventListener("lostpointercapture", end);
    resizer.classList.remove("dragging");
    document.documentElement.classList.remove("resizing");
    setRail(railWidth, { save: true });
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", end);
  resizer.addEventListener("pointercancel", end);
  resizer.addEventListener("lostpointercapture", end);
});
resizer.addEventListener("dblclick", () => setRail(RAIL.normal, { save: true }));
// Its own keys, which must not also step the trace.
resizer.addEventListener("keydown", (event) => {
  // Shortcuts held with Alt, Control or Command are the browser's (Alt+Left is Back), not a resize.
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const by = event.shiftKey ? 64 : 16;
  const to =
    event.key === "ArrowLeft" ? railWidth - by
    : event.key === "ArrowRight" ? railWidth + by
    : event.key === "Home" ? RAIL.min
    : event.key === "End" ? railMax()
    : event.key === "Enter" ? RAIL.normal
    : undefined;
  if (to === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  setRail(to, { save: true });
});
addEventListener("resize", () => applyRail({ fit: false }));

let savedRail = NaN;
try {
  savedRail = Number(localStorage.getItem(RAIL.key));
} catch {
  // As above: no storage, no remembered width.
}
setRail(Number.isFinite(savedRail) && savedRail > 0 ? savedRail : RAIL.normal);

$("featured").replaceChildren(...DATA.featured.map((f) => caseButton(byId.get(f.id)!, f.title, subtitle(byId.get(f.id)!))));
$("n-start").textContent = String(DATA.featured.length);
$("n-all").textContent = String(DATA.episodes.length);

// A radio picked with the mouse gives its focus back, so the arrow keys go on stepping the trace rather than
// flipping the filter; picked from the keyboard, it keeps focus, as a radio should.
let pickedByPointer = false;
railHead.addEventListener("pointerdown", () => (pickedByPointer = true));
railHead.addEventListener("keydown", () => (pickedByPointer = false));
railHead.addEventListener("change", (event) => {
  drawList();
  // A new list starts at its top; a switch of view starts at the open case, if the list holds it.
  if ((event.target as HTMLInputElement).name === "view") revealCurrent();
  else rail.scrollTop = 0;
  if (pickedByPointer) (event.target as HTMLInputElement).blur();
});
$("clear").addEventListener("click", () => {
  for (const key of FILTER_KEYS) choiceInputs.get(`${key}=`)!.input.checked = true;
  drawList();
  rail.scrollTop = 0;
  choiceInputs.get("part=")!.input.focus();
});
drawList();

// On a phone, one picker with the featured cases first.
$("pick").replaceChildren(
  el("optgroup", { attrs: { label: "Start here" } }, ...DATA.featured.map((f) => el("option", { text: f.title, attrs: { value: f.id } }))),
  el(
    "optgroup",
    { attrs: { label: "Every case" } },
    ...DATA.episodes.map((e) =>
      el("option", {
        text: e.part === 1 ? `${nameOf(e.model)}: ${e.scenario ?? e.id}` : `${nameOf(e.model)} vs ${(e.sample ?? "").replace(`${e.task}--`, "")} (t${e.trial})`,
        attrs: { value: e.id },
      }),
    ),
  ),
);
$("pick", HTMLSelectElement).addEventListener("change", (event) => openCase((event.target as HTMLSelectElement).value));

// ---- On a phone, the player as a sheet ----------------------------------------------------------------

// The page's own controls, diagram, total and stamp move into the sheet while it is open and back when it
// closes, so there is one player, on whichever screen it is shown.
// A browser without <dialog> keeps the player on the page, and the button that opens the sheet is not shown.
const player = $("player") as HTMLDialogElement;
const canSheet = typeof player.showModal === "function";
$("b-watch").hidden = !canSheet;
const phone = matchMedia("(max-width: 860px)");
const toSheet: [HTMLElement, HTMLElement][] = [
  [$("transport"), $("player-body")],
  [$("narration"), $("player-body")],
  [$("stage-sheet"), $("player-body")],
  [$("total"), $("player-money")],
  [$("stamp"), $("player-money")],
];
const homes: Comment[] = [];

function labelPlayer(): void {
  $("player-title").textContent = $("title").textContent;
  $("player-money-k").textContent = $("st-title").textContent;
}

function restorePlayer(): void {
  if (homes.length === 0) return;
  toSheet.forEach(([node], i) => homes[i]?.replaceWith(node));
  homes.length = 0;
  fitDiagram();
}

function openPlayer(): void {
  if (!canSheet || player.open) return;
  restorePlayer();
  labelPlayer();
  for (const [node, into] of toSheet) {
    const home = document.createComment("");
    node.before(home);
    homes.push(home);
    into.append(node);
  }
  player.showModal();
  $("b-play").focus();
  // It opens to play the case from the start, unless the viewer prefers less motion.
  if (!reduced) {
    stop();
    seek(0);
    start();
  }
}

player.addEventListener("close", () => {
  if (player.open) return;
  stop();
  player.style.transform = "";
  restorePlayer();
  // Focus goes back to the button that opened the sheet; if that is hidden now, to the page's play button.
  if (document.activeElement === document.body) $("b-play").focus({ preventScroll: true });
});
$("b-watch").addEventListener("click", openPlayer);
$("player-close").addEventListener("click", () => player.close());
// A tap on the dimmed page above the sheet closes it: one that starts there, so a click from the keyboard
// (which has no position) or a drag that ends there does not.
let downAbove = false;
const above = (event: MouseEvent) => event.target === player && event.clientY < player.getBoundingClientRect().top;
player.addEventListener("pointerdown", (event) => (downAbove = above(event)));
player.addEventListener("click", (event) => {
  if (downAbove && above(event)) player.close();
  downAbove = false;
});
// So does pulling the sheet down by its top.
$("player-head").addEventListener("pointerdown", (down) => {
  if (down.button !== 0 || (down.target as Element).closest("button")) return;
  const head = $("player-head");
  head.setPointerCapture(down.pointerId);
  player.style.transition = "none";
  const pulled = (event: PointerEvent) => Math.max(0, event.clientY - down.clientY);
  const move = (event: PointerEvent) => (player.style.transform = `translateY(${pulled(event)}px)`);
  const end = (event: PointerEvent) => {
    head.removeEventListener("pointermove", move);
    head.removeEventListener("pointerup", end);
    head.removeEventListener("pointercancel", end);
    player.style.transition = "";
    if (event.type === "pointerup" && pulled(event) > 90) player.close();
    else player.style.transform = "";
  };
  head.addEventListener("pointermove", move);
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
});
// A screen that turns wide enough for the stage puts the player back on the page.
phone.addEventListener("change", () => {
  if (!phone.matches && player.open) player.close();
});

// ---- Opening line, footer and first case -------------------------------------------------------------

$("intro").textContent = intro(DATA);
$("foot").replaceChildren(
  el(
    "p",
    {},
    "Built by ",
    el("code", { text: "npm run replay" }),
    ` from the published runs (Part 1 started ${DATA.runs.eval.startedAt.slice(0, 10)} at commit `,
    el("code", { text: DATA.runs.eval.commit }),
    ", Part 2 at ",
    el("code", { text: DATA.runs.review.commit }),
    "), re-graded and re-judged under the final grader. Nothing on this page is staged: every step is a line of a recorded trace.",
  ),
  el("p", { text: "The statement is drawn from the trace’s PayCo and Shipping calls. Model replies and code appear exactly as they were graded." }),
);

// The first case opens complete, so the page reads at a glance; then, unless the viewer prefers less
// motion, it plays from the start once, so nobody has to find the Play button to see what it does. It
// waits until its diagram is in view: at once on a wide screen, and on a phone once the viewer scrolls to it.
const first = caseFromHash(location.hash, new Set(byId.keys())) ?? DATA.featured[0]!.id;
if (!featured.has(first)) {
  document.querySelector<HTMLInputElement>('input[name="view"][value="all"]')!.checked = true;
  drawList();
}
openCase(first, { play: false });
revealCurrent();
if (!reduced) {
  const loaded = performance.now();
  // Once the viewer has clicked or pressed a key, the page leaves playing to them.
  let acted = false;
  addEventListener("click", () => (acted = true), { capture: true, once: true });
  addEventListener(
    "keydown",
    (event) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) acted = true;
    },
    { capture: true },
  );
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return;
      seen.disconnect();
      setTimeout(
        () => {
          if (!acted && ep.id === first && !playing() && step === ep.trace.length) {
            seek(0);
            start();
          }
        },
        performance.now() - loaded < 1000 ? 1500 : 500,
      );
    },
    { threshold: 0.5 },
  );
  seen.observe($("diagram-scroll"));
}
