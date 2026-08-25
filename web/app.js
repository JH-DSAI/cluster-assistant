import {
  buildModel,
  historyStats,
  nodeUtilisation,
  STATE_GROUPS,
  GROUP_LABEL,
  FLAG_LABEL,
  FACTORS,
  FACTOR_LABEL,
  TRES_LABEL,
} from "./parse.js";
import {
  priorityModel,
  ageScore,
  estimatePriority,
  rankIn,
  overtakeSeconds,
  jobCost,
  jobBilling,
  memoryWaste,
  effectiveRequest,
  accountHeadroom,
  feasibility,
  sbatchPreamble,
  toRequest,
  preambleDefaults,
  PREAMBLE_OPTIONS,
} from "./plan.js";

const FILES = {
  sinfoText: "sinfo.txt",
  squeueText: "squeue.txt",
  sprioText: "sprio.txt",
  sshareText: "sshare.txt",
  sacctQosText: "sacct_qos.txt",
  sacctAssocText: "sacct_assoc.txt",
  scontrolConfigText: "scontrol_config.txt",
  scontrolPartitionText: "scontrol_partition.txt",
  scontrolJobText: "scontrol_job.txt",
  assocMgrText: "scontrol_assoc_mgr.txt",
  sacctmgrQosText: "sacctmgr_qos.txt",
  scontrolNodeText: "scontrol_node.txt",
};
// Read once per explicit load rather than every refresh: the history dump is
// two orders of magnitude larger than the rest and describes the past, which
// does not change between one minute and the next.
const SLOW_FILES = { sacctHistText: "sacct_hist.txt" };
const DATA_DIR = "../data/";
const REFRESH_MS = 60_000;
const STALE_MS = 15 * 60_000;
const TOP_N = 10;

const GROUP_COLOR = {
  idle: "var(--node-idle)",
  mix: "var(--node-mix)",
  alloc: "var(--node-alloc)",
  resv: "var(--node-resv)",
  unavail: "var(--status-warning)",
  offline: "var(--status-critical)",
  other: "var(--node-other)",
};
// Legible label colour for text set directly on each fill above.
const GROUP_TEXT = {
  idle: "var(--on-idle)",
  mix: "var(--on-mix)",
  alloc: "var(--on-alloc)",
  resv: "var(--on-resv)",
  unavail: "var(--on-warning)",
  offline: "var(--on-critical)",
  other: "var(--on-other)",
};

const JOB_COLOR = { running: "var(--series-1)", pending: "var(--series-2)" };
const JOB_TEXT = { running: "var(--on-series-1)", pending: "var(--on-series-2)" };
// CPU cores reuse the node-state colours: in use, free, unavailable.
const CPU_COLOR = { alloc: "var(--node-alloc)", idle: "var(--node-idle)", other: "var(--status-warning)" };
const CPU_LABEL = { alloc: "Allocated", idle: "Idle", other: "Unavailable" };
const CPU_TEXT = { alloc: "var(--on-alloc)", idle: "var(--on-idle)", other: "var(--on-warning)" };
const factorColor = (f) => `var(--series-${FACTORS.indexOf(f) + 1})`;
// Colour follows the GPU model, fixed by its position in the sorted type list,
// so filtering the table never repaints a series.
const gpuColor = (types, k) => `var(--series-${(types.indexOf(k) % 8) + 1})`;
const gpuLabel = (k) => k.replace(/^gres\/gpu:/, "");

// Singular for a rate: "CPU-minutes", not "CPUs-minutes".
const TRES_MINUTES_LABEL = { cpu: "CPU", "gres/gpu": "GPU", mem: "memory MB", billing: "billing" };

const nf = new Intl.NumberFormat();
const n = (v) => nf.format(v);

// Durations span seconds to months here, so the unit follows the magnitude.
function dur(s) {
  if (s === null || s === undefined) return "-";
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  const d = h / 24;
  return d < 365 ? `${Math.round(d)}d` : `${(d / 365).toFixed(1)}y`;
}

// A scheduler start estimate, relative to when the data was captured.
function when(date) {
  if (!date) return "-";
  const delta = (+date - +model.now) / 1000;
  return delta < 0 ? "now" : `in ${dur(delta)}`;
}

const size = (r) =>
  `${n(r.nodes)}n · ${n(r.cpus)}c` +
  (r.gpus ? ` · ${n(r.gpus)}g` : "") +
  (r.memoryMB ? ` · ${r.memoryMB >= 1024 ? `${Math.round(r.memoryMB / 1024)}G` : `${r.memoryMB}M`}` : "");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// scontrol_partition.txt's AllowAccounts, shown beside the name so users can
// tell at a glance which partitions their account may use. Account names are
// SLURM logins (lowercase); this is how they're styled for display.
const ACCOUNT_LABEL = { jhu: "JHU" };
const formatAccount = (a) => ACCOUNT_LABEL[a] ?? a.charAt(0).toUpperCase() + a.slice(1);
const partAccounts = (p) =>
  p.info?.allowAccounts?.length ? p.info.allowAccounts.map(formatAccount).join(", ") : "All";
const partLabel = (p) => `${p.name} (${partAccounts(p)})`;

// f-part filter values that stand for a group of partitions rather than one:
// every partition restricted to that account, plus every partition open to
// all accounts (AllowAccounts=ALL parses to a null allowAccounts).
const GROUP_FILTERS = {
  "group:jhu": { account: "jhu", label: "All JHU", scopeLabel: "Every JHU partition here" },
  "group:schmidt": { account: "schmidt", label: "All Schmidt", scopeLabel: "Every Schmidt partition here" },
};
const partitionInGroup = (p, account) => {
  const allow = p.info?.allowAccounts;
  return !allow || allow.includes(account);
};
// Resolves the current filter to the set of real partition names it covers,
// or null for "all" (every partition, no filtering needed).
function scopedPartitionNames() {
  const g = GROUP_FILTERS[state.partition];
  if (g) return new Set(model.partitions.filter((p) => partitionInGroup(p, g.account)).map((p) => p.name));
  return state.partition === "all" ? null : new Set([state.partition]);
}

const state = {
  tab: "status",
  partition: "all",
  user: "",
  views: { nodes: "chart", capacity: "chart", queue: "chart" },
  expanded: new Set(),
};
let model = null;
let stamps = {};
// The priority weights recovered from the current dumps, refreshed with them.
let prioModel = null;

// ---------------------------------------------------------------- loading

