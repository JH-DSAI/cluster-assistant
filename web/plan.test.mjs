// node --test web/plan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "./parse.js";
import {
  fitPriorityModel,
  priorityModel,
  effectiveRequest,
  jobBilling,
  memoryWaste,
  placement,
  scorableRows,
  jobSizeScore,
  ageScore,
  estimatePriority,
  rankIn,
  overtakeSeconds,
  jobCost,
  accountHeadroom,
  feasibility,
  sbatchPreamble,
  timeSpec,
  toRequest,
  arrayTasks,
  preambleDefaults,
  PREAMBLE_OPTIONS,
} from "./plan.js";

const NOW = new Date("2026-07-30T12:00:00");

// A cluster of 100 nodes x 100 cores, so the job-size arithmetic is checkable by
// hand: weight 5000 gives 25 per node and 0.25 per core.
const SINFO = [
  "PARTITION|AVAIL|TIMELIMIT|NODES|STATE|NODELIST|CPUS(A/I/O/T)|GRES|MEMORY|REASON",
  "gpu*|up|3-00:00:00|50|mixed|g[01-50]|2000/3000/0/5000|gpu:a100:8|512000|none",
  "cpu|up|1-00:00:00|50|idle|c[01-50]|0/5000/0/5000|(null)|256000|none",
].join("\n");

const SSHARE = [
  "Account|User|RawShares|NormShares|RawUsage|NormUsage|EffectvUsage|FairShare|LevelFS|GrpTRESMins|TRESRunMins",
  " lab||50000|0.01|100||0.0||0.0|cpu=1000000,gres/gpu=50000|cpu=400000,gres/gpu=20000",
  " poor||50000|0.01|100||0.0||0.0|cpu=1000|cpu=900",
].join("\n");

const QOS = ["normal|0||gres/gpu=18|gres/gpu=18|", "small|0||gres/gpu=2|cpu=64|"].join("\n");
const ASSOC = ["lab||normal,small|||", "poor||normal|||"].join("\n");

// sprio rows are generated from the true model, so the fit has something exact
// to recover: jobsize = 2500 x (nodes/100 + cpus/10000), age = 5000 x wait/7d.
const AGE_MAX = 604800;
const trueJobSize = (nodes, cpus) => Math.floor(2500 * (nodes / 100 + cpus / 10000));

// SLURM's stamps carry no timezone and parse.js reads them as local time, so a
// fixture built with toISOString() would shift every wait by the UTC offset.
const localStamp = (d) => {
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
};

function fixture() {
  const squeue = ["JOBID|PARTITION|USER|ACCOUNT|NAME|STATE|TIME|TIME_LEFT|NODES|CPUS|TRES_PER_NODE|MIN_MEMORY|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS"];
  const sprio = ["JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES"];
  // A spread of sizes and waits, all obeying the model exactly.
  const jobs = [
    [1, 1, 8, 6 * 86400],
    [2, 1, 16, 5 * 86400],
    [3, 1, 32, 4 * 86400],
    [4, 2, 64, 3 * 86400],
    [5, 1, 100, 2 * 86400],
    [6, 4, 200, 86400],
    [7, 1, 4, 43200],
    [8, 2, 48, 21600],
    [9, 1, 128, 3600],
    [10, 8, 400, 7200],
  ];
  for (const [id, nodes, cpus, wait] of jobs) {
    const js = trueJobSize(nodes, cpus);
    const norm = wait / AGE_MAX;
    const age = Math.round(5000 * norm);
    const submit = localStamp(new Date(+NOW - wait * 1000));
    squeue.push(
      [id, "gpu", `u${id}`, "lab", `j${id}`, "PENDING", "0:00", "1-00:00:00", nodes, cpus,
       "gres/gpu:2", "64G", js + age, submit, "N/A", "(Priority)", "normal"].join("|"),
    );
    sprio.push([id, "gpu", `u${id}`, norm.toFixed(7), js + age, 0, age, 0, 0, js, 0, 0, 0, "normal", ""].join("|"));
  }
  return buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: squeue.join("\n"),
    sprioText: sprio.join("\n"),
    sshareText: SSHARE,
    sacctQosText: QOS,
    sacctAssocText: ASSOC,
  });
}

const model = fixture();
const pm = fitPriorityModel(model);
const gpu = () => model.partitions.find((p) => p.name === "gpu");

test("buildModel records what a single node in the partition holds", () => {
  assert.deepEqual(gpu().perNode, { cpus: 100, gpus: 8, memoryMB: 512000 });
  const cpu = model.partitions.find((p) => p.name === "cpu");
  assert.deepEqual(cpu.perNode, { cpus: 100, gpus: 0, memoryMB: 256000 });
});

test("fitPriorityModel recovers the weights from the dumps alone", () => {
  assert.equal(pm.ageWeight, 5000);
  assert.equal(pm.ageMax, AGE_MAX);
  assert.equal(pm.jobSizeWeight, 5000);
  assert.equal(pm.cpuCount, 10000);
  assert.equal(pm.nodeCount, 100);
  assert.equal(pm.agreement, 1); // every fitted row reproduced exactly
  assert.deepEqual(pm.measured, { ageWeight: true, ageMax: true, jobSize: true });
  // 1, 2, 4 and 8-node jobs are in the fixture, so the split is real.
  assert.equal(pm.nodeSplitIdentifiable, true);
  assert.equal(pm.perNodePoints, 25);
  assert.equal(pm.perCpuPoints, 0.25);
});

test("fitPriorityModel admits when the node and CPU terms cannot be separated", () => {
  // A queue of nothing but single-node jobs pins down the sum of the two terms
  // and nothing else, so the weight must not be presented as measured on its own.
  const squeue = ["JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS"];
  const sprio = ["JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES"];
  for (const [id, cpus] of [[1,8],[2,64],[3,200],[4,400],[5,1000],[6,2000],[7,16],[8,32],[9,120],[10,500]]) {
    const js = trueJobSize(1, cpus);
    squeue.push([id, "gpu", `u${id}`, "lab", "PENDING", 1, cpus, js, "2026-07-30T11:00:00", "N/A", "(Priority)", "normal"].join("|"));
    sprio.push([id, "gpu", `u${id}`, "0", js, 0, 0, 0, 0, js, 0, 0, 0, "normal", ""].join("|"));
  }
  const fit = fitPriorityModel(
    buildModel({ now: NOW, sinfoText: SINFO, squeueText: squeue.join("\n"), sprioText: sprio.join("\n"), sshareText: SSHARE }),
  );
  assert.equal(fit.distinctNodeCounts, 1);
  assert.equal(fit.nodeSplitIdentifiable, false);
  assert.equal(fit.agreement, 1); // it still reproduces every row it was given
  // Whatever pair it settled on, the per-CPU coefficient — the identifiable
  // half — has to be right, because that is what a one-node estimate turns on.
  assert.ok(Math.abs(fit.perCpuPoints - 0.25) < 0.005);
});

