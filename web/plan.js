// The job planner: what a job would cost, what priority it would start with,
// and whether the cluster can run it at all.
//
// SLURM's priority weights are cluster configuration. Where `scontrol show
// config` is dumped they are read from it; where it is absent they are
// *recovered from the other dumps* instead — sprio prints both the weighted and
// the normalized form of each factor, which is enough to solve for the weights.
// Either way the model is scored against the live queue and the page prints how
// much of it the model reproduces, rather than asserting that it is right.
//
// One quantity is fitted even with the config in hand: slurm.conf's
// node_record_count, which no dump reports, because both `sinfo` and `scontrol
// show partition` list only nodes that belong to a partition.

import { FACTORS, parseDuration } from "./parse.js";

// Only used when the dumps are too thin to fit anything. These are SLURM's own
// defaults for a cluster that enables age and job size at all.
export const PRIORITY_FALLBACK = { ageWeight: 1000, ageMax: 604800, jobSizeWeight: 1000 };

// Age and job size follow from the request; the rest are properties of the
// account, QOS and partition, so they are read off jobs already queued.
export const OTHER_FACTORS = FACTORS.filter((f) => f !== "age" && f !== "jobsize");

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const sum = (xs) => xs.reduce((t, x) => t + x, 0);

/**
 * SLURM's job-size factor, with PriorityFavorSmall off:
 *
 *   PriorityWeightJobSize / 2 x (nodes / node_count + cpus / cpu_count)
 *
 * `cpu_count` is the cluster's total cores, which sinfo gives exactly.
 * `node_count` is slurm.conf's node_record_count, which sinfo *under*-reports
 * whenever a node is hidden or in FUTURE state, so it is fitted rather than
 * assumed. Returned unfloored: SLURM floors the sum of all factors, not each one.
 */
export function jobSizeScore(nodes, cpus, pm) {
  if (!pm.cpuCount || !pm.nodeCount) return 0;
  return (pm.jobSizeWeight / 2) * (nodes / pm.nodeCount + cpus / pm.cpuCount);
}

// Grows linearly from submission until PriorityMaxAge, then stops. This is the
// only factor a waiting job can change.
export function ageScore(seconds, pm) {
  return pm.ageWeight * Math.min(1, Math.max(0, seconds) / pm.ageMax);
}

// Round to the coarsest of the given steps that the value is already close to,
// so a measurement lands on the round number a human would have configured.
function snap(v, steps) {
  for (const step of steps) {
    if (Math.abs(v - Math.round(v / step) * step) < step * 0.05) return Math.round(v / step) * step;
  }
  return Math.round(v / steps.at(-1)) * steps.at(-1);
}

// Least squares of (jobsize + 0.5) on nodes and cpus — the half unit aims at the
// middle of each floored value rather than its bottom edge.
function lineThrough(obs) {
  let nn = 0;
  let nc = 0;
  let cc = 0;
  let ny = 0;
  let cy = 0;
  for (const r of obs) {
    const y = r.factors.jobsize + 0.5;
    nn += r.nodes * r.nodes;
    nc += r.nodes * r.cpus;
    cc += r.cpus * r.cpus;
    ny += r.nodes * y;
    cy += r.cpus * y;
  }
  const det = nn * cc - nc * nc;
  if (Math.abs(det) < 1e-9) return null;
  const perNode = (ny * cc - cy * nc) / det;
  const perCpu = (cy * nn - ny * nc) / det;
  return perNode > 0 && perCpu > 0 ? { perNode, perCpu } : null;
}

/**
 * Recover PriorityWeightJobSize and slurm.conf's node count from the JOBSIZE
 * column.
 *
 * Least squares locates the line, but not robustly: squeue's CPUS column
 * understates the allocation for a job that asked for GPUs and let SLURM pick
 * the cores to go with them, and a handful of rows reading "1 CPU, job size 48"
 * are enough to drag the line off every well-behaved one. So the line is refit
 * without the rows it could not explain, and the answer is then chosen by
 * *counting exact matches* over the whole set — a mode, which outliers cannot
 * move, rather than a mean, which they can.
 */
function fitJobSize(obs, cpuCount, sinfoNodes) {
  if (!(cpuCount > 0) || !(sinfoNodes > 0) || obs.length < 8) return null;
  let line = lineThrough(obs);
  if (!line) return null;
  const off = (r) => Math.abs(r.factors.jobsize + 0.5 - line.perNode * r.nodes - line.perCpu * r.cpus);
  const keep = obs.filter((r) => off(r) <= 2);
  if (keep.length >= 8) line = lineThrough(keep) ?? line;

  const w0 = 2 * line.perCpu * cpuCount;
  const n0 = Math.round(w0 / 2 / line.perNode);
  let best = { hits: -1, weight: Math.round(w0 / 100) * 100, nodeCount: n0 };
  // Weights are configured in round numbers; the node count is a plain integer.
  for (let weight = Math.max(100, Math.round((w0 * 0.7) / 100) * 100); weight <= w0 * 1.4; weight += 100) {
    for (let N = Math.max(1, n0 - 15); N <= n0 + 15; N++) {
      const pm = { jobSizeWeight: weight, nodeCount: N, cpuCount };
      let hits = 0;
      for (const r of obs) {
        if (Math.floor(jobSizeScore(r.nodes, r.cpus, pm)) === r.factors.jobsize) hits++;
      }
      // Flooring leaves whole ranges of (weight, node count) indistinguishable
      // when every queued job is small. A tie goes to the node count closest to
      // what sinfo lists, since inventing nodes the dump never mentioned is the
      // more speculative of two equally good fits.
      const closer =
        Math.abs(N - sinfoNodes) < Math.abs(best.nodeCount - sinfoNodes) ||
        (N === best.nodeCount && Math.abs(weight - w0) < Math.abs(best.weight - w0));
      if (hits > best.hits || (hits === best.hits && closer)) best = { hits, weight, nodeCount: N };
    }
  }
  return {
    jobSizeWeight: best.weight,
    nodeCount: best.nodeCount,
    agreement: best.hits / obs.length,
    // With only one distinct node count in the queue, the per-node and per-CPU
    // terms cannot be told apart — every (weight, node count) pair holding the
    // same two coefficients fits identically. That is fine for a single-node
    // estimate, which only uses the combination, and is worth saying out loud
    // before anyone reads the weight as a measurement.
    distinctNodeCounts: new Set(obs.map((r) => r.nodes)).size,
  };
}

/**
 * The priority model the page should use.
 *
 * `scontrol show config` is authoritative and needs no fitting; without it the
 * weights are recovered from the dumps instead. Either way the job-size line is
 * scored against the live `sprio` numbers, so the page can report how much of
 * the queue the model actually reproduces rather than asserting it is right.
 *
 * The node count is fitted in both cases: it is slurm.conf's node_record_count,
 * which no dump reports — `sinfo` and `scontrol show partition` both list only
 * nodes that belong to a partition.
 */