async function loadFile(name) {
  const res = await fetch(`${DATA_DIR}${name}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const lm = res.headers.get("last-modified");
  return { text: await res.text(), at: lm ? new Date(lm) : null };
}

// Held across refreshes so the large history dump is fetched once. `slow` forces
// a re-read, which the Refresh button does.
let slowTexts = null;

async function load({ slow = slowTexts === null } = {}) {
  const main = document.getElementById("main");
  main.dataset.busy = model ? "1" : "0";
  const errors = [];
  const texts = {};
  stamps = {};
  const wanted = { ...FILES, ...(slow ? SLOW_FILES : {}) };

  await Promise.all(
    Object.entries(wanted).map(async ([key, name]) => {
      try {
        const { text, at } = await loadFile(name);
        texts[key] = text;
        stamps[name] = at;
      } catch (e) {
        texts[key] = "";
        // A history dump that is absent or unreadable costs one card, not the
        // page, so it is not worth an error banner.
        if (!(key in SLOW_FILES)) errors.push(e.message);
      }
    }),
  );

  if (slow) slowTexts = Object.fromEntries(Object.keys(SLOW_FILES).map((k) => [k, texts[k] ?? ""]));
  else Object.assign(texts, slowTexts);

  document.getElementById("errors").innerHTML = errors
    .map((m) => `<div class="error">${esc(m)} — that section will be empty. Is the dump process running?</div>`)
    .join("");

  // Wait times are measured from when the data was captured, not from the
  // browser clock, so they stay put while the page is open.
  model = buildModel({ ...texts, now: stamps["squeue.txt"] ?? new Date() });
  prioModel = priorityModel(model);
  renderFilters();
  renderPlanForm();
  render();
  // renderFilters() always unhides the bar; the plan tab has no use for it.
  document.getElementById("filters").hidden = state.tab === "plan";
  main.dataset.busy = "0";
}

// ---------------------------------------------------------------- scoping

// Rows that fell back to sprio's 8-character USER still match a full username.
const matchUser = (user, q) => {
  const r = (user ?? "").toLowerCase();
  return r.includes(q) || (r.length === 8 && q.startsWith(r));
};

function scopedPartitions() {
  const u = state.user.trim().toLowerCase();
  const names = scopedPartitionNames();
  const parts = model.partitions.filter((p) => names === null || names.has(p.name));
  if (!u) return parts;
  // Ranks come from the unfiltered sort, so a filtered row still shows the
  // job's true position in that partition's queue.
  return parts.map((p) => {
    const jobs = model.jobs.filter((j) => matchUser(j.user, u) && j.partitions.includes(p.name));
    const pd = jobs.filter((j) => j.state === "PD");
    const reasons = new Map();
    for (const j of pd) reasons.set(j.reason ?? "-", (reasons.get(j.reason ?? "-") ?? 0) + 1);
    return {
      ...p,
      running: jobs.filter((j) => j.state === "R").length,
      pending: pd.length,
      pendingTasks: pd.reduce((t, j) => t + j.tasks, 0),
      queue: p.queue.filter((r) => matchUser(r.user, u)),
      reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    };
  });
}

function scopedJobs() {
  const u = state.user.trim().toLowerCase();
  const names = scopedPartitionNames();
  return model.jobs.filter(
    (j) =>
      (names === null || j.partitions.some((p) => names.has(p))) &&
      (!u || matchUser(j.user, u)),
  );
}

// ---------------------------------------------------------------- chrome

function renderFilters() {
  const sel = document.getElementById("f-part");
  const opts = ['<option value="all">All partitions</option>']
    .concat(Object.entries(GROUP_FILTERS).map(([value, g]) => `<option value="${value}">${esc(g.label)}</option>`))
    .concat(
      model.partitions.map(
        (p) => `<option value="${esc(p.name)}">${esc(partLabel(p))}${p.isDefault ? " (default)" : ""}</option>`,
      ),
    );
  sel.innerHTML = opts.join("");
  const valid = GROUP_FILTERS[state.partition] || model.partitions.some((p) => p.name === state.partition);
  sel.value = valid ? state.partition : "all";
  state.partition = sel.value;
  document.getElementById("f-user").value = state.user;
  document.getElementById("filters").hidden = false;
  document.getElementById("filter-note").textContent = state.user.trim()
    ? "User filter scopes jobs and the priority queue; node status stays partition-wide."
    : "";
}

function renderFreshness() {
  const dates = Object.values(stamps).filter(Boolean);
  const el = document.getElementById("freshness");
  if (!dates.length) {
    el.textContent = "data timestamps unavailable";
    return;
  }
  const oldest = new Date(Math.min(...dates.map((d) => +d)));
  const age = Date.now() - +oldest;
  const mins = Math.round(age / 60000);
  const rel = mins < 1 ? "just now" : mins === 1 ? "1 min ago" : `${mins} min ago`;
  el.innerHTML =
    `data from ${esc(oldest.toLocaleTimeString())} (${rel})` +
    (age > STALE_MS ? ` <span class="stale">stale — dump may have stopped</span>` : "");
}

// ---------------------------------------------------------------- pieces

function legend(entries) {
  return `<div class="legend">${entries
    .map(
      ([label, color, count]) =>
        `<span><i class="swatch" style="background:${color}"></i>${esc(label)}` +
        (count === undefined ? "" : ` <span class="count">${n(count)}</span>`) +
        `</span>`,
    )
    .join("")}</div>`;
}

function segments(parts, widthPct = 100, extraClass = "", labeled = false) {
  const cls = [extraClass, labeled ? "labeled" : ""].filter(Boolean).join(" ");
  const total = parts.reduce((t, p) => t + p.value, 0);
  if (!total) return `<div class="bar${cls ? ` ${cls}` : ""}" style="width:${widthPct}%"><span class="track"></span></div>`;
  const segs = parts
    .filter((p) => p.value > 0)
    .map(
      (p) =>
        `<span class="seg" style="flex:${p.value};--c:${p.color}" data-tip="${esc(p.tip)}"><i>${
          labeled ? `<span class="seg-label" style="color:${p.textColor ?? "#fff"}">${n(p.value)}</span>` : ""
        }</i></span>`,
    )
    .join("");
  return `<div class="bar${cls ? ` ${cls}` : ""}" style="width:${widthPct}%">${segs}</div>`;
}

function nodeTip(p, group) {
  const rows = p.stateRows.filter((r) => r.group === group);
  const names = rows.flatMap((r) => r.nodes);
  const shown = names.slice(0, 12).join(", ") + (names.length > 12 ? `, +${names.length - 12} more` : "");
  const states = [...new Set(rows.map((r) => r.state + r.flags))].join(", ");
  const flags = [...new Set(rows.flatMap((r) => [...r.flags]))].map((f) => FLAG_LABEL[f] ?? f);
  const reasons = [...new Set(rows.map((r) => r.reason).filter(Boolean))];
  return (
    `${partLabel(p)} · ${GROUP_LABEL[group]}: ${n(p.byGroup[group])} of ${n(p.nodes)} nodes\n` +
    `sinfo state: ${states}` +
    (flags.length ? ` (${flags.join(", ")})` : "") +
    (reasons.length ? `\n${reasons.join(" / ")}` : "") +
    (shown ? `\n${shown}` : "")
  );
}

function nodesCard(parts) {
  const totals = Object.fromEntries(STATE_GROUPS.map((g) => [g, 0]));
  for (const p of parts) for (const g of STATE_GROUPS) totals[g] += p.byGroup[g];
  const present = STATE_GROUPS.filter((g) => totals[g] > 0);

  const body =
    state.views.nodes === "table"
      ? `<div class="scroll"><table><thead><tr><th>Partition</th><th class="num">Nodes</th>${present
          .map((g) => `<th class="num">${esc(GROUP_LABEL[g])}</th>`)
          .join("")}<th>Time limit</th><th>Avail</th></tr></thead><tbody>${parts
          .map(
            (p) =>
              `<tr><td>${esc(partLabel(p))}${p.isDefault ? ' <span class="dim">default</span>' : ""}</td>` +
              `<td class="num">${n(p.nodes)}</td>` +
              present.map((g) => `<td class="num">${p.byGroup[g] || '<span class="dim">0</span>'}</td>`).join("") +
              `<td>${esc(p.timelimit ?? "-")}</td><td>${esc(p.avail ?? "-")}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<div class="rows">${parts
          .map(
            (p) =>
              `<div class="row row-solo"><div class="row-label">${esc(partLabel(p))}${
                p.isDefault ? '<span class="dflt">*</span>' : ""
              }</div>` +
              (p.nodes === 0
                ? `<div class="bar"><span class="none">no node data in sinfo.txt</span></div>`
                : segments(
                    STATE_GROUPS.filter((g) => p.byGroup[g] > 0).map((g) => ({
                      value: p.byGroup[g],
                      color: GROUP_COLOR[g],
                      textColor: GROUP_TEXT[g],
                      tip: nodeTip(p, g),
                    })),
                    100,
                    "",
                    true,
                  )) +
              `</div>`,
          )
          .join("")}</div>
        <p class="axis-note">Each bar is one partition's nodes, split by state — full width is that partition's total, labelled at the tip. <code>*</code> marks the default partition. Nodes shared between partitions appear in each.</p>`;

  return card(
    "Node status by partition",
    "Where the machines are: idle capacity, how much is in use, and what is unavailable.",
    "nodes",
    legend(present.map((g) => [GROUP_LABEL[g], GROUP_COLOR[g], totals[g]])) + body,
  );
}

// GPUs neither held by a running job nor sitting on an unavailable node.
const gpuFree = (p) => Math.max(0, p.gpuTotal - p.gpuUnavail - p.runningGpus);

function capacityCard(parts) {
  if (!model.notes.hasNodeCapacity) return "";
  const withCpus = parts.filter((p) => p.cpu.total > 0);
  if (!withCpus.length) return "";
  const kinds = ["alloc", "idle", "other"];
  const totals = Object.fromEntries(kinds.map((k) => [k, withCpus.reduce((t, p) => t + p.cpu[k], 0)]));
  const gpuTotal = withCpus.reduce((t, p) => t + p.gpuTotal, 0);
  const gpuUsed = withCpus.reduce((t, p) => t + p.runningGpus, 0);
  const gpuUnavail = withCpus.reduce((t, p) => t + p.gpuUnavail, 0);

  const body =
    state.views.capacity === "table"
      ? `<div class="scroll"><table><thead><tr><th>Partition</th>
          <th class="num">CPUs allocated</th><th class="num">Idle</th><th class="num">Unavailable</th><th class="num">Total</th>
          <th class="num">GPUs in use</th><th class="num">GPUs free</th><th class="num">GPUs total</th><th>GPU model</th><th class="num">Memory / node</th>
          </tr></thead><tbody>${withCpus
          .map(
            (p) =>
              `<tr><td>${esc(partLabel(p))}</td>` +
              `<td class="num">${n(p.cpu.alloc)}</td><td class="num">${n(p.cpu.idle)}</td>` +
              `<td class="num">${p.cpu.other ? n(p.cpu.other) : '<span class="dim">0</span>'}</td>` +
              `<td class="num">${n(p.cpu.total)}</td>` +
              `<td class="num">${p.gpuTotal ? n(p.runningGpus) : '<span class="dim">-</span>'}</td>` +
              `<td class="num">${p.gpuTotal ? n(gpuFree(p)) : '<span class="dim">-</span>'}</td>` +
              `<td class="num">${p.gpuTotal ? n(p.gpuTotal) : '<span class="dim">-</span>'}</td>` +
              `<td class="dim">${esc(p.gpuModel ?? "-")}</td>` +
              `<td class="num dim">${p.memoryMB ? `${n(Math.round(p.memoryMB / 1024))} GB` : "-"}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<div class="rows rows-split">
          <div class="row-label head-cell"></div><div class="col-head head-cell">Cores</div><div class="col-head gpu-bar head-cell">GPUs</div>
          ${withCpus
          .map((p) => {
            const cpuSegs = kinds
              .filter((k) => p.cpu[k] > 0)
              .map((k) => ({
                value: p.cpu[k],
                color: CPU_COLOR[k],
                textColor: CPU_TEXT[k],
                tip:
                  `${partLabel(p)} · ${CPU_LABEL[k]}: ${n(p.cpu[k])} of ${n(p.cpu.total)} CPUs (${(
                    (p.cpu[k] / p.cpu.total) *
                    100
                  ).toFixed(0)}%)` + (p.memoryMB ? `\n${n(Math.round(p.memoryMB / 1024))} GB per node` : ""),
              }));
            const gpuValues = { alloc: p.runningGpus, idle: gpuFree(p), other: p.gpuUnavail };
            const gpuSegs = kinds
              .filter((k) => gpuValues[k] > 0)
              .map((k) => ({
                value: gpuValues[k],
                color: CPU_COLOR[k],
                textColor: CPU_TEXT[k],
                tip: `${partLabel(p)} · ${CPU_LABEL[k]}: ${n(gpuValues[k])} of ${n(p.gpuTotal)} ${
                  p.gpuModel ?? ""
                } GPUs (${((gpuValues[k] / p.gpuTotal) * 100).toFixed(0)}%)`,
              }));
            return (
              `<div class="row-label">${esc(partLabel(p))}</div>` +
              segments(cpuSegs, 100, "", true) +
              (p.gpuTotal
                ? segments(gpuSegs, 100, "gpu-bar", true)
                : `<div class="bar gpu-bar"><span class="none">no GPUs</span></div>`)
            );
          })
          .join("")}</div>
        <p class="axis-note">Each left bar is one partition's cores, from <code>sinfo</code>'s CPUS(A/I/O/T) column; each right bar is that partition's GPUs, using the same allocated/idle/unavailable colours. <em>Unavailable</em> is on drained, down or maintenance nodes. GPU counts are the configured total per partition against what running jobs hold — ${
          model.notes.hasJobDetail
            ? "taken from each job's <code>AllocTRES</code>, which is the allocation itself"
            : "derived from what they request, so a GPU held by an idle allocation is not counted and the figure is a floor"
        }.</p>`;

  return card(
    "Capacity by partition",
    "How much compute is actually free — a partition full of “mixed” nodes can still have plenty of idle cores.",
    "capacity",
    legend(
      kinds
        .filter((k) => totals[k] > 0)
        .map((k) => [CPU_LABEL[k], CPU_COLOR[k], totals[k]])
        .concat(gpuTotal ? [] : []),
    ) +
      body +
      (gpuTotal
        ? `<p class="axis-note">Cluster-wide: <b>${n(totals.idle)}</b> of ${n(
            totals.alloc + totals.idle + totals.other,
          )} cores idle, and <b>${n(gpuUsed)}</b> of ${n(gpuTotal)} GPUs held by running jobs${
            gpuUnavail ? ` (a further ${n(gpuUnavail)} sit on unavailable nodes)` : ""
          }.</p>`
        : ""),
  );
}

function problemCard(parts) {
  const bad = parts.flatMap((p) => p.problemRows.map((r) => ({ ...r, partition: partLabel(p) })));
  if (!bad.length) return "";
  const total = bad.reduce((t, r) => t + r.count, 0);
  return `<div class="card"><div class="card-head"><h2>Nodes needing attention</h2></div>
    <p class="card-sub">${n(total)} node${
      total === 1 ? "" : "s"
    } drained, in maintenance, down or unknown, grouped by the reason <code>sinfo</code> reports.</p>
    <div class="scroll"><table><thead><tr><th>Partition</th><th class="num">Nodes</th>${
      model.notes.hasNodelist ? "<th>Which</th>" : ""
    }<th class="num">Cores</th><th>State</th><th>Flag</th><th>Reason</th></tr></thead><tbody>
    ${bad
      .map(
        (r) =>
          `<tr><td>${esc(r.partition)}</td><td class="num">${n(r.count)}</td>` +
          (model.notes.hasNodelist ? `<td class="mono">${esc(r.nodelist || "-")}</td>` : "") +
          `<td class="num dim">${r.cpus ? n(r.cpus.total) : "-"}</td>` +
          `<td><span class="chip"><i class="dot" style="--c:${GROUP_COLOR[r.group]}"></i>${esc(r.state)} — ${esc(
            GROUP_LABEL[r.group],
          )}</span></td>` +
          `<td class="dim">${esc([...r.flags].map((f) => FLAG_LABEL[f] ?? f).join(", ") || "-")}</td>` +
          `<td>${esc(r.reason || "-")}</td></tr>`,
      )
      .join("")}
    </tbody></table></div>
    ${
      total && model.notes.hasNodeCapacity
        ? (() => {
            const cores = bad.reduce((t, r) => t + (r.cpus?.total ?? 0), 0);
            const busy = bad.reduce((t, r) => t + (r.cpus?.alloc ?? 0), 0);
            return `<p class="axis-note">${n(cores)} cores sit on these nodes${
              busy ? `; ${n(busy)} of them are still running work that has to finish before the node drains` : ""
            }. The rest cannot be scheduled and are counted as unavailable in the capacity chart.</p>`;
          })()
        : ""
    }</div>`;
}

function queueCard(parts) {
  // Legend totals count each job once, so they agree with the tiles above; the
  // per-partition bars sum higher because multi-partition jobs appear in each.
  const jobs = scopedJobs();
  const totRun = jobs.filter((j) => j.state === "R").length;
  const totPend = jobs.filter((j) => j.state === "PD").length;

  const body =
    state.views.queue === "table"
      ? `<div class="scroll"><table><thead><tr><th>Partition</th><th class="num">Pending</th><th class="num">Tasks</th>
          <th class="num">CPUs</th><th class="num">GPUs</th><th class="num">Median wait</th><th class="num">Longest</th>
          <th class="num">Next start</th><th class="num">Frees up</th><th class="num">Running</th><th>Top reason pending</th></tr></thead><tbody>${parts
          .map(
            (p) =>
              `<tr><td>${esc(partLabel(p))}</td><td class="num">${n(p.pending)}</td>` +
              `<td class="num">${n(p.pendingTasks)}</td>` +
              `<td class="num">${p.pendingCpus ? n(p.pendingCpus) : '<span class="dim">0</span>'}</td>` +
              `<td class="num">${p.pendingGpus ? n(p.pendingGpus) : '<span class="dim">0</span>'}</td>` +
              `<td class="num">${esc(dur(p.waitMedian))}</td><td class="num">${esc(dur(p.waitMax))}</td>` +
              `<td class="num">${esc(when(p.nextStart))}</td>` +
              `<td class="num">${esc(dur(p.endsInSoonest))}</td>` +
              `<td class="num">${n(p.running)}</td>` +
              `<td class="dim">${esc(p.reasons[0] ? `${p.reasons[0][0]} (${p.reasons[0][1]})` : "-")}</td></tr>`,
          )
          .join("")}</tbody></table></div>
        <p class="axis-note">Median wait and longest wait are measured from each job's submit time to when the dump was taken. <em>Next start</em> is the soonest estimate the scheduler has produced for anything waiting here; <em>frees up</em> is the time remaining on the running job that finishes soonest.</p>`
      : `<div class="rows">${parts
          .map((p) => {
            return (
              `<div class="row row-solo"><div class="row-label">${esc(partLabel(p))}${
                p.isDefault ? '<span class="dflt">*</span>' : ""
              }</div>` +
              segments(
                [
                  {
                    value: p.running,
                    color: JOB_COLOR.running,
                    textColor: JOB_TEXT.running,
                    tip:
                      `${partLabel(p)}: ${n(p.running)} running` +
                      (p.runningCpus ? `\n${n(p.runningCpus)} CPUs, ${n(p.runningGpus)} GPUs in use` : "") +
                      (p.endsInSoonest !== null ? `\nnext one finishes in ${dur(p.endsInSoonest)}` : ""),
                  },
                  {
                    value: p.pending,
                    color: JOB_COLOR.pending,
                    textColor: JOB_TEXT.pending,
                    tip:
                      `${partLabel(p)}: ${n(p.pending)} pending (${n(p.pendingTasks)} array tasks)` +
                      (p.pendingCpus ? `\n${n(p.pendingCpus)} CPUs, ${n(p.pendingGpus)} GPUs requested` : "") +
                      (p.waitMedian !== null
                        ? `\nmedian wait ${dur(p.waitMedian)}, longest ${dur(p.waitMax)}`
                        : "") +
                      (p.nextStart ? `\nnext estimated start ${when(p.nextStart)}` : "") +
                      (p.reasons.length ? `\ntop reason: ${p.reasons[0][0]} (${n(p.reasons[0][1])})` : ""),
                  },
                ],
                100,
                "",
                true,
              ) +
              `</div>`
            );
          })
          .join("")}</div>
        <p class="axis-note">Each bar is one partition's jobs, split into running and pending — full width is that partition's total. A job that requested several partitions is counted in each.</p>`;

  const reasons = new Map();
  for (const p of parts) for (const [r, c] of p.reasons) reasons.set(r, (reasons.get(r) ?? 0) + c);
  const reasonList = [...reasons.entries()].sort((a, b) => b[1] - a[1]);

  return card(
    "Queue depth by partition",
    "How many jobs are waiting, and how many are already running.",
    "queue",
    legend([
      ["Running", JOB_COLOR.running, totRun],
      ["Pending", JOB_COLOR.pending, totPend],
    ]) +
      body +
      (reasonList.length
        ? `<p class="axis-note">Why jobs are waiting: ${reasonList
            .map(([r, c]) => `${esc(r)} <b>${n(c)}</b>`)
            .join(" · ")}</p>`
        : ""),
  );
}

// An account whose running TRES-minutes exceed its GrpTRESMins allowance cannot
// start new work, so it is called out with an icon and a word, not just colour.
function limitCell(a) {
  if (!a.cpuLimit) return '<span class="dim">none</span>';
  const pct = (a.runCpu / a.cpuLimit) * 100;
  const text = `${pct.toFixed(1)}%`;
  if (pct < 90) return text;
  const critical = pct >= 100;
  return `<span class="chip" style="--c:${critical ? "var(--status-critical)" : "var(--status-warning)"}"><i class="dot"></i>${text} ${
    critical ? "over" : "near"
  }</span>`;
}

function accountsCard(parts) {
  if (!model.accounts.length) return "";
  const types = model.activeGpuTypes;
  const filtering = state.partition !== "all" || state.user.trim() !== "";

  // Pending jobs per account, within whatever the filter row currently scopes.
  // Only possible while a dump reports each job's account.
  const known = model.notes.hasJobAccounts;
  const pendingBy = new Map();
  if (known) {
    for (const p of parts) for (const r of p.queue) pendingBy.set(r.account, (pendingBy.get(r.account) ?? 0) + 1);
  }

  const withUsage = model.accounts.filter((a) => a.runCpu > 0 || a.runGpu > 0);
  const all = filtering && known ? model.accounts.filter((a) => pendingBy.has(a.account)) : withUsage;
  const key = "accounts";
  const shown = state.expanded.has(key) ? all : all.slice(0, 12);
  if (!all.length) return "";

  const maxGpu = Math.max(1, ...all.map((a) => a.runGpu));

  const mix = (a) =>
    a.runGpu === 0
      ? '<span class="dim">-</span>'
      : `<div class="pq-bar" style="width:${Math.max(3, (a.runGpu / maxGpu) * 100)}%">${types
          .filter((k) => a.gpuByType[k] > 0)
          .map(
            (k) =>
              `<span class="seg" style="flex:${a.gpuByType[k]};background:${gpuColor(
                model.gpuTypes,
                k,
              )}" data-tip="${esc(`${a.account} · ${gpuLabel(k)}: ${n(a.gpuByType[k])} GPU-minutes running`)}"></span>`,
          )
          .join("")}</div>`;

  return `<div class="card"><div class="card-head"><h2>Accounts</h2></div>
    <p class="card-sub">Cluster share per account and the work each one has in flight, from <code>sshare -l</code>. TRES-minutes are the resource-time currently committed to running jobs, not a job count.</p>
    ${legend(types.map((k) => [gpuLabel(k), gpuColor(model.gpuTypes, k)]))}
    <div class="scroll"><table><thead><tr>
      <th>Account</th><th class="num">Norm share</th><th class="num">CPU-min</th><th class="num">of limit</th>
      <th class="num">GPU-min</th><th>GPU mix</th>
      ${types.map((k) => `<th class="num">${esc(gpuLabel(k))}</th>`).join("")}
      ${known ? `<th class="num">Pending${filtering ? " here" : ""}</th>` : ""}</tr></thead><tbody>
    ${shown
      .map(
        (a) =>
          `<tr><td>${esc(a.account)}</td>` +
          `<td class="num">${a.normShares.toFixed(4)}</td>` +
          `<td class="num">${n(a.runCpu)}</td>` +
          `<td class="num">${limitCell(a)}</td>` +
          `<td class="num">${a.runGpu ? n(a.runGpu) : '<span class="dim">0</span>'}</td>` +
          `<td>${mix(a)}</td>` +
          types
            .map((k) => `<td class="num">${a.gpuByType[k] ? n(a.gpuByType[k]) : '<span class="dim">0</span>'}</td>`)
            .join("") +
          (known
            ? `<td class="num">${
                pendingBy.get(a.account) ? n(pendingBy.get(a.account)) : '<span class="dim">0</span>'
              }</td>`
            : "") +
          `</tr>`,
      )
      .join("")}
    </tbody></table></div>
    ${
      all.length > 12
        ? `<div class="more"><button data-expand="${key}">${
            state.expanded.has(key) ? "Show top 12 only" : `Show all ${n(all.length)}`
          }</button></div>`
        : ""
    }
    <p class="axis-note">Bar length is GPU-minutes relative to the heaviest GPU user shown (${n(
      maxGpu,
    )} GPU-min); the per-model columns carry the same numbers. <em>of limit</em> is CPU-minutes against this account's <code>GrpTRESMins</code> allowance — an account over 100% cannot start new work until running jobs finish. The <code>MaxCpuPerAccount</code> limit that blocks most of the queue is a separate QOS/association limit, not present in <code>sshare</code> output.</p></div>`;
}