test("fitPriorityModel finds a node count sinfo does not list", () => {
  // A hidden or FUTURE node is in slurm.conf's node_record_count but not in the
  // dump, which shifts the job-size intercept. The fit has to follow the data.
  const hidden = 104;
  const squeue = ["JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS"];
  const sprio = ["JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES"];
  // A wide spread of node counts is what pins the intercept down: with only
  // one- and two-node jobs, flooring leaves 103 and 104 indistinguishable.
  for (const [id, nodes, cpus] of [[1,1,8],[2,1,64],[3,1,200],[4,2,400],[5,1,1000],[6,3,2000],[7,1,16],[8,25,100],[9,2,120],[10,50,500]]) {
    const js = Math.floor(2500 * (nodes / hidden + cpus / 10000));
    squeue.push([id, "gpu", `u${id}`, "lab", "PENDING", nodes, cpus, js, "2026-07-30T11:00:00", "N/A", "(Priority)", "normal"].join("|"));
    sprio.push([id, "gpu", `u${id}`, "0", js, 0, 0, 0, 0, js, 0, 0, 0, "normal", ""].join("|"));
  }
  const m = buildModel({ now: NOW, sinfoText: SINFO, squeueText: squeue.join("\n"), sprioText: sprio.join("\n"), sshareText: SSHARE });
  const fit = fitPriorityModel(m);
  assert.equal(fit.nodeCount, hidden);
  assert.equal(fit.sinfoNodes, 100);
  assert.equal(fit.agreement, 1);
});

test("fitPriorityModel breaks an undecidable node count towards sinfo's own count", () => {
  // Every job one node: 103 and 104 then reproduce the queue equally well, and
  // guessing the larger would be inventing a node the dump never mentioned.
  const squeue = ["JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS"];
  const sprio = ["JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES"];
  for (const [id, cpus] of [[1,8],[2,64],[3,200],[4,400],[5,1000],[6,2000],[7,16],[8,32],[9,120],[10,500]]) {
    const js = Math.floor(2500 * (1 / 104 + cpus / 10000));
    squeue.push([id, "gpu", `u${id}`, "lab", "PENDING", 1, cpus, js, "2026-07-30T11:00:00", "N/A", "(Priority)", "normal"].join("|"));
    sprio.push([id, "gpu", `u${id}`, "0", js, 0, 0, 0, 0, js, 0, 0, 0, "normal", ""].join("|"));
  }
  const m = buildModel({ now: NOW, sinfoText: SINFO, squeueText: squeue.join("\n"), sprioText: sprio.join("\n"), sshareText: SSHARE });
  const fit = fitPriorityModel(m);
  assert.equal(fit.agreement, 1);
  // Several counts fit these rows equally exactly; the fit takes the one nearest
  // sinfo's 100 rather than the largest, but still moves off 100, which does not
  // fit. Only a spread of node counts in the queue can pin the true 104 down.
  assert.equal(fit.nodeCount, 101);
  assert.ok(fit.nodeCount > fit.sinfoNodes);
});

test("fitPriorityModel falls back rather than fitting noise", () => {
  const m = buildModel({ now: NOW, sinfoText: SINFO, squeueText: "", sprioText: "", sshareText: SSHARE });
  const fit = fitPriorityModel(m);
  assert.deepEqual(fit.measured, { ageWeight: false, ageMax: false, jobSize: false });
  assert.equal(fit.samples, 0);
  assert.equal(fit.agreement, 0);
});

test("jobSizeScore and ageScore follow SLURM's formulas", () => {
  assert.equal(jobSizeScore(1, 0, pm), 25); // 2500/100
  assert.equal(jobSizeScore(0, 100, pm), 25); // 2500 x 100/10000
  assert.equal(jobSizeScore(2, 200, pm), 100);
  assert.equal(ageScore(0, pm), 0);
  assert.equal(ageScore(AGE_MAX / 2, pm), 2500);
  assert.equal(ageScore(AGE_MAX * 10, pm), 5000); // capped
  assert.equal(ageScore(-5, pm), 0);
});

test("estimatePriority scores a fresh job with no age at all", () => {
  const req = toRequest({ partition: "gpu", account: "lab", qos: "normal", nodes: 2, ntasksPerNode: 1, cpusPerTask: 50, gpusPerNode: 2, memValue: 64, memUnit: "G", memPer: "node", days: 1 });
  const est = estimatePriority(req, gpu(), pm);
  assert.equal(req.cpus, 100);
  assert.equal(est.jobsize, 2500 * (2 / 100 + 100 / 10000)); // 75
  assert.equal(est.base, 75); // no other factor is in use on this cluster
  assert.equal(est.start, 75);
  assert.equal(est.atCap, 75 + 5000);
  assert.equal(est.peers, gpu().queue.length); // matched on account and QOS
  assert.match(est.scope, /this account and QOS/);
});

test("estimatePriority reads the account factors off jobs already queued", () => {
  // A cluster where fair-share is switched on: the new job inherits the value
  // its account's other jobs are getting rather than a guess.
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      "1|gpu|u1|lab|PENDING|1|100|1350|2026-07-30T11:00:00|N/A|(Priority)|normal",
      "2|gpu|u2|other|PENDING|1|100|9350|2026-07-30T11:00:00|N/A|(Priority)|normal",
    ].join("\n"),
    sprioText: [
      "JOBID|PARTITION|USER|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES",
      "1|gpu|u1|1350|0|0|0|1300|50|0|0|0|normal|",
      "2|gpu|u2|9350|0|0|0|9300|50|0|0|0|normal|",
    ].join("\n"),
    sshareText: SSHARE,
  });
  const fit = fitPriorityModel(m);
  const req = toRequest({ partition: "gpu", account: "lab", qos: "normal", nodes: 1, ntasksPerNode: 1, cpusPerTask: 100, days: 1 });
  const est = estimatePriority(req, m.partitions.find((p) => p.name === "gpu"), fit);
  assert.equal(est.other.fairshare, 1300); // lab's, not other's 9300
  assert.equal(est.peers, 1);
  assert.equal(est.base, est.jobsize + 1300);
});

test("rankIn places the job in the queue as it stands", () => {
  const top = gpu().queue[0].priority;
  assert.equal(rankIn(gpu(), top + 1).rank, 1);
  assert.equal(rankIn(gpu(), top + 1).ahead, 0);
  const bottom = gpu().queue.at(-1).priority;
  assert.equal(rankIn(gpu(), bottom - 1).rank, gpu().queue.length + 1);
  assert.equal(rankIn(gpu(), bottom - 1).total, gpu().queue.length);
  assert.equal(rankIn(null, 100).rank, 1); // no partition data: nothing ahead
});

test("overtakeSeconds refuses to promise what aging cannot deliver", () => {
  // A job ahead on more than age can never be passed by waiting, because both
  // jobs' age factors grow at the same rate.
  const rich = { priority: 3000, factors: { age: 1000 } }; // base 2000
  assert.equal(overtakeSeconds(50, rich, pm), null);

  // Ahead on age alone: the new job has to climb almost the whole cap, because
  // it only gains ground on a rival that has already stopped growing.
  const old = { priority: 4030, factors: { age: 4000 } }; // base 30
  assert.equal(overtakeSeconds(50, old, pm), AGE_MAX * (1 - 20 / 5000));

  // A narrower base gap takes correspondingly longer.
  const nearlyEqual = { priority: 5045, factors: { age: 5000 } }; // capped, base 45
  assert.equal(overtakeSeconds(50, nearlyEqual, pm), AGE_MAX * (1 - 5 / 5000));

  // Ties do not count as overtaking.
  assert.equal(overtakeSeconds(50, { priority: 5050, factors: { age: 5000 } }, pm), null);

  // A base gap wider than the whole age weight means it is already ahead.
  assert.equal(overtakeSeconds(9000, old, pm), 0);
});