export function priorityModel(model) {
  const fitted = fitPriorityModel(model);
  const c = model.config;
  if (!c?.present || c.ageWeight === null || c.jobSizeWeight === null) return fitted;

  const pm = {
    ...fitted,
    ageWeight: c.ageWeight,
    ageMax: c.ageMax ?? fitted.ageMax,
    jobSizeWeight: c.jobSizeWeight,
    favorSmall: c.favorSmall ?? false,
    source: "config",
    measured: { ageWeight: true, ageMax: c.ageMax !== null, jobSize: true },
  };

  // The weight is known now, so only the node count is left to fit, and it is
  // scored on the rows where squeue's CPUS column can be trusted (see below).
  const obs = scorableRows(model);
  if (obs.length >= 8 && pm.cpuCount > 0) {
    let best = { hits: -1, nodeCount: fitted.nodeCount };
    for (let N = Math.max(1, model.cluster.nodes - 20); N <= model.cluster.nodes + 20; N++) {
      let hits = 0;
      for (const r of obs) {
        if (Math.floor(jobSizeScore(r.nodes, r.cpus, { ...pm, nodeCount: N })) === r.factors.jobsize) hits++;
      }
      const closer = Math.abs(N - model.cluster.nodes) < Math.abs(best.nodeCount - model.cluster.nodes);
      if (hits > best.hits || (hits === best.hits && closer)) best = { hits, nodeCount: N };
    }
    pm.nodeCount = best.nodeCount;
    pm.agreement = best.hits / obs.length;
    pm.samples = obs.length;
    pm.distinctNodeCounts = new Set(obs.map((r) => r.nodes)).size;
    pm.nodeSplitIdentifiable = pm.distinctNodeCounts >= 2;
  }
  pm.perNodePoints = pm.nodeCount > 0 ? pm.jobSizeWeight / 2 / pm.nodeCount : 0;
  pm.perCpuPoints = pm.cpuCount > 0 ? pm.jobSizeWeight / 2 / pm.cpuCount : 0;
  return pm;
}

/**
 * The sprio rows the job-size model can honestly be scored against.
 *
 * `scontrol show job` settles this. For a **running** job `NumCPUs` is the count
 * SLURM allocated, which is the count it costed the factor against, and the
 * model reproduces those rows almost exactly. For a **pending** job `NumCPUs` is
 * still only the request — identical to `squeue`'s `%C` — while the factor is
 * computed against the allocation the scheduler projects for it, which no dump
 * reports. Those rows are excluded rather than counted as failures.
 *
 * Falls back to the queue's own CPU counts when there is no job dump, which is
 * the best that was available before.
 */
export function scorableRows(model) {
  // Any authoritative row beats the heuristic, however few there are — the
  // callers that fit already require a workable sample size.
  const authoritative = (model.factorSamples ?? []).filter((s) => s.authoritative);
  if (authoritative.length) return authoritative.map((s) => ({ ...s, factors: { jobsize: s.jobsize } }));
  const out = [];
  for (const p of model.partitions) {
    for (const r of p.queue) {
      if (!r.factors || !(r.nodes > 0) || !(r.cpus > 0) || !(r.factors.jobsize > 0)) continue;
      if (r.cpus >= allocationFloor(r, p.info)) out.push(r);
    }
  }
  return out;
}

/**
 * The smallest CPU count a partition's rules force on a request.
 *
 * `DefCpuPerGPU` is a *default*: it applies only when `--cpus-per-task` was left
 * unset, and an explicit one overrides it however small. Applying it regardless
 * — which this did before `scontrol show job` was available to check against —
 * over-counted 49 of 1066 running jobs; gating it takes the allocation model to
 * 99.5% exact. `MaxMemPerCPU` applies either way and is the rule that binds for
 * the overwhelming majority.
 */
export function allocationFloor(req, info) {
  if (!info) return 0;
  let floor = 0;
  const gpus = req.gpus ?? 0;
  if (gpus > 0 && info.defCpuPerGpu && !req.explicitCpusPerTask) {
    floor = Math.max(floor, gpus * info.defCpuPerGpu);
  }
  if (req.memoryMB > 0 && info.maxMemPerCpuMB) {
    floor = Math.max(floor, Math.ceil(req.memoryMB / info.maxMemPerCpuMB));
  }
  return floor;
}

/**
 * Solve for the cluster's priority weights from the live dumps.
 *
 * - `PriorityWeightAge` is the ratio of sprio's weighted AGE to its normalized
 *   AGE, which the dump prints side by side.
 * - `PriorityMaxAge` is the wait a job needed to reach that normalized age.
 * - The job-size line is a least-squares fit of the JOBSIZE factor against the
 *   requested nodes and CPUs, from which the weight and node count follow; the
 *   node count is then refined to whichever integer reproduces the most rows.
 *
 * `agreement` is the fraction of pending jobs whose JOBSIZE the fitted model
 * reproduces to the exact integer — the page prints it rather than implying the
 * estimate is exact.
 */
export function fitPriorityModel(model) {
  const rows = model.partitions.flatMap((p) => p.queue).filter((r) => r.factors);
  const measured = { ageWeight: false, ageMax: false, jobSize: false };

  const ratios = rows
    .filter((r) => r.factors.age > 0 && r.normFactors?.age > 0)
    .map((r) => r.factors.age / r.normFactors.age);
  let ageWeight = PRIORITY_FALLBACK.ageWeight;
  if (ratios.length >= 5) {
    // The weighted column is printed as an integer, so each ratio is off by up
    // to half a unit; the median lands on the weight and is rounded to a step a
    // human would have configured.
    ageWeight = Math.max(1, Math.round(median(ratios) / 10) * 10);
    measured.ageWeight = true;
  }

  // Measured against AccrueTime where `scontrol show job` supplies it — that is
  // what the factor actually counts from — and against submit time otherwise.
  const ages = rows
    .filter((r) => r.normFactors?.age > 0.02 && r.normFactors.age < 0.98)
    .map((r) => (r.accrueSeconds ?? r.waitSeconds) / r.normFactors.age)
    .filter((v) => v > 0);
  let ageMax = PRIORITY_FALLBACK.ageMax;
  if (ages.length >= 5) {
    // Snapped to the granularity a human configures PriorityMaxAge at, which
    // absorbs the small bias from measuring the wait at submit rather than at
    // the eligible time.
    ageMax = Math.max(60, snap(median(ages), [86400, 3600, 60]));
    measured.ageMax = true;
  }

  const cpuCount = model.cluster.cpu.total;
  let { jobSizeWeight } = PRIORITY_FALLBACK;
  let nodeCount = model.cluster.nodes;
  let agreement = 0;
  let samples = 0;

  const obs = rows.filter((r) => r.nodes > 0 && r.cpus > 0 && r.factors.jobsize > 0);
  samples = obs.length;
  const js = fitJobSize(obs, cpuCount, model.cluster.nodes);
  let distinctNodeCounts = 0;
  if (js) {
    ({ jobSizeWeight, nodeCount, agreement, distinctNodeCounts } = js);
    measured.jobSize = true;
  }

  return {
    source: "fit",
    favorSmall: false,
    ageWeight,
    ageMax,
    jobSizeWeight,
    nodeCount,
    cpuCount,
    // The two quantities the data actually pins down, whatever weight and node
    // count were used to express them.
    perNodePoints: nodeCount > 0 ? jobSizeWeight / 2 / nodeCount : 0,
    perCpuPoints: cpuCount > 0 ? jobSizeWeight / 2 / cpuCount : 0,
    distinctNodeCounts,
    // Below 2, the weight and node count are one number wearing two hats.
    nodeSplitIdentifiable: distinctNodeCounts >= 2,
    // Node count as sinfo reports it, so the page can say when the fit needed
    // more nodes than the dump lists.
    sinfoNodes: model.cluster.nodes,
    agreement,
    samples,
    measured,
  };
}