function limitsCard(parts) {
  if (!model.notes.hasLimits || !model.limits.length) return "";
  const scoped = new Set(parts.map((p) => p.name));
  const u = state.user.trim().toLowerCase();
  const rows = model.limits.filter(
    (l) =>
      (state.partition === "all" || l.partitions.some((p) => scoped.has(p))) &&
      (!u || l.scope !== "user" || matchUser(l.key, u)),
  );
  if (!rows.length) return "";

  const held = rows.reduce((t, l) => t + l.jobs, 0);
  const pending = scopedJobs().filter((j) => j.state === "PD").length;
  const idleCores =
    state.partition === "all" ? model.cluster.cpu.idle : parts.reduce((t, p) => t + (p.cpu?.idle ?? 0), 0);

  // The fill escalates with severity against a lighter step of the same ramp,
  // and the number is printed either way, so colour never carries it alone.
  const meter = (l) => {
    if (l.kind === "minutes") {
      return '<span class="dim">consumed budget not in these dumps</span>';
    }
    if (!l.cap) return '<span class="dim">limit not in the sacctmgr dumps</span>';
    const pct = Math.min(100, (l.used / l.cap.value) * 100);
    const fill = pct >= 100 ? "var(--status-critical)" : pct >= 90 ? "var(--status-warning)" : "var(--node-alloc)";
    return `<div class="bar" style="width:150px" data-tip="${esc(
      `${l.key}: ${n(l.used)} of ${n(l.cap.value)} ${TRES_LABEL[l.tres] ?? l.tres} (${pct.toFixed(0)}%)\ncap from ${
        l.cap.source
      }${l.cap.inferred ? " — not this job's own QOS" : ""}`,
    )}"><span class="seg" style="flex:${Math.max(l.used, 0.001)};--c:${fill}"><i></i></span>${
      l.used < l.cap.value
        ? `<span class="seg" style="flex:${l.cap.value - l.used};--c:var(--node-idle)"><i></i></span>`
        : ""
    }</div>`;
  };

  return `<div class="card"><div class="card-head"><h2>What's blocking the queue</h2></div>
    <p class="card-sub">Pending jobs held back by an account or user limit rather than by a shortage of hardware, with the limit that is holding them${
      model.notes.hasAssocMgr ? ", read from <code>assoc_mgr</code> with the usage SLURM itself counts" : ""
    }.</p>
    <div class="scroll"><table><thead><tr>
      <th>Account / user</th><th>Resource</th><th class="num">Held</th><th class="num">In use</th><th class="num">Cap</th>
      <th>Usage</th><th>Reason</th><th>Cap comes from</th></tr></thead><tbody>
    ${rows
      .map(
        (l) =>
          `<tr><td>${esc(l.key)} <span class="dim">${l.scope}</span></td>` +
          `<td>${
            l.kind === "minutes"
              ? `${esc(TRES_MINUTES_LABEL[l.tres] ?? l.tres)}-minutes <span class="dim">budget</span>`
              : esc(TRES_LABEL[l.tres] ?? l.tres)
          }</td>` +
          `<td class="num"><b>${n(l.jobs)}</b>${l.tasks > l.jobs ? ` <span class="dim">/${n(l.tasks)}</span>` : ""}</td>` +
          `<td class="num">${n(Math.round(l.used))}${
            l.usedIsInFlight ? ' <span class="dim">in flight</span>' : ""
          }</td>` +
          `<td class="num">${l.cap ? n(l.cap.value) : '<span class="dim">?</span>'}</td>` +
          `<td>${meter(l)}</td>` +
          `<td>${
            l.kind === "minutes"
              ? `<span class="dim">${esc(l.reason)}</span>`
              : l.cap && l.used >= l.cap.value
              ? `<span class="chip" style="--c:var(--status-critical)" title="${esc(l.reason)}"><i class="dot"></i>at limit</span>`
              : `<span class="dim">${esc(l.reason)}</span>`
          }</td>` +
          `<td class="dim">${
            l.cap
              ? esc(l.cap.source) +
                (l.cap.inferred ? ' <span title="this QOS is not on the job itself — most likely a partition QOS">(inferred)</span>' : "") +
                (l.cap.ambiguous ? " (ambiguous)" : "")
              : "-"
          }</td></tr>`,
      )
      .join("")}
    </tbody></table></div>
    <p class="axis-note">${
      held && pending
        ? `<b>${n(held)}</b> of ${n(pending)} pending jobs are held by a limit${
            idleCores ? `, while ${n(idleCores)} cores sit idle` : ""
          } — adding hardware would not start them.  `
        : ""
    }${
      rows.some((l) => l.kind === "minutes")
        ? `A <em>-minutes budget</em> row is a <code>GrpTRESMins</code> allowance, not a cap on what may be held at once: the figure shown is what running jobs have committed, and how much of the budget is already spent is in none of these dumps — <code>sshare</code> reports <code>RawUsage</code> as one weighted number rather than per TRES. `
        : ""
    }<code>squeue</code> reports a job's own QOS, but a <em>partition</em> QOS can apply too and is in none of these dumps; a cap marked <em>inferred</em> was matched by shape and by the account sitting exactly on it. <code>scontrol show partition</code> would confirm which QOS each partition attaches.</p></div>`;
}

// A limit's own field name says what it counts over and per whom.
const LIMIT_FIELD_LABEL = {
  GrpTRES: "held at once",
  GrpTRESMins: "resource-time budget",
  GrpTRESRunMins: "in-flight resource-time",
  GrpJobs: "running jobs",
  GrpSubmitJobs: "submitted jobs",
  GrpWall: "wall-clock budget",
  MaxTRESPA: "held at once, per account",
  MaxTRESPU: "held at once, per user",
  MaxTRESRunMinsPA: "in-flight resource-time, per account",
  MaxTRESRunMinsPU: "in-flight resource-time, per user",
  MaxJobsPA: "running jobs, per account",
  MaxJobsPU: "running jobs, per user",
  MaxSubmitJobsPA: "submitted jobs, per account",
  MaxSubmitJobsPU: "submitted jobs, per user",
  MaxJobs: "running jobs",
  MaxSubmitJobs: "submitted jobs",
};

/**
 * Limits close to their ceiling, whether or not anything is blocked yet.
 *
 * Every other limits view on this page is reactive: it starts from a job that is
 * already stuck. `scontrol show assoc_mgr` reports usage against every limit, so
 * this is the forward-looking version — the thing that is about to stop you,
 * while there is still time to ask for less.
 */
function ceilingCard() {
  if (!model.notes.hasAssocMgr) return "";
  const NEAR = 0.8;
  const u = state.user.trim().toLowerCase();
  const rows = model.assocLimits
    .map((l) => ({ ...l, pct: (l.used / l.limit) * 100 }))
    .filter((l) => l.pct >= NEAR * 100)
    // The user filter scopes to limits that could bite this person: their own,
    // and any that count over a whole account.
    .filter((l) => !u || !l.user || matchUser(l.user, u))
    .sort((a, b) => b.pct - a.pct || b.limit - a.limit);
  if (!rows.length) return "";

  const key = "ceiling";
  const shown = state.expanded.has(key) ? rows : rows.slice(0, 12);
  const over = rows.filter((l) => l.pct >= 100).length;
  const who = (l) => l.user || l.account || l.qos || "-";

  return `<div class="card"><div class="card-head"><h2>Limits near their ceiling</h2>
      ${
        over
          ? `<span class="chip" style="--c:var(--status-critical)"><i class="dot"></i>${n(over)} at or over</span>`
          : `<span class="chip" style="--c:var(--status-warning)"><i class="dot"></i>${n(rows.length)} within ${100 - NEAR * 100}%</span>`
      }</div>
    <p class="card-sub">What is about to stop a job, from <code>scontrol show assoc_mgr</code> — which reports each limit with the usage SLURM counts against it. Unlike the table above, a row here needs nothing to be blocked yet.</p>
    <div class="scroll"><table><thead><tr>
      <th>Account / user</th><th>Limit</th><th>Counts</th><th class="num">Used</th><th class="num">Of</th>
      <th class="num">%</th><th>Usage</th><th>Comes from</th></tr></thead><tbody>
    ${shown
      .map((l) => {
        const pct = Math.min(100, l.pct);
        const fill = l.pct >= 100 ? "var(--status-critical)" : "var(--status-warning)";
        const tres = l.tres ? (TRES_MINUTES_LABEL[l.tres] ?? l.tres) : "";
        return (
          `<tr><td>${esc(who(l))}${l.user ? ' <span class="dim">user</span>' : l.account ? ' <span class="dim">account</span>' : ""}</td>` +
          `<td>${esc(tres || l.field)}${tres ? "" : ""}</td>` +
          `<td class="dim">${esc(LIMIT_FIELD_LABEL[l.field] ?? l.field)}</td>` +
          `<td class="num">${n(Math.round(l.used))}</td>` +
          `<td class="num">${n(l.limit)}</td>` +
          `<td class="num">${
            l.pct >= 100
              ? `<span class="chip" style="--c:var(--status-critical)"><i class="dot"></i>${l.pct.toFixed(0)}%</span>`
              : `${l.pct.toFixed(0)}%`
          }</td>` +
          `<td><div class="bar" style="width:120px" data-tip="${esc(
            `${who(l)}: ${Math.round(l.used)} of ${l.limit} — ${l.field}${l.tres ? ` (${l.tres})` : ""}\n${l.source}`,
          )}"><span class="seg" style="flex:${Math.max(pct, 0.001)};--c:${fill}"><i></i></span>${
            pct < 100 ? `<span class="seg" style="flex:${100 - pct};--c:var(--node-idle)"><i></i></span>` : ""
          }</div></td>` +
          `<td class="dim">${esc(l.source)}</td></tr>`
        );
      })
      .join("")}
    </tbody></table></div>
    ${
      rows.length > 12
        ? `<div class="more"><button data-expand="${key}">${
            state.expanded.has(key) ? "Show the closest 12 only" : `Show all ${n(rows.length)}`
          }</button></div>`
        : ""
    }
    <p class="axis-note">${n(model.assocLimits.length)} limit(s) are set across this cluster's associations and QOS; these are the ones at ${
      NEAR * 100
    }% or more of their ceiling. A <em>resource-time budget</em> row is cumulative and resets on <code>PriorityUsageResetPeriod</code>${
      model.config?.usageResetPeriod ? ` (${esc(model.config.usageResetPeriod.toLowerCase())})` : ""
    }, so it does not fall as jobs finish — unlike a <em>held at once</em> row, which does.</p></div>`;
}