test("jobCost reports the TRES-minutes an account is charged for", () => {
  const req = toRequest({ nodes: 2, ntasksPerNode: 4, cpusPerTask: 8, gpusPerNode: 4, memValue: 100, memUnit: "G", memPer: "node", days: 1, hours: 12 });
  assert.equal(req.cpus, 64); // 2 x 4 x 8
  assert.equal(req.gpus, 8);
  assert.equal(req.minutes, 36 * 60);
  const c = jobCost(req);
  assert.equal(c.cpuMinutes, 64 * 2160);
  assert.equal(c.gpuMinutes, 8 * 2160);
  assert.equal(c.nodeMinutes, 2 * 2160);
  assert.equal(c.cpuHours, 64 * 36);
  assert.equal(c.gpuHours, 8 * 36);
  assert.equal(c.memGBMinutes, 200 * 2160); // 100G per node x 2 nodes
});

test("per-CPU memory is scaled by the ALLOCATED cores, not the requested ones", () => {
  // toRequest carries --mem-per-cpu through as a rate, because the core count it
  // multiplies is not known until the partition's rules have run.
  const perCpu = toRequest({ nodes: 2, ntasksPerNode: 2, cpusPerTask: 8, memValue: 4, memUnit: "G", memPer: "cpu", hours: 1 });
  assert.equal(perCpu.memPerCpuMB, 4096);
  const perNode = toRequest({ nodes: 2, ntasksPerNode: 2, cpusPerTask: 8, memValue: 4, memUnit: "G", memPer: "node", hours: 1 });
  assert.equal(perNode.memPerNodeMB, 4096);
  assert.equal(perNode.memPerCpuMB, 0);

  // effectiveRequest resolves it, against 16 cores per node.
  const plain = effectiveRequest(perCpu, null);
  assert.equal(plain.memPerNodeMB, 16 * 4096);
  assert.equal(plain.memMB, 2 * 16 * 4096);
});

test("accountHeadroom subtracts what is already committed", () => {
  const req = toRequest({ account: "lab", nodes: 1, ntasksPerNode: 1, cpusPerTask: 100, gpusPerNode: 8, days: 1 });
  const head = accountHeadroom(model, "lab", jobCost(req));
  const cpu = head.rows.find((r) => r.label === "CPU-minutes");
  assert.equal(cpu.limit, 1000000);
  assert.equal(cpu.used, 400000); // TRESRunMins
  assert.equal(cpu.want, 100 * 1440);
  assert.equal(accountHeadroom(model, "nosuchaccount", jobCost(req)), null);
});

test("feasibility catches a request no node can satisfy", () => {
  const req = toRequest({ partition: "gpu", account: "lab", qos: "normal", nodes: 1, ntasksPerNode: 1, cpusPerTask: 200, gpusPerNode: 16, memValue: 900, memUnit: "G", memPer: "node", days: 5 });
  const bad = feasibility(req, gpu(), model, pm).filter((c) => c.level === "bad");
  const labels = bad.map((c) => c.label);
  assert.ok(labels.includes("Walltime"), "5 days exceeds the 3-day limit");
  assert.ok(labels.includes("CPUs per node"), "200 cores on a 100-core node");
  assert.ok(labels.includes("GPUs per node"), "16 GPUs on an 8-GPU node");
  assert.ok(labels.includes("Memory"), "900G on a 500G node");
});

test("feasibility passes a request the partition can hold", () => {
  const req = toRequest({ partition: "gpu", account: "lab", qos: "normal", nodes: 1, ntasksPerNode: 1, cpusPerTask: 64, gpusPerNode: 4, memValue: 256, memUnit: "G", memPer: "node", days: 1 });
  const checks = feasibility(req, gpu(), model, pm);
  assert.equal(checks.filter((c) => c.level === "bad").length, 0);
  // 3000 cores idle and 400 - 100 running GPUs free, so it could start now.
  assert.equal(checks.find((c) => c.label === "Free now").level, "ok");
});

test("feasibility says a QOS cap the job breaches on its own is a hard stop", () => {
  const req = toRequest({ partition: "gpu", account: "lab", qos: "small", nodes: 1, ntasksPerNode: 1, cpusPerTask: 8, gpusPerNode: 4, days: 1 });
  const bad = feasibility(req, gpu(), model, pm).filter((c) => c.level === "bad");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].label, "QOS GPUs");
  assert.match(bad[0].text, /allows 2 GPUs per user/);
});

test("feasibility warns rather than fails when the cluster is merely busy", () => {
  // Legal at every per-node limit and under no QOS, but far more than is free.
  const req = toRequest({ partition: "gpu", account: "lab", qos: "", nodes: 40, ntasksPerNode: 1, cpusPerTask: 100, gpusPerNode: 8, days: 1 });
  const checks = feasibility(req, gpu(), model, pm);
  assert.equal(checks.filter((c) => c.level === "bad").length, 0); // 40 of 50 nodes is legal
  assert.equal(checks.find((c) => c.label === "Free now").level, "warn");
});

test("feasibility reports a partition that is not in sinfo", () => {
  const checks = feasibility(toRequest({ partition: "ghost", days: 1 }), null, model, pm);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, "bad");
  assert.match(checks[0].text, /not in sinfo/);
  // With no dump at all there is no name to report, and saying "  is not in
  // sinfo.txt" would read as a bug rather than as missing data.
  const none = feasibility(toRequest({ partition: "", days: 1 }), null, model, pm);
  assert.match(none[0].text, /named none/);
});

test("timeSpec writes the form sbatch documents", () => {
  assert.equal(timeSpec({ days: 0, hours: 2, minutes: 30 }), "02:30:00");
  assert.equal(timeSpec({ days: 3, hours: 0, minutes: 0 }), "3-00:00:00");
  assert.equal(timeSpec({ days: 1, hours: 6, minutes: 5 }), "1-06:05:00");
  assert.equal(timeSpec({}), "00:00:00");
});

test("sbatchPreamble emits only the directives that were set", () => {
  const lines = sbatchPreamble({
    jobName: "train", partition: "gpu", account: "lab", qos: "normal",
    nodes: 1, ntasksPerNode: 1, cpusPerTask: 8, gpusPerNode: 2, gpuModel: "a100",
    memValue: 64, memUnit: "G", memPer: "node", days: 1, hours: 0, minutes: 0,
    output: "logs/%x-%j.out", error: "", mailType: "", constraint: "",
    exclusive: false, requeue: false, array: "",
  });
  assert.deepEqual(lines, [
    "#SBATCH --job-name=train",
    "#SBATCH --partition=gpu",
    "#SBATCH --account=lab",
    "#SBATCH --qos=normal",
    "#SBATCH --nodes=1",
    "#SBATCH --ntasks-per-node=1",
    "#SBATCH --cpus-per-task=8",
    "#SBATCH --gpus-per-node=a100:2",
    "#SBATCH --mem=64G",
    "#SBATCH --time=1-00:00:00",
    "#SBATCH --output=logs/%x-%j.out",
  ]);
});

