// Parsers for the delimited SLURM dumps in data/, plus the aggregation that
// turns them into the dashboard model.
//
// Where a file carries a header row, columns are located by name rather than by
// position, so adding or reordering fields in the dump does not break the page.
// squeue has no header, so its column order is fixed by SQUEUE_COLUMNS below and
// each row is shape-checked as it is read.

const STATE_FLAGS = "*~#$@+-%";

// squeue has no header row, so this is the column order it is read in:
//   %i|%P|%u|%a|%j|%T|%M|%L|%D|%C|%b|%Q|%V|%S|%R|%q
// If a header line appears, it is used instead and this is ignored.
const SQUEUE_COLUMNS = [
  "jobid",
  "partition",
  "user",
  "account",
  "name",
  "state",
  "time",
  "timeleft",
  "nodes",
  "cpus",
  "gres",
  "priority",
  "submit",
  "start",
  "tail",
  "qos",
];

// Long-form job states (%T) mapped to the short codes (%t) the page uses.
const JOB_STATE = {
  PENDING: "PD",
  RUNNING: "R",
  SUSPENDED: "S",
  COMPLETING: "CG",
  COMPLETED: "CD",
  CONFIGURING: "CF",
  CANCELLED: "CA",
  FAILED: "F",
  TIMEOUT: "TO",
  PREEMPTED: "PR",
  NODE_FAIL: "NF",
  REQUEUED: "RQ",
  RESIZING: "RS",
  REVOKED: "RV",
  SIGNALING: "SI",
  SPECIAL_EXIT: "SE",
  STAGE_OUT: "SO",
  STOPPED: "ST",
};

// Node state -> display group. Groups drive both colour and ordering.
const STATE_GROUP = {
  idle: "idle",
  mix: "mix",
  mixed: "mix",
  alloc: "alloc",
  allocated: "alloc",
  comp: "alloc",
  completing: "alloc",
  resv: "resv",
  reserved: "resv",
  drain: "unavail",
  drained: "unavail",
  drng: "unavail",
  draining: "unavail",
  maint: "unavail",
  plnd: "unavail",
  planned: "unavail",
  down: "offline",
  fail: "offline",
  failing: "offline",
  err: "offline",
  error: "offline",
  unk: "offline",
  unknown: "offline",
  inval: "offline",
  invalid: "offline",
  futr: "offline",
  future: "offline",
  pow_dn: "offline",
  powering_down: "offline",
  powered_down: "offline",
  pow_up: "offline",
  powering_up: "offline",
};

export const STATE_GROUPS = ["idle", "mix", "alloc", "resv", "unavail", "offline", "other"];

export const GROUP_LABEL = {
  idle: "Idle",
  mix: "Mixed",
  alloc: "Allocated",
  resv: "Reserved",
  unavail: "Drain / maint",
  offline: "Down / unknown",
  other: "Other",
};

// Flag suffixes sinfo appends to a state. Kept out of the group so a node is
// classified by what it is, and the flag is reported alongside.
export const FLAG_LABEL = {
  "*": "not responding",
  "~": "powered down",
  "#": "powering up",
  "%": "powering down",
  $: "reservation maintenance",
  "@": "pending reboot",
  "-": "planned by backfill",
  "+": "maintenance",
};

// Priority factors in a fixed order, so a factor keeps its colour regardless of
// which factors a given cluster actually uses.
export const FACTORS = ["age", "fairshare", "jobsize", "partition", "qos", "assoc", "site", "tres"];

export const FACTOR_LABEL = {
  age: "Age",
  fairshare: "Fair-share",
  jobsize: "Job size",
  partition: "Partition",
  qos: "QOS",
  assoc: "Assoc",
  site: "Site",
  tres: "TRES",
};

// ------------------------------------------------------------------ tables

const detectDelim = (line) => (line.includes("|") ? "|" : line.includes(",") ? "," : null);

const cells = (line, delim) => (delim ? line.split(delim) : line.trim().split(/\s+/));

const normKey = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