function priorityCard(parts) {
  const factors = model.activeFactors;
  const hasAccounts = model.notes.hasJobAccounts;
  const hasWaits = model.notes.hasWaitTimes;
  // `scontrol show job` supplies AccrueTime, which is what the age factor counts
  // from — a job held by a dependency has none and is not climbing at all.
  const hasAccrual = model.notes.hasJobDetail;
  const hasStarts = model.notes.hasStartEstimates;
  const withQueue = parts.filter((p) => p.queue.length);
  if (!withQueue.length) {
    return `<div class="card"><div class="card-head"><h2>Priority queue</h2></div>
      <p class="card-sub">No pending jobs match the current filters.</p></div>`;
  }

  const tables = withQueue
    .map((p) => {
      const key = `pq:${p.name}`;
      const all = state.expanded.has(key);
      const rows = all ? p.queue : p.queue.slice(0, TOP_N);
      const max = Math.max(1, ...p.queue.map((r) => r.priority));
      return `<div class="pq"><div class="pq-head"><h3>${esc(partLabel(p))}</h3>
        <span class="dim">${n(p.queue.length)} pending job${p.queue.length === 1 ? "" : "s"} · top priority ${n(
          max,
        )}${p.waitMedian !== null ? ` · median wait ${dur(p.waitMedian)}` : ""}${
          p.nextStart ? ` · next start ${when(p.nextStart)}` : ""
        }</span></div>
        <div class="scroll"><table><thead><tr>
          <th class="num">#</th><th>Job ID</th><th>Name</th><th>User</th>${
            hasAccounts ? "<th>Account</th>" : ""
          }<th>QOS</th><th class="num">Size</th>
          ${hasWaits ? '<th class="num">Waiting</th>' : ""}${
            hasWaits && hasAccrual ? '<th class="num">Ageing</th>' : ""
          }${hasStarts ? '<th class="num">Est. start</th>' : ""}
          <th class="num">Priority</th><th>Composition</th>
          ${factors.map((f) => `<th class="num">${esc(FACTOR_LABEL[f])}</th>`).join("")}
          <th>Blocked by</th></tr></thead><tbody>
        ${rows
          .map(
            (r) =>
              `<tr><td class="num dim">${r.rank}</td>` +
              `<td class="mono">${esc(r.jobid)}${r.tasks > 1 ? ` <span class="dim">×${r.tasks}</span>` : ""}</td>` +
              `<td class="clip" title="${esc(r.name)}">${esc(r.name || "-")}</td><td>${esc(r.user)}</td>` +
              (hasAccounts ? `<td>${esc(r.account || "-")}</td>` : "") +
              `<td class="dim">${esc(r.qosname || "-")}</td>` +
              `<td class="num dim">${esc(size(r))}</td>` +
              (hasWaits
                ? `<td class="num">${esc(dur(r.waitSeconds))}</td>` +
                  (hasAccrual
                    ? `<td class="num${r.accruing === false ? " dim" : ""}" data-tip="${esc(
                        r.accruing === false
                          ? `Not accruing age priority${r.dependency ? `\nheld by ${r.dependency}` : ""}\nIts age factor stays at 0 until this clears, so waiting does nothing.`
                          : `Accruing since ${r.accrue ? r.accrue.toLocaleString() : "submission"}`,
                      )}">${r.accruing === false ? "not ageing" : esc(dur(r.accrueSeconds))}</td>`
                    : "")
                : "") +
              (hasStarts
                ? `<td class="num${r.start ? "" : " dim"}" title="${esc(
                    r.start ? r.start.toLocaleString() : "no estimate yet",
                  )}">${esc(when(r.start))}</td>`
                : "") +
              `<td class="num"><b>${n(r.priority)}</b></td>` +
              `<td>${prioBar(r, factors, max)}</td>` +
              factors
                .map(
                  (f) =>
                    `<td class="num">${
                      !r.factors ? '<span class="dim">-</span>' : r.factors[f] ? n(r.factors[f]) : '<span class="dim">0</span>'
                    }</td>`,
                )
                .join("") +
              `<td class="dim">${esc(r.reason || "-")}</td></tr>`,
          )
          .join("")}
        </tbody></table></div>
        ${
          p.queue.length > TOP_N
            ? `<div class="more"><button data-expand="${esc(key)}">${
                all ? `Show top ${TOP_N} only` : `Show all ${n(p.queue.length)}`
              }</button></div>`
            : ""
        }</div>`;
    })
    .join("");

  return `<div class="card"><div class="card-head"><h2>Priority queue</h2></div>
    <p class="card-sub">Pending jobs in the order SLURM will consider them, highest priority first, with the factors that produced each score. A job pending in several partitions appears in each, ranked separately. Ranks are partition-wide and do not change when you filter by user.</p>
    ${legend(factors.map((f) => [FACTOR_LABEL[f], factorColor(f)]))}
    ${tables}
    <p class="axis-note">Bar length is priority relative to the top of that partition's queue; factors with a zero weight on this cluster are not shown. Ordering uses <code>squeue</code>'s priority, which is the freshest value; the breakdown comes from <code>sprio</code>. <em>Waiting</em> runs from submit time to the moment the dump was taken.${
      hasAccrual
        ? " <em>Ageing</em> runs from <code>AccrueTime</code> instead, which is what the age factor actually counts: a job held by a dependency or a limit has none, earns no age priority, and does not climb the queue however long it sits."
        : ""
    } <em>Est. start</em> is the scheduler's own estimate and is blank until it computes one.</p></div>`;
}

function prioBar(r, factors, max) {
  // sprio has no row for this job and partition, so there is no breakdown.
  if (!r.factors)
    return `<span class="dim" title="no sprio row for this job in this partition">no breakdown</span>`;
  const segs = factors
    .filter((f) => r.factors[f] > 0)
    .map((f) => {
      const norm = r.normFactors?.[f];
      const tip =
        `${FACTOR_LABEL[f]}: ${n(r.factors[f])} of ${n(r.priority)} total priority` +
        (norm === undefined ? "" : `\nnormalized ${norm.toFixed(4)} of this factor's maximum`);
      return `<span class="seg" style="flex:${r.factors[f]};background:${factorColor(f)}" data-tip="${esc(
        tip,
      )}"></span>`;
    })
    .join("");
  const width = Math.max(3, (r.priority / max) * 100);
  return `<div class="pq-bar" style="width:${width}%">${segs}</div>`;
}

function kpiRow(parts) {
  const jobs = scopedJobs();
  const nodeSource =
    state.partition === "all"
      ? { nodes: model.cluster.nodes, byGroup: model.cluster.byGroup }
      : {
          nodes: parts.reduce((t, p) => t + p.nodes, 0),
          byGroup: Object.fromEntries(
            STATE_GROUPS.map((g) => [g, parts.reduce((t, p) => t + (p.byGroup[g] ?? 0), 0)]),
          ),
        };
  const g = (k) => nodeSource.byGroup[k] ?? 0;
  const pending = jobs.filter((j) => j.state === "PD");
  const tasks = pending.reduce((t, j) => t + j.tasks, 0);
  const problem = g("unavail") + g("offline");

  const tile = (label, value, sub, cls = "") =>
    `<div class="tile ${cls}"><div class="tile-label">${esc(label)}</div>
     <div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;

  const running = jobs.filter((j) => j.state === "R");
  // Capacity is cluster-wide unless the filter scopes to one or more partitions.
  const cpu =
    state.partition === "all"
      ? model.cluster.cpu
      : parts.reduce(
          (t, p) => ({ total: t.total + (p.cpu?.total ?? 0), idle: t.idle + (p.cpu?.idle ?? 0) }),
          { total: 0, idle: 0 },
        );
  const gpuTotal =
    state.partition === "all" ? model.cluster.gpuTotal : parts.reduce((t, p) => t + (p.gpuTotal ?? 0), 0);
  const gpuUsed = running.reduce((t, j) => t + j.gpus, 0);
  const gpuPct = gpuTotal ? Math.round((gpuUsed / gpuTotal) * 100) : 0;
  const waits = pending.map((j) => j.submit && Math.max(0, (+model.now - +j.submit) / 1000)).filter((w) => w);
  const sorted = waits.sort((a, b) => a - b);
  const medWait = sorted.length ? sorted[sorted.length >> 1] : null;
  const demand = (list) => {
    const c = list.reduce((t, j) => t + j.cpus, 0);
    const gp = list.reduce((t, j) => t + j.gpus, 0);
    const tb = list.reduce((t, j) => t + j.memoryMB, 0) / 1024 / 1024;
    return [c && `${n(c)} CPUs`, gp && `${n(gp)} GPUs`, tb >= 1 && `${tb.toFixed(0)} TB`]
      .filter(Boolean)
      .join(", ");
  };
  // Pending jobs a limit is holding, within the current filter scope.
  const scopedNames = new Set(parts.map((p) => p.name));
  const heldByLimit = model.limits
    .filter((l) => state.partition === "all" || l.partitions.some((p) => scopedNames.has(p)))
    .reduce((t, l) => t + l.jobs, 0);

  return `<div class="kpis">
    ${tile(
      "Jobs pending",
      n(pending.length),
      [tasks > pending.length ? `${n(tasks)} array tasks` : "", demand(pending) && `${demand(pending)} requested`]
        .filter(Boolean)
        .join(" · ") || "waiting to start",
    )}
    ${
      medWait
        ? tile(
            "Median wait",
            esc(dur(medWait)),
            `longest ${dur(sorted.at(-1))}`,
          )
        : ""
    }
    ${
      heldByLimit
        ? tile(
            "Held by a limit",
            n(heldByLimit),
            `of ${n(pending.length)} pending · not waiting on hardware`,
          )
        : ""
    }
    ${tile("Jobs running", n(running.length), demand(running) || `${n(new Set(jobs.map((j) => j.user)).size)} users`)}
    ${
      cpu.total
        ? tile("Idle cores", n(cpu.idle), `of ${n(cpu.total)} · ${n(g("idle"))} nodes fully idle`)
        : tile("Idle nodes", n(g("idle")), `of ${n(nodeSource.nodes)} nodes`)
    }
    ${
      gpuTotal
        ? tile("GPUs in use", `${n(gpuUsed)}<span class="of">/${n(gpuTotal)}</span>`, `${gpuPct}% of the cluster's GPUs`)
        : ""
    }
    ${tile("Unavailable nodes", n(problem), problem ? "drain, maint, down" : "none")}
  </div>`;
}

/**
 * What MAX_TRES actually means for a job here.
 *
 * With MAX_TRES a node is billed for its largest weighted resource, so which
 * resource that is decides what a job costs. On every partition here
 * MaxMemPerCPU tops the memory term out below the CPU weight of 1, so CPU
 * always wins — but not by the same margin everywhere: med/b200/b300/h100/h200
 * size it to 0.976-0.977, just under; a100 and l40s still pair MaxMemPerCPU=6000
 * with the same Mem weight the 12000 MB partitions use, so a maxed-out core
 * there carries only 0.488 — about half the memory cost per core. The bill is
 * the core count on every partition either way, which is what is checked below;
 * it means memory is not free — it costs by forcing the core count up, not by
 * being billed directly.
 */
function billingShapeNote() {
  const jobs = model.jobDetail ?? [];
  const running = jobs.filter((j) => j.state === "RUNNING" && j.allocBilling !== null);
  const cpuDriven = running.filter((j) => j.allocBilling <= (j.allocTres.get("cpu") ?? 0) + 1).length;
  const pendingMemDriven = jobs.filter(
    (j) => j.state === "PENDING" && j.reqBilling !== null && j.reqBilling > (j.reqTres.get("cpu") ?? 0) + 1,
  ).length;

  const base = `<code>PriorityFlags</code> includes <code>MAX_TRES</code>, so a job is billed for the <em>largest</em> of its weighted resources per node, not their sum.`;
  if (!running.length) return base;
  return (
    base +
    ` <code>scontrol show job</code> settles what that comes to: for <b>${n(cpuDriven)}</b> of the ${n(
      running.length,
    )} running jobs the billed figure equals the allocated core count, because <code>MaxMemPerCPU</code> forces the core count up until it covers the memory — so memory is not billed directly, it is billed <em>through</em> the cores it obliges you to take.` +
    (pendingMemDriven
      ? ` A <em>pending</em> job can still show a memory-driven <code>ReqTRES</code> billing (${n(
          pendingMemDriven,
        )} do), because that figure is computed before the allocation absorbs it.`
      : "")
  );
}

/**
 * What finished jobs actually used, against what they asked for.
 *
 * Every other card on this page describes a request. This one is the only place
 * the page can say whether the request was *right* — and on a cluster where
 * `MaxMemPerCPU` turns memory into cores and `MAX_TRES` bills the cores, an
 * over-generous memory request has a price that can be put in core-hours.
 */
function historyCard() {
  if (!model.notes.hasHistory) return "";
  const u = state.user.trim().toLowerCase();
  const names = scopedPartitionNames();
  const scoped = model.history.filter(
    (h) => (names === null || names.has(h.partition)) && (!u || matchUser(h.user, u)),
  );
  if (!scoped.length) return "";
  const st = historyStats(scoped);
  const waste = memoryWaste(scoped, model.partitions);
  const pctOf = (v) => (v === null ? "-" : `${Math.round(v * 100)}%`);

  const tile = (label, value, sub, cls = "") =>
    `<div class="tile ${cls}"><div class="tile-label">${esc(label)}</div>
     <div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;

  const worst = waste.worst.filter((w) => w.scope === (u ? "user" : "account")).slice(0, 8);

  return `<div class="card"><div class="card-head"><h2>What finished jobs actually used</h2>
      <span class="dim">${
        st.from && st.to ? `${esc(st.from.toLocaleDateString())} – ${esc(st.to.toLocaleDateString())}` : ""
      }</span></div>
    <p class="card-sub">From <code>sacct</code> — the only dump that says what a request was actually worth. ${n(
      st.jobs,
    )} job record(s) in the window, of which ${n(
      st.completed,
    )} ran to completion; the percentages below are of what those jobs asked for.</p>
    <div class="kpis plan-kpis">
      ${tile(
        "Walltime used",
        pctOf(st.wallMedian),
        `median of ${n(st.wallSamples)} · 90th percentile ${pctOf(st.wallP90)}`,
      )}
      ${tile("Memory used", pctOf(st.memMedian), `median · 90th percentile ${pctOf(st.memP90)}`)}
      ${
        waste.jobs
          ? tile(
              "Avoidable core-hours",
              n(Math.round(waste.avoidableCoreHours)),
              `${pctOf(waste.pct)} of the bill on ${n(waste.jobs)} job(s)`,
            )
          : ""
      }
      ${tile("Ran out of time", n(st.timeouts), st.timeouts ? "hit the walltime limit" : "none")}
      ${tile("Ran out of memory", n(st.outOfMemory), st.outOfMemory ? "asked for too little" : "none")}
    </div>
    ${
      waste.jobs
        ? `<p class="axis-note"><b>Why memory costs cores.</b> ${esc(
            state.partition === "all"
              ? "Every partition here"
              : (GROUP_FILTERS[state.partition]?.scopeLabel ?? state.partition),
          )} sets <code>MaxMemPerCPU</code>, so a memory request is satisfied by taking more cores — and <code>MAX_TRES</code> bills the core count. Across these jobs that is <b>${n(
            Math.round(waste.billedMinutes / 60),
          )}</b> core-hours charged where <b>${n(
            Math.round(waste.neededMinutes / 60),
          )}</b> would have covered the memory they actually touched. Asking for what a job uses is the single cheapest saving available.</p>`
        : ""
    }
    ${
      worst.length
        ? `<div class="scroll"><table><thead><tr><th>${u ? "User" : "Account"}</th><th class="num">Jobs</th>
            <th class="num">Core-hours charged</th><th class="num">Needed</th><th class="num">Avoidable</th><th>Share wasted</th>
            </tr></thead><tbody>${worst
              .map((w) => {
                const pct = Math.min(100, w.pct * 100);
                return (
                  `<tr><td>${esc(w.key)}</td><td class="num">${n(w.jobs)}</td>` +
                  `<td class="num">${n(Math.round(w.billed / 60))}</td>` +
                  `<td class="num">${n(Math.round(w.needed / 60))}</td>` +
                  `<td class="num"><b>${n(Math.round(w.avoidable / 60))}</b></td>` +
                  `<td><div class="bar" style="width:130px" data-tip="${esc(
                    `${w.key}: ${Math.round(w.avoidable / 60)} of ${Math.round(w.billed / 60)} core-hours avoidable (${pct.toFixed(0)}%)`,
                  )}"><span class="seg" style="flex:${Math.max(pct, 0.001)};--c:var(--status-warning)"><i></i></span>` +
                  (pct < 100
                    ? `<span class="seg" style="flex:${100 - pct};--c:var(--node-alloc)"><i></i></span>`
                    : "") +
                  `</div></td></tr>`
                );
              })
              .join("")}</tbody></table></div>`
        : ""
    }
    ${strandedNote()}
    <p class="axis-note">Walltime and memory figures cover only <code>COMPLETED</code> jobs: a <code>TIMEOUT</code> used all of its walltime by definition, and a cancelled or failed job stopped for its own reasons. Memory is <code>MaxRSS</code>, the high-water mark of a single task — against a per-node <code>--mem</code> request that is exact for a one-task job and a floor for anything wider, so the waste above is a conservative figure. Over-requesting <em>walltime</em> costs nothing directly, but it keeps the backfill scheduler from fitting a job into a gap, which is why a job that asks for three days and runs for four hours waits longer than it needs to.</p></div>`;
}