test("sbatchPreamble uses mem-per-cpu when that is what was chosen", () => {
  const lines = sbatchPreamble({ memValue: 4, memUnit: "G", memPer: "cpu", days: 0, hours: 1, minutes: 0 });
  assert.ok(lines.includes("#SBATCH --mem-per-cpu=4G"));
  assert.ok(!lines.some((l) => l.startsWith("#SBATCH --mem=")));
});

test("sbatchPreamble omits GPUs and mail when they are not asked for", () => {
  const lines = sbatchPreamble({ gpusPerNode: 0, memValue: 0, mailType: "", mailUser: "me@x.edu", days: 0, hours: 1, minutes: 0 });
  assert.ok(!lines.some((l) => l.includes("gpus-per-node")));
  assert.ok(!lines.some((l) => l.includes("mem")));
  assert.ok(!lines.some((l) => l.includes("mail-user")), "no mail-user without a mail-type");
});

test("sbatchPreamble writes the bare flags without a value", () => {
  const lines = sbatchPreamble({ exclusive: true, requeue: true, days: 0, hours: 1, minutes: 0, array: "0-9%4" });
  assert.ok(lines.includes("#SBATCH --exclusive"));
  assert.ok(lines.includes("#SBATCH --requeue"));
  assert.ok(lines.includes("#SBATCH --array=0-9%4"));
});

test("arrayTasks counts what an array spec expands to", () => {
  assert.equal(arrayTasks(""), 1);
  assert.equal(arrayTasks("0-9"), 10);
  assert.equal(arrayTasks("0-9%4"), 10); // %4 throttles, it does not shrink
  assert.equal(arrayTasks("1,3,5"), 3);
  assert.equal(arrayTasks("0-10:2"), 6);
  assert.equal(arrayTasks("0-3,7"), 5);
});

test("toRequest multiplies the cost by the array size", () => {
  const req = toRequest({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 8, array: "0-9", hours: 2 });
  assert.equal(req.tasks, 10);
  assert.equal(req.cpus, 8); // per task, not for the array
  assert.equal(jobCost({ ...req, minutes: req.minutes * req.tasks }).cpuHours, 8 * 20);
});

// ---------------------------------------------------------------- scontrol

// gpu: 8 GPUs and 100 cores per node, DefCpuPerGPU=6, MaxMemPerCPU=8000 MB.
const SC_PART = [
  "PartitionName=gpu AllowGroups=ALL AllowAccounts=ALL AllowQos=ALL Default=YES QoS=N/A DefaultTime=04:00:00 Hidden=NO MaxNodes=4 MaxTime=3-00:00:00 MinNodes=0 MaxCPUsPerNode=96 Nodes=g[01-50] State=UP TotalCPUs=5000 TotalNodes=50 JobDefaults=DefCpuPerGPU=6 DefMemPerCPU=8000 MaxMemPerCPU=8000 TRES=cpu=4800,mem=25600000M,node=50,billing=6250,gres/gpu=400 TRESBillingWeights=CPU=1,Mem=0.25G,GRES/gpu=2",
  "PartitionName=cpu AllowGroups=ALL AllowAccounts=lab AllowQos=small Default=NO QoS=small DefaultTime=12:00:00 Hidden=NO MaxNodes=2 MaxTime=1-00:00:00 MinNodes=0 MaxCPUsPerNode=100 Nodes=c[01-50] State=DOWN TotalCPUs=5000 TotalNodes=50 JobDefaults=(null) DefMemPerCPU=4000 MaxMemPerCPU=4000 TRES=cpu=5000,mem=12800000M,node=50,billing=5000 TRESBillingWeights=CPU=1,Mem=0.25G",
].join("\n");

const SC_CONFIG = [
  "PriorityFavorSmall      = no",
  "PriorityFlags           = CALCULATE_RUNNING,MAX_TRES",
  "PriorityMaxAge          = 7-00:00:00",
  "PriorityWeightAge       = 5000",
  "PriorityWeightFairShare = 20000",
  "PriorityWeightJobSize   = 5000",
  "MaxArraySize            = 1000",
].join("\n");

// One `scontrol show job` record, in the shape SLURM prints it.
const jobRecord = ({ id, state = "PENDING", nodes = 1, cpus = 4, gpus = 0, mem = "64G", part = "gpu", cpt = null, accrue = "2026-07-30T11:00:00", dep = "(null)" }) =>
  [
    `JobId=${id} JobName=j${id}`,
    `   UserId=u${id}(1001) GroupId=g(1001) MCS_label=N/A`,
    `   Priority=100 Nice=0 Account=lab QOS=normal`,
    `   JobState=${state} Reason=None Dependency=${dep}`,
    `   RunTime=00:00:00 TimeLimit=1-00:00:00 TimeMin=N/A`,
    `   SubmitTime=2026-07-30T10:00:00 EligibleTime=2026-07-30T10:00:00`,
    `   AccrueTime=${accrue}`,
    `   StartTime=Unknown EndTime=Unknown Deadline=N/A`,
    `   Partition=${part} AllocNode:Sid=login01:1`,
    `   NodeList=`,
    `   NumNodes=${nodes} NumCPUs=${cpus} NumTasks=1 CPUs/Task=${cpt ?? cpus} ReqB:S:C:T=0:0:*:*`,
    `   ReqTRES=cpu=${cpus},mem=${mem},node=${nodes},billing=${cpus}${gpus ? `,gres/gpu=${gpus}` : ""}`,
    `   AllocTRES=${state === "RUNNING" ? `cpu=${cpus},mem=${mem},node=${nodes},billing=${cpus}` : "(null)"}`,
    `   MinCPUsNode=${cpus} MinMemoryNode=${mem} MinTmpDiskNode=0`,
    `   Features=(null) DelayBoot=00:00:00`,
    `   Command=/tmp/x.sh`,
    `   WorkDir=/home/u${id}`,
    ...(gpus ? [`   TresPerNode=gres/gpu:${gpus}`] : []),
    ...(cpt !== null ? [`   TresPerTask=cpu=${cpt}`] : []),
  ].join("\n");

const withScontrol = (extra = {}) =>
  buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: "",
    sprioText: "",
    sshareText: SSHARE,
    sacctQosText: QOS,
    sacctAssocText: ASSOC,
    scontrolConfigText: SC_CONFIG,
    scontrolPartitionText: SC_PART,
    ...extra,
  });

test("priorityModel reads the weights from the config instead of fitting them", () => {
  const m = fixture();
  const withCfg = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: "",
    sprioText: "",
    sshareText: SSHARE,
    scontrolConfigText: SC_CONFIG,
  });
  const pm = priorityModel(withCfg);
  assert.equal(pm.source, "config");
  assert.equal(pm.ageWeight, 5000);
  assert.equal(pm.ageMax, 7 * 86400);
  assert.equal(pm.jobSizeWeight, 5000);
  assert.deepEqual(pm.measured, { ageWeight: true, ageMax: true, jobSize: true });
  // Without the config it falls back to the fit, unchanged.
  assert.equal(priorityModel(m).source, "fit");
});