/**
 * The priority a freshly submitted job would carry in one partition.
 *
 * Age is zero at submission, so `base` — job size plus the account/QOS factors —
 * is the whole of it, and is also what decides whether waiting can ever move the
 * job past anything already ahead of it.
 */
export function estimatePriority(req, part, pm) {
  const jobsize = jobSizeScore(req.nodes, req.cpus, pm);

  // Peers first: same account and QOS in this partition, then progressively
  // wider, because these factors do not depend on the request at all.
  const queue = part?.queue?.filter((r) => r.factors) ?? [];
  const scopes = [
    ["this account and QOS in this partition", (r) => r.account === req.account && r.qosname === req.qos],
    ["this account in this partition", (r) => r.account === req.account],
    ["this partition", () => true],
  ];
  let peers = [];
  let scope = "no comparable job";
  for (const [label, match] of scopes) {
    peers = queue.filter(match);
    if (peers.length) {
      scope = label;
      break;
    }
  }

  const other = Object.fromEntries(
    OTHER_FACTORS.map((f) => [f, median(peers.map((r) => r.factors[f])) ?? 0]),
  );
  const base = jobsize + sum(Object.values(other));
  return {
    jobsize,
    other,
    base,
    // Age adds nothing at submission and everything by the cap.
    start: base,
    atCap: base + pm.ageWeight,
    peers: peers.length,
    scope,
  };
}

// Where the job would slot into a partition's queue as it stands right now.
export function rankIn(part, priority) {
  const queue = part?.queue ?? [];
  const ahead = queue.filter((r) => r.priority > priority).length;
  return { rank: ahead + 1, ahead, behind: queue.length - ahead, total: queue.length };
}

/**
 * When a new job would overtake one that is already ahead of it.
 *
 * Every pending job gains age priority at the same rate, so waiting does not
 * close the gap — not until the job ahead reaches PriorityMaxAge and stops
 * growing. The difference between the two priorities is therefore monotonic:
 * it starts at `base - row.priority` and rises to `base - rowBase`, so there is
 * exactly one crossing, and it exists only if the new job's *base* priority —
 * everything except age — is the higher of the two.
 *
 * Returns seconds after submission, or null if waiting alone never does it.
 */
export function overtakeSeconds(base, row, pm) {
  const rowBase = row.priority - (row.factors?.age ?? 0);
  if (rowBase >= base) return null;
  // Once the job ahead is pinned at the cap, ours has this much left to climb.
  return Math.max(0, pm.ageMax * (1 + (rowBase - base) / pm.ageWeight));
}

/**
 * What the job will actually be allocated, as opposed to what it asked for.
 *
 * A partition can force the CPU count up in two ways, and both are invisible
 * from the request alone: `DefCpuPerGPU` gives a GPU job that many cores per
 * GPU, and `MaxMemPerCPU` means a memory request can only be met by taking more
 * cores. Because CPUs drive both the cost and the job-size factor, the estimates
 * have to run on these numbers rather than on the request.
 *
 * The rest fill in what the request left out — `DefMemPerCPU` the memory,
 * `DefaultTime` the walltime — which is most of what this does now that every
 * directive on the form is optional. Order matters: the memory default is per
 * *allocated* core, so it is applied after `DefCpuPerGPU` and before the
 * `MaxMemPerCPU` that may raise the count again to cover it.
 *
 * Returns a request of the same shape, plus what changed and why. `requested`
 * keeps the figures as typed, so the page can show both.
 */
export function effectiveRequest(req, part) {
  const info = part?.info ?? null;
  const adjustments = [];
  let cpusPerNode = req.cpusPerNode;
  let memPerNodeMB = req.memPerNodeMB;
  let minutes = req.minutes;

  // DefCpuPerGPU comes first: it settles the core count, and the memory default
  // below is per *allocated* core, not per requested one.
  //
  // DefCpuPerGPU only fills in for an unset --cpus-per-task; an explicit one
  // wins however small. So it applies exactly when the form's CPUs-per-task
  // toggle is off — and when it is on, it is still worth naming, because
  // deleting that one line is the easiest way to multiply a job's cost.
  if (info?.defCpuPerGpu && req.gpusPerNode > 0) {
    const need = req.gpusPerNode * info.defCpuPerGpu;
    if (req.explicitCpusPerTask === false && need > cpusPerNode) {
      adjustments.push({
        rule: "DefCpuPerGPU",
        text: `no --cpus-per-task was set, so ${req.gpusPerNode} GPU(s) per node at DefCpuPerGPU=${info.defCpuPerGpu} gives ${need} cores per node rather than the ${cpusPerNode} a bare task would get.`,
      });
      cpusPerNode = need;
    } else if (need > cpusPerNode) {
      adjustments.push({
        rule: "DefCpuPerGPU",
        // Not applied, so it must not change the numbers — but it is the single
        // easiest way to accidentally multiply this job's cost.
        advisory: true,
        text: `${part.name} would give ${need} cores for ${req.gpusPerNode} GPU(s) (DefCpuPerGPU=${info.defCpuPerGpu}) to a job that did not set --cpus-per-task. This preamble sets it, so the ${cpusPerNode} asked for stands — but deleting that line would take the job to ${need} cores, and the bill with it.`,
      });
    }
  }

  // Only now is the core count settled, so only now can a per-CPU memory rate be
  // turned into a per-node figure. Doing it any earlier costs a GPU job its
  // DefCpuPerGPU cores' worth of memory.
  if (req.memPerCpuMB > 0) memPerNodeMB = req.memPerCpuMB * cpusPerNode;

  if (info?.defMemPerCpuMB && memPerNodeMB === 0) {
    memPerNodeMB = cpusPerNode * info.defMemPerCpuMB;
    adjustments.push({
      rule: "DefMemPerCPU",
      text: `no memory requested, so the partition's default of ${info.defMemPerCpuMB} MB per CPU applies — ${Math.round(memPerNodeMB / 1024)} GB per node.`,
    });
  }

  // Only a per-*node* request can be met by taking more cores. A --mem-per-cpu
  // above MaxMemPerCPU is not a job SLURM makes bigger, it is one it rejects —
  // every extra core brings the same excess with it. feasibility() says so.
  if (info?.maxMemPerCpuMB && memPerNodeMB > 0 && !(req.memPerCpuMB > 0)) {
    const need = Math.ceil(memPerNodeMB / info.maxMemPerCpuMB);
    if (need > cpusPerNode) {
      adjustments.push({
        rule: "MaxMemPerCPU",
        text: `${Math.round(memPerNodeMB / 1024)} GB per node at MaxMemPerCPU=${info.maxMemPerCpuMB} MB needs ${need} cores per node, more than the ${cpusPerNode} asked for — SLURM raises the core count to cover the memory.`,
      });
      cpusPerNode = need;
    }
  }

  // A job that sets no --time is not a job with no walltime: it gets the
  // partition's DefaultTime, and where that is unset SLURM uses MaxTime. The
  // cost and the walltime check both have to run on that figure, since it is
  // what the job will be killed at.
  const timeDefault = partitionDefaultTime(info);
  if (minutes === 0 && timeDefault) {
    minutes = Math.round(timeDefault.seconds / 60);
    adjustments.push({
      rule: timeDefault.rule,
      text: `no walltime requested, so ${part.name}'s ${timeDefault.rule} of ${fmtDur(
        timeDefault.seconds,
      )} applies — that is what the job is costed at and killed at.`,
    });
  }

  return {
    ...req,
    cpusPerNode,
    cpus: req.nodes * cpusPerNode,
    memPerNodeMB,
    memMB: memPerNodeMB * req.nodes,
    minutes,
    requested: {
      cpusPerNode: req.cpusPerNode,
      cpus: req.cpus,
      memPerNodeMB: req.memPerNodeMB || req.memPerCpuMB * req.cpusPerNode,
      minutes: req.minutes,
    },
    adjustments,
    // Only the ones that actually moved a number; an advisory did not.
    applied: adjustments.filter((a) => !a.advisory),
  };
}