/**
 * Cores handed out that nothing appears to be running on.
 *
 * The history card says jobs ask for memory they do not use; this is the same
 * finding from the live side and by an independent route — `MaxMemPerCPU` turns
 * that memory request into cores, and `CPULoad` shows the cores idle. Two dumps
 * that share no fields agreeing is worth more than either alone.
 */
function strandedNote() {
  if (!model.notes.hasNodeDetail) return "";
  const u = nodeUtilisation(model.nodeDetail);
  if (!u.nodes || u.busyFraction === null) return "";
  const worst = u.idleNodes.slice(0, 5);
  return `<p class="axis-note"><b>The live side agrees.</b> Across ${n(
    u.nodes,
  )} node(s) with work on them, <b>${n(u.cpuAlloc)}</b> cores are allocated against a total <code>CPULoad</code> of <b>${n(
    Math.round(u.cpuLoad),
  )}</b> — <b>${(u.busyFraction * 100).toFixed(0)}%</b> of what has been handed out is actually busy.${
    u.idleNodes.length
      ? ` ${n(u.idleNodes.length)} node(s) hold 16 or more cores at under a quarter load, stranding about <b>${n(
          Math.round(u.strandedCores),
        )}</b> of them${
          worst.length
            ? ` — ${worst.map((nd) => `${esc(nd.name)} (${nd.cpuAlloc} allocated, load ${nd.cpuLoad.toFixed(1)})`).join(", ")}`
            : ""
        }.`
      : ""
  } <code>CPULoad</code> is a one-minute average and counts threads, so it is evidence rather than proof — but it points the same way as the memory figures above, from a dump that shares no fields with them.</p>`;
}