test("priorityModel still fits the node count, which no dump reports", () => {
  // The weights are known, so only node_record_count is left — and here the true
  // value is 105 while the dumps only account for 100.
  const squeue = ["JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS"];
  const sprio = ["JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES"];
  for (const [id, nodes, cpus] of [[1,1,8],[2,1,64],[3,1,200],[4,2,400],[5,1,1000],[6,3,2000],[7,1,16],[8,25,100],[9,2,120],[10,50,500]]) {
    const js = Math.floor(2500 * (nodes / 105 + cpus / 10000));
    squeue.push([id, "gpu", `u${id}`, "lab", "PENDING", nodes, cpus, js, "2026-07-30T11:00:00", "N/A", "(Priority)", "normal"].join("|"));
    sprio.push([id, "gpu", `u${id}`, "0", js, 0, 0, 0, 0, js, 0, 0, 0, "normal", ""].join("|"));
  }
  const pm = priorityModel(
    buildModel({ now: NOW, sinfoText: SINFO, squeueText: squeue.join("\n"), sprioText: sprio.join("\n"),
                 sshareText: SSHARE, scontrolConfigText: SC_CONFIG }),
  );
  assert.equal(pm.source, "config");
  assert.equal(pm.nodeCount, 105);
  assert.equal(pm.sinfoNodes, 100);
  assert.equal(pm.agreement, 1);
});

test("scorableRows uses the running jobs, whose CPU count scontrol settles", () => {
  // sprio lists running jobs too (PriorityFlags=CALCULATE_RUNNING). For those,
  // NumCPUs is the count SLURM allocated and costed the factor against. For a
  // pending job it is only the request, so those rows cannot be scored.
  const m = withScontrol({
    scontrolJobText: [
      jobRecord({ id: 1, state: "RUNNING", nodes: 1, cpus: 48 }),
      jobRecord({ id: 2, state: "RUNNING", nodes: 2, cpus: 96 }),
      jobRecord({ id: 3, state: "PENDING", nodes: 1, cpus: 4 }),
    ].join("\n\n"),
    sprioText: [
      "JOBID|PARTITION|USER|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES",
      "1|gpu|u1|100|0|0|0|0|37|0|0|0|normal|",
      "2|gpu|u2|100|0|0|0|0|74|0|0|0|normal|",
      "3|gpu|u3|100|0|0|0|0|31|0|0|0|normal|",
    ].join("\n"),
  });
  const rows = scorableRows(m);
  assert.deepEqual(rows.map((r) => r.jobid), ["1", "2"]);
  assert.equal(rows[0].cpus, 48); // NumCPUs, not the squeue request
  assert.equal(m.factorSamples.length, 3);
  assert.equal(m.factorSamples.filter((s) => s.authoritative).length, 2);
});

test("effectiveRequest raises the core count the way the partition will", () => {
  const m = withScontrol();
  const gpu = m.partitions.find((p) => p.name === "gpu");

  // DefCpuPerGPU is a *default*: an explicit --cpus-per-task overrides it, and
  // the preamble this page writes always sets one. So 2 GPUs at DefCpuPerGPU=6
  // does NOT become 12 cores — it stays at the 4 asked for, and the rule is
  // reported as an advisory rather than applied. Applying it regardless was
  // wrong for 49 of 1066 real running jobs.
  const byGpu = effectiveRequest(
    toRequest({ partition: "gpu", nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, gpusPerNode: 2, memValue: 8, memUnit: "G", memPer: "node", hours: 1 }),
    gpu,
  );
  assert.equal(byGpu.requested.cpus, 4);
  assert.equal(byGpu.cpus, 4);
  assert.deepEqual(byGpu.applied, []);
  assert.equal(byGpu.adjustments.length, 1);
  assert.equal(byGpu.adjustments[0].rule, "DefCpuPerGPU");
  assert.equal(byGpu.adjustments[0].advisory, true);
  assert.match(byGpu.adjustments[0].text, /deleting that line/);

  // With --cpus-per-task genuinely unset, the default does apply.
  const noCpt = effectiveRequest(
    { ...toRequest({ partition: "gpu", nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, gpusPerNode: 2, memValue: 8, memUnit: "G", memPer: "node", hours: 1 }), explicitCpusPerTask: false },
    gpu,
  );
  assert.equal(noCpt.cpus, 12);
  assert.deepEqual(noCpt.applied.map((a) => a.rule), ["DefCpuPerGPU"]);

  // 400 GB at MaxMemPerCPU=8000 MB needs 50 cores, and memory wins over GPUs.
  const byMem = effectiveRequest(
    toRequest({ partition: "gpu", nodes: 2, ntasksPerNode: 1, cpusPerTask: 4, gpusPerNode: 1, memValue: 400, memUnit: "G", memPer: "node", hours: 1 }),
    gpu,
  );
  assert.equal(byMem.cpusPerNode, 52); // ceil(409600 / 8000)
  assert.equal(byMem.cpus, 104); // that many per node, across both nodes
  // MaxMemPerCPU applies whatever --cpus-per-task says; it is the rule that
  // binds for the overwhelming majority of real jobs.
  assert.deepEqual(byMem.applied.map((a) => a.rule), ["MaxMemPerCPU"]);

  // Asking for enough of both leaves the request alone.
  const asIs = effectiveRequest(
    toRequest({ partition: "gpu", nodes: 1, ntasksPerNode: 1, cpusPerTask: 64, gpusPerNode: 2, memValue: 64, memUnit: "G", memPer: "node", hours: 1 }),
    gpu,
  );
  assert.equal(asIs.cpus, 64);
  assert.deepEqual(asIs.adjustments, []);

  // No memory asked for means DefMemPerCPU fills it in.
  const noMem = effectiveRequest(
    toRequest({ partition: "gpu", nodes: 1, ntasksPerNode: 1, cpusPerTask: 10, gpusPerNode: 0, memValue: 0, hours: 1 }),
    gpu,
  );
  assert.equal(noMem.memPerNodeMB, 10 * 8000);
  assert.deepEqual(noMem.adjustments.map((a) => a.rule), ["DefMemPerCPU"]);

  // With no scontrol dump there is nothing to apply and nothing changes.
  const bare = effectiveRequest(toRequest({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, gpusPerNode: 8, hours: 1 }), null);
  assert.equal(bare.cpus, 4);
  assert.deepEqual(bare.adjustments, []);
});