/**
 * The walltime a job gets when it asks for none. `DefaultTime` is that value,
 * and slurm.conf documents `MaxTime` as the fallback where it is unset — the two
 * are worth distinguishing, since landing on MaxTime is rarely what was wanted.
 * Null when no partition dump says.
 */
export function partitionDefaultTime(info) {
  if (info?.defaultTime) return { seconds: info.defaultTime, rule: "DefaultTime" };
  if (info?.maxTime) return { seconds: info.maxTime, rule: "MaxTime" };
  return null;
}

/**
 * A job's billable TRES, from the partition's `TRESBillingWeights`.
 *
 * With `PriorityFlags=MAX_TRES` — which this cluster sets — a node's billing is
 * the *largest* of its weighted resources, not their sum. That single flag
 * decides whether memory or CPUs drive the bill, so it is read from the config
 * rather than assumed. Returns null when the weights are unknown.
 */
export function jobBilling(req, part, config, qos = null) {
  const w = part?.info?.billingWeights;
  if (!w || w.size === 0) return null;
  // A QOS can scale everything its jobs are charged; absent means 1.0.
  const factor = qos?.usageFactor ?? 1;
  const terms = [
    { tres: "cpu", label: "CPUs", value: req.cpusPerNode * (w.get("cpu") ?? 0) },
    { tres: "mem", label: "Memory", value: (req.memPerNodeMB / 1024) * (w.get("mem") ?? 0) },
    {
      tres: "gres/gpu",
      label: "GPUs",
      value: req.gpusPerNode * (w.get("gres/gpu") ?? w.get(`gres/gpu:${req.gpuModel}`) ?? 0),
    },
    { tres: "node", label: "Nodes", value: w.get("node") ?? 0 },
  ].filter((t) => t.value > 0 || w.has(t.tres));
  const max = config?.maxTres ?? false;
  const perNode = max
    ? Math.max(0, ...terms.map((t) => t.value))
    : terms.reduce((s, t) => s + t.value, 0);
  const driver = max ? terms.reduce((a, b) => (b.value > a.value ? b : a), terms[0] ?? null) : null;
  return {
    perNode: perNode * factor,
    total: perNode * req.nodes * factor,
    minutes: perNode * req.nodes * req.minutes * factor,
    usageFactor: factor,
    terms,
    // Under MAX_TRES only one resource is ever charged for; naming it tells the
    // user which knob actually moves their bill.
    driver,
    max,
    weights: w,
  };
}

/**
 * What over-requesting memory actually costs, measured against finished jobs.
 *
 * On a cluster with `MaxMemPerCPU` set, a memory request is met by taking more
 * cores — and under `MAX_TRES` billing the core count *is* the bill. So asking
 * for memory you do not use is not free: it buys cores you did not need and pays
 * for them for the whole run.
 *
 * For each completed job where memory was the rule that set the core count, this
 * compares the cores the *request* forced against the cores the observed peak
 * would have needed. Jobs where the user's own core request was already the
 * binding figure are skipped — there is nothing to attribute to memory there.
 */
export function memoryWaste(history, partitions) {
  const info = new Map((partitions ?? []).filter((p) => p.info?.maxMemPerCpuMB).map((p) => [p.name, p.info]));
  const byWho = new Map();
  let jobs = 0;
  let billed = 0;
  let needed = 0;

  for (const h of history ?? []) {
    if (!h.finished || h.peakMemMB === null || !h.elapsed || !(h.reqMemMB > 0)) continue;
    const i = info.get(h.partition);
    if (!i) continue;
    const forced = Math.ceil(h.reqMemMB / i.maxMemPerCpuMB);
    // Memory only cost something if it, not the core request, set the count.
    if (forced <= h.reqCpus) continue;
    const wouldNeed = Math.max(h.reqCpus, Math.ceil(h.peakMemMB / i.maxMemPerCpuMB));
    const charged = Math.max(h.reqCpus, forced);
    const minutes = h.elapsed / 60;
    jobs++;
    billed += charged * minutes;
    needed += wouldNeed * minutes;

    for (const [scope, key] of [
      ["account", h.account],
      ["user", h.user],
    ]) {
      if (!key) continue;
      const id = `${scope}|${key}`;
      const e = byWho.get(id) ?? { scope, key, jobs: 0, billed: 0, needed: 0 };
      e.jobs++;
      e.billed += charged * minutes;
      e.needed += wouldNeed * minutes;
      byWho.set(id, e);
    }
  }

  const avoidable = billed - needed;
  return {
    jobs,
    billedMinutes: billed,
    neededMinutes: needed,
    avoidableMinutes: avoidable,
    avoidableCoreHours: avoidable / 60,
    pct: billed > 0 ? avoidable / billed : 0,
    worst: [...byWho.values()]
      .map((e) => ({ ...e, avoidable: e.billed - e.needed, pct: e.billed > 0 ? (e.billed - e.needed) / e.billed : 0 }))
      .sort((a, b) => b.avoidable - a.avoidable),
  };
}