function notesCard() {
  const items = [];
  for (const [name, at] of Object.entries(stamps)) {
    items.push(`<code>data/${esc(name)}</code> — ${at ? esc(at.toLocaleString()) : "timestamp unavailable"}`);
  }
  items.push(
    `parsed ${n(model.counts.sinfo)} sinfo rows, ${n(model.counts.squeue)} squeue rows, ${n(
      model.counts.sprio,
    )} sprio rows, ${n(model.counts.sshare)} sshare rows, ${n(
      model.counts.scontrolPartition,
    )} partitions and ${n(model.counts.scontrolConfig)} config settings`,
  );
  const { unattributedJobs, withoutFactors, sprioStale, priorityDrift, hasNodelist, squeueHasPartition } =
    model.notes;
  if (!squeueHasPartition)
    items.push(
      `<code>squeue.txt</code> has no PARTITION column, so every job is attributed to a partition through its <code>sprio.txt</code> row${
        unattributedJobs ? `; ${n(unattributedJobs)} job(s) appear in neither and are missing from all per-partition counts` : ""
      }. Adding <code>%P</code> to the squeue format would make this direct.`,
    );
  else if (unattributedJobs)
    items.push(`${n(unattributedJobs)} job(s) list no partition at all and are missing from per-partition counts.`);
  if (!hasNodelist)
    items.push(
      `<code>sinfo.txt</code> has no NODELIST column, so nodes cannot be named and a node belonging to two partitions is counted in both. Cluster node totals are the sum across partitions.`,
    );
  else {
    const shared = model.nodes.filter((nd) => nd.partitions.size > 1);
    items.push(
      `${n(model.nodes.length)} distinct node(s) across ${n(model.partitions.filter((p) => p.inSinfo).length)} partition(s)` +
        (shared.length
          ? `, of which ${n(shared.length)} belong to more than one and are counted once in cluster totals.`
          : `, none shared between partitions.`),
    );
  }
  if (model.cluster.busyNodes)
    items.push(
      `<code>squeue.txt</code> places running jobs on ${n(
        model.cluster.busyNodes,
      )} distinct node(s); <code>sinfo.txt</code> reports ${n(
        model.cluster.byGroup.mix + model.cluster.byGroup.alloc,
      )} mixed or allocated. The two should agree closely.`,
    );
  if (model.notes.hasNodeCapacity && model.notes.hasCpuCounts)
    items.push(
      `<code>sinfo.txt</code> reports ${n(model.cluster.cpu.alloc)} cores allocated; the running jobs in ` +
        `<code>squeue.txt</code> request ${n(model.cluster.runningCpus)}. A gap means the dumps are not simultaneous.`,
    );
  if (withoutFactors)
    items.push(
      `${n(
        withoutFactors,
      )} pending job/partition pair(s) have no <code>sprio.txt</code> row, so their priority is shown but not its breakdown — <code>sprio</code> omits jobs it will not schedule.` +
        (model.notes.dependencyHeld
          ? ` <code>scontrol_job.txt</code> names why for ${n(
              model.notes.dependencyHeld,
            )} of them: they are waiting on a dependency, which the priority queue now shows in the <em>Ageing</em> column.`
          : ""),
    );
  if (sprioStale)
    items.push(
      `${n(
        sprioStale,
      )} row(s) in <code>sprio.txt</code> do not match a job <code>squeue.txt</code> lists as pending — mostly jobs that have since started. They are ignored.`,
    );
  if (priorityDrift)
    items.push(
      `${n(
        priorityDrift,
      )} job(s) have a different priority in the two files, because the age factor grows continuously and the dumps are not captured at the same instant. Ordering uses <code>squeue.txt</code>; dumping the two closer together shrinks the gap.`,
    );
  const missing = model.partitions.filter((p) => !p.inSinfo).map((p) => p.name);
  if (missing.length)
    items.push(
      `Partition(s) <b>${esc(missing.join(", "))}</b> appear in the job data but not in <code>sinfo.txt</code>, so their node status is unknown (hidden partition, or the dump predates them).`,
    );
  if (model.notes.sprioTruncates)
    items.push(
      `<code>sprio.txt</code> caps USER and ACCOUNT at 8 characters while the other dumps do not, so those columns come from <code>squeue.txt</code> where the job IDs join, and account names are matched back to <code>sshare.txt</code>. A width such as <code>%20u</code> in the sprio format removes the guesswork.`,
    );
  if (!model.notes.hasJobAccounts)
    items.push(
      `No dump reports which account a job belongs to, so the priority queue cannot show it and per-account pending counts are unavailable. In <code>sprio</code>, <code>%a</code> means normalized <em>age</em>, not account — add <code>%a</code> to the <b>squeue</b> format instead, where it is the account.`,
    );
  if (model.notes.ambiguousAccounts.length)
    items.push(
      `${n(model.notes.ambiguousAccounts.length)} truncated account name(s) match more than one <code>sshare</code> account and were left unresolved: <b>${esc(
        model.notes.ambiguousAccounts.join(", "),
      )}</b>.`,
    );
  const over = model.accounts.filter((a) => a.cpuLimit && a.runCpu > a.cpuLimit);
  if (over.length)
    items.push(
      `${n(over.length)} account(s) have more CPU-minutes running than their <code>GrpTRESMins</code> allowance — <b>${esc(
        over.map((a) => a.account).join(", "),
      )}</b> — and cannot start new work until running jobs finish.`,
    );
  const niced = model.partitions.flatMap((p) => p.queue).filter((r) => r.nice !== 0);
  if (niced.length) items.push(`${n(niced.length)} pending job(s) carry a non-zero nice value.`);
  const noEstimate = model.partitions.flatMap((p) => p.queue).filter((r) => !r.start).length;
  if (model.notes.hasStartEstimates && noEstimate)
    items.push(
      `${n(
        noEstimate,
      )} pending job/partition pair(s) have no estimated start time yet — the backfill scheduler only computes one for jobs it can place.`,
    );
  if (!model.notes.hasCpuCounts)
    items.push(`No CPU counts on jobs; add <code>%C</code> to the squeue format for resource demand.`);
  if (model.notes.hasNodeCapacity)
    items.push(
      model.notes.hasJobDetail
        ? `<code>sinfo</code> reports configured GRES but not allocated GRES, so GPU usage comes from each job's own <code>AllocTRES</code> in <code>scontrol_job.txt</code>.` +
            (model.notes.gpuCorrected
              ? ` That corrected <b>${n(model.notes.gpuCorrected)}</b> job(s) and <b>${n(
                  model.notes.gpuDelta,
                )}</b> GPUs against <code>squeue</code>'s <code>%b</code>, which is per-node and reports nothing for a <code>--gpus</code> request — the figure used to run that much low.`
              : "")
        : `<code>sinfo</code> reports configured GRES but not allocated GRES, so GPU usage is taken from what running jobs request. A GPU held by an idle allocation is not counted as in use, and the figure is a floor.`,
    );
  if (model.notes.hasAssocMgr) {
    const at = model.notes.limitsAtCeiling;
    items.push(
      `<code>scontrol_assoc_mgr.txt</code> reports every limit together with the usage counted against it, in a <code>LIMIT(USAGE)</code> form. ${n(
        model.assocLimits.length,
      )} limit(s) are actually set across ${n(model.counts.assocMgr)} association and QOS records${
        at ? `, and <b>${n(at)}</b> of them are at or over their ceiling` : ""
      }. Caps below are read from it rather than matched by shape, and a <code>GrpTRESMins</code> budget now has a consumed figure.`,
    );
  }
  if (model.notes.hasPartitionInfo) {
    items.push(
      `<code>scontrol_partition.txt</code> supplies each partition's own limits — <code>MaxNodes</code>, <code>MaxTime</code>, <code>MaxCPUsPerNode</code>, <code>MaxMemPerCPU</code>, <code>TRESBillingWeights</code> — none of which are in <code>sinfo</code>. The job planner checks against them.` +
        (model.notes.partitionQos.length
          ? ` ${n(model.notes.partitionQos.length)} partition(s) attach a QOS of their own: <b>${esc(
              model.notes.partitionQos.join(", "),
            )}</b>, so the caps below are named rather than matched by shape.`
          : ""),
    );
  }
  if (model.notes.hasJobDetail) {
    items.push(
      `<code>scontrol_job.txt</code> gives every job's own numbers: <code>NumCPUs</code> (the count SLURM costed, not the count requested), <code>AccrueTime</code> (what the age factor counts from), and <code>ReqTRES</code>/<code>AllocTRES</code> with SLURM's own <code>billing=</code> figure.` +
        (model.notes.notAccruing
          ? ` <b>${n(model.notes.notAccruing)}</b> of ${n(
              model.notes.accruing + model.notes.notAccruing,
            )} pending job(s) have no <code>AccrueTime</code> and are earning no age priority at all — they will not climb the queue until whatever holds them clears${
              model.notes.dependencyHeld
                ? `, and ${n(model.notes.dependencyHeld)} of those are held by a dependency`
                : ""
            }.`
          : ""),
    );
    const samples = model.factorSamples ?? [];
    const auth = samples.filter((x) => x.authoritative).length;
    if (samples.length)
      items.push(
        `Of ${n(samples.length)} <code>sprio</code> row(s) that match a job record, <b>${n(
          auth,
        )}</b> are running and so can be scored against the priority model — for a running job <code>NumCPUs</code> is the allocated count the factor was computed from. The ${n(
          samples.length - auth,
        )} pending one(s) cannot: their <code>NumCPUs</code> is still only the request, identical to <code>squeue</code>'s, while the factor is computed against the allocation the scheduler projects. No dump reports that.`,
      );
  }
  if (model.notes.hasNodeDetail) {
    const u = nodeUtilisation(model.nodeDetail);
    items.push(
      `<code>scontrol_node.txt</code> gives per-node <code>CPUAlloc</code>, <code>CPULoad</code>, <code>AllocMem</code> and <code>AllocTRES</code>, so "can this job start now" is a placement question rather than an arithmetic one — ${n(
        model.counts.scontrolNode,
      )} node(s) read.` +
        (u.busyFraction !== null
          ? ` It also shows <b>${n(u.cpuAlloc)}</b> cores allocated against a total load of <b>${n(
              Math.round(u.cpuLoad),
            )}</b>.`
          : "") +
        ` <code>CPUEfctv</code> matches each partition's <code>MaxCPUsPerNode</code> exactly, so that limit is <code>CoreSpecCount</code> being held back rather than a policy choice.`,
    );
  }
  if (model.notes.hasRichQos) {
    items.push(
      `<code>sacctmgr_qos.txt</code> carries the QOS fields the narrow dump omits. <code>UsageFactor</code> is ${
        model.notes.usageFactors.length
          ? `not 1 on ${esc(model.notes.usageFactors.join(", "))}, which scales what those jobs are charged`
          : `1.0 on every QOS, so nothing scales what a job is charged — worth knowing rather than assuming`
      }.` +
        (model.notes.qosWallCaps.length
          ? ` <b>${esc(model.notes.qosWallCaps.join(", "))}</b> cap walltime per job through <code>MaxWall</code>, which is in no other dump.`
          : "") +
        (model.notes.denyOnLimit.length
          ? ` <b>${esc(
              model.notes.denyOnLimit.join(", "),
            )}</b> carry <code>DenyOnLimit</code>, so a job breaching one of their limits is refused at submit rather than queued.`
          : ""),
    );
  }
  if (model.notes.hasConfig) {
    const c = model.config;
    items.push(
      `<code>scontrol_config.txt</code> gives the priority weights directly: age ${n(c.ageWeight ?? 0)} over ${dur(
        c.ageMax,
      )}, job size ${n(c.jobSizeWeight ?? 0)}, fair-share ${n(c.fairShareWeight ?? 0)}, QOS ${n(
        c.qosWeight ?? 0,
      )}, partition ${n(c.partitionWeight ?? 0)}, assoc ${n(c.assocWeight ?? 0)}` +
        (c.flags.length ? `; <code>PriorityFlags=${esc(c.flags.join(","))}</code>` : "") +
        `. Nothing about priority is inferred any more.`,
    );
    if (model.notes.inertFactors.length)
      items.push(
        `<b>${esc(
          model.notes.inertFactors.map((f) => FACTOR_LABEL[f] ?? f).join(", "),
        )}</b> carries a non-zero weight but evaluates to zero for every pending job${
          model.notes.inertFactors.includes("fairshare")
            ? ` — every account's computed fair-share is 0.000000 in <code>sshare</code>, so a weight of ${n(
                model.config.fairShareWeight ?? 0,
              )} contributes nothing and priority is age plus job size in practice`
            : ""
        }.`,
      );
    if (model.config.maxTres) items.push(billingShapeNote());
  }
  if (model.notes.hasLimits) {
    const inferred = model.limits.filter((l) => l.cap?.inferred);
    if (inferred.length)
      items.push(
        `${n(inferred.length)} limit(s) were matched to a QOS the blocked jobs do not themselves carry — ${esc(
          inferred.map((l) => `${l.key} → ${l.cap.source}`).join(", "),
        )}, and not to a QOS any of their partitions attaches either.`,
      );
    if (model.notes.unresolvedLimits)
      items.push(
        `${n(
          model.notes.unresolvedLimits,
        )} blocking limit(s) have no matching entry in <code>sacct_qos.txt</code> or <code>sacct_assoc.txt</code>, so the cap is unknown.`,
      );
  } else {
    items.push(
      `No <code>sacctmgr</code> data, so the account and QOS limits behind most blocked jobs cannot be shown.`,
    );
  }
  if (!model.notes.hasMemoryRequests)
    items.push(`No memory requests on jobs; add <code>%m</code> to the squeue format to see memory demand.`);
  for (const w of model.warnings.slice(0, 5)) items.push(esc(w));
  if (model.warnings.length > 5) items.push(`…and ${n(model.warnings.length - 5)} more parse warnings.`);

  return `<div class="card"><div class="card-head"><h2>Data notes</h2></div>
    <ul class="notes">${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
}

function card(title, sub, viewKey, body) {
  const t = viewKey
    ? `<div class="toggle" role="group" aria-label="${esc(title)} view">
         <button data-view="${viewKey}" data-mode="chart" aria-pressed="${state.views[viewKey] === "chart"}">Chart</button>
         <button data-view="${viewKey}" data-mode="table" aria-pressed="${state.views[viewKey] === "table"}">Table</button>
       </div>`
    : "";
  return `<div class="card"><div class="card-head"><h2>${esc(title)}</h2>${t}</div>
    <p class="card-sub">${esc(sub)}</p>${body}</div>`;
}

function render() {
  const parts = scopedPartitions();
  renderFreshness();
  document.getElementById("main").innerHTML =
    kpiRow(parts) + nodesCard(parts) + capacityCard(parts) + queueCard(parts);
  document.getElementById("details-main").innerHTML =
    problemCard(parts) +
    limitsCard(parts) +
    ceilingCard() +
    historyCard() +
    priorityCard(parts) +
    accountsCard(parts) +
    notesCard();
}

// ---------------------------------------------------------------- planner

const planForm = document.getElementById("plan-form");

// ehunte18 is the tool's most common user — seed the account select with them
// on first load only, so a later refresh never overwrites someone's own choice
// (including an explicit switch back to "(default)", which is also "").
const DEFAULT_ACCOUNT = "ehunte18";
let accountSeeded = false;

// The form is static markup, so the tick boxes can be found once.
const optBoxes = new Map(
  [...planForm.querySelectorAll(".opt")].map((box) => [box.dataset.opt, box]),
);

const optOn = (key) => optBoxes.get(key)?.checked ?? false;

// The form's own values, typed. Number inputs come back as strings, and a blank
// one must not silently become 0 in the middle of a multiplication.
//
// A directive whose tick box is clear reads as null the whole way down: the
// preamble writes no line for it and the estimates substitute what SLURM would.
// That is why null rather than 0 or "" — `--nodes=0` is a rejected job, no
// `--nodes` at all is a one-node job, and the two must not collapse together.
function readPlanForm() {
  const el = (name) => planForm.elements[name];
  const num = (name, dflt = 0) => {
    const v = el(name)?.value;
    return v === "" || v === undefined || Number.isNaN(Number(v)) ? dflt : Number(v);
  };
  const str = (name) => (el(name)?.value ?? "").trim();
  const optNum = (key, name, dflt) => (optOn(key) ? num(name, dflt) : null);
  const optStr = (key, name) => (optOn(key) ? str(name) : null);
  return {
    jobName: optStr("jobName", "jobName"),
    partition: optStr("partition", "partition"),
    account: optStr("account", "account"),
    qos: optStr("qos", "qos"),
    nodes: optNum("nodes", "nodes", 1),
    ntasksPerNode: optNum("ntasksPerNode", "ntasksPerNode", 1),
    cpusPerTask: optNum("cpusPerTask", "cpusPerTask", 1),
    gpusPerNode: optNum("gpus", "gpusPerNode", 0),
    gpuModel: optStr("gpus", "gpuModel"),
    memValue: optNum("mem", "memValue", 0),
    memUnit: str("memUnit") || "G",
    memPer: str("memPer") || "node",
    days: optNum("time", "days", 0),
    hours: optNum("time", "hours", 0),
    minutes: optNum("time", "minutes", 0),
    array: optStr("array", "array"),
    output: optStr("output", "output"),
    error: optStr("error", "error"),
    mailType: optStr("mail", "mailType"),
    mailUser: optStr("mail", "mailUser"),
    constraint: optStr("constraint", "constraint"),
    // A bare flag is already its own switch: absent unless ticked.
    exclusive: el("exclusive")?.checked ?? false,
    requeue: el("requeue")?.checked ?? false,
  };
}

/**
 * Bring one directive's inputs into line with its tick box.
 *
 * Switching a directive on seeds it with the value SLURM would have used
 * anyway — the partition's DefaultTime, its DefMemPerCPU, the default partition
 * — so ticking a box never changes what the job asks for, it only writes the
 * assumption down where it can be edited. `seed` is skipped for a box that was
 * already on, so re-rendering the form does not undo anyone's typing.
 */
function syncOption(opt, defaults, seed) {
  const on = optOn(opt.key);
  for (const name of opt.inputs) {
    const el = planForm.elements[name];
    if (!el) continue;
    el.disabled = !on;
    // The row's label dims with its input rather than with the tick box beside
    // it — "Mail to" belongs to the mail directive but sits a row below it.
    if (el.id) planForm.querySelector(`label[for="${el.id}"]`)?.classList.toggle("off", !on);
  }
  const d = defaults[opt.key];
  const box = optBoxes.get(opt.key);
  if (box && d) box.dataset.tip = `Left clear: ${d.text}`;
  if (!d?.values) return;
  // Switched on, the value is the user's, and is written only at the moment the
  // box is ticked. Switched off, the box goes on showing what SLURM will use,
  // refreshed as the partition and the GPU count move under it — a greyed-out
  // figure that disagrees with the cost card beside it is worse than none, and
  // it is the reason the walltime row could read 1h against a 4h estimate. Only
  // entries marked `real` have a value worth showing that way; the rest are
  // starting points for a directive SLURM would simply not apply.
  if (on ? !seed : !d.real) return;
  for (const [name, value] of Object.entries(d.values)) {
    const el = planForm.elements[name];
    // A select can only be seeded with an option it actually has — the GPU model
    // list is rebuilt per partition, and an account may not hold every QOS.
    if (!el) continue;
    if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(value))) continue;
    el.value = value;
  }
}

/**
 * The partition the job actually lands in. A preamble with no `--partition` is
 * not a job with no partition: SLURM sends it to the one marked `Default=YES`,
 * and every check and estimate on the page has to be made against that one.
 */
function planPartition(name) {
  const parts = model?.partitions ?? [];
  return (name ? parts.find((p) => p.name === name) : parts.find((p) => p.isDefault)) ?? null;
}

// Every tick box against its inputs. `seedKey` is the one directive just
// switched on, which is the only one whose value may be overwritten.
function syncOptions(seedKey = null) {
  const part = planPartition(optOn("partition") ? planForm.elements.partition.value : "");
  // The request as it stands decides some of the seeds — what --cpus-per-task
  // would have been depends on how many GPUs this job asks for.
  const defaults = preambleDefaults(model, part, toRequest(readPlanForm()));
  for (const opt of PREAMBLE_OPTIONS) syncOption(opt, defaults, opt.key === seedKey);
}

// Replace a select's options while keeping the current choice if it survives.
function fillSelect(el, options, fallback) {
  const want = el.value;
  el.innerHTML = options
    .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
    .join("");
  const has = options.some(([v]) => v === want);
  el.value = has ? want : (fallback ?? options[0]?.[0] ?? "");
}

// QOS is an association property, so offer only what the chosen account may use.
function fillQos() {
  const account = planForm.elements.account.value;
  const assoc = model.assocList?.find((a) => a.account === account && !a.user);
  const names = assoc?.qos.length ? assoc.qos : model.qosList.map((q) => q.name);
  fillSelect(planForm.elements.qos, [["", "(default)"], ...names.map((q) => [q, q])]);
}

// GPU models are a property of the partition's nodes — the partition the job
// really lands in, which is the default one whenever --partition is switched off.
// Reading the disabled select instead would offer a model from a partition the
// job is not going to.
function fillGpuModels() {
  const p = planPartition(optOn("partition") ? planForm.elements.partition.value : "");
  const models = p?.gpuModel ? [[p.gpuModel, p.gpuModel]] : [];
  fillSelect(planForm.elements.gpuModel, [["", "(any)"], ...models], "");
}

function renderPlanForm() {
  const parts = model.partitions.filter((p) => p.inSinfo);
  fillSelect(
    planForm.elements.partition,
    (parts.length ? parts : model.partitions).map((p) => [
      p.name,
      // Kept short: a select truncates rather than wraps, and the detail is on
      // the cards beside it anyway.
      `${partLabel(p)}${p.isDefault ? " *" : ""} — ${n(p.nodes)}n` +
        (p.perNode.gpus ? ` · ${p.perNode.gpus}×${p.gpuModel ?? "gpu"}` : ""),
    ]),
    parts.find((p) => p.isDefault)?.name,
  );
  const accountNames = [...model.accounts].sort((a, b) => a.account.localeCompare(b.account)).map((a) => a.account);
  fillSelect(
    planForm.elements.account,
    [["", "(default)"], ...accountNames.map((a) => [a, a])],
    "",
  );
  if (!accountSeeded) {
    accountSeeded = true;
    if (accountNames.includes(DEFAULT_ACCOUNT)) {
      planForm.elements.account.value = DEFAULT_ACCOUNT;
      // Seeding the value alone leaves the tick box (and every account-gated
      // read in readPlanForm) blind to it — flip it on so the select isn't
      // stuck disabled and the rest of the planner actually sees the account.
      const box = optBoxes.get("account");
      if (box) box.checked = true;
    }
  }
  fillGpuModels();
  fillQos();
  syncOptions();
  renderPlan();
}

// Feasibility levels: a hard stop, something that only makes the job wait, and
// a check that passed. The word is always printed, so colour never carries it.
const LEVEL_COLOR = {
  ok: "var(--status-good)",
  info: "var(--series-1)",
  note: "var(--muted)",
  warn: "var(--status-warning)",
  bad: "var(--status-critical)",
};

/**
 * The submit script drawer at the foot of the planner: the `#SBATCH` preamble
 * plus a meta line, refreshed on every edit. Feasibility's own checks already
 * name the directives a partition rule silently adjusts; this only has to say
 * what SLURM assumed for the rest.
 */