test("jobBilling charges the largest weighted resource under MAX_TRES", () => {
  const m = withScontrol();
  const gpu = m.partitions.find((p) => p.name === "gpu");
  // 20 cores x1, 400 GB x0.25 = 100, 2 GPUs x2 = 4 -> memory is the largest.
  const req = toRequest({ partition: "gpu", nodes: 2, ntasksPerNode: 1, cpusPerTask: 20, gpusPerNode: 2, memValue: 400, memUnit: "G", memPer: "node", hours: 1 });
  const b = jobBilling(req, gpu, m.config);
  assert.equal(b.max, true);
  assert.equal(b.perNode, 100);
  assert.equal(b.total, 200); // two nodes
  assert.equal(b.minutes, 200 * 60);
  assert.equal(b.driver.label, "Memory");

  // Without MAX_TRES the same request is billed for the sum instead.
  const summed = jobBilling(req, gpu, { maxTres: false });
  assert.equal(summed.perNode, 20 + 100 + 4);
  assert.equal(summed.driver, null);

  // Cores can win when memory is small.
  const cpuHeavy = toRequest({ partition: "gpu", nodes: 1, ntasksPerNode: 1, cpusPerTask: 90, gpusPerNode: 0, memValue: 8, memUnit: "G", memPer: "node", hours: 1 });
  assert.equal(jobBilling(cpuHeavy, gpu, m.config).driver.label, "CPUs");

  // No weights, no answer — rather than a made-up one.
  assert.equal(jobBilling(req, m.partitions.find((p) => p.name === "nvl"), m.config), null);
});

test("jobBilling reproduces the billing figure scontrol reports for the partition", () => {
  // The strongest available check on the formula: bill the partition's own TRES
  // and the answer has to match its own billing= value.
  const m = withScontrol();
  for (const p of m.partitions.filter((x) => x.info?.billingWeights.size)) {
    const i = p.info;
    const whole = {
      cpusPerNode: i.tres.get("cpu") / i.totalNodes,
      memPerNodeMB: i.tres.get("mem") / i.totalNodes,
      gpusPerNode: (i.tres.get("gres/gpu") ?? 0) / i.totalNodes,
      nodes: i.totalNodes,
      minutes: 1,
      gpuModel: null,
    };
    const b = jobBilling(whole, p, m.config);
    assert.ok(
      Math.abs(b.total - i.tres.get("billing")) <= 1,
      `${p.name}: computed ${b.total}, scontrol says ${i.tres.get("billing")}`,
    );
  }
});

test("feasibility enforces the limits only scontrol reports", () => {
  const m = withScontrol();
  const gpu = m.partitions.find((p) => p.name === "gpu");
  const check = (f) => {
    const req = effectiveRequest(toRequest({ partition: "gpu", account: "lab", qos: "", ...f }), gpu);
    return feasibility(req, gpu, m, priorityModel(m));
  };
  const bad = (f) => check(f).filter((c) => c.level === "bad").map((c) => c.label);

  // MaxNodes=4, well below the 50 nodes the partition has.
  assert.ok(bad({ nodes: 6, ntasksPerNode: 1, cpusPerTask: 4, days: 1 }).includes("Nodes"));
  assert.ok(!bad({ nodes: 4, ntasksPerNode: 1, cpusPerTask: 4, days: 1 }).includes("Nodes"));
  // MaxCPUsPerNode=96, below the 100 cores a node actually has.
  assert.ok(bad({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 98, days: 1 }).includes("CPUs per node"));
  // MaxTime=3 days.
  assert.ok(bad({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, days: 4 }).includes("Walltime"));
  // A memory request whose forced core count breaks MaxCPUsPerNode.
  assert.ok(bad({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 1, memValue: 800, memUnit: "G", memPer: "node", days: 1 }).includes("CPUs per node"));

  // DefCpuPerGPU did not move anything, so it is a note, not an adjustment.
  const c = check({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, gpusPerNode: 2, days: 1 });
  assert.equal(c.find((x) => x.label === "DefCpuPerGPU")?.level, "note");
  // MaxMemPerCPU does move it, and that is reported as an adjustment.
  const c2 = check({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 1, memValue: 64, memUnit: "G", memPer: "node", days: 1 });
  assert.equal(c2.find((x) => x.label === "MaxMemPerCPU")?.level, "info");
});

test("feasibility rejects a partition that will not take the account or QOS", () => {
  const m = withScontrol();
  const cpu = m.partitions.find((p) => p.name === "cpu");
  const req = effectiveRequest(
    toRequest({ partition: "cpu", account: "poor", qos: "normal", nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, hours: 1 }),
    cpu,
  );
  const labels = feasibility(req, cpu, m, priorityModel(m)).filter((c) => c.level === "bad").map((c) => c.label);
  assert.ok(labels.includes("Account"), "AllowAccounts=lab excludes poor");
  assert.ok(labels.includes("QOS allowed"), "AllowQos=small excludes normal");
  assert.ok(labels.includes("Partition"), "State=DOWN");
});

test("feasibility applies the QOS the partition attaches, not just the job's", () => {
  // The cpu partition attaches QOS "small", which caps GPUs at 2 per user — the
  // job carries no QOS of its own, so this cap is only visible via scontrol.
  const m = withScontrol();
  const cpu = m.partitions.find((p) => p.name === "cpu");
  const req = effectiveRequest(
    toRequest({ partition: "cpu", account: "lab", qos: "", nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, gpusPerNode: 8, hours: 1 }),
    cpu,
  );
  const gpuCap = feasibility(req, cpu, m, priorityModel(m)).find((c) => c.label === "QOS GPUs");
  assert.equal(gpuCap.level, "bad");
  assert.match(gpuCap.text, /attached to cpu/);
});

test("feasibility checks the array against MaxArraySize", () => {
  const m = withScontrol();
  const gpu = m.partitions.find((p) => p.name === "gpu");
  const req = effectiveRequest(
    toRequest({ partition: "gpu", account: "lab", nodes: 1, ntasksPerNode: 1, cpusPerTask: 4, array: "0-1999", hours: 1 }),
    gpu,
  );
  assert.equal(req.tasks, 2000);
  const arr = feasibility(req, gpu, m, priorityModel(m)).find((c) => c.label === "Array");
  assert.equal(arr.level, "bad");
  assert.match(arr.text, /MaxArraySize of 1000/);
});

test("toRequest keeps a blank field from becoming a zero-sized job", () => {
  const req = toRequest({ nodes: 0, ntasksPerNode: 0, cpusPerTask: 0, gpusPerNode: -3 });
  assert.equal(req.nodes, 1);
  assert.equal(req.cpus, 1);
  assert.equal(req.gpus, 0);
});

// ------------------------------------------------------- optional directives

// A form with every directive switched off, which is how the page starts.
const NOTHING_SET = Object.fromEntries(PREAMBLE_OPTIONS.flatMap((o) => o.inputs.map((i) => [i, null])));

test("sbatchPreamble writes nothing for a directive that is switched off", () => {
  assert.deepEqual(sbatchPreamble(NOTHING_SET), []);
  assert.deepEqual(sbatchPreamble({ ...NOTHING_SET, nodes: 2 }), ["#SBATCH --nodes=2"]);
  // Zero is a value the user asked for; null is the absence of one. --nodes=0
  // is a rejected job, no --nodes at all is a one-node job, so the two must not
  // collapse into each other anywhere along the way.
  assert.deepEqual(sbatchPreamble({ ...NOTHING_SET, nodes: 0 }), ["#SBATCH --nodes=0"]);
  assert.deepEqual(sbatchPreamble({ ...NOTHING_SET, days: 0, hours: 4, minutes: 0 }), [
    "#SBATCH --time=04:00:00",
  ]);
});