/**
 * What the job commits, in the units the accounting dumps use: `GrpTRESMins`
 * caps and `sshare`'s `TRESRunMins` are both TRES-minutes, so these numbers go
 * straight against an account's allowance.
 */
export function jobCost(req) {
  const m = req.minutes;
  return {
    minutes: m,
    cpuMinutes: req.cpus * m,
    gpuMinutes: req.gpus * m,
    nodeMinutes: req.nodes * m,
    memGBMinutes: (req.memMB / 1024) * m,
    cpuHours: (req.cpus * m) / 60,
    gpuHours: (req.gpus * m) / 60,
    nodeHours: (req.nodes * m) / 60,
  };
}

// AllowAccounts names a *root* account (e.g. "jhu"); a job's account is
// usually a descendant of it (lab/PI sub-accounts, then per-user leaves).
// `scontrol show assoc_mgr`'s Lineage string is the flattened ancestor path
// for an account, so walking it is what tells us the job is actually under
// that root rather than requiring an exact name match. Falls back to null
// when the dump lacks assoc_mgr or the account, so callers can fall back to
// the flat comparison instead.
function accountAncestors(model, account) {
  const rows = model?.assocMgr?.assoc;
  if (!rows || !account) return null;
  const row =
    rows.find((a) => a.account && !a.user && a.account.toLowerCase() === account.toLowerCase()) ??
    rows.find((a) => a.account && a.account.toLowerCase() === account.toLowerCase());
  if (!row?.lineage) return null;
  return row.lineage.split("/").filter((s) => s && !s.startsWith("0-"));
}

/**
 * Whether the request can run at all, and whether it could start now.
 *
 * `level` is "bad" for something that makes the job unschedulable as written,
 * "warn" for something that will make it wait, "info" for a silent adjustment
 * the partition applies, and "ok" for a check that passed. A check the dumps
 * cannot answer is left out rather than guessed at.
 */