// sprio -l has two columns called PARTITION (the name, and the priority
// factor); the second becomes "partition2".
function dedupe(keys) {
  const seen = new Map();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}${n}`;
  });
}

/**
 * Read a delimited dump. `expect` names columns that must all be present for
 * the first line to count as a header; `names` is the fixed column order used
 * when there is no header.
 */
function readTable(text, { expect = [], names = [] } = {}) {
  const lines = (text ?? "").split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return { rows: [], index: {}, hasHeader: false, delim: null };
  const delim = detectDelim(lines[0]);
  const firstKeys = cells(lines[0], delim).map(normKey);
  const hasHeader = expect.length > 0 && expect.every((e) => firstKeys.includes(e));
  const keys = hasHeader ? dedupe(firstKeys) : names;
  return {
    rows: lines.slice(hasHeader ? 1 : 0).map((l) => cells(l, delim)),
    index: Object.fromEntries(keys.map((k, i) => [k, i])),
    hasHeader,
    delim,
  };
}

/**
 * SLURM spells the same column differently depending on how it was requested —
 * `%V` prints SUBMIT_TIME under `-o` but SUBMIT under some versions, `%b` is
 * TRES_PER_NODE or GRES, `%R` is NODELIST(REASON) or REASON. Each field the page
 * needs therefore lists the header names it may arrive under, and the canonical
 * name is filled in from the first one present.
 */
function canonical(index, aliases) {
  const out = { ...index };
  const missing = [];
  for (const [name, candidates] of Object.entries(aliases)) {
    if (out[name] !== undefined) continue;
    const hit = candidates.find((c) => index[c] !== undefined);
    if (hit === undefined) missing.push(name);
    else out[name] = index[hit];
  }
  return { index: out, missing };
}

const SQUEUE_ALIASES = {
  jobid: ["jobid", "jobidraw"],
  partition: ["partition"],
  user: ["user", "username"],
  account: ["account"],
  name: ["name", "jobname"],
  state: ["state", "statecompact"],
  time: ["time", "timeused"],
  timeleft: ["timeleft", "timeremaining"],
  nodes: ["nodes", "numnodes"],
  cpus: ["cpus", "numcpus", "cpu"],
  gres: ["gres", "trespernode", "trespertask", "tresperjob", "tres"],
  minmemory: ["minmemory", "minmem", "memory", "reqmem"],
  priority: ["priority", "prioritylong"],
  submit: ["submit", "submittime"],
  start: ["start", "starttime"],
  tail: ["tail", "nodelistreason", "reason", "nodelist"],
  qos: ["qos", "qosname"],
};

const SINFO_ALIASES = {
  cpustate: ["cpustate", "cpusaiot", "cpusstate"],
  nodelist: ["nodelist", "nodehost"],
  gres: ["gres"],
  memory: ["memory", "mem"],
  reason: ["reason"],
};

const reader = (index) => ({
  raw: (row, key) => (index[key] === undefined ? "" : (row[index[key]] ?? "")),
  str: (row, key) => (index[key] === undefined ? "" : (row[index[key]] ?? "").trim()),
  num: (row, key) => {
    const v = (index[key] === undefined ? "" : (row[index[key]] ?? "")).trim();
    return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0;
  },
});

const isNA = (s) => !s || /^(n\/a|none|unknown|invalid|unlimited|\(null\))$/i.test(s.trim());

// squeue's MIN_MEMORY: "768G", "500M", or "4Gc" (per CPU) / "8Gn" (per node)
export function parseMemory(s) {
  if (isNA(s)) return null;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)([KMGT])?([nc])?$/i);
  if (!m) return null;
  const mult = { k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 };
  return {
    mb: Number(m[1]) * (mult[(m[2] ?? "M").toLowerCase()] ?? 1),
    per: m[3]?.toLowerCase() ?? null,
  };
}

// sinfo's CPUS(A/I/O/T) column: "143/113/0/256", aggregated over the row's nodes
export function parseCpuState(s) {
  const p = (s ?? "").split("/").map((v) => Number(v.trim()));
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  return { alloc: p[0], idle: p[1], other: p[2], total: p[3] };
}

// sinfo's %G: "gpu:l40s:8" | "gpu:8" | "(null)" -> GPUs per node, and the model
export function parseSinfoGres(s) {
  if (isNA(s)) return { model: null, count: 0 };
  let count = 0;
  let model = null;
  for (const part of s.split(",")) {
    const m = part.trim().match(/^gpu:(?:([^:()]+):)?(\d+)/);
    if (!m) continue;
    count += Number(m[2]);
    model ??= m[1] ?? null;
  }
  return { model, count };
}

// "1-19:23:23" | "18:11:38" | "29:41" | "0:00" -> seconds; "N/A" -> null
export function parseDuration(s) {
  if (isNA(s)) return null;
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mm)) * 60 + Number(ss);
}

// "2026-07-21T16:18:03" -> Date; "N/A" -> null
export function parseStamp(s) {
  if (isNA(s)) return null;
  const d = new Date(s.trim());
  return Number.isNaN(+d) ? null : d;
}

// "gres/gpu:a100:8" | "gres/gpu:4" | "N/A" -> GPU count
export function parseGresGpus(s) {
  if (isNA(s)) return 0;
  let total = 0;
  for (const part of s.split(",")) {
    const m = part.trim().match(/^gres\/gpu(?::[^:]+)?:(\d+)$/);
    if (m) total += Number(m[1]);
  }
  return total;
}

// Memory in a TRES list carries a unit — `scontrol` prints mem=6188800M while
// `sshare` prints a bare number — so a suffix is scaled to MB rather than
// dropped. Without this, every memory TRES read as zero.
const TRES_UNIT = { k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024, p: 1024 * 1024 * 1024 };

// "cpu=385475,gres/gpu=1357,mem=6188800M" -> Map (memory in MB)
export function parseTres(s) {
  const out = new Map();
  for (const pair of (s ?? "").split(",")) {
    const i = pair.lastIndexOf("=");
    if (i < 1) continue;
    const key = pair.slice(0, i).trim();
    const raw = pair.slice(i + 1).trim();
    const m = raw.match(/^(-?\d*\.?\d+)([KMGTP])?$/i);
    if (!m) {
      out.set(key, 0);
      continue;
    }
    const scale = m[2] ? (TRES_UNIT[m[2].toLowerCase()] ?? 1) : 1;
    out.set(key, Number(m[1]) * scale);
  }
  return out;
}

// Split on commas that are not inside brackets: "l[01,03],c002" -> ["l[01,03]", "c002"]
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// "cpu[009-012,015]" -> ["cpu009","cpu010","cpu011","cpu012","cpu015"]
export function expandHostlist(s) {
  if (!s || s.startsWith("(") || s === "n/a") return [];
  return splitTop(s).flatMap((part) => {
    const m = part.match(/^([^[]*)\[([^\]]*)\](.*)$/);
    if (!m) return part ? [part] : [];
    const [, pre, body, post] = m;
    return body.split(",").flatMap((range) => {
      const r = range.match(/^(\d+)-(\d+)$/);
      if (!r) return [pre + range + post];
      const width = r[1].length;
      const names = [];
      for (let i = Number(r[1]); i <= Number(r[2]); i++) {
        names.push(pre + String(i).padStart(width, "0") + post);
      }
      return names;
    });
  });
}

function splitState(raw) {
  let base = raw;
  let flags = "";
  while (base.length && STATE_FLAGS.includes(base.at(-1))) {
    flags = base.at(-1) + flags;
    base = base.slice(0, -1);
  }
  return { state: base.toLowerCase(), flags };
}

export const stateGroup = (state) => STATE_GROUP[state] ?? "other";

// ------------------------------------------------------------------ parsers

// PARTITION|AVAIL|TIMELIMIT|NODES|STATE|NODELIST|CPUS(A/I/O/T)|GRES|MEMORY|REASON
export function parseSinfo(text) {
  const { rows: raw, index: rawIndex } = readTable(text, { expect: ["partition", "state", "nodes"] });
  const { index } = canonical(rawIndex, SINFO_ALIASES);
  const at = reader(index);
  const rows = [];
  const warnings = [];
  for (const row of raw) {
    const count = at.num(row, "nodes");
    const rawState = at.str(row, "state");
    if (!rawState || !count) {
      warnings.push(`sinfo: skipped unparsable row: ${row.join("|").slice(0, 70)}`);
      continue;
    }
    const { state, flags } = splitState(rawState);
    const name = at.str(row, "partition");
    const reason = at.str(row, "reason");
    const gres = parseSinfoGres(at.str(row, "gres"));
    rows.push({
      partition: name.replace(/\*$/, ""),
      isDefault: name.endsWith("*"),
      avail: at.str(row, "avail"),
      timelimit: at.str(row, "timelimit"),
      count,
      state,
      flags,
      group: stateGroup(state),
      reason: isNA(reason) ? "" : reason,
      // All four below are present only if the dump asks for them.
      nodelist: at.str(row, "nodelist"),
      nodes: expandHostlist(at.str(row, "nodelist")),
      // Allocated / idle / other / total, already summed over the row's nodes.
      cpus: parseCpuState(at.str(row, "cpustate")),
      gpusPerNode: gres.count,
      gpuModel: gres.model,
      memoryMB: at.num(row, "memory"),
    });
  }
  return { rows, warnings };
}

// Pending array entries are collapsed by squeue: "123_[0-4%5]" is 5 tasks.
export function arrayTaskCount(jobid) {
  const m = jobid.match(/_\[([^\]]+)\]/);
  if (!m) return 1;
  return m[1]
    .split("%")[0]
    .split(",")
    .reduce((n, part) => {
      const r = part.match(/^(\d+)-(\d+)$/);
      return n + (r ? Number(r[2]) - Number(r[1]) + 1 : 1);
    }, 0);
}

// See SQUEUE_COLUMNS for the expected order when there is no header row.
export function parseSqueue(text) {
  const { rows: raw, index: rawIndex, hasHeader } = readTable(text, {
    expect: ["jobid", "state"],
    names: SQUEUE_COLUMNS,
  });
  const { index, missing } = canonical(rawIndex, SQUEUE_ALIASES);
  const at = reader(index);
  const rows = [];
  const warnings = [];
  // A renamed column would otherwise go unnoticed: the rows still parse, they
  // just lose a field. Say so instead.
  if (hasHeader && missing.length) {
    warnings.push(`squeue: no column found for ${missing.join(", ")} — those values will be blank`);
  }
  for (const row of raw) {
    const jobid = at.str(row, "jobid");
    const rawState = at.str(row, "state").toUpperCase();
    const state = JOB_STATE[rawState] ?? rawState;
    // A shape check, so a changed column order is reported rather than
    // silently mis-attributed.
    if (!jobid || !/^[A-Z_]{1,12}$/.test(rawState)) {
      warnings.push(`squeue: skipped unparsable row: ${row.join("|").slice(0, 70)}`);
      continue;
    }
    const tail = at.str(row, "tail");
    const isReason = tail.startsWith("(");
    const nodes = at.num(row, "nodes");
    const cpus = at.num(row, "cpus");
    const mem = parseMemory(at.str(row, "minmemory"));
    rows.push({
      jobid,
      base: jobid.split("_")[0],
      user: at.str(row, "user"),
      account: at.str(row, "account"),
      name: at.str(row, "name"),
      state,
      nodes,
      cpus,
      gpus: parseGresGpus(at.str(row, "gres")),
      // MIN_MEMORY is per node unless it carries a "c" suffix, in which case it
      // is per CPU. Either way, record what the whole job asks for.
      memoryMB: mem ? Math.round(mem.mb * (mem.per === "c" ? cpus || 1 : nodes || 1)) : 0,
      memoryPer: mem?.per ?? null,
      priority: at.num(row, "priority"),
      qos: at.str(row, "qos"),
      // %M is elapsed run time (0:00 while pending); %L is time remaining.
      elapsed: parseDuration(at.str(row, "time")),
      timeLeft: parseDuration(at.str(row, "timeleft")),
      submit: parseStamp(at.str(row, "submit")),
      // Actual start for running jobs, the scheduler's estimate for pending
      // ones, and N/A when it has not computed one.
      start: parseStamp(at.str(row, "start")),
      reason: isReason ? tail.slice(1, -1) : null,
      nodelist: isReason ? "" : tail,
      tasks: arrayTaskCount(jobid),
      partitions: at
        .str(row, "partition")
        .split(",")
        .filter(Boolean),
    });
  }
  return { rows, warnings };
}

/**
 * A sprio format can repeat a header name — PARTITION is both the partition and
 * its priority factor, and requesting both weighted and normalized AGE gives two
 * AGE columns. Choose between the candidates by what the cells look like rather
 * than by position: the weighted factor is an integer, a normalized factor is a
 * decimal, and a partition *name* is neither.
 */
function pickFactorColumns(rows, index, name) {
  const keys = Object.keys(index).filter((k) => k === name || new RegExp(`^${name}\\d+$`).test(k));
  let weighted = null;
  let normalized = null;
  let bestInt = 0;
  let bestFrac = 0;
  for (const k of keys) {
    const i = index[k];
    let ints = 0;
    let fracs = 0;
    for (const row of rows) {
      const v = (row[i] ?? "").trim();
      if (/^-?\d+$/.test(v)) ints++;
      else if (/^-?\d*\.\d+$/.test(v)) fracs++;
    }
    if (ints > bestInt) {
      bestInt = ints;
      weighted = k;
    }
    if (fracs > bestFrac) {
      bestFrac = fracs;
      normalized = k;
    }
  }
  return { weighted: weighted ?? keys[0] ?? null, normalized };
}

// JOBID|PARTITION|USER|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|
// NICE|QOS|QOSNAME|TRES, plus any normalized factor columns.
export function parseSprio(text) {
  const { rows: raw, index } = readTable(text, { expect: ["jobid", "priority"] });
  const at = reader(index);
  const cols = Object.fromEntries(FACTORS.map((f) => [f, pickFactorColumns(raw, index, f)]));
  const rows = [];
  const warnings = [];
  for (const row of raw) {
    const jobid = at.str(row, "jobid");
    if (!jobid || !/^\d/.test(jobid)) {
      warnings.push(`sprio: skipped unparsable row: ${row.join("|").slice(0, 70)}`);
      continue;
    }
    rows.push({
      jobid,
      base: jobid.split("_")[0],
      partition: at.str(row, "partition"),
      user: at.str(row, "user"),
      account: at.str(row, "account"),
      priority: at.num(row, "priority"),
      qosname: at.str(row, "qosname"),
      nice: at.num(row, "nice"),
      factors: Object.fromEntries(
        FACTORS.map((f) => [f, cols[f].weighted ? at.num(row, cols[f].weighted) : 0]),
      ),
      // Present only when the dump asks for normalized factors as well.
      normFactors: Object.fromEntries(
        FACTORS.filter((f) => cols[f].normalized).map((f) => [f, at.num(row, cols[f].normalized)]),
      ),
    });
  }
  return { rows, warnings };
}

// Account|User|RawShares|NormShares|RawUsage|NormUsage|EffectvUsage|FairShare|
// LevelFS|GrpTRESMins|TRESRunMins  (`sshare -l`)
export function parseSshare(text) {
  const { rows: raw, index } = readTable(text, { expect: ["account", "rawshares"] });
  const at = reader(index);
  const rows = [];
  for (const row of raw) {
    const cell = at.raw(row, "account");
    const account = cell.trim();
    if (!account) continue;
    rows.push({
      // Leading spaces encode depth in the account tree; root sits at 0.
      depth: cell.length - cell.trimStart().length,
      account,
      user: at.str(row, "user"),
      rawShares: at.num(row, "rawshares"),
      normShares: at.num(row, "normshares"),
      rawUsage: at.num(row, "rawusage"),
      effectvUsage: at.num(row, "effectvusage"),
      fairShare: at.str(row, "fairshare"),
      levelFS: at.str(row, "levelfs"),
      limits: parseTres(at.str(row, "grptresmins")),
      running: parseTres(at.str(row, "tresrunmins")),
    });
  }
  return { rows, warnings: [] };
}

// name|priority|grptres|maxtresperuser|maxtresperaccount|maxjobspu
// (`sacctmgr -nP show qos format=...`)
const SACCT_QOS_COLUMNS = [
  "name",
  "priority",
  "grptres",
  "maxtresperuser",
  "maxtresperaccount",
  "maxjobspu",
];

export function parseSacctQos(text) {
  const { rows: raw, index } = readTable(text, {
    expect: ["name", "maxtresperaccount"],
    names: SACCT_QOS_COLUMNS,
  });
  const at = reader(index);
  const rows = [];
  for (const row of raw) {
    const name = at.str(row, "name");
    if (!name) continue;
    rows.push({
      name,
      priority: at.num(row, "priority"),
      grpTres: parseTres(at.str(row, "grptres")),
      maxPerUser: parseTres(at.str(row, "maxtresperuser")),
      maxPerAccount: parseTres(at.str(row, "maxtresperaccount")),
      maxJobsPerUser: at.num(row, "maxjobspu"),
    });
  }
  return { rows, warnings: [] };
}

// account|user|qos|grptres|maxtres|maxjobs
// (`sacctmgr -nP show assoc format=...`); a blank user is the account itself.
const SACCT_ASSOC_COLUMNS = ["account", "user", "qos", "grptres", "maxtres", "maxjobs"];

export function parseSacctAssoc(text) {
  const { rows: raw, index } = readTable(text, {
    expect: ["account", "qos"],
    names: SACCT_ASSOC_COLUMNS,
  });
  const at = reader(index);
  const rows = [];
  for (const row of raw) {
    const account = at.str(row, "account");
    if (!account) continue;
    rows.push({
      account,
      user: at.str(row, "user"),
      qos: at.str(row, "qos").split(",").filter(Boolean),
      grpTres: parseTres(at.str(row, "grptres")),
      maxTres: parseTres(at.str(row, "maxtres")),
      maxJobs: at.num(row, "maxjobs"),
    });
  }
  return { rows, warnings: [] };
}

// ------------------------------------------------------------------ scontrol

/**
 * `scontrol show config` — one `KEY = VALUE` per line, with a timestamp line, a
 * few blank-separated section headings and an "is UP" trailer, none of which
 * contain " = " and all of which are therefore skipped by construction.
 */
export function parseScontrolConfig(text) {
  const values = new Map();
  for (const line of (text ?? "").split("\n")) {
    const i = line.indexOf(" = ");
    if (i < 1) continue;
    values.set(line.slice(0, i).trim(), line.slice(i + 3).trim());
  }
  return { values, warnings: [] };
}

const NONE = /^(n\/a|none|null|\(null\)|unlimited|infinite)$/i;

/**
 * Read the priority settings the page needs out of the config map, keeping the
 * raw map for anything else. A value the config does not carry stays null so
 * callers can tell "not configured" from "configured as zero" — the difference
 * between a factor that is switched off and one this page failed to read.
 */
export function readConfig(values) {
  const num = (k) => {
    const v = values.get(k);
    return v === undefined || NONE.test(v) ? null : (Number.isNaN(Number(v)) ? null : Number(v));
  };
  const dur = (k) => {
    const v = values.get(k);
    return v === undefined || NONE.test(v) ? null : parseDuration(v);
  };
  const yes = (k) => {
    const v = values.get(k);
    return v === undefined ? null : /^(yes|true|1)$/i.test(v.trim());
  };
  const flags = (values.get("PriorityFlags") ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f && !NONE.test(f));

  return {
    present: values.size > 0,
    raw: values,
    cluster: values.get("ClusterName") ?? "",
    version: values.get("SLURM_VERSION") ?? "",
    priorityType: values.get("PriorityType") ?? "",
    ageWeight: num("PriorityWeightAge"),
    ageMax: dur("PriorityMaxAge"),
    jobSizeWeight: num("PriorityWeightJobSize"),
    fairShareWeight: num("PriorityWeightFairShare"),
    qosWeight: num("PriorityWeightQOS"),
    partitionWeight: num("PriorityWeightPartition"),
    assocWeight: num("PriorityWeightAssoc"),
    favorSmall: yes("PriorityFavorSmall"),
    decayHalfLife: dur("PriorityDecayHalfLife"),
    usageResetPeriod: values.get("PriorityUsageResetPeriod") ?? "",
    flags,
    // MAX_TRES makes a job's billable TRES the largest of its weighted per-node
    // resources rather than their sum, which changes what a job costs.
    maxTres: flags.includes("MAX_TRES"),
    maxArraySize: num("MaxArraySize"),
    defMemPerCpuMB: num("DefMemPerCPU"),
    maxMemPerCpuMB: num("MaxMemPerCPU"),
    schedulerType: values.get("SchedulerType") ?? "",
  };
}

/**
 * `TRESBillingWeights=CPU=1,Mem=0.1667G,GRES/gpu=2`.
 *
 * A memory weight carries a unit suffix and is billed per that unit; the others
 * are per whole resource. Normalized here to a weight per GB of memory, since
 * that is the unit the page displays.
 */
export function parseBillingWeights(s) {
  const out = new Map();
  if (!s || NONE.test(s)) return out;
  for (const pair of s.split(",")) {
    const i = pair.lastIndexOf("=");
    if (i < 1) continue;
    const key = pair.slice(0, i).trim().toLowerCase();
    const m = pair
      .slice(i + 1)
      .trim()
      .match(/^(\d*\.?\d+)([KMGTP])?$/i);
    if (!m) continue;
    let w = Number(m[1]);
    if (key === "mem") {
      // A bare weight is per MB; a suffix scales it to that unit.
      const perGB = { k: 1024 * 1024, m: 1024, g: 1, t: 1 / 1024, p: 1 / (1024 * 1024) };
      w *= perGB[(m[2] ?? "M").toLowerCase()] ?? 1024;
    }
    out.set(key, w);
  }
  return out;
}

// "DefCpuPerGPU=14,DefMemPerGPU=1000" -> Map, or empty for "(null)"
function parseJobDefaults(s) {
  const out = new Map();
  if (!s || NONE.test(s)) return out;
  for (const pair of s.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v !== undefined && !Number.isNaN(Number(v))) out.set(k.trim(), Number(v));
  }
  return out;
}

/**
 * `scontrol -o show partition` — one line per partition of space-separated
 * `Key=Value`, where several values themselves contain `=`
 * (`JobDefaults=DefCpuPerGPU=14`), so each token is split at its first one only.
 *
 * This is the authoritative source for the limits a partition imposes, none of
 * which appear in `sinfo`: MaxNodes, MaxCPUsPerNode, MaxMemPerCPU, the QOS the
 * partition attaches, and the billing weights that decide what a job costs.
 */
export function parseScontrolPartition(text) {
  const rows = [];
  const warnings = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const d = new Map();
    for (const token of line.trim().split(/\s+/)) {
      const i = token.indexOf("=");
      if (i > 0) d.set(token.slice(0, i), token.slice(i + 1));
    }
    const name = d.get("PartitionName");
    if (!name) {
      warnings.push(`scontrol partition: skipped unparsable line: ${line.slice(0, 70)}`);
      continue;
    }
    const str = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) ? "" : v;
    };
    const num = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) || Number.isNaN(Number(v)) ? null : Number(v);
    };
    const dur = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) ? null : parseDuration(v);
    };
    const list = (k) => {
      const v = str(k);
      return !v || v.toUpperCase() === "ALL" ? null : v.split(",").filter(Boolean);
    };
    const defaults = parseJobDefaults(d.get("JobDefaults"));
    rows.push({
      name,
      state: str("State"),
      isDefault: /^yes$/i.test(str("Default")),
      hidden: /^yes$/i.test(str("Hidden")),
      // null means UNLIMITED or absent, i.e. no limit of this kind.
      maxTime: dur("MaxTime"),
      defaultTime: dur("DefaultTime"),
      maxNodes: num("MaxNodes"),
      minNodes: num("MinNodes"),
      maxCpusPerNode: num("MaxCPUsPerNode"),
      defMemPerCpuMB: num("DefMemPerCPU"),
      maxMemPerCpuMB: num("MaxMemPerCPU"),
      maxMemPerNodeMB: num("MaxMemPerNode"),
      defCpuPerGpu: defaults.get("DefCpuPerGPU") ?? null,
      defMemPerGpuMB: defaults.get("DefMemPerGPU") ?? null,
      // The partition's own QOS, which applies on top of the job's and which no
      // other dump reports.
      qos: str("QoS"),
      // null means ALL are allowed.
      allowAccounts: list("AllowAccounts"),
      allowQos: list("AllowQos"),
      allowGroups: list("AllowGroups"),
      totalNodes: num("TotalNodes"),
      totalCpus: num("TotalCPUs"),
      nodes: expandHostlist(str("Nodes")),
      nodelist: str("Nodes"),
      priorityJobFactor: num("PriorityJobFactor"),
      priorityTier: num("PriorityTier"),
      overSubscribe: str("OverSubscribe"),
      preemptMode: str("PreemptMode"),
      tres: parseTres(str("TRES")),
      billingWeights: parseBillingWeights(d.get("TRESBillingWeights")),
    });
  }
  return { rows, warnings };
}

/**
 * `scontrol show job` — the authoritative view of every job, and the only dump
 * that carries three things the page otherwise had to infer or approximate:
 *
 * - `NumCPUs`, the CPU count SLURM actually costed the job at. `squeue`'s `%C`
 *   is the *request*, which `MaxMemPerCPU` and `DefCpuPerGPU` both raise.
 * - `AccrueTime`, which is what the age factor counts from — not submit time.
 *   A job held by a dependency has none and accrues no age at all.
 * - `ReqTRES`/`AllocTRES`, which include SLURM's own `billing=` figure.
 *
 * Records are separated by a blank line, and each is `Key=Value` tokens on
 * several lines. A token with no `=` is a continuation of the previous value, so
 * a path or job name containing a space survives.
 */
export function parseScontrolJob(text) {
  const rows = [];
  const warnings = [];
  const records = [];
  let cur = null;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) {
      cur = null;
      continue;
    }
    // Some SLURM builds omit the blank line between records.
    if (line.startsWith("JobId=") || cur === null) {
      cur = new Map();
      records.push(cur);
    }
    let last = null;
    for (const token of line.trim().split(" ")) {
      if (!token) continue;
      const i = token.indexOf("=");
      if (i > 0) {
        last = token.slice(0, i);
        cur.set(last, token.slice(i + 1));
      } else if (last) {
        cur.set(last, `${cur.get(last)} ${token}`);
      }
    }
  }

  for (const d of records) {
    const jobId = d.get("JobId");
    if (!jobId) {
      warnings.push(`scontrol job: skipped a record with no JobId`);
      continue;
    }
    const str = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) ? "" : v;
    };
    const num = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) || Number.isNaN(Number(v)) ? null : Number(v);
    };
    const stamp = (k) => parseStamp(str(k));
    const reqTres = parseTres(str("ReqTRES"));
    const allocTres = parseTres(str("AllocTRES"));
    // MinMemoryNode / MinMemoryCPU / MinMemoryTRES are mutually exclusive and
    // say which unit the request was made in.
    const memNode = parseMemory(str("MinMemoryNode"));
    const memCpu = parseMemory(str("MinMemoryCPU"));
    const nodes = firstInt(str("NumNodes"));
    const cpus = num("NumCPUs");
    rows.push({
      jobId,
      // An array task's factors are shared with the parent job id.
      base: str("ArrayJobId") || jobId.split("_")[0],
      arrayTaskId: str("ArrayTaskId"),
      arrayThrottle: num("ArrayTaskThrottle"),
      name: str("JobName"),
      // "csriwor1(2397)" -> "csriwor1"
      user: str("UserId").replace(/\(\d+\)$/, ""),
      account: str("Account"),
      qos: str("QOS"),
      partitions: str("Partition").split(",").filter(Boolean),
      state: str("JobState"),
      reason: str("Reason"),
      dependency: str("Dependency"),
      priority: num("Priority") ?? 0,
      nice: num("Nice") ?? 0,
      // NumNodes can be a range ("2-4"); the job-size factor uses the minimum.
      nodes,
      // The count SLURM costed, not the count requested.
      cpus,
      tasks: num("NumTasks"),
      cpusPerTask: num("CPUs/Task"),
      // DefCpuPerGPU is a *default*, so it only applies when --cpus-per-task was
      // left unset, and an explicit one shows up as a cpu= in TresPerTask.
      explicitCpusPerTask: /(^|,)cpu=/.test(str("TresPerTask")),
      timeLimit: parseDuration(str("TimeLimit")),
      submit: stamp("SubmitTime"),
      eligible: stamp("EligibleTime"),
      // What the age factor actually counts from. Absent while a job is held,
      // which is exactly when it is not accruing age.
      accrue: stamp("AccrueTime"),
      start: stamp("StartTime"),
      end: stamp("EndTime"),
      lastSchedEval: stamp("LastSchedEval"),
      runTime: parseDuration(str("RunTime")),
      reqTres,
      allocTres,
      // SLURM's own billing figure. AllocTRES is what a running job is charged;
      // ReqTRES is computed at submit and, for a multi-partition job, against
      // whichever partition SLURM picked — so the two can disagree.
      reqBilling: reqTres.get("billing") ?? null,
      allocBilling: allocTres.get("billing") ?? null,
      gpus: parseGresGpus(str("TresPerNode")) * (nodes || 1) + parseGresGpus(str("TresPerJob")),
      memoryMB: memNode
        ? Math.round(memNode.mb * (nodes || 1))
        : memCpu
          ? Math.round(memCpu.mb * (cpus || 1))
          : (reqTres.get("mem") ?? 0),
      memoryPer: memNode ? "n" : memCpu ? "c" : null,
      nodelist: str("NodeList"),
      features: str("Features"),
      workDir: str("WorkDir"),
      command: str("Command"),
    });
  }
  return { rows, warnings };
}

// "1-1" -> 1, "2-4" -> 2, "3" -> 3
function firstInt(s) {
  const m = (s ?? "").match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * `scontrol show assoc_mgr` — the only dump that reports a limit *and* the usage
 * against it, in a `LIMIT(USAGE)` form: `GrpJobs=N(1294)` is no limit with 1294
 * jobs running, `gres/gpu=18(0)` is a cap of 18 with none in use.
 *
 * That pairing is what closes two gaps the page had to write disclaimers for:
 * caps that previously had to be matched by shape, and the consumed side of a
 * `GrpTRESMins` budget, which `sshare` only aggregates into one weighted number.
 *
 * Three sections, keyed by indentation: a record header at column 0, its fields
 * at 4, and inside a QOS record an `Account Limits` / `User Limits` block whose
 * entity names sit at 6 and their limits at 8.
 */
export function parseAssocMgr(text) {
  const assoc = [];
  const qos = [];
  const users = [];
  const warnings = [];
  let section = null;
  let rec = null;
  let subMode = null;
  let sub = null;

  for (const raw of (text ?? "").split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    const heading = line.match(/^([A-Z][A-Za-z]*) Records$/);
    if (indent === 0 && heading) {
      section = heading[1].toLowerCase();
      rec = null;
      continue;
    }
    if (indent === 0 && /^Current Association Manager/.test(line)) continue;

    if (indent === 0) {
      subMode = null;
      sub = null;
      const fields = pairsOnLine(line);
      if (section === "user") {
        users.push({
          user: stripId(fields.get("UserName") ?? ""),
          defAccount: fields.get("DefAccount") ?? "",
          adminLevel: fields.get("AdminLevel") ?? "",
        });
        rec = null;
      } else if (section === "association") {
        rec = {
          account: fields.get("Account") ?? "",
          user: stripId(fields.get("UserName") ?? ""),
          partition: fields.get("Partition") ?? "",
          id: fields.get("ID") ?? "",
          priority: numOrNull(fields.get("Priority")),
          limits: new Map(),
        };
        assoc.push(rec);
      } else if (section === "qos") {
        const name = fields.get("QOS") ?? "";
        rec = {
          name: stripId(name),
          limits: new Map(),
          accountLimits: new Map(),
          userLimits: new Map(),
        };
        qos.push(rec);
      } else {
        rec = null;
      }
      continue;
    }

    if (!rec) continue;

    if (indent === 4) {
      // A QOS record nests per-account and per-user limits under a heading.
      const nested = line.match(/^(Account|User) Limits$/);
      if (nested) {
        subMode = nested[1].toLowerCase();
        sub = null;
        continue;
      }
      subMode = null;
      readLimitLine(line, rec);
      continue;
    }

    if (indent === 6 && subMode) {
      sub = { entity: stripId(line), limits: new Map() };
      (subMode === "account" ? rec.accountLimits : rec.userLimits).set(sub.entity, sub);
      continue;
    }

    if (indent >= 8 && sub) readLimitLine(line, sub);
  }

  return { assoc, qos, users, warnings };
}

// "normal(1)" -> "normal";  "tzhang85(2218)" -> "tzhang85"
const stripId = (s) => s.replace(/\((\d+)\)$/, "");

const numOrNull = (v) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// Space-separated Key=Value on one line, each split at its first "=".
function pairsOnLine(line) {
  const out = new Map();
  for (const token of line.split(/\s+/)) {
    const i = token.indexOf("=");
    if (i > 0) out.set(token.slice(0, i), token.slice(i + 1));
    else if (i === -1 && token) continue;
    else if (i === 0) continue;
  }
  return out;
}

/** "N(1294)" -> {limit: null, used: 1294}; "18(0)" -> {limit: 18, used: 0} */
export function parseLimitPair(s) {
  const m = (s ?? "").match(/^(N|-?\d+(?:\.\d+)?)\((-?\d+(?:\.\d+)?)\)$/);
  if (!m) return null;
  return { limit: m[1] === "N" ? null : Number(m[1]), used: Number(m[2]) };
}

/** "cpu=N(7039),gres/gpu=18(0)" -> Map of TRES -> {limit, used} */
export function parseLimitTres(s) {
  const out = new Map();
  for (const part of (s ?? "").split(",")) {
    const i = part.lastIndexOf("=");
    if (i < 1) continue;
    const pair = parseLimitPair(part.slice(i + 1).trim());
    if (pair) out.set(part.slice(0, i).trim(), pair);
  }
  return out;
}

/**
 * One field line of an assoc_mgr record. A value is either a scalar limit pair,
 * a comma-separated TRES list of them, or plain text; an empty value means the
 * limit is unset, which is not the same as a limit of zero.
 */
function readLimitLine(line, target) {
  for (const [key, value] of pairsOnLine(line)) {
    if (value === "") continue;
    const scalar = parseLimitPair(value);
    if (scalar) {
      target.limits.set(key, scalar);
      continue;
    }
    if (value.includes("(") && value.includes("=")) {
      const tres = parseLimitTres(value);
      if (tres.size) target.limits.set(key, tres);
      continue;
    }
    // PreemptMode=OFF, Priority=0, Lineage=/..., UsageRaw=9111432720.03
    target[key.charAt(0).toLowerCase() + key.slice(1)] = value;
  }
}

/**
 * Every limit in the dump that is actually set, flattened to one row each, with
 * the usage recorded against it. `scope` is what the limit counts over, which is
 * carried in the field name's suffix: PA per account, PU per user, PJ per job.
 */
export function activeLimits({ assoc, qos }) {
  const out = [];
  const push = (o) => {
    if (o.limit !== null && o.limit !== undefined && o.limit > 0) out.push(o);
  };
  const walk = (limits, base) => {
    for (const [field, value] of limits) {
      if (value instanceof Map) {
        for (const [tres, pair] of value) push({ ...base, field, tres, ...pair });
      } else {
        push({ ...base, field, tres: null, ...value });
      }
    }
  };
  for (const a of assoc) {
    walk(a.limits, { kind: "assoc", account: a.account, user: a.user, source: `association ${a.account}${a.user ? `/${a.user}` : ""}` });
  }
  for (const q of qos) {
    walk(q.limits, { kind: "qos", qos: q.name, source: `QOS ${q.name}` });
    for (const [account, sub] of q.accountLimits) {
      walk(sub.limits, { kind: "qos", qos: q.name, account, source: `QOS ${q.name} per-account` });
    }
    for (const [user, sub] of q.userLimits) {
      walk(sub.limits, { kind: "qos", qos: q.name, user, source: `QOS ${q.name} per-user` });
    }
  }
  return out;
}

/**
 * `sacct` history — the only dump that says what a job actually *used*, as
 * opposed to what it asked for.
 *
 * Two row shapes share the file. A **job** row (`1843618_25`) carries `ReqTRES`,
 * `AllocTRES` and `TimelimitRaw`; a **step** row (`1843618_25.batch`) carries
 * `MaxRSS` and nothing else useful. Peak memory therefore has to be joined back
 * from the steps onto their parent, taking the largest across them.
 *
 * `TimelimitRaw` is in minutes. `MaxRSS` is the high-water mark of a single task,
 * so against a per-node `--mem` request it is exact for a one-task job and a
 * floor otherwise — stated rather than smoothed over.
 */
export function parseSacctHist(text) {
  const { rows: raw, index } = readTable(text, { expect: ["jobid", "state"] });
  const at = reader(index);
  const warnings = [];
  if (!raw.length) return { rows: [], warnings };

  const peakByJob = new Map();
  const jobRows = [];
  for (const row of raw) {
    const id = at.str(row, "jobid");
    if (!id) continue;
    const dot = id.indexOf(".");
    if (dot > 0) {
      // A step row: all we want is its peak memory, folded into the parent.
      const parent = id.slice(0, dot);
      const rss = parseMemory(at.str(row, "maxrss"));
      if (rss) peakByJob.set(parent, Math.max(peakByJob.get(parent) ?? 0, rss.mb));
      continue;
    }
    jobRows.push({ id, row });
  }

  const rows = [];
  for (const { id, row } of jobRows) {
    // "CANCELLED by 2621" -> "CANCELLED"
    const state = at.str(row, "state").split(" ")[0].toUpperCase();
    const reqTres = parseTres(at.str(row, "reqtres"));
    const allocTres = parseTres(at.str(row, "alloctres"));
    const elapsed = parseDuration(at.str(row, "elapsed"));
    const limitRaw = at.str(row, "timelimitraw");
    const timeLimit = /^\d+$/.test(limitRaw) ? Number(limitRaw) * 60 : parseDuration(limitRaw);
    const reqMem = reqTres.get("mem") ?? 0;
    const peakMem = peakByJob.get(id) ?? null;
    rows.push({
      id,
      base: id.split("_")[0],
      partition: at.str(row, "partition"),
      account: at.str(row, "account"),
      user: at.str(row, "user"),
      state,
      submit: parseStamp(at.str(row, "submit")),
      start: parseStamp(at.str(row, "start")),
      end: parseStamp(at.str(row, "end")),
      elapsed,
      timeLimit,
      reqTres,
      allocTres,
      reqCpus: reqTres.get("cpu") ?? 0,
      allocCpus: allocTres.get("cpu") ?? 0,
      reqMemMB: reqMem,
      peakMemMB: peakMem,
      gpus: reqTres.get("gres/gpu") ?? 0,
      billing: allocTres.get("billing") ?? reqTres.get("billing") ?? 0,
      exitCode: at.str(row, "exitcode"),
      // Only a job that ran to completion says anything about how much of its
      // request it needed: a TIMEOUT used all of its walltime by definition, and
      // a cancelled or failed job stopped for reasons of its own.
      finished: state === "COMPLETED",
      wallUsed: state === "COMPLETED" && elapsed !== null && timeLimit > 0 ? elapsed / timeLimit : null,
      memUsed: state === "COMPLETED" && peakMem !== null && reqMem > 0 ? peakMem / reqMem : null,
      // How long it waited before starting, which history alone can measure.
      queueSeconds:
        at.str(row, "start") && parseStamp(at.str(row, "start")) && parseStamp(at.str(row, "submit"))
          ? Math.max(0, (+parseStamp(at.str(row, "start")) - +parseStamp(at.str(row, "submit"))) / 1000)
          : null,
    });
  }
  return { rows, warnings };
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/**
 * Turn the history into the few figures worth showing, over whichever jobs the
 * caller scopes in. Kept out of buildModel so the dashboard's user filter can
 * re-scope it without re-parsing 90,000 rows.
 */
export function historyStats(rows) {
  const done = rows.filter((r) => r.finished);
  const wall = done.map((r) => r.wallUsed).filter((v) => v !== null);
  const mem = done.map((r) => r.memUsed).filter((v) => v !== null);
  const waits = rows.map((r) => r.queueSeconds).filter((v) => v !== null && v > 0);
  const byState = new Map();
  for (const r of rows) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
  return {
    jobs: rows.length,
    completed: done.length,
    states: [...byState.entries()].sort((a, b) => b[1] - a[1]),
    timeouts: byState.get("TIMEOUT") ?? 0,
    outOfMemory: byState.get("OUT_OF_MEMORY") ?? 0,
    failed: byState.get("FAILED") ?? 0,
    wallSamples: wall.length,
    wallMedian: quantile(wall, 0.5),
    wallP90: quantile(wall, 0.9),
    memSamples: mem.length,
    memMedian: quantile(mem, 0.5),
    memP90: quantile(mem, 0.9),
    waitMedian: quantile(waits, 0.5),
    waitP90: quantile(waits, 0.9),
    from: rows.reduce((a, r) => (r.submit && (!a || r.submit < a) ? r.submit : a), null),
    to: rows.reduce((a, r) => (r.end && (!a || r.end > a) ? r.end : a), null),
  };
}

// name|priority|usagefactor|grptres|maxtresperuser|maxtresperaccount|
// maxtresperjob|maxwall|maxjobspu|maxsubmitjobspu|grpjobs|flags|preempt
const SACCTMGR_QOS_COLUMNS = [
  "name",
  "priority",
  "usagefactor",
  "grptres",
  "maxtresperuser",
  "maxtresperaccount",
  "maxtresperjob",
  "maxwall",
  "maxjobspu",
  "maxsubmitjobspu",
  "grpjobs",
  "flags",
  "preempt",
];

/**
 * The richer `sacctmgr show qos` format. A superset of what `sacct_qos.txt`
 * carries, but *not* positionally compatible with it — `usagefactor` sits where
 * `grptres` used to — so this is a separate parser and the model prefers it only
 * when the file is present.
 *
 * Three of these fields change what the page can say:
 *
 * - `UsageFactor` multiplies everything the job is charged, so a cost estimate
 *   that ignores it is wrong by that factor.
 * - `MaxWall` is a per-QOS walltime ceiling that no other dump reports and that
 *   can be far below the partition's own.
 * - `DenyOnLimit` in `Flags` decides whether breaching a limit means the job
 *   waits or is refused outright at submit — a different answer to "will it run".
 */
export function parseSacctmgrQos(text) {
  const { rows: raw, index } = readTable(text, {
    expect: ["name", "usagefactor"],
    names: SACCTMGR_QOS_COLUMNS,
  });
  const at = reader(index);
  const rows = [];
  for (const row of raw) {
    const name = at.str(row, "name");
    if (!name) continue;
    const usage = at.str(row, "usagefactor");
    const flags = at
      .str(row, "flags")
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f && !isNA(f));
    rows.push({
      name,
      priority: at.num(row, "priority"),
      // Absent means 1.0 — no scaling — which is not the same as 0.
      usageFactor: usage && !isNA(usage) && Number(usage) > 0 ? Number(usage) : 1,
      grpTres: parseTres(at.str(row, "grptres")),
      maxPerUser: parseTres(at.str(row, "maxtresperuser")),
      maxPerAccount: parseTres(at.str(row, "maxtresperaccount")),
      maxPerJob: parseTres(at.str(row, "maxtresperjob")),
      maxWall: parseDuration(at.str(row, "maxwall")),
      maxJobsPerUser: at.num(row, "maxjobspu"),
      maxSubmitPerUser: at.num(row, "maxsubmitjobspu"),
      grpJobs: at.num(row, "grpjobs"),
      flags,
      // With DenyOnLimit a job that breaches a limit is rejected at submit
      // rather than held, so "will wait" is the wrong thing to tell the user.
      denyOnLimit: flags.some((f) => /denyonlimit/i.test(f)),
      preempt: at
        .str(row, "preempt")
        .split(",")
        .filter((p) => p && !isNA(p)),
    });
  }
  return { rows, warnings: [] };
}

/**
 * `scontrol show node` — per-node state, and the only dump that says what a node
 * is *doing* as opposed to what has been handed out on it.
 *
 * `CPUAlloc` is cores allocated; `CPULoad` is the actual run-queue load. The two
 * diverging is the clearest evidence available that a job took cores it is not
 * using — which on this cluster is what `MaxMemPerCPU` makes happen.
 *
 * `CPUEfctv` is cores actually schedulable after `CoreSpecCount` is reserved, and
 * matches each partition's `MaxCPUsPerNode` exactly, so that limit is explained
 * rather than arbitrary.
 */
export function parseScontrolNode(text) {
  const rows = [];
  const warnings = [];
  const records = [];
  let cur = null;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) {
      cur = null;
      continue;
    }
    if (line.startsWith("NodeName=") || cur === null) {
      cur = new Map();
      records.push(cur);
    }
    let last = null;
    for (const token of line.trim().split(" ")) {
      if (!token) continue;
      const i = token.indexOf("=");
      if (i > 0) {
        last = token.slice(0, i);
        cur.set(last, token.slice(i + 1));
      } else if (last) {
        cur.set(last, `${cur.get(last)} ${token}`);
      }
    }
  }

  for (const d of records) {
    const name = d.get("NodeName");
    if (!name) {
      warnings.push("scontrol node: skipped a record with no NodeName");
      continue;
    }
    const str = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) ? "" : v;
    };
    const num = (k) => {
      const v = d.get(k);
      return v === undefined || NONE.test(v) || Number.isNaN(Number(v)) ? null : Number(v);
    };
    const list = (k) => {
      const v = str(k);
      return v ? v.split(",").filter(Boolean) : [];
    };
    const cfgTres = parseTres(str("CfgTRES"));
    const allocTres = parseTres(str("AllocTRES"));
    // "IDLE+DRAIN" -> base IDLE plus the flags that qualify it.
    const stateParts = str("State").split("+");
    rows.push({
      name,
      state: stateParts[0].toLowerCase(),
      stateFlags: stateParts.slice(1).map((f) => f.toLowerCase()),
      group: stateGroup(stateParts[0].toLowerCase()),
      // Drained, down or reserved nodes cannot take new work whatever else says.
      schedulable: !stateParts.slice(1).some((f) => /DRAIN|MAINT|RESERVED|NOT_RESPONDING|FAIL/i.test(f)) &&
        !/DOWN|DRAIN|FAIL|UNKNOWN|FUTURE/i.test(stateParts[0]),
      cpuAlloc: num("CPUAlloc"),
      // Schedulable cores, after CoreSpecCount is held back.
      cpuEfctv: num("CPUEfctv") ?? num("CPUTot"),
      cpuTot: num("CPUTot"),
      cpuLoad: num("CPULoad"),
      realMemoryMB: num("RealMemory"),
      allocMemoryMB: num("AllocMem") ?? 0,
      freeMemoryMB: num("FreeMem"),
      memSpecLimitMB: num("MemSpecLimit") ?? 0,
      gres: str("Gres"),
      gpusTotal: parseSinfoGres(str("Gres")).count,
      gpuModel: parseSinfoGres(str("Gres")).model,
      gpusAlloc: allocTres.get("gres/gpu") ?? 0,
      cfgTres,
      allocTres,
      partitions: list("Partitions"),
      activeFeatures: list("ActiveFeatures"),
      availableFeatures: list("AvailableFeatures"),
      weight: num("Weight"),
      reason: str("Reason"),
      version: str("Version"),
    });
  }
  return { rows, warnings };
}

/**
 * Cores handed out against cores actually working.
 *
 * `CPULoad` is a one-minute run-queue average, so it is noisy for a job that has
 * just started and it counts threads rather than cores — a job legitimately
 * oversubscribing shows a load above its allocation. It is evidence, not an
 * indictment, and the threshold is deliberately generous.
 */
export function nodeUtilisation(nodes, { minCores = 16, busyFraction = 0.25 } = {}) {
  const live = (nodes ?? []).filter((nd) => nd.cpuAlloc > 0 && nd.cpuLoad !== null);
  const alloc = live.reduce((t, nd) => t + nd.cpuAlloc, 0);
  const load = live.reduce((t, nd) => t + nd.cpuLoad, 0);
  const idle = live
    .filter((nd) => nd.cpuAlloc >= minCores && nd.cpuLoad < nd.cpuAlloc * busyFraction)
    .sort((a, b) => b.cpuAlloc - a.cpuAlloc);
  return {
    nodes: live.length,
    cpuAlloc: alloc,
    cpuLoad: load,
    busyFraction: alloc > 0 ? load / alloc : null,
    idleNodes: idle,
    // Cores handed out on those nodes that nothing appears to be running on.
    strandedCores: idle.reduce((t, nd) => t + Math.max(0, nd.cpuAlloc - nd.cpuLoad), 0),
  };
}

// ------------------------------------------------------------------ limits

// The TRES a blocking reason refers to, and whose usage it is counted against.
// Reason strings vary by SLURM version, so they are matched loosely.
const LIMIT_REASONS = [
  // A *Minutes* reason is a TRES-minutes allowance (GrpTRESMins), not a cap on
  // how much of a resource may be held at once, so it must be matched first and
  // kept apart: comparing an account's current CPU count against a CPU-minutes
  // budget produced rows reading "0 of 3360 CPUs" for a job blocked on a
  // quarterly allowance.
  [/minutes/i, null],
  [/maxcpuperaccount|grpcpu|maxtresperaccount.*cpu/i, { scope: "account", tres: "cpu" }],
  [/maxcpuperuser/i, { scope: "user", tres: "cpu" }],
  [/max(gres|tres)?peraccount|grpgres/i, { scope: "account", tres: "gres/gpu" }],
  [/max(gres|tres)?peruser/i, { scope: "user", tres: "gres/gpu" }],
];

const MINUTES_REASONS = [
  [/cpuminutes/i, { scope: "account", tres: "cpu" }],
  [/(gres|gpu)minutes/i, { scope: "account", tres: "gres/gpu" }],
  [/billingminutes/i, { scope: "account", tres: "billing" }],
  [/memminutes/i, { scope: "account", tres: "mem" }],
];

/**
 * What a blocking reason refers to, and whose usage it counts against.
 *
 * `kind` separates the two kinds of limit SLURM reports through this field: a
 * "count" limit caps how much of a resource may be held at once and is
 * comparable with what the account is holding now; a "minutes" limit is a
 * resource-time budget and is not.
 */
export function classifyReason(reason) {
  if (!reason) return null;
  if (/minutes/i.test(reason)) {
    for (const [re, spec] of MINUTES_REASONS) {
      if (re.test(reason)) return { ...spec, kind: "minutes" };
    }
    // Named as a minutes limit but not one of the TRES the page knows.
    return { scope: /peruser/i.test(reason) ? "user" : "account", tres: "cpu", kind: "minutes" };
  }
  for (const [re, spec] of LIMIT_REASONS) {
    if (spec && re.test(reason)) return { ...spec, kind: "count" };
  }
  return null;
}

export const TRES_LABEL = { cpu: "CPUs", "gres/gpu": "GPUs" };

/**
 * Find the cap that is holding an account or user back.
 *
 * squeue reports a job's own QOS, but a *partition* QOS can also apply and is
 * not in any of these dumps — that is how a job with QOS `normal` ends up
 * stopped by a `cpu=` cap defined on some other QOS. So candidates are gathered
 * from the job's QOS (exact), from every other QOS that defines a cap of the
 * same shape (inferred), and from the account's own association.
 *
 * When a candidate equals what the account currently holds, that identifies the
 * binding one: sitting exactly on a number is not a coincidence.
 */
/**
 * The cap holding an account or user back, taken from `scontrol show assoc_mgr`.
 *
 * This needs no guessing at all: the dump reports each limit together with the
 * usage counted against it, so the binding one is the one whose usage has
 * reached it — observed rather than inferred. Returns null when the assoc_mgr
 * dump is absent or has nothing matching, and `resolveCap` below then falls back
 * to matching by shape.
 */
function resolveCapFromAssocMgr({ tres, scope, key, account, kind, limits }) {
  if (!limits?.length) return null;
  // GrpTRESMins is a resource-time budget; the count limits are everything else.
  const wantMins = kind === "minutes";
  const candidates = limits.filter((l) => {
    if (l.tres !== tres) return false;
    if (wantMins !== /Mins/.test(l.field)) return false;
    if (scope === "user") return l.user === key || (l.account === account && !l.user);
    return (l.account === key && !l.user) || (l.kind === "qos" && l.account === key);
  });
  if (!candidates.length) return null;
  // Sitting on a limit is what identifies it; otherwise the tightest applies.
  const binding = candidates.find((l) => l.used >= l.limit);
  const chosen = binding ?? candidates.reduce((a, b) => (b.limit < a.limit ? b : a));
  return {
    value: chosen.limit,
    used: chosen.used,
    source: chosen.source,
    field: chosen.field,
    inferred: false,
    ambiguous: !binding && candidates.length > 1,
    fromAssocMgr: true,
  };
}

function resolveCap({ tres, scope, qosNames, partQos, account, used, qosByName, assocByAccount }) {
  const candidates = [];
  const add = (value, source, exact) => {
    if (value > 0) candidates.push({ value, source, exact });
  };
  const pick = (q) => (scope === "account" ? q.maxPerAccount : q.maxPerUser).get(tres) ?? 0;

  for (const name of qosNames) {
    const q = qosByName.get(name);
    if (q) add(pick(q), `QOS ${name}`, true);
  }
  // A partition QOS applies on top of the job's own and used to be guessable
  // only by shape. `scontrol show partition` names it, so it counts as exact.
  for (const name of partQos ?? []) {
    if (qosNames.includes(name)) continue;
    const q = qosByName.get(name);
    if (q) add(pick(q), `QOS ${name} (on the partition)`, true);
  }
  for (const q of qosByName.values()) {
    if (qosNames.includes(q.name) || partQos?.includes(q.name)) continue;
    add(pick(q), `QOS ${q.name}`, false);
  }
  const assoc = assocByAccount.get(account);
  if (assoc) {
    add(assoc.grpTres.get(tres) ?? 0, `association ${account}`, true);
    add(assoc.maxTres.get(tres) ?? 0, `association ${account}`, true);
  }
  if (!candidates.length) return null;

  const exact = candidates.filter((c) => c.exact);
  const pool = exact.length ? exact : candidates;
  const atCap = pool.find((c) => c.value === used);
  const chosen = atCap ?? pool.reduce((a, b) => (b.value < a.value ? b : a));
  return {
    value: chosen.value,
    source: chosen.source,
    // Marked when the cap comes from a QOS the job does not itself carry.
    inferred: !chosen.exact,
    ambiguous: !atCap && pool.length > 1,
  };
}

// ------------------------------------------------------------------ model

function blankPartition(name) {
  return {
    name,
    isDefault: false,
    avail: null,
    timelimit: null,
    nodes: 0,
    byGroup: Object.fromEntries(STATE_GROUPS.map((g) => [g, 0])),
    stateRows: [],
    running: 0,
    pending: 0,
    pendingTasks: 0,
    otherJobs: 0,
    runningCpus: 0,
    runningGpus: 0,
    pendingCpus: 0,
    pendingGpus: 0,
    cpu: { alloc: 0, idle: 0, other: 0, total: 0 },
    gpuTotal: 0,
    gpuUnavail: 0,
    gpuModel: null,
    memoryMB: 0,
    // The largest single node in the partition — what one job can ask for, as
    // opposed to what the partition holds in total.
    perNode: { cpus: 0, gpus: 0, memoryMB: 0 },
    // The partition's configured limits, from `scontrol show partition`; null
    // when that dump is absent, in which case only sinfo's view is available.
    info: null,
    endsIn: [],
    reasons: new Map(),
    queue: [],
    inSinfo: false,
  };
}

const CPU_BUCKETS = ["alloc", "idle", "other", "total"];

/**
 * sinfo reports a maintenance node's cores in the *idle* column even though
 * nothing can be scheduled on them, so fold the idle cores of any unavailable
 * node into "other". After this, idle means genuinely schedulable. Cores already
 * allocated on a draining node stay allocated — that work is still running.
 */
function usableCpu(row) {
  if (!row.cpus) return null;
  const { alloc, idle, other, total } = row.cpus;
  return row.group === "unavail" || row.group === "offline"
    ? { alloc, idle: 0, other: idle + other, total }
    : { alloc, idle, other, total };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Combine the dumps into the model the page renders.
 *
 * squeue drives everything: it lists every job, its partitions, and its current
 * priority. sprio supplies only the breakdown of that priority into factors, and
 * is joined per (job, partition) — a job pending in four partitions has four
 * sprio rows and competes separately in each.
 *
 * `now` is the moment the data was captured (the squeue file's timestamp), used
 * for wait times so they do not drift while the page sits open.
 */
export function buildModel({
  sinfoText,
  squeueText,
  sprioText,
  sshareText,
  sacctQosText,
  sacctAssocText,
  scontrolConfigText,
  scontrolPartitionText,
  scontrolJobText,
  assocMgrText,
  sacctHistText,
  sacctmgrQosText,
  scontrolNodeText,
  now = new Date(),
}) {
  const sinfo = parseSinfo(sinfoText);
  const squeue = parseSqueue(squeueText);
  const sprio = parseSprio(sprioText);
  const sshare = parseSshare(sshareText);
  const sacctQos = parseSacctQos(sacctQosText);
  const sacctAssoc = parseSacctAssoc(sacctAssocText);
  const scConfig = parseScontrolConfig(scontrolConfigText);
  const scPart = parseScontrolPartition(scontrolPartitionText);
  const scJob = parseScontrolJob(scontrolJobText);
  const am = parseAssocMgr(assocMgrText);
  const hist = parseSacctHist(sacctHistText);
  const qosRich = parseSacctmgrQos(sacctmgrQosText);
  const scNode = parseScontrolNode(scontrolNodeText);
  // Every limit that is actually set, each carrying the usage counted against it.
  const amLimits = activeLimits(am);
  const config = readConfig(scConfig.values);
  const partInfo = new Map(scPart.rows.map((r) => [r.name, r]));
  // Keyed by both the full id and the array parent, so an array task finds its
  // record whichever form the other dumps use.
  const jobInfo = new Map();
  for (const r of scJob.rows) {
    jobInfo.set(r.jobId, r);
    if (!jobInfo.has(r.base)) jobInfo.set(r.base, r);
  }
  const warnings = [
    ...sinfo.warnings,
    ...squeue.warnings,
    ...sprio.warnings,
    ...sshare.warnings,
    ...sacctQos.warnings,
    ...sacctAssoc.warnings,
    ...scPart.warnings,
    ...scJob.warnings,
    ...am.warnings,
    ...hist.warnings,
    ...qosRich.warnings,
    ...scNode.warnings,
  ];

  const partitions = new Map();
  const part = (name) => {
    if (!partitions.has(name)) {
      const p = blankPartition(name);
      p.info = partInfo.get(name) ?? null;
      partitions.set(name, p);
    }
    return partitions.get(name);
  };

  // A partition scontrol knows about but that has neither nodes nor jobs in the
  // other dumps still belongs on the list, so the planner can offer it.
  for (const r of scPart.rows) part(r.name);

  // --- nodes -------------------------------------------------------------
  // Keyed by node name where the dump provides one, so a node in two
  // partitions is counted once at cluster level.
  const nodeState = new Map();
  for (const row of sinfo.rows) {
    const p = part(row.partition);
    p.inSinfo = true;
    p.isDefault ||= row.isDefault;
    p.avail ??= row.avail;
    p.timelimit ??= row.timelimit;
    p.nodes += row.count;
    p.byGroup[row.group] += row.count;
    p.stateRows.push(row);
    const cpus = usableCpu(row);
    if (cpus) for (const k of CPU_BUCKETS) p.cpu[k] += cpus[k];
    p.gpuTotal += row.gpusPerNode * row.count;
    // GPUs on drained, down or maintenance nodes cannot be allocated at all.
    if (row.group === "unavail" || row.group === "offline") p.gpuUnavail += row.gpusPerNode * row.count;
    p.gpuModel ??= row.gpuModel;
    p.memoryMB = Math.max(p.memoryMB, row.memoryMB);
    // A row aggregates identically-configured nodes, so total/count is the
    // per-node figure; the largest is what a single job can request.
    if (row.cpus) p.perNode.cpus = Math.max(p.perNode.cpus, Math.round(row.cpus.total / row.count));
    p.perNode.gpus = Math.max(p.perNode.gpus, row.gpusPerNode);
    p.perNode.memoryMB = Math.max(p.perNode.memoryMB, row.memoryMB);
    for (const name of row.nodes) {
      if (!nodeState.has(name)) {
        nodeState.set(name, {
          name,
          state: row.state,
          flags: row.flags,
          group: row.group,
          reason: row.reason,
          partitions: new Set(),
          // A row aggregates identically-configured nodes, so total/count is
          // exact per node; the alloc/idle split is a per-node average that
          // still sums correctly across nodes.
          cpu: cpus ? Object.fromEntries(CPU_BUCKETS.map((k) => [k, cpus[k] / row.count])) : null,
          gpus: row.gpusPerNode,
          memoryMB: row.memoryMB,
        });
      }
      nodeState.get(name).partitions.add(row.partition);
    }
  }

  // --- authoritative GPU counts -------------------------------------------
  /**
   * `squeue`'s `%b` is TRES *per node*, so a job that asked with `--gpus` (per
   * job) reports nothing there and one spanning nodes reports a fraction. That
   * made the dashboard's "GPUs in use" a floor — understated by about a tenth of
   * this cluster. `scontrol show job` carries the real figure: `AllocTRES` for a
   * running job, `ReqTRES` for one still queued.
   *
   * Corrected here, before any aggregation, so the per-partition and cluster
   * totals both follow.
   */
  let gpuCorrected = 0;
  let gpuDelta = 0;
  for (const j of squeue.rows) {
    const sc = jobInfo.get(j.jobid) ?? jobInfo.get(j.base);
    if (!sc) continue;
    const authoritative = j.state === "R" ? sc.allocBilling !== null ? sc.allocTres.get("gres/gpu") : undefined : sc.reqTres.get("gres/gpu");
    if (authoritative === undefined) continue;
    if (authoritative !== j.gpus) {
      gpuCorrected++;
      gpuDelta += authoritative - j.gpus;
    }
    j.gpus = authoritative;
  }

  // --- job -> partitions --------------------------------------------------
  // squeue's %P is authoritative; sprio only fills in for a dump that lacks it.
  const squeueHasPartition = squeue.rows.some((j) => j.partitions.length > 0);
  const partsByJob = new Map();
  for (const r of sprio.rows) {
    if (!partsByJob.has(r.base)) partsByJob.set(r.base, new Set());
    partsByJob.get(r.base).add(r.partition);
    part(r.partition);
  }

  let unattributedJobs = 0;
  for (const j of squeue.rows) {
    if (!j.partitions.length) j.partitions = [...(partsByJob.get(j.base) ?? [])];
    if (!j.partitions.length) unattributedJobs++;
    for (const name of j.partitions) {
      const p = part(name);
      if (j.state === "R") {
        p.running++;
        p.runningCpus += j.cpus;
        p.runningGpus += j.gpus;
        if (j.timeLeft !== null) p.endsIn.push(j.timeLeft);
      } else if (j.state === "PD") {
        p.pending++;
        p.pendingTasks += j.tasks;
        p.pendingCpus += j.cpus;
        p.pendingGpus += j.gpus;
        p.reasons.set(j.reason ?? "-", (p.reasons.get(j.reason ?? "-") ?? 0) + 1);
      } else p.otherJobs++;
    }
  }

  // --- account names -----------------------------------------------------
  // sprio -l truncates USER and ACCOUNT to 8 characters, so a sprio account is
  // resolved against sshare's full names — but only where that is unambiguous.
  const exactAccount = new Set();
  const byPrefix = new Map();
  for (const a of sshare.rows) {
    if (a.user || a.depth === 0) continue;
    exactAccount.add(a.account);
    const p = a.account.slice(0, 8);
    byPrefix.set(p, byPrefix.has(p) ? null : a.account);
  }
  const ambiguous = new Set();
  const resolveAccount = (name) => {
    if (exactAccount.has(name)) return name;
    const hit = byPrefix.get(name);
    if (hit) return hit;
    if (hit === null) ambiguous.add(name);
    return name;
  };

  // --- priority queue ----------------------------------------------------
  // Built from squeue's pending jobs so nothing is missing, then enriched with
  // the sprio factor breakdown for the same (job, partition) pair.
  const sprioByKey = new Map(sprio.rows.map((r) => [`${r.base}|${r.partition}`, r]));
  const sprioUsed = new Set();
  let priorityDrift = 0;
  let withoutFactors = 0;

  let accruing = 0;
  let notAccruing = 0;
  for (const j of squeue.rows) {
    if (j.state !== "PD") continue;
    const sc = jobInfo.get(j.jobid) ?? jobInfo.get(j.base) ?? null;
    // Two different facts, previously the same one. How long a job has sat in
    // the queue is measured from submission; how much age *priority* it has
    // earned is measured from AccrueTime, and a job held by a dependency or a
    // limit has no AccrueTime and is earning none at all.
    const waitSeconds = j.submit ? Math.max(0, (+now - +j.submit) / 1000) : null;
    const accrueFrom = sc ? sc.accrue : (j.submit ?? null);
    const accrueSeconds = accrueFrom ? Math.max(0, (+now - +accrueFrom) / 1000) : null;
    if (sc) {
      if (sc.accrue) accruing++;
      else notAccruing++;
    }
    for (const name of j.partitions) {
      const key = `${j.base}|${name}`;
      const sp = sprioByKey.get(key);
      if (sp) sprioUsed.add(key);
      else withoutFactors++;
      if (sp && sp.priority !== j.priority) priorityDrift++;
      part(name).queue.push({
        jobid: j.jobid,
        base: j.base,
        user: j.user,
        account: resolveAccount(j.account),
        accountRaw: j.account,
        name: j.name,
        qosname: j.qos || sp?.qosname || "",
        nodes: j.nodes,
        cpus: j.cpus,
        gpus: j.gpus,
        memoryMB: j.memoryMB,
        tasks: j.tasks,
        priority: j.priority,
        reason: j.reason ?? "",
        submit: j.submit,
        // Time in the queue, from submission.
        waitSeconds,
        // Time spent earning age priority, from AccrueTime. Null means the job
        // is not accruing — it will not climb the queue until that clears.
        accrueSeconds: sc && !sc.accrue ? null : accrueSeconds,
        accruing: sc ? Boolean(sc.accrue) : null,
        accrue: sc?.accrue ?? null,
        eligible: sc?.eligible ?? null,
        // scontrol's NumCPUs is the count SLURM costed; squeue's is the request.
        scontrolCpus: sc?.cpus ?? null,
        scontrolNodes: sc?.nodes ?? null,
        scontrolState: sc?.state ?? "",
        dependency: sc?.dependency ?? "",
        reqBilling: sc?.reqBilling ?? null,
        allocBilling: sc?.allocBilling ?? null,
        timeLimit: sc?.timeLimit ?? null,
        start: j.start,
        // Present only where sprio has a row for this job and partition.
        factors: sp?.factors ?? null,
        normFactors: sp?.normFactors ?? null,
        sprioPriority: sp?.priority ?? null,
        nice: sp?.nice ?? 0,
      });
    }
  }
  // sprio rows for jobs squeue no longer shows as pending (started, or the
  // dumps are seconds apart).
  const sprioStale = sprio.rows.length - sprioUsed.size;

  /**
   * sprio rows paired with the CPU and node counts to score them against.
   *
   * `PriorityFlags=CALCULATE_RUNNING` makes sprio list running jobs too, and
   * those are the ones worth scoring: for a running job `NumCPUs` is the count
   * SLURM allocated and costed, so the job-size factor is reproducible exactly.
   * For a pending job it is only the request, which the partition's own rules
   * may not yet have been applied to — so such rows are marked and excluded
   * rather than counted as failures of the model.
   */
  const factorSamples = [];
  for (const r of sprio.rows) {
    const sc = jobInfo.get(r.jobid) ?? jobInfo.get(r.base);
    if (!sc || !(sc.cpus > 0) || !(sc.nodes > 0) || !(r.factors.jobsize > 0)) continue;
    factorSamples.push({
      jobid: r.jobid,
      partition: r.partition,
      nodes: sc.nodes,
      cpus: sc.cpus,
      jobsize: r.factors.jobsize,
      state: sc.state,
      // Only a running job's CPU count is the one the factor was computed from.
      authoritative: sc.state === "RUNNING",
    });
  }

  for (const p of partitions.values()) {
    // scontrol is authoritative, so its State replaces sinfo's AVAIL rather than
    // merely filling in for it — sinfo reports "up" for a partition scontrol has
    // as DOWN or INACTIVE. The time limit stays as sinfo's string for display;
    // plan.js prefers `info.maxTime`, which is already in seconds.
    if (p.info) {
      p.isDefault ||= p.info.isDefault;
      if (p.info.state) p.avail = p.info.state.toLowerCase();
    }
    p.queue.sort((a, b) => b.priority - a.priority || Number(a.base) - Number(b.base));
    p.queue.forEach((r, i) => (r.rank = i + 1));
    p.maxPriority = p.queue[0]?.priority ?? 0;
    p.reasons = [...p.reasons.entries()].sort((a, b) => b[1] - a[1]);
    p.problemRows = p.stateRows.filter((r) => r.group === "unavail" || r.group === "offline");
    const waits = p.queue.map((r) => r.waitSeconds).filter((w) => w !== null);
    p.waitMedian = median(waits);
    p.waitMax = waits.length ? Math.max(...waits) : null;
    // Soonest scheduler estimate for anything still waiting here.
    const starts = p.queue.map((r) => r.start).filter(Boolean);
    p.nextStart = starts.length ? new Date(Math.min(...starts.map((d) => +d))) : null;
    p.startEstimates = starts.length;
    // Soonest running job to finish, i.e. when capacity next frees up.
    p.endsInSoonest = p.endsIn.length ? Math.min(...p.endsIn) : null;
    p.hasFactors = p.queue.some((r) => r.factors);
  }

  // Factors that are actually in use, so unused columns are dropped.
  const activeFactors = FACTORS.filter((f) => sprio.rows.some((r) => r.factors[f] !== 0));

  // --- accounts ----------------------------------------------------------
  const gpuKeys = new Set();
  for (const a of sshare.rows) for (const k of a.running.keys()) if (k.startsWith("gres/gpu:")) gpuKeys.add(k);
  const gpuTypes = [...gpuKeys].sort();

  const accounts = sshare.rows
    .filter((a) => a.depth > 0 && !a.user)
    .map((a) => ({
      ...a,
      runCpu: a.running.get("cpu") ?? 0,
      runGpu: a.running.get("gres/gpu") ?? 0,
      gpuByType: Object.fromEntries(gpuTypes.map((k) => [k, a.running.get(k) ?? 0])),
      cpuLimit: a.limits.get("cpu") ?? 0,
      gpuLimit: a.limits.get("gres/gpu") ?? 0,
    }))
    .sort((x, y) => y.runCpu - x.runCpu || y.runGpu - x.runGpu);

  const root = sshare.rows.find((a) => a.depth === 0) ?? null;
  // Displayed types are the ones actually in use; colours index into the full
  // sorted list, so a type keeps its colour when another drops to zero.
  const activeGpuTypes = gpuTypes.filter((k) => accounts.some((a) => a.gpuByType[k] > 0));

  // --- cluster totals ----------------------------------------------------
  const clusterByGroup = Object.fromEntries(STATE_GROUPS.map((g) => [g, 0]));
  const clusterCpu = { alloc: 0, idle: 0, other: 0, total: 0 };
  let totalNodes = 0;
  let clusterGpus = 0;
  let clusterGpusUnavail = 0;
  const nodeList = [...nodeState.values()];
  if (nodeList.length) {
    totalNodes = nodeList.length;
    for (const nd of nodeList) {
      clusterByGroup[nd.group]++;
      clusterGpus += nd.gpus;
      if (nd.group === "unavail" || nd.group === "offline") clusterGpusUnavail += nd.gpus;
      if (nd.cpu) for (const k of CPU_BUCKETS) clusterCpu[k] += nd.cpu[k];
    }
    for (const k of CPU_BUCKETS) clusterCpu[k] = Math.round(clusterCpu[k]);
  } else {
    // No node list: fall back to summing rows, which double-counts a node
    // belonging to two partitions.
    for (const row of sinfo.rows) {
      clusterByGroup[row.group] += row.count;
      totalNodes += row.count;
      clusterGpus += row.gpusPerNode * row.count;
      if (row.group === "unavail" || row.group === "offline")
        clusterGpusUnavail += row.gpusPerNode * row.count;
      const cpus = usableCpu(row);
      if (cpus) for (const k of CPU_BUCKETS) clusterCpu[k] += cpus[k];
    }
  }

  const jobs = squeue.rows;
  const pending = jobs.filter((j) => j.state === "PD");
  const running = jobs.filter((j) => j.state === "R");
  const busyNodes = new Set(running.flatMap((j) => expandHostlist(j.nodelist)));
  const waits = pending.map((j) => (j.submit ? Math.max(0, (+now - +j.submit) / 1000) : null)).filter((w) => w !== null);

  // --- limits -------------------------------------------------------------
  // The richer dump is a superset, so it replaces the narrow one entirely rather
  // than being merged with it — the two are not positionally compatible.
  const qosList = qosRich.rows.length ? qosRich.rows : sacctQos.rows;
  const qosByName = new Map(qosList.map((q) => [q.name, q]));
  const assocByAccount = new Map(sacctAssoc.rows.filter((a) => !a.user).map((a) => [a.account, a]));

  // What each account and each user currently holds, from running jobs.
  const usage = { account: new Map(), user: new Map() };
  const bump = (m, key, tres, v) => {
    if (!key) return;
    if (!m.has(key)) m.set(key, new Map());
    m.get(key).set(tres, (m.get(key).get(tres) ?? 0) + v);
  };
  for (const j of running) {
    for (const [scope, key] of [
      ["account", j.account],
      ["user", j.user],
    ]) {
      bump(usage[scope], key, "cpu", j.cpus);
      bump(usage[scope], key, "gres/gpu", j.gpus);
    }
  }

  // Group the jobs a limit is holding back by which limit it is.
  const blocked = new Map();
  for (const j of pending) {
    const spec = classifyReason(j.reason);
    if (!spec) continue;
    const key = spec.scope === "account" ? j.account : j.user;
    if (!key) continue;
    const id = `${spec.scope}|${key}|${spec.tres}`;
    if (!blocked.has(id)) {
      blocked.set(id, {
        ...spec,
        key,
        reason: j.reason,
        jobs: 0,
        tasks: 0,
        qosNames: new Set(),
        accounts: new Set(),
        partitions: new Set(),
      });
    }
    const b = blocked.get(id);
    b.jobs++;
    b.tasks += j.tasks;
    if (j.qos) b.qosNames.add(j.qos);
    if (j.account) b.accounts.add(j.account);
    for (const p of j.partitions) b.partitions.add(p);
  }

  const limits = [...blocked.values()]
    .map((b) => {
      const account = b.scope === "account" ? b.key : ([...b.accounts][0] ?? "");
      // A minutes limit is a resource-time budget, so neither the cap nor the
      // usage comes from the TRES-count tables. sshare has the allowance
      // (GrpTRESMins) and what running jobs have committed (TRESRunMins); how
      // much of the budget has already been consumed is in none of these dumps,
      // because sshare reports RawUsage as one weighted number, not per TRES.
      if (b.kind === "minutes") {
        const fromAm = resolveCapFromAssocMgr({
          tres: b.tres, scope: b.scope, key: b.key, account, kind: "minutes", limits: amLimits,
        });
        const a = sshare.rows.find((x) => x.account === account && !x.user);
        const cap = a?.limits.get(b.tres) ?? 0;
        return {
          ...b,
          qosNames: [...b.qosNames],
          accounts: [...b.accounts],
          partitions: [...b.partitions],
          partQos: [...new Set([...b.partitions].map((nm) => partInfo.get(nm)?.qos).filter(Boolean))],
          account,
          // assoc_mgr reports the consumed budget; sshare only has what is in
          // flight, which is a different quantity and must be labelled as one.
          used: fromAm ? fromAm.used : (a?.running.get(b.tres) ?? 0),
          usedIsInFlight: !fromAm,
          cap:
            fromAm ??
            (cap > 0
              ? { value: cap, source: `GrpTRESMins on ${account}`, inferred: false, ambiguous: false }
              : null),
        };
      }
      const used = usage[b.scope].get(b.key)?.get(b.tres) ?? 0;
      const fromAm = resolveCapFromAssocMgr({
        tres: b.tres, scope: b.scope, key: b.key, account, kind: "count", limits: amLimits,
      });
      // The QOS attached to any partition these jobs are queued in.
      const partQos = [
        ...new Set([...b.partitions].map((name) => partInfo.get(name)?.qos).filter(Boolean)),
      ];
      return {
        ...b,
        qosNames: [...b.qosNames],
        accounts: [...b.accounts],
        partitions: [...b.partitions],
        partQos,
        used,
        account,
        // assoc_mgr's figure is observed; the shape match is the fallback.
        cap:
          fromAm ??
          resolveCap({
            tres: b.tres,
            scope: b.scope,
            qosNames: [...b.qosNames],
            partQos,
            account,
            used,
            qosByName,
            assocByAccount,
          }),
        // Where assoc_mgr counts the usage itself, prefer that over the figure
        // derived from summing running jobs.
        observedUsed: fromAm?.used ?? null,
      };
    })
    .sort((a, b) => b.jobs - a.jobs);

  return {
    partitions: [...partitions.values()].sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name)),
    cluster: {
      nodes: totalNodes,
      byGroup: clusterByGroup,
      cpu: clusterCpu,
      gpuTotal: clusterGpus,
      gpuUnavail: clusterGpusUnavail,
      running: running.length,
      pending: pending.length,
      pendingTasks: pending.reduce((t, j) => t + j.tasks, 0),
      other: jobs.length - running.length - pending.length,
      users: new Set(jobs.map((j) => j.user)).size,
      busyNodes: busyNodes.size,
      runningCpus: running.reduce((t, j) => t + j.cpus, 0),
      runningGpus: running.reduce((t, j) => t + j.gpus, 0),
      pendingCpus: pending.reduce((t, j) => t + j.cpus, 0),
      pendingGpus: pending.reduce((t, j) => t + j.gpus, 0),
      waitMedian: median(waits),
      waitMax: waits.length ? Math.max(...waits) : null,
    },
    now,
    jobs,
    nodes: nodeList,
    problemNodes: nodeList
      .filter((nd) => nd.group === "unavail" || nd.group === "offline")
      .sort((a, b) => a.name.localeCompare(b.name)),
    accounts,
    limits,
    qosList,
    // Which QOS each account and user may actually use — the job planner offers
    // only these rather than every QOS defined on the cluster.
    assocList: sacctAssoc.rows,
    // The cluster's own priority configuration, so the weights are read rather
    // than recovered. `config.present` is false when the dump is absent.
    config,
    // Every job as `scontrol show job` reports it, and the sprio rows paired
    // with the counts to score the priority model against.
    jobDetail: scJob.rows,
    factorSamples,
    // Limits with the usage counted against them, from `scontrol show assoc_mgr`.
    assocMgr: am,
    assocLimits: amLimits,
    // Finished jobs, and what they actually used against what they asked for.
    history: hist.rows,
    // Per-node state, including what each node is actually doing.
    nodeDetail: scNode.rows,
    gpuTypes,
    activeGpuTypes,
    root,
    activeFactors,
    warnings,
    notes: {
      unattributedJobs,
      withoutFactors,
      sprioStale,
      priorityDrift,
      // A node list would let shared nodes be de-duplicated and the sinfo and
      // squeue views of "in use" be reconciled.
      hasNodelist: sinfo.rows.some((r) => r.nodes.length > 0),
      squeueHasPartition,
      // sprio caps USER/ACCOUNT at 8 characters while the other dumps do not.
      sprioTruncates:
        sprio.rows.length > 0 &&
        Math.max(...sprio.rows.map((r) => Math.max(r.user.length, r.account.length))) === 8 &&
        squeue.rows.some((j) => j.user.length > 8),
      ambiguousAccounts: [...ambiguous],
      hasJobAccounts: squeue.rows.some((j) => j.account) || sprio.rows.some((r) => r.account),
      hasNormFactors: sprio.rows.some((r) => Object.keys(r.normFactors).length > 0),
      hasWaitTimes: pending.some((j) => j.submit),
      hasStartEstimates: pending.some((j) => j.start),
      hasCpuCounts: jobs.some((j) => j.cpus > 0),
      hasGpuCounts: jobs.some((j) => j.gpus > 0),
      hasNodeCapacity: clusterCpu.total > 0,
      hasLimits: sacctQos.rows.length > 0 || sacctAssoc.rows.length > 0,
      hasMemoryRequests: jobs.some((j) => j.memoryMB > 0),
      // Blocked jobs whose limit could not be found in the sacctmgr dumps.
      unresolvedLimits: limits.filter((l) => !l.cap).length,
      hasConfig: config.present,
      hasPartitionInfo: scPart.rows.length > 0,
      hasJobDetail: scJob.rows.length > 0,
      hasAssocMgr: am.assoc.length > 0 || am.qos.length > 0,
      hasHistory: hist.rows.length > 0,
      hasNodeDetail: scNode.rows.length > 0,
      hasRichQos: qosRich.rows.length > 0,
      // A QOS that scales what its jobs are charged, or refuses them outright.
      usageFactors: qosList.filter((q) => q.usageFactor !== undefined && q.usageFactor !== 1).map((q) => `${q.name} ×${q.usageFactor}`),
      denyOnLimit: qosList.filter((q) => q.denyOnLimit).map((q) => q.name),
      qosWallCaps: qosList.filter((q) => q.maxWall > 0).map((q) => q.name),
      // Jobs whose GPU count squeue's %b got wrong, and by how much in total.
      gpuCorrected,
      gpuDelta,
      // Limits already at or over their ceiling, which is now observable.
      limitsAtCeiling: amLimits.filter((l) => l.used >= l.limit).length,
      // Pending jobs that are not accruing age at all, so waiting does nothing
      // for them until whatever is holding them clears.
      accruing,
      notAccruing,
      // Jobs held by a dependency, which sprio omits entirely.
      dependencyHeld: scJob.rows.filter((r) => r.state === "PENDING" && r.dependency).length,
      // Partitions that attach a QOS of their own — the caps that used to have
      // to be matched by shape.
      partitionQos: scPart.rows.filter((r) => r.qos).map((r) => `${r.name} → ${r.qos}`),
      // A weight the cluster sets but that no pending job actually receives.
      // Worth naming: it looks like it should dominate and does not.
      inertFactors: ["fairshare", "qos", "partition", "assoc", "site", "tres"].filter((f) => {
        const w = { fairshare: config.fairShareWeight, qos: config.qosWeight, partition: config.partitionWeight, assoc: config.assocWeight }[f];
        return w > 0 && sprio.rows.length > 0 && sprio.rows.every((r) => r.factors[f] === 0);
      }),
    },
    counts: {
      sinfo: sinfo.rows.length,
      squeue: squeue.rows.length,
      sprio: sprio.rows.length,
      sshare: sshare.rows.length,
      sacctQos: sacctQos.rows.length,
      sacctAssoc: sacctAssoc.rows.length,
      scontrolPartition: scPart.rows.length,
      scontrolConfig: scConfig.values.size,
      scontrolJob: scJob.rows.length,
      assocMgr: am.assoc.length + am.qos.length,
      history: hist.rows.length,
      scontrolNode: scNode.rows.length,
    },
  };
}