test("toRequest reads an empty form as the job sbatch would really run", () => {
  const req = toRequest(NOTHING_SET);
  assert.equal(req.nodes, 1);
  assert.equal(req.cpus, 1); // one task of one core
  assert.equal(req.gpus, 0);
  assert.equal(req.tasks, 1);
  // Memory and walltime are cluster configuration, not sbatch's own defaults,
  // so they are left at zero for the partition to fill in.
  assert.equal(req.memPerNodeMB, 0);
  assert.equal(req.minutes, 0);
  assert.equal(req.explicitCpusPerTask, false);
});

test("effectiveRequest fills in the walltime the partition would have applied", () => {
  const m = withScontrol();
  const gpu = m.partitions.find((p) => p.name === "gpu");
  const req = effectiveRequest(toRequest({ ...NOTHING_SET, partition: "gpu" }), gpu);
  assert.equal(req.minutes, 240); // DefaultTime=04:00:00
  assert.equal(req.requested.minutes, 0); // the request itself asked for none
  assert.ok(req.applied.some((a) => a.rule === "DefaultTime"));

  // slurm.conf documents MaxTime as the fallback where DefaultTime is unset.
  const noDefault = { ...gpu, info: { ...gpu.info, defaultTime: null } };
  const viaMax = effectiveRequest(toRequest({ ...NOTHING_SET, partition: "gpu" }), noDefault);
  assert.equal(viaMax.minutes, 3 * 24 * 60);
  assert.ok(viaMax.applied.some((a) => a.rule === "MaxTime"));

  // A walltime that was asked for is left alone.
  const explicit = effectiveRequest(toRequest({ ...NOTHING_SET, days: 0, hours: 2, minutes: 0 }), gpu);
  assert.equal(explicit.minutes, 120);
  assert.ok(!explicit.applied.some((a) => a.rule === "DefaultTime" || a.rule === "MaxTime"));
});

test("an unset --cpus-per-task is exactly what lets DefCpuPerGPU apply", () => {
  const m = withScontrol();
  const gpu = m.partitions.find((p) => p.name === "gpu");
  const req = effectiveRequest(toRequest({ ...NOTHING_SET, partition: "gpu", gpusPerNode: 2 }), gpu);
  // 2 GPUs at DefCpuPerGPU=6, rather than the single core a bare task gets.
  assert.equal(req.cpus, 12);
  // And the memory default is per *allocated* core, so the order of the two
  // rules matters: 12 cores of DefMemPerCPU, not 1.
  assert.equal(req.memPerNodeMB, 12 * 8000);
  assert.deepEqual(req.applied.map((a) => a.rule), ["DefCpuPerGPU", "DefMemPerCPU", "DefaultTime"]);
});

test("feasibility says so when no dump reports the walltime a job would get", () => {
  // No scontrol dump, so nothing says what the partition substitutes — and a
  // silent "0m is within the limit" would read as a pass.
  const part = gpu();
  const req = effectiveRequest(toRequest({ ...NOTHING_SET, partition: "gpu" }), part);
  const wall = feasibility(req, part, model, pm).find((c) => c.label === "Walltime");
  assert.equal(wall.level, "warn");
  assert.match(wall.text, /scontrol show partition/);
});

test("only a seed SLURM would really use is marked as one", () => {
  // `real` decides what a switched-off box is allowed to display. Marking a mere
  // starting point as real is how the walltime row came to show 1h beside a cost
  // card figured on the partition's 4h DefaultTime.
  const m = withScontrol();
  const part = m.partitions.find((p) => p.name === "gpu");
  const d = preambleDefaults(m, part, toRequest(NOTHING_SET));
  const real = Object.entries(d).filter(([, v]) => v.real).map(([k]) => k).sort();
  assert.deepEqual(real, ["cpusPerTask", "mem", "nodes", "ntasksPerNode", "output", "partition", "time"]);
  // A GPU count SLURM would never invent, an array that would not exist, a mail
  // it would not send: seeds, not defaults.
  for (const k of ["gpus", "array", "mail", "error", "jobName"]) assert.equal(d[k].real, false, k);

  // And where the dumps report no default, the fallback must not claim to be one
  // — this is the exact case the walltime box got wrong.
  const bare = preambleDefaults(model, gpu(), toRequest(NOTHING_SET));
  assert.equal(bare.time.real, false);
  assert.equal(bare.mem.real, false);
  assert.equal(d.time.real, true);
});

test("preambleDefaults seeds a directive with what SLURM would have used anyway", () => {
  const m = withScontrol();
  const part = m.partitions.find((p) => p.name === "gpu");
  const d = preambleDefaults(m, part);
  assert.deepEqual(d.time.values, { days: 0, hours: 4, minutes: 0 }); // DefaultTime
  assert.deepEqual(d.mem.values, { memValue: 8000, memUnit: "M", memPer: "cpu" }); // DefMemPerCPU
  assert.deepEqual(d.partition.values, { partition: "gpu" }); // Default=YES
  assert.deepEqual(d.nodes.values, { nodes: 1 });

  // The point of the seeds: switching a directive on writes down what was going
  // to happen anyway, so the job it describes does not change.
  const off = effectiveRequest(toRequest({ ...NOTHING_SET, partition: "gpu" }), part);
  const on = effectiveRequest(
    toRequest({ ...NOTHING_SET, partition: "gpu", ...d.time.values, ...d.mem.values }),
    part,
  );
  assert.equal(on.minutes, off.minutes);
  assert.equal(on.memPerNodeMB, off.memPerNodeMB);
  assert.equal(on.cpus, off.cpus);

  // Where SLURM has no configured default there is nothing to seed, and it says
  // so rather than inventing an authority for a made-up value.
  assert.equal(d.account.values, null);
  assert.match(d.account.text, /no dump reports/);
  assert.equal(preambleDefaults(model, gpu()).time.values.hours, 1); // nothing to read
});

test("ticking --cpus-per-task on a GPU job keeps the cores DefCpuPerGPU gives it", () => {
  // The bug this covers: seeding the box with 1 took a 1-GPU l40s job from 14
  // cores to 1 and its bill with it, the moment the box was ticked. Whatever the
  // seed is, switching a directive on must describe the same job.
  const m = withScontrol();
  const part = m.partitions.find((p) => p.name === "gpu"); // DefCpuPerGPU=6
  const form = { ...NOTHING_SET, partition: "gpu", gpusPerNode: 2 };

  const off = effectiveRequest(toRequest(form), part);
  assert.equal(off.cpus, 12); // 2 GPUs x 6

  const d = preambleDefaults(m, part, toRequest(form));
  assert.deepEqual(d.cpusPerTask.values, { cpusPerTask: 12 });
  const on = effectiveRequest(toRequest({ ...form, ...d.cpusPerTask.values }), part);
  assert.equal(on.cpus, off.cpus);
  assert.equal(on.memPerNodeMB, off.memPerNodeMB);
  assert.equal(jobBilling(on, part, m.config).total, jobBilling(off, part, m.config).total);

  // Split across tasks, the per-task figure has to divide, not repeat.
  const twoTasks = { ...form, ntasksPerNode: 2 };
  assert.deepEqual(preambleDefaults(m, part, toRequest(twoTasks)).cpusPerTask.values, { cpusPerTask: 6 });
  assert.equal(effectiveRequest(toRequest({ ...twoTasks, cpusPerTask: 6 }), part).cpus, 12);

  // With no GPUs asked for, one core per task is still the answer.
  assert.deepEqual(preambleDefaults(m, part, toRequest({ ...NOTHING_SET })).cpusPerTask.values, {
    cpusPerTask: 1,
  });
});