export function feasibility(req, part, model, pm) {
  const out = [];
  const add = (level, label, text) => out.push({ level, label, text });
  if (!part) {
    add(
      "bad",
      "Partition",
      req.partition
        ? `${req.partition} is not in sinfo.txt — it may be hidden, or the dump predates it.`
        : "No partition to check against — sinfo.txt named none.",
    );
    return out;
  }

  const info = part.info;

  if (part.avail && part.avail !== "up") {
    add("bad", "Partition", `${part.name} is ${part.avail}, so nothing will start there.`);
  }

  if (info?.allowAccounts && req.account) {
    const ancestors = accountAncestors(model, req.account);
    const allowed = ancestors
      ? ancestors.some((a) => info.allowAccounts.some((allow) => allow.toLowerCase() === a.toLowerCase()))
      : info.allowAccounts.includes(req.account);
    if (!allowed) {
      add("bad", "Account", `${part.name} only accepts jobs from ${info.allowAccounts.join(", ")}.`);
    }
  }
  if (info?.allowQos && req.qos && !info.allowQos.includes(req.qos)) {
    add("bad", "QOS allowed", `${part.name} only accepts QOS ${info.allowQos.join(", ")}.`);
  }

  // scontrol's MaxTime is authoritative; sinfo's TIMELIMIT string is a fallback.
  const limit = info ? info.maxTime : parseDuration(part.timelimit ?? "");
  // Already resolved to the partition's default where the job set none, so a
  // zero here means nothing in the dumps says what the job would get.
  const asked = req.minutes * 60;
  if (asked === 0) {
    add(
      "warn",
      "Walltime",
      `No walltime set, and nothing in these dumps says what ${part.name} would substitute — ${
        info ? "it reports neither DefaultTime nor MaxTime" : "scontrol show partition would give its DefaultTime"
      }. The cost below assumes nothing for the runtime, so read it as a rate, not a total.`,
    );
  } else if (limit !== null) {
    if (asked > limit) {
      add("bad", "Walltime", `${fmtDur(asked)} exceeds ${part.name}'s limit of ${fmtDur(limit)} — sbatch will reject it.`);
    } else {
      add("ok", "Walltime", `${fmtDur(asked)} is within ${part.name}'s limit of ${fmtDur(limit)}.`);
    }
  }

  // MaxNodes is a partition limit and is often far below the node count.
  if (info?.maxNodes !== null && info?.maxNodes !== undefined) {
    if (req.nodes > info.maxNodes) {
      add("bad", "Nodes", `${req.nodes} nodes requested but ${part.name} allows at most ${info.maxNodes} per job.`);
    } else {
      add("ok", "Nodes", `${req.nodes} of the ${info.maxNodes} nodes ${part.name} allows per job.`);
    }
  } else if (req.nodes > part.nodes && part.nodes > 0) {
    add("bad", "Nodes", `${req.nodes} nodes requested but ${part.name} only has ${part.nodes}.`);
  }
  if (info?.minNodes && req.nodes < info.minNodes) {
    add("bad", "Nodes", `${part.name} requires at least ${info.minNodes} nodes per job.`);
  }

  // Phrased as "each <name> node" throughout: partition names are things like
  // a100 and l40s, and no choice of indefinite article reads correctly for all
  // of them.
  const per = part.perNode;
  // The binding per-node core limit is the smaller of what a node physically has
  // and what the partition permits — MaxCPUsPerNode is routinely lower.
  const coreCap = Math.min(...[per?.cpus, info?.maxCpusPerNode].filter((v) => v > 0));
  if (Number.isFinite(coreCap)) {
    const via =
      info?.maxCpusPerNode && info.maxCpusPerNode === coreCap && coreCap !== per?.cpus
        ? ` (${part.name}'s MaxCPUsPerNode, below the ${per.cpus} the hardware has)`
        : "";
    if (req.cpusPerNode > coreCap) {
      add("bad", "CPUs per node", `${req.cpusPerNode} cores per node, but the limit is ${coreCap}${via}.`);
    } else {
      add("ok", "CPUs per node", `${req.cpusPerNode} of the ${coreCap} cores allowed per ${part.name} node${via}.`);
    }
  }

  // Why the core count may differ from what was typed. Listed as checks so the
  // reason sits next to the limit it interacts with. Not a warning: the job runs
  // exactly as asked, it is just costed and ranked on more cores.
  for (const a of req.adjustments ?? []) {
    add(a.advisory ? "note" : "info", a.rule, a.text);
  }

  if (req.gpusPerNode > 0) {
    if (!per?.gpus) {
      add("bad", "GPUs", `${part.name} has no GPUs configured.`);
    } else if (req.gpusPerNode > per.gpus) {
      add("bad", "GPUs per node", `${req.gpusPerNode} GPUs per node, but each ${part.name} node has ${per.gpus}.`);
    } else {
      const model = part.gpuModel ? `${part.gpuModel} ` : "";
      add("ok", "GPUs per node", `${req.gpusPerNode} of the ${per.gpus} ${model}GPUs on each node.`);
    }
    if (req.gpuModel && part.gpuModel && req.gpuModel !== part.gpuModel) {
      add("bad", "GPU model", `${part.name} has ${part.gpuModel} GPUs, not ${req.gpuModel}.`);
    }
  }

  if (info?.maxMemPerCpuMB && req.memPerCpuMB > info.maxMemPerCpuMB) {
    add(
      "bad",
      "Memory per CPU",
      `${Math.round(req.memPerCpuMB)} MB per CPU is above ${part.name}'s MaxMemPerCPU of ${info.maxMemPerCpuMB} MB. Unlike --mem, this is not something more cores can cover — every core would carry the same excess — so sbatch rejects it.`,
    );
  }

  const memCap = Math.min(...[per?.memoryMB, info?.maxMemPerNodeMB].filter((v) => v > 0));
  if (Number.isFinite(memCap) && req.memPerNodeMB > 0) {
    if (req.memPerNodeMB > memCap) {
      add("bad", "Memory", `${gb(req.memPerNodeMB)} per node, but the limit is ${gb(memCap)}.`);
    } else {
      add("ok", "Memory", `${gb(req.memPerNodeMB)} of the ${gb(memCap)} available on each ${part.name} node.`);
    }
  }

  // A QOS cap the job would breach on its own is a hard stop, not a wait. Both
  // the job's QOS and the partition's own apply.
  const qosNames = [req.qos, info?.qos].filter(Boolean);
  for (const name of qosNames) {
    const qos = model.qosList?.find((q) => q.name === name);
    if (!qos) continue;
    const whose = name === info?.qos && name !== req.qos ? ` (attached to ${part.name})` : "";
    // A per-QOS walltime ceiling, which no other dump reports and which can sit
    // far below the partition's own limit.
    if (qos.maxWall > 0) {
      if (asked > qos.maxWall) {
        add(
          "bad",
          "QOS walltime",
          `QOS ${qos.name}${whose} allows at most ${fmtDur(qos.maxWall)} per job; this asks for ${fmtDur(asked)}.`,
        );
      } else {
        add("ok", "QOS walltime", `${fmtDur(asked)} is within QOS ${qos.name}'s limit of ${fmtDur(qos.maxWall)}.`);
      }
    }
    // MaxTRESPerJob caps a single job outright, unlike the per-user totals below.
    for (const [tres, want, label] of [
      ["gres/gpu", req.gpus, "GPUs"],
      ["cpu", req.cpus, "CPUs"],
    ]) {
      const cap = qos.maxPerJob?.get(tres);
      if (want && cap > 0 && want > cap) {
        add("bad", `QOS ${label} per job`, `QOS ${qos.name}${whose} allows ${cap} ${label} in one job; this asks for ${want}.`);
      }
    }
    for (const [tres, want, label] of [
      ["gres/gpu", req.gpus, "GPUs"],
      ["cpu", req.cpus, "CPUs"],
    ]) {
      if (!want) continue;
      for (const [key, scope] of [
        ["maxPerUser", "user"],
        ["maxPerAccount", "account"],
      ]) {
        const cap = qos[key].get(tres);
        if (cap > 0 && want > cap) {
          add(
            "bad",
            `QOS ${label}`,
            `QOS ${qos.name}${whose} allows ${cap} ${label} per ${scope}; this job alone asks for ${want}.` +
              (qos.denyOnLimit
                ? ` ${qos.name} carries DenyOnLimit, so sbatch refuses the job outright rather than queueing it.`
                : ""),
          );
        }
      }
    }
  }

  if (req.tasks > 1 && model.config?.maxArraySize && req.tasks > model.config.maxArraySize) {
    add("bad", "Array", `${req.tasks} tasks exceeds MaxArraySize of ${model.config.maxArraySize}.`);
  }

  // Could it start right now? Where `scontrol show node` is available this is a
  // placement question rather than an arithmetic one: a partition with 400 idle
  // cores spread a few per node cannot hold a 64-core job on any of them.
  const fits = placement(req, part, model.nodeDetail);
  if (fits) {
    if (fits.nodes >= req.nodes) {
      add(
        "ok",
        "Free now",
        `${fits.nodes} of ${part.name}'s ${fits.considered} node(s) could take this job as it stands${
          req.nodes > 1 ? `, and it needs ${req.nodes}` : ""
        } — though anything ahead of it in the queue gets them first.`,
      );
    } else {
      add(
        "warn",
        "Free now",
        `No node in ${part.name} has room for this job right now — ${fits.blocked} — so it waits for something to finish.`,
      );
    }
    return out;
  }

  const freeGpus = Math.max(0, part.gpuTotal - part.gpuUnavail - part.runningGpus);
  const tight = [];
  if (part.cpu.total && req.cpus > part.cpu.idle) tight.push(`${req.cpus} cores against ${part.cpu.idle} idle`);
  if (req.gpus > freeGpus) tight.push(`${req.gpus} GPUs against ${freeGpus} free`);
  if (tight.length) {
    add("warn", "Free now", `Not enough capacity free in ${part.name} right now: ${tight.join(", ")}.`);
  } else if (part.cpu.total || part.gpuTotal) {
    add(
      "ok",
      "Free now",
      `${part.name} has ${part.cpu.idle} idle cores${
        part.gpuTotal ? ` and ${freeGpus} free GPUs` : ""
      } — enough for this job, though anything ahead of it in the queue gets them first.`,
    );
  }

  return out;
}

/**
 * How many nodes in the partition could hold one node's worth of this job right
 * now, and what stops the rest.
 *
 * Aggregate free capacity overstates this badly: cores free a handful per node
 * cannot host a job that wants sixty on one. Returns null without the node dump,
 * so the caller falls back to the aggregate figure.
 */