function renderDrawer(f) {
  const lines = ["#!/bin/bash", ...sbatchPreamble(f)];
  document.getElementById("plan-script").textContent = lines.join("\n");
  const dirCount = lines.length - 1;
  const name = f.jobName || "job";
  document.getElementById("plan-drawer-meta").textContent =
    `${name}.sh · ${n(dirCount)} directive${dirCount === 1 ? "" : "s"} · updates as you type`;
}

// The header line above the directive table: where the job would land and
// where its priority weights came from.
function planMetaLine(part, req) {
  const pending = part?.queue?.length ?? 0;
  const acct = req.account || "association default";
  const src = prioModel.source === "config" ? "weights from scontrol show config" : "weights fitted from the dumps";
  return `${part?.name ?? "no partition"} · ${esc(acct)} · ${n(pending)} pending · ${src}`;
}

function feasibilityCard(req, part) {
  const checks = feasibility(req, part, model, prioModel);
  const bad = checks.filter((c) => c.level === "bad");
  const warn = checks.filter((c) => c.level === "warn");
  const verdict = bad.length
    ? ["bad", `Will not run as written — ${n(bad.length)} problem${bad.length === 1 ? "" : "s"}`]
    : warn.length
      ? ["warn", "Valid, but it will have to wait"]
      : ["ok", "Valid, and the capacity is free right now"];

  const feasTip = `Checked against ${
    model.notes.hasPartitionInfo
      ? "the partition's configured limits, what sinfo reports each node holds, and the QOS caps"
      : "what sinfo reports each node holds and the caps in sacct_qos.txt"
  }.`;

  // Every level collapses into one of three buckets: a hard stop, a silent
  // adjustment (applied or just noted), and everything else that passed —
  // "will wait" is still a check that passed, just not instantly. Each
  // bucket is a table column that expands independently, so its rows stay
  // open across re-renders instead of resetting on every keystroke.
  const GROUPS = [
    { key: "blocked", title: "Blocked", color: LEVEL_COLOR.bad, levels: ["bad"] },
    { key: "ok", title: "OK", color: LEVEL_COLOR.ok, levels: ["ok", "warn"] },
    { key: "adjusted", title: "Adjusted", color: LEVEL_COLOR.info, levels: ["info", "note"] },
  ];

  const groups = GROUPS.map((g) => ({
    ...g,
    items: checks.filter((c) => g.levels.includes(c.level)),
    open: state.expanded.has(`feas-${g.key}`),
  }));
  const rowCount = Math.max(0, ...groups.map((g) => (g.open ? g.items.length : 0)));
  const rows = Array.from(
    { length: rowCount },
    (_, i) =>
      `<tr>${groups
        .map((g) => {
          const c = g.open ? g.items[i] : null;
          return `<td>${c ? `<b>${esc(c.label)}</b><span class="tip-icon" data-tip="${esc(c.text)}">?</span>` : ""}</td>`;
        })
        .join("")}</tr>`,
  ).join("");

  return `<div class="card"><div class="card-head"><h2>Will it run?</h2><span class="tip-icon" data-tip="${esc(
    feasTip,
  )}">?</span>
      <span class="chip" style="--c:${LEVEL_COLOR[verdict[0]]}"><i class="dot"></i>${esc(verdict[1])}</span></div>
    <table class="feas-table"><thead><tr>${groups
      .map(
        (g) =>
          `<th class="feas-col-head${g.open ? " open" : ""}"${
            g.items.length ? ` data-expand="feas-${g.key}"` : ""
          }><span class="chip" style="--c:${g.color}"><i class="dot"></i>${esc(
            g.title,
          )}</span><span class="feas-count">${n(g.items.length)}</span></th>`,
      )
      .join("")}</tr></thead>
    <tbody>${rows}</tbody></table>
    <details class="tech-notes"><summary>Technical notes</summary>
    <p class="axis-note">${
      model.notes.hasPartitionInfo
        ? `Limits come from <code>scontrol show partition</code>, so <code>MaxNodes</code>, <code>MaxTime</code>, <code>MaxCPUsPerNode</code>, <code>MaxMemPerCPU</code>, <code>AllowAccounts</code>/<code>AllowQos</code> and the partition's own QOS are all checked. What is still not checked is anything set on your association — <code>MaxJobs</code>, <code>GrpTRES</code> — and whether the nodes free right now are the ones that fit.`
        : `A partition's <em>own</em> limits — <code>MaxNodes</code>, <code>MaxTime</code>, <code>MaxMemPerNode</code>, the QOS it attaches — are in none of these dumps, so a request can still be rejected by something not checked here. <code>scontrol -o show partition</code> would close that gap.`
    }</p></details></div>`;
}

function costCard(req, part) {
  const cost = jobCost(req);
  const total = req.tasks > 1 ? jobCost({ ...req, minutes: req.minutes * req.tasks }) : cost;
  const head = accountHeadroom(model, req.account, total);

  const tile = (label, value, sub) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div>
     <div class="tile-value">${value}</div><div class="tile-sub">${esc(sub)}</div></div>`;

  // What fraction of the partition this job would occupy for its whole runtime.
  const shareCpu = part?.cpu.total ? (req.cpus / part.cpu.total) * 100 : null;
  const shareGpu = part?.gpuTotal ? (req.gpus / part.gpuTotal) * 100 : null;

  const bill = jobBilling(req, part, model.config, model.qosList?.find((q) => q.name === (req.qos || part?.info?.qos)));
  const billTotal = bill ? bill.minutes * (req.tasks > 1 ? req.tasks : 1) : null;

  // Every tile is a total over the whole run, and the line under it is the rate
  // and the time that produced it. Mixing the two — a bill quoted as units held,
  // beside CPU-hours quoted over the run — reads as a far cheaper job than it is,
  // so the multiplication is written out under every one of them.
  const over = `${dur(req.minutes * 60)}${req.tasks > 1 ? ` × ${n(req.tasks)} tasks` : ""}`;
  const plural = (v, word) => `${n(v)} ${word}${v === 1 ? "" : "s"}`;

  const costTip =
    "What the job commits if it runs to its full walltime — each figure is the whole run, not the rate while it runs. These are the same TRES-minutes that GrpTRESMins caps and sshare reports as in flight.";

  const topTiles = [
    bill
      ? tile(
          "Billing-hours",
          n(Math.round(billTotal / 60)),
          `${plural(Math.round(bill.total), "unit")} held × ${over} = ${n(
            Math.round(billTotal),
          )} billing-minutes`,
        )
      : "",
    req.gpus ? tile("GPU-hours", n(Math.round(total.gpuHours)), `${plural(req.gpus, "GPU")} × ${over}`) : "",
  ]
    .filter(Boolean)
    .join("");

  return `<div class="card"><div class="card-head"><h2>Cost of the whole run</h2><span class="tip-icon" data-tip="${esc(
    costTip,
  )}">?</span></div>
    ${topTiles ? `<div class="kpis plan-kpis">${topTiles}</div>` : ""}
    <div class="kpis plan-kpis cost-line">
      ${tile("CPU-hours", n(Math.round(total.cpuHours)), `${plural(req.cpus, "core")} × ${over}`)}
      ${tile(
        "Node-hours",
        n(Math.round(total.nodeHours * 10) / 10),
        `${plural(req.nodes, "node")} × ${over}`,
      )}
      ${tile(
        "GB-hours",
        n(Math.round(total.memGBMinutes / 60)),
        `${n(Math.round(req.memMB / 1024))} GB × ${over}`,
      )}
    </div>
    ${
      head
        ? `<div class="scroll"><table><thead><tr><th>Against ${esc(head.account.account)}</th>
            <th class="num">Allowance</th><th class="num">Already committed</th><th class="num">This job</th>
            <th class="num">Left after</th><th>Usage</th></tr></thead><tbody>
          ${head.rows
            .map((r) => {
              const after = r.limit ? r.limit - r.used - r.want : null;
              const pct = r.limit ? Math.min(100, ((r.used + r.want) / r.limit) * 100) : 0;
              const fill = pct >= 100 ? "var(--status-critical)" : pct >= 90 ? "var(--status-warning)" : "var(--node-alloc)";
              return (
                `<tr><td>${esc(r.label)}</td>` +
                `<td class="num">${r.limit ? n(r.limit) : '<span class="dim">none</span>'}</td>` +
                `<td class="num">${n(Math.round(r.used))}</td>` +
                `<td class="num"><b>${n(Math.round(r.want))}</b></td>` +
                `<td class="num">${
                  after === null
                    ? '<span class="dim">-</span>'
                    : after < 0
                      ? `<span class="chip" style="--c:var(--status-critical)"><i class="dot"></i>${n(Math.round(after))} over</span>`
                      : n(Math.round(after))
                }</td>` +
                `<td>${
                  r.limit
                    ? `<div class="bar" style="width:140px" data-tip="${esc(
                        `${r.label}: ${n(Math.round(r.used))} committed + ${n(Math.round(r.want))} for this job = ${pct.toFixed(0)}% of ${n(r.limit)}`,
                      )}"><span class="seg" style="flex:${Math.max(r.used, 0.001)};--c:${fill}"><i></i></span>` +
                      `<span class="seg" style="flex:${Math.max(r.want, 0.001)};--c:var(--series-2)"><i></i></span>` +
                      (r.used + r.want < r.limit
                        ? `<span class="seg" style="flex:${r.limit - r.used - r.want};--c:var(--node-idle)"><i></i></span>`
                        : "") +
                      `</div>`
                    : '<span class="dim">uncapped</span>'
                }</td></tr>`
              );
            })
            .join("")}
          </tbody></table></div>`
        : `<p class="axis-note">No <code>sshare</code> row for <b>${esc(req.account || "this account")}</b>, so its remaining allowance is unknown.</p>`
    }
    <details class="tech-notes"><summary>Technical notes</summary>
    ${bill ? billingNote(bill, part, req) : ""}
    <p class="axis-note">${
      shareCpu !== null
        ? `While running, this job holds <b>${shareCpu.toFixed(1)}%</b> of ${esc(part.name)}'s cores${
            shareGpu !== null ? ` and <b>${shareGpu.toFixed(1)}%</b> of its GPUs` : ""
          }. `
        : ""
    }${
      req.tasks > 1
        ? `Figures above are the whole array — ${n(req.tasks)} tasks × ${dur(req.minutes * 60)} each. `
        : ""
    }${
      bill
        ? ""
        : `This is resource-time, not <em>billing</em>: SLURM charges a weighted combination set per partition by <code>TRESBillingWeights</code>, which <code>scontrol show partition</code> would supply.`
    }</p></details></div>`;
}

/**
 * What the job is actually billed for. Under MAX_TRES only one resource is
 * charged, so showing all the terms side by side makes clear which one to change
 * — on this cluster it is almost always memory, which is not the obvious answer.
 *
 * The per-node weight is what decides *which* term wins, so it has to be shown;
 * but it is a rate, and the row carrying "this is what you pay" has to state what
 * is paid. So each term is given twice: the per-node weight it is compared on,
 * and the billing-hours it comes to over the whole run — the second of which is
 * the figure in the tile above, for the winning row.
 */
function billingNote(bill, part, req) {
  const w = bill.weights;
  const nodes = req.nodes;
  const tasks = req.tasks > 1 ? req.tasks : 1;
  const rate = (k) => (w.has(k) ? w.get(k) : null);
  // Term values are the raw per-node weights; the QOS UsageFactor scales what is
  // actually charged, and bill.perNode already carries it.
  const runHours = (v) => (v * nodes * req.minutes * bill.usageFactor * tasks) / 60;
  const rows = bill.terms
    .map((t) => {
      const won = bill.driver === t;
      const hrs = runHours(t.value);
      return (
        `<tr><td>${esc(t.label)}</td>` +
        `<td class="num dim">${
          t.tres === "mem" ? `${rate("mem")} per GB` : `${rate(t.tres) ?? 0} per ${t.tres === "cpu" ? "core" : t.tres.replace("gres/", "")}`
        }</td>` +
        `<td class="num${won ? "" : " dim"}">${n(Math.round(t.value * 100) / 100)}</td>` +
        `<td class="num${won ? "" : " dim"}">${
          won ? `<b>${n(Math.round(hrs))}</b>` : n(Math.round(hrs))
        }</td>` +
        `<td>${
          won
            ? `<span class="chip" style="--c:var(--series-2)"><i class="dot"></i>this is what you pay</span>`
            : bill.max
              ? '<span class="dim">not charged</span>'
              : ""
        }</td></tr>`
      );
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th>${esc(part.name)} charges</th>
      <th class="num">Rate</th><th class="num">Units per node</th>
      <th class="num">Billing-hours over the run</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="axis-note">${
      bill.max
        ? `<code>PriorityFlags=MAX_TRES</code> is set, so a node is billed for the <em>largest</em> of these, not their sum — <b>${esc(
            bill.driver?.label ?? "one resource",
          )}</b> here. Trimming anything else changes nothing about the bill.`
        : `Billed as the sum of these, from <code>TRESBillingWeights</code>.`
    } ${n(Math.round(bill.perNode))} unit${Math.round(bill.perNode) === 1 ? "" : "s"} per node × ${n(nodes)} node${
      nodes === 1 ? "" : "s"
    } = ${n(Math.round(bill.total))} held, and they are held for the whole walltime — so the charge is
    that × ${dur(req.minutes * 60)}${tasks > 1 ? ` × ${n(tasks)} tasks` : ""} =
    <b>${n(Math.round((bill.minutes * tasks) / 60))}</b> billing-hours
    (${n(Math.round(bill.minutes * tasks))} billing-minutes).${
      bill.usageFactor !== 1
        ? ` The QOS <code>UsageFactor</code> of ${bill.usageFactor} is already in those figures.`
        : ""
    }</p>`;
}