test("--mem-per-cpu is charged against the cores DefCpuPerGPU allocated", () => {
  const m = withScontrol();
  const part = m.partitions.find((p) => p.name === "gpu"); // DefCpuPerGPU=6, MaxMemPerCPU=8000
  // 2 GPUs and no --cpus-per-task is a 12-core job, so 4000 MB per CPU is 48 GB
  // per node — not the 4 GB a one-core reading of the same request would give.
  const req = effectiveRequest(
    toRequest({ ...NOTHING_SET, partition: "gpu", gpusPerNode: 2, memValue: 4000, memUnit: "M", memPer: "cpu" }),
    part,
  );
  assert.equal(req.cpus, 12);
  assert.equal(req.memPerNodeMB, 12 * 4000);

  // Above MaxMemPerCPU it is a rejection, not a bigger allocation: more cores
  // cannot cover it, since each one brings the same excess.
  const over = effectiveRequest(
    toRequest({ ...NOTHING_SET, partition: "gpu", memValue: 16, memUnit: "G", memPer: "cpu" }),
    part,
  );
  assert.equal(over.cpus, 1); // not raised
  const check = feasibility(over, part, m, priorityModel(m)).find((c) => c.label === "Memory per CPU");
  assert.equal(check.level, "bad");
});

test("every option's inputs are fields the form actually reads", () => {
  // PREAMBLE_OPTIONS drives the tick boxes, the seeding and the list of what was
  // left out, so a key that matches no field would fail silently in all three.
  const fields = new Set(Object.keys(toRequest(NOTHING_SET)));
  const known = new Set(["jobName", "output", "error", "mailType", "mailUser", "constraint", "array",
    "ntasksPerNode", "cpusPerTask", "memValue", "memUnit", "memPer", "days", "hours", "minutes"]);
  for (const o of PREAMBLE_OPTIONS) {
    for (const i of o.inputs) {
      assert.ok(fields.has(i) || known.has(i), `${o.key}: nothing reads ${i}`);
    }
  }
});

test("memoryWaste prices an over-generous memory request in cores", () => {
  const m = withScontrol();
  // gpu: MaxMemPerCPU=8000 MB. Asking 400 GB forces ceil(409600/8000)=52 cores;
  // the 80 GB actually touched would have needed ceil(81920/8000)=11.
  const history = [
    { finished: true, partition: "gpu", account: "lab", user: "alice",
      elapsed: 3600, reqCpus: 4, reqMemMB: 400 * 1024, peakMemMB: 80 * 1024 },
    // Core request already exceeds what memory forces -> memory cost nothing.
    { finished: true, partition: "gpu", account: "lab", user: "bob",
      elapsed: 3600, reqCpus: 96, reqMemMB: 8 * 1024, peakMemMB: 4 * 1024 },
    // Unfinished jobs say nothing about what they needed.
    { finished: false, partition: "gpu", account: "lab", user: "carol",
      elapsed: 3600, reqCpus: 4, reqMemMB: 400 * 1024, peakMemMB: 80 * 1024 },
    // A partition with no MaxMemPerCPU has no such mechanism.
    { finished: true, partition: "nvl", account: "lab", user: "dave",
      elapsed: 3600, reqCpus: 4, reqMemMB: 400 * 1024, peakMemMB: 8 * 1024 },
  ];
  const w = memoryWaste(history, m.partitions);
  assert.equal(w.jobs, 1);
  assert.equal(w.billedMinutes, 52 * 60);
  assert.equal(w.neededMinutes, 11 * 60);
  assert.equal(w.avoidableCoreHours, (52 - 11) * 60 / 60);
  assert.ok(Math.abs(w.pct - (52 - 11) / 52) < 1e-9);
  // Attributed to both the account and the user who submitted it.
  assert.deepEqual(
    w.worst.filter((x) => x.scope === "user").map((x) => x.key),
    ["alice"],
  );
  // Nothing to price without history or partition limits.
  assert.equal(memoryWaste([], m.partitions).jobs, 0);
  assert.equal(memoryWaste(history, []).jobs, 0);
});

test("placement asks which nodes can hold the job, not whether the total fits", () => {
  const m = withScontrol({
    scontrolNodeText: [
      // 40 cores free, plenty of memory, 4 GPUs free.
      "NodeName=g01 CPUAlloc=48 CPUEfctv=88 CPUTot=96 CPULoad=40.0",
      "   Gres=gpu:a100:8",
      "   RealMemory=512000 AllocMem=64000 FreeMem=400000",
      "   State=MIXED Weight=1",
      "   Partitions=gpu ",
      "   AllocTRES=cpu=48,mem=64000M,gres/gpu=4",
      "",
      // Only 8 cores free -- the aggregate would count them, placement cannot.
      "NodeName=g02 CPUAlloc=80 CPUEfctv=88 CPUTot=96 CPULoad=70.0",
      "   Gres=gpu:a100:8",
      "   RealMemory=512000 AllocMem=400000 FreeMem=100000",
      "   State=MIXED Weight=1",
      "   Partitions=gpu ",
      "   AllocTRES=cpu=80,mem=400000M,gres/gpu=8",
      "",
      // Wholly free but drained.
      "NodeName=g03 CPUAlloc=0 CPUEfctv=88 CPUTot=96 CPULoad=0.0",
      "   Gres=gpu:a100:8",
      "   RealMemory=512000 AllocMem=0 FreeMem=500000",
      "   State=IDLE+DRAIN Weight=1",
      "   Partitions=gpu ",
      "   AllocTRES=",
    ].join("\n"),
  });
  const gpu = m.partitions.find((p) => p.name === "gpu");
  const req = (f) => effectiveRequest(toRequest({ partition: "gpu", ...f }), gpu);

  // 40 cores: g01 only. Aggregate free cores across the three is 48+8+88, which
  // would have said yes three times over.
  const forty = placement(req({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 40, hours: 1 }), gpu, m.nodeDetail);
  assert.equal(forty.considered, 3);
  assert.equal(forty.nodes, 1);

  // 60 cores fits nowhere, and the reason names the drained node separately.
  const sixty = placement(req({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 60, hours: 1 }), gpu, m.nodeDetail);
  assert.equal(sixty.nodes, 0);
  assert.match(sixty.blocked, /short on cores/);

  // GPUs are their own constraint: 5 free on g01 is 4, so nothing fits.
  const gpus = placement(req({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 8, gpusPerNode: 5, hours: 1 }), gpu, m.nodeDetail);
  assert.equal(gpus.nodes, 0);
  assert.match(gpus.blocked, /GPU/);

  // Without the node dump there is nothing to place against.
  assert.equal(placement(req({ nodes: 1, ntasksPerNode: 1, cpusPerTask: 8, hours: 1 }), gpu, []), null);
});