export function placement(req, part, nodes) {
  const pool = (nodes ?? []).filter((nd) => nd.partitions.includes(part.name));
  if (!pool.length) return null;
  const reasons = new Map();
  const bump = (why) => reasons.set(why, (reasons.get(why) ?? 0) + 1);
  let fits = 0;
  for (const nd of pool) {
    if (!nd.schedulable) {
      bump(`${nd.state}${nd.stateFlags.length ? `/${nd.stateFlags.join("/")}` : ""}`);
      continue;
    }
    const freeCpu = Math.max(0, (nd.cpuEfctv ?? 0) - (nd.cpuAlloc ?? 0));
    const freeMem = Math.max(0, (nd.realMemoryMB ?? 0) - (nd.allocMemoryMB ?? 0) - (nd.memSpecLimitMB ?? 0));
    const freeGpu = Math.max(0, (nd.gpusTotal ?? 0) - (nd.gpusAlloc ?? 0));
    if (freeCpu < req.cpusPerNode) bump("short on cores");
    else if (req.memPerNodeMB > 0 && freeMem < req.memPerNodeMB) bump("short on memory");
    else if (req.gpusPerNode > 0 && freeGpu < req.gpusPerNode) bump("short on GPUs");
    else fits++;
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  return {
    considered: pool.length,
    nodes: fits,
    // Counts are of *nodes*, not the resource itself — worth spelling out, since
    // "3 short on GPUs" next to a 1-GPU request otherwise reads as if the job asked
    // for three.
    blocked: top.map(([why, count]) => `${count} node${count === 1 ? "" : "s"} ${why}`).join(", ") || "none free",
  };
}

/**
 * The account's remaining GrpTRESMins allowance, and what this job would take
 * out of it. `sshare`'s TRESRunMins is what running jobs have already committed.
 */
export function accountHeadroom(model, account, cost) {
  const a = model.accounts?.find((x) => x.account === account);
  if (!a) return null;
  const rows = [
    { label: "CPU-minutes", limit: a.cpuLimit, used: a.runCpu, want: cost.cpuMinutes },
    { label: "GPU-minutes", limit: a.gpuLimit, used: a.runGpu, want: cost.gpuMinutes },
  ].filter((r) => r.limit > 0 || r.used > 0);
  return { account: a, rows };
}

// ------------------------------------------------------------------ sbatch

// "1-06:30:00" from days/hours/minutes, in the form sbatch documents. A null
// field is an unset one, which counts as zero here.
export function timeSpec(f) {
  const v = (x) => Number(x) || 0;
  const p2 = (x) => String(v(x)).padStart(2, "0");
  return v(f.days) > 0 ? `${v(f.days)}-${p2(f.hours)}:${p2(f.minutes)}:00` : `${p2(f.hours)}:${p2(f.minutes)}:00`;
}

/**
 * The `#SBATCH` block for a request.
 *
 * Every directive is optional, and `null` means the form left it switched off:
 * nothing is written for it and SLURM substitutes its own value. That is not the
 * same as a directive set to zero or to the empty string, so the two are kept
 * apart all the way through — `--nodes=0` is a rejected job, while no `--nodes`
 * at all is a one-node job.
 */
export function sbatchPreamble(f) {
  const lines = [];
  const put = (flag, value) => {
    if (value !== "" && value !== null && value !== undefined) lines.push(`#SBATCH --${flag}=${value}`);
  };
  const flag = (name, on) => {
    if (on) lines.push(`#SBATCH --${name}`);
  };

  put("job-name", f.jobName);
  put("partition", f.partition);
  put("account", f.account);
  put("qos", f.qos);
  put("array", f.array);
  put("nodes", f.nodes);
  put("ntasks-per-node", f.ntasksPerNode);
  put("cpus-per-task", f.cpusPerTask);
  if (f.gpusPerNode > 0) put("gpus-per-node", f.gpuModel ? `${f.gpuModel}:${f.gpusPerNode}` : f.gpusPerNode);
  if (f.memValue > 0) {
    // --mem is per node; --mem-per-cpu multiplies by cpus-per-task.
    put(f.memPer === "cpu" ? "mem-per-cpu" : "mem", `${f.memValue}${f.memUnit}`);
  }
  // All three walltime fields belong to one directive, so they are switched off
  // together; a null walltime is one left to the partition's DefaultTime.
  if (f.days !== null || f.hours !== null || f.minutes !== null) put("time", timeSpec(f));
  put("constraint", f.constraint);
  flag("exclusive", f.exclusive);
  flag("requeue", f.requeue);
  put("output", f.output);
  put("error", f.error);
  if (f.mailType) {
    put("mail-type", f.mailType);
    put("mail-user", f.mailUser);
  }
  return lines;
}

/**
 * Every `#SBATCH` directive the form can write, in the order the preamble emits
 * them, with the form inputs each one governs. A directive is one toggle even
 * where it takes several fields — a walltime is three inputs and one `--time`.
 */
export const PREAMBLE_OPTIONS = [
  { key: "jobName", flag: "job-name", inputs: ["jobName"] },
  { key: "partition", flag: "partition", inputs: ["partition"] },
  { key: "account", flag: "account", inputs: ["account"] },
  { key: "qos", flag: "qos", inputs: ["qos"] },
  { key: "array", flag: "array", inputs: ["array"] },
  { key: "nodes", flag: "nodes", inputs: ["nodes"] },
  { key: "ntasksPerNode", flag: "ntasks-per-node", inputs: ["ntasksPerNode"] },
  { key: "cpusPerTask", flag: "cpus-per-task", inputs: ["cpusPerTask"] },
  { key: "gpus", flag: "gpus-per-node", inputs: ["gpusPerNode", "gpuModel"] },
  { key: "mem", flag: "mem", inputs: ["memValue", "memUnit", "memPer"] },
  { key: "time", flag: "time", inputs: ["days", "hours", "minutes"] },
  { key: "constraint", flag: "constraint", inputs: ["constraint"] },
  { key: "output", flag: "output", inputs: ["output"] },
  { key: "error", flag: "error", inputs: ["error"] },
  { key: "mail", flag: "mail-type", inputs: ["mailType", "mailUser"] },
];

// Seconds to the days/hours/minutes the walltime inputs hold.
function splitTime(seconds) {
  return {
    days: Math.floor(seconds / 86400),
    hours: Math.floor((seconds % 86400) / 3600),
    minutes: Math.round((seconds % 3600) / 60),
  };
}

/**
 * For each optional directive: what SLURM does when it is absent, and the value
 * to seed the input with when the user switches it on.
 *
 * Leaving a directive out does not mean the job goes without — SLURM substitutes
 * something, and for several of them that something is cluster configuration
 * (`DefaultTime`, `DefMemPerCPU`, the partition marked `Default=YES`). Seeding a
 * newly-enabled field with exactly that value means turning a toggle on never
 * silently changes what the job asks for; it only writes down what was already
 * going to happen.
 *
 * `text` says what the absent directive resolves to, so it serves both as the
 * explanation on the toggle and as the list of assumptions the estimates run on.
 * Where SLURM has no configured default the seed is a plain starting point and
 * `text` says so rather than inventing an authority for it. `values` is null when
 * there is nothing sensible to seed and the input should be left as it stands.
 *
 * `real` separates those two cases: it marks the entries whose `values` *are*
 * what SLURM would use, which are the only ones a switched-off input may display.
 * A greyed-out box showing `1 h` next to a cost card figured on the partition's
 * four-hour DefaultTime is worse than showing nothing at all.
 */
export function preambleDefaults(model, part, req = null) {
  const info = part?.info ?? null;
  const where = part?.name ?? "the partition";
  const out = {};
  const put = (key, values, text, real = false) => (out[key] = { values, text, real });

  const defPart = model?.partitions?.find((p) => p.isDefault) ?? null;
  const defMem = info?.defMemPerCpuMB ?? model?.config?.defMemPerCpuMB ?? null;
  const defTime = partitionDefaultTime(info);

  put("jobName", { jobName: "myjob" }, "the job is named after the submit script.");
  put(
    "partition",
    defPart ? { partition: defPart.name } : null,
    defPart
      ? `the job goes to ${defPart.name}, the partition marked Default=YES.`
      : "the job goes to the cluster's default partition; no dump marks which that is.",
    !!defPart,
  );
  // The default account and the default QOS both live on the submitter's own
  // association, and the association dump carries neither — see README.
  put("account", null, "the job is charged to your association's default account, which no dump reports.");
  put("qos", null, `the job runs under your association's DefaultQOS${info?.qos ? `, plus ${where}'s own ${info.qos}` : ""} — no dump reports which that is.`);
  put("array", { array: "0-9" }, "the script runs once, as a single job.");
  put("nodes", { nodes: 1 }, "SLURM allocates one node.", true);
  put("ntasksPerNode", { ntasksPerNode: 1 }, "SLURM runs one task per node.", true);
  // The seed that matters most. A GPU job with no --cpus-per-task does not get
  // one core per task: DefCpuPerGPU gives it that many cores for every GPU, and
  // on these partitions that is 10 to 30 times more. Seeding the box with 1
  // would divide the job — and its bill — by that factor the moment it was
  // ticked, which is the opposite of what switching a directive on is for.
  const gpuCores = info?.defCpuPerGpu && req?.gpusPerNode > 0 ? req.gpusPerNode * info.defCpuPerGpu : 0;
  const tasks = Math.max(1, req?.ntasksPerNode ?? 1);
  put(
    "cpusPerTask",
    { cpusPerTask: gpuCores ? Math.max(1, Math.round(gpuCores / tasks)) : 1 },
    gpuCores
      ? `${where}'s DefCpuPerGPU of ${info.defCpuPerGpu} gives this job ${gpuCores} core(s) for its ${req.gpusPerNode} GPU(s) per node, not one per task.`
      : info?.defCpuPerGpu
        ? `each task gets one core — except a GPU job, which gets ${where}'s DefCpuPerGPU of ${info.defCpuPerGpu} cores per GPU instead.`
        : "each task gets one core.",
    true,
  );
  put("gpus", { gpusPerNode: 1, gpuModel: part?.gpuModel ?? "" }, "the job gets no GPUs; a GPU job has to ask.");
  put(
    "mem",
    defMem ? { memValue: defMem, memUnit: "M", memPer: "cpu" } : { memValue: 4, memUnit: "G", memPer: "node" },
    defMem
      ? `each core carries ${defMem} MB, from ${info?.defMemPerCpuMB ? `${where}'s` : "the cluster's"} DefMemPerCPU.`
      : "the memory per core is whatever DefMemPerCPU is set to, which these dumps do not report.",
    !!defMem,
  );
  put(
    "time",
    defTime ? splitTime(defTime.seconds) : { days: 0, hours: 1, minutes: 0 },
    defTime
      ? `the job runs at most ${fmtDur(defTime.seconds)}, ${where}'s ${defTime.rule}.`
      : `the job runs at most ${where}'s DefaultTime, which these dumps do not report.`,
    !!defTime,
  );
  put("constraint", null, "any node in the partition will do; node features are not in these dumps.");
  // SLURM's own default file names. An array job's is slurm-%A_%a.out, since %j
  // would give every task the same file.
  put("output", { output: "slurm-%j.out" }, "stdout goes to slurm-%j.out beside the submit script.", true);
  put("error", { error: "slurm-%j.err" }, "stderr is merged into the output file.");
  put("mail", { mailType: "END,FAIL", mailUser: "" }, "SLURM sends no mail about this job.");
  return out;
}

// ------------------------------------------------------------------ shaping

/**
 * Turn the form's fields into the single request shape the estimators take, so
 * the CPU and GPU totals are derived in exactly one place.
 *
 * A field the form left switched off arrives as null and is replaced by what
 * sbatch itself would assume — one node, one task, one core per task, no GPUs —
 * so an empty form still describes a real job. The two defaults that are
 * *cluster* configuration rather than SLURM's own, memory and walltime, are left
 * at zero for `effectiveRequest` to fill from the partition.
 */
export function toRequest(f) {
  const nodes = Math.max(1, f.nodes || 1);
  const cpusPerNode = Math.max(1, (f.ntasksPerNode || 1) * (f.cpusPerTask || 1));
  const gpusPerNode = Math.max(0, f.gpusPerNode || 0);
  const unit = { M: 1, G: 1024, T: 1024 * 1024 }[f.memUnit] ?? 1024;
  const memMB = (f.memValue || 0) * unit;
  // `--mem-per-cpu` is per *allocated* core, and the allocated count is not
  // known here — DefCpuPerGPU can multiply it. So it is carried through as a
  // rate for effectiveRequest to resolve, rather than multiplied out now
  // against a core count the partition is about to change.
  const perCpuMB = f.memPer === "cpu" ? memMB : 0;
  const perNodeMB = f.memPer === "cpu" ? 0 : memMB;
  const tasks = Math.max(1, arrayTasks(f.array));
  return {
    partition: f.partition,
    account: f.account,
    qos: f.qos,
    nodes,
    ntasksPerNode: Math.max(1, f.ntasksPerNode || 1),
    cpusPerNode,
    cpus: nodes * cpusPerNode,
    gpusPerNode,
    gpus: nodes * gpusPerNode,
    gpuModel: f.gpuModel,
    memPerCpuMB: perCpuMB,
    memPerNodeMB: perNodeMB,
    memMB: perNodeMB * nodes,
    minutes: (f.days || 0) * 1440 + (f.hours || 0) * 60 + (f.minutes || 0),
    // Whether the preamble emits --cpus-per-task, which is the one thing that
    // stops DefCpuPerGPU from applying.
    explicitCpusPerTask: f.cpusPerTask !== null,
    // An array's tasks are separately scheduled jobs, each costing the same.
    tasks,
  };
}

// "0-9%4" -> 10, "1,3,5" -> 3, "" -> 1
export function arrayTasks(spec) {
  if (!spec || !spec.trim()) return 1;
  return spec
    .split("%")[0]
    .split(",")
    .reduce((t, part) => {
      const m = part.trim().match(/^(\d+)-(\d+)(?::(\d+))?$/);
      if (!m) return t + (/^\d+$/.test(part.trim()) ? 1 : 0);
      const step = Number(m[3] ?? 1) || 1;
      return t + Math.floor((Number(m[2]) - Number(m[1])) / step) + 1;
    }, 0);
}

// ------------------------------------------------------------------ helpers

const gb = (mb) => (mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${Math.round(mb)} MB`);

function fmtDur(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.round((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "0m";
}