function priorityCardPlan(req, part) {
  const pm = prioModel;
  const est = estimatePriority(req, part, pm);
  const start = Math.floor(est.start);
  const rank = rankIn(part, start);
  const queue = part?.queue ?? [];

  const ahead = queue.filter((r) => r.priority > start);
  const passable = ahead
    .map((r) => ({ r, t: overtakeSeconds(est.base, r, pm) }))
    .filter((x) => x.t !== null);
  const stuck = ahead.length - passable.length;

  // A range whose ends round to the same thing reads as broken, not as precise.
  const span = (xs) => {
    const lo = dur(Math.min(...xs));
    const hi = dur(Math.max(...xs));
    return lo === hi ? `after about ${lo}` : `after ${lo} to ${hi}`;
  };

  // Job size spans a few dozen points where age spans thousands, so on a cluster
  // configured this way the queue is very nearly first-in-first-out. Worth
  // saying, because it is the single most useful fact about waiting here.
  const bases = queue.filter((r) => r.factors).map((r) => r.priority - r.factors.age);
  const spread = bases.length ? Math.max(...bases) - Math.min(...bases) : 0;
  const fifo = bases.length > 1 && spread < pm.ageWeight / 10;

  const at = (secs) => Math.floor(est.base + ageScore(secs, pm));
  const growth = [
    ["at submit", 0],
    ["+1 day", 86400],
    ["+3 days", 3 * 86400],
    [`at the cap (${dur(pm.ageMax)})`, pm.ageMax],
  ];

  const prioTip = `What this job would score the moment you submit it, and where that puts it in ${
    part?.name ?? "the partition"
  }'s queue as it stands.`;

  // Up to three rows around the job's slot: one neighbour on each side, or two
  // on whichever side exists when it lands at either end of the queue.
  const ins = rank.ahead;
  let beforeCount, afterCount;
  if (ins === 0) {
    beforeCount = 0;
    afterCount = Math.min(2, queue.length);
  } else if (ins === queue.length) {
    beforeCount = Math.min(2, queue.length);
    afterCount = 0;
  } else {
    beforeCount = 1;
    afterCount = 1;
  }
  const beforeRows = queue.slice(ins - beforeCount, ins);
  const afterRows = queue.slice(ins, ins + afterCount);
  const previewRows = [
    ...beforeRows.map((r, i) => ({ r, rankNum: rank.rank - beforeRows.length + i })),
    { you: true, rankNum: rank.rank },
    ...afterRows.map((r, i) => ({ r, rankNum: rank.rank + 1 + i })),
  ];

  const preview = `<div class="qprev">${previewRows
    .map(
      (row) =>
        `<div class="qprev-row${row.you ? " you" : ""}"><span class="num">#${n(row.rankNum)}</span>` +
        `<span class="job">${
          row.you ? "This job" : `${esc(row.r.jobid)} <span class="dim">${esc(row.r.user)}</span>`
        }</span><span class="pri">${n(row.you ? start : row.r.priority)}</span></div>`,
    )
    .join("")}</div>${
    queue.length === 0
      ? `<p class="axis-note">Nothing else pending in ${esc(part?.name ?? "this partition")}.</p>`
      : ""
  }`;

  return `<div class="card"><div class="card-head"><h2>Priority at submit</h2><span class="tip-icon" data-tip="${esc(
    prioTip,
  )}">?</span></div>
    <p class="rank-line">Rank in queue: <b>${n(rank.rank)}</b><span class="of">/${n(
      rank.total + 1,
    )}</span> <span class="dim">— ${n(rank.ahead)} pending job(s) ahead of it</span></p>
    <details class="tech-notes"><summary>Preview Queue Placement</summary>
    ${preview}</details>
    <details class="tech-notes"><summary>Technical notes</summary>
    <p class="axis-note">Priority over time: ${growth
      .map(([label, s]) => `${esc(label)} <b>${n(at(s))}</b>`)
      .join(" · ")}.</p>
    <p class="axis-note">${
      ahead.length === 0
        ? `Nothing pending in ${esc(part?.name ?? "this partition")} outranks it, so it is next in line for whatever frees up. `
        : `Every pending job gains age priority at the same rate, so waiting does not close a gap — a job ahead only stops pulling away once it hits the age cap. Of the <b>${n(
            ahead.length,
          )}</b> ahead of this one, <b>${n(
            stuck,
          )}</b> score higher on something other than age and cannot be passed by waiting at all; they move only when they start or are cancelled. ${
            passable.length
              ? `The other <b>${n(passable.length)}</b> would be passed ${esc(
                  span(passable.map((x) => x.t)),
                )}. `
              : ""
          }`
    }${
      fifo
        ? `Base priorities across this queue span only <b>${n(
            Math.round(spread),
          )}</b> points against an age weight of ${n(
            pm.ageWeight,
          )}, so the queue is very nearly first-in-first-out: submitting earlier beats asking for less, and job size only breaks ties. `
        : ""
    }${
      req.tasks > 1
        ? `Each of the ${n(req.tasks)} array tasks is scheduled separately and starts with this same priority. `
        : ""
    }</p>
    ${modelNote()}</details></div>`;
}

// Where the weights came from, stated rather than assumed — the page has no
// scontrol dump to read them from.
function modelNote() {
  const pm = prioModel;
  const fromConfig = pm.source === "config";
  const src = (ok) => (fromConfig ? "from scontrol" : ok ? "measured from the dumps" : "SLURM default, not measurable here");
  const inert = model.notes.inertFactors ?? [];

  return `<p class="axis-note">Priority model: <code>PriorityWeightAge</code> ${n(pm.ageWeight)} (${src(
    pm.measured.ageWeight,
  )}), <code>PriorityMaxAge</code> ${dur(pm.ageMax)} (${src(pm.measured.ageMax)}), <code>PriorityWeightJobSize</code> ${n(
    pm.jobSizeWeight,
  )} (${src(pm.measured.jobSize)}) over ${n(pm.nodeCount)} nodes and ${n(pm.cpuCount)} CPUs${
    pm.measured.jobSize
      ? ` — reproduces the <code>sprio</code> job-size factor exactly for <b>${(pm.agreement * 100).toFixed(
          0,
        )}%</b> of the ${n(pm.samples)} pending jobs it can be scored against`
      : ""
  }.${
    fromConfig
      ? ` The node count is slurm.conf's <code>node_record_count</code>, which no dump reports — <code>sinfo</code> and <code>scontrol show partition</code> both list only nodes that belong to a partition — so it is still fitted${
          pm.nodeCount > pm.sinfoNodes
            ? `, and needs ${n(pm.nodeCount)} where the dumps account for ${n(pm.sinfoNodes)}`
            : ""
        }.`
      : ""
  }${
    pm.measured.jobSize && !pm.nodeSplitIdentifiable && !fromConfig
      ? ` Every job it was fitted against asks for one node, so the weight and the node count cannot be told apart — only the two coefficients above, which is all a single-node estimate uses.`
      : ""
  }${
    pm.measured.jobSize && pm.agreement < 0.999
      ? ` The rest are jobs SLURM costed against more CPUs than <code>squeue</code> reports, which is what <code>DefCpuPerGPU</code> and <code>MaxMemPerCPU</code> do to a request; those rows are excluded from the score rather than counted as misses, and <code>scontrol show job</code> is the only dump that would settle them.`
      : ""
  }${
    inert.length
      ? ` <b>${inert
          .map((f) => FACTOR_LABEL[f] ?? f)
          .join(" and ")}</b> ${inert.length === 1 ? "carries a non-zero weight" : "carry non-zero weights"} on this cluster but ${
          inert.length === 1 ? "evaluates" : "evaluate"
        } to zero for every pending job, so ${inert.length === 1 ? "it contributes" : "they contribute"} nothing in practice.`
      : ""
  }${fromConfig ? "" : " <code>scontrol show config</code> would replace all of this with the real values."}</p>`;
}

function renderPlan() {
  const out = document.getElementById("plan-out");
  const meta = document.getElementById("plan-meta");
  if (!model || !prioModel) {
    out.innerHTML = `<div class="card"><p class="card-sub">Loading cluster data…</p></div>`;
    meta.textContent = "loading…";
    return;
  }
  const f = readPlanForm();
  const part = planPartition(f.partition);
  // Everything downstream runs on what the job will actually be allocated, not
  // on what was typed — the partition can force the core count up, and fills in
  // the memory and the walltime for a request that names neither.
  const req = effectiveRequest(toRequest(f), part);
  out.innerHTML = costCard(req, part) + feasibilityCard(req, part) + priorityCardPlan(req, part);
  renderDrawer(f);
  meta.textContent = planMetaLine(part, req);
}

function switchTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll("[data-tab]")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  }
  document.getElementById("view-status").hidden = tab !== "status";
  document.getElementById("view-plan").hidden = tab !== "plan";
  document.getElementById("view-details").hidden = tab !== "details";
  document.getElementById("filters").hidden = tab === "plan" || !model;
}

// ---------------------------------------------------------------- events

const tip = document.getElementById("tip");

function placeTip(e) {
  const pad = 14;
  const r = tip.getBoundingClientRect();
  const x = Math.min(e.clientX + pad, window.innerWidth - r.width - 8);
  const y = e.clientY + pad + r.height > window.innerHeight ? e.clientY - r.height - pad : e.clientY + pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

document.addEventListener("pointerover", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) return;
  tip.textContent = t.dataset.tip;
  tip.dataset.show = "1";
  placeTip(e); // position before the first paint, so it never flashes where it was
});

document.addEventListener("pointermove", (e) => {
  if (tip.dataset.show === "1") placeTip(e);
});

document.addEventListener("pointerout", (e) => {
  if (e.target.closest("[data-tip]")) tip.dataset.show = "0";
});

function onCardClick(e) {
  const view = e.target.closest("[data-view]");
  if (view) {
    state.views[view.dataset.view] = view.dataset.mode;
    render();
    return;
  }
  const exp = e.target.closest("[data-expand]");
  if (exp) {
    const key = exp.dataset.expand;
    state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
    e.target.closest("#plan-out") ? renderPlan() : render();
  }
}
document.getElementById("main").addEventListener("click", onCardClick);
document.getElementById("details-main").addEventListener("click", onCardClick);
document.getElementById("plan-out").addEventListener("click", onCardClick);

for (const btn of document.querySelectorAll("[data-tab]")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

// The form is static markup and only the results are re-rendered, so typing in a
// field never costs it focus.
planForm.addEventListener("input", (e) => {
  // A tick box is handled on `change`, which fires straight after this one and
  // has to seed the field before anything is rendered from it.
  if (!model || e.target.classList.contains("opt")) return;
  // Typing changes what the switched-off directives resolve to — more GPUs means
  // more cores from DefCpuPerGPU — so those boxes follow along as it is typed.
  syncOptions();
  renderPlan();
});

planForm.addEventListener("change", (e) => {
  if (!model) return;
  const opt = e.target.classList.contains("opt") ? e.target.dataset.opt : null;
  // Both of these narrow what the other selects may offer — and switching
  // --partition off changes the partition as surely as picking another one does.
  if (e.target.name === "account" || opt === "account") fillQos();
  if (e.target.name === "partition" || opt === "partition") fillGpuModels();
  // The partition and the GPU count decide several of the seeds, so a change to
  // either refreshes the explanations even though it seeds nothing itself.
  if (opt || e.target.name === "partition" || e.target.name === "gpusPerNode") {
    syncOptions(opt && e.target.checked ? opt : null);
  }
  renderPlan();
});

document.getElementById("plan-reset").addEventListener("click", () => {
  for (const box of optBoxes.values()) box.checked = false;
  fillGpuModels();
  syncOptions();
  if (model) renderPlan();
});

document.getElementById("view-plan").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const text = document.getElementById("plan-script").textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed — select it by hand";
  }
  setTimeout(() => (btn.textContent = "Copy"), 1600);
});

function toggleDrawer() {
  const pre = document.getElementById("plan-script");
  pre.hidden = !pre.hidden;
  document.getElementById("plan-drawer-tri").textContent = pre.hidden ? "▸" : "▾";
}
const drawerToggle = document.getElementById("plan-drawer-toggle");
drawerToggle.addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  toggleDrawer();
});
drawerToggle.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  toggleDrawer();
});

document.getElementById("plan-download").addEventListener("click", () => {
  const text = document.getElementById("plan-script").textContent;
  const name = (readPlanForm().jobName || "job").replace(/[^\w.-]+/g, "_");
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/x-shellscript" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.sh`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("f-part").addEventListener("change", (e) => {
  state.partition = e.target.value;
  render();
});

let userTimer;
document.getElementById("f-user").addEventListener("input", (e) => {
  state.user = e.target.value;
  clearTimeout(userTimer);
  userTimer = setTimeout(() => {
    renderFilters();
    render();
  }, 180);
});

document.getElementById("f-clear").addEventListener("click", () => {
  state.partition = "all";
  state.user = "";
  renderFilters();
  render();
});

document.getElementById("refresh").addEventListener("click", () => load({ slow: true }));

document.getElementById("theme").addEventListener("click", () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
  document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
});

// ?theme=dark / ?theme=light forces a theme, for kiosk screens and screenshots.
const params = new URLSearchParams(location.search);
const forced = params.get("theme");
if (forced === "dark" || forced === "light") document.documentElement.dataset.theme = forced;
if (params.get("tab") === "plan") switchTab("plan");

let timer = setInterval(() => load(), REFRESH_MS);
document.getElementById("auto").addEventListener("change", (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(() => load(), REFRESH_MS);
});

load({ slow: true });
setInterval(renderFreshness, 30_000);
