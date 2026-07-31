// node --test web/parse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandHostlist,
  parseTres,
  parseDuration,
  parseStamp,
  parseGresGpus,
  parseCpuState,
  parseSinfoGres,
  parseMemory,
  parseSacctQos,
  parseSacctAssoc,
  parseScontrolConfig,
  parseAssocMgr,
  parseSacctHist,
  parseSacctmgrQos,
  parseScontrolNode,
  nodeUtilisation,
  historyStats,
  activeLimits,
  parseLimitPair,
  parseLimitTres,
  parseScontrolPartition,
  parseBillingWeights,
  readConfig,
  classifyReason,
  parseSinfo,
  parseSqueue,
  parseSprio,
  parseSshare,
  arrayTaskCount,
  buildModel,
} from "./parse.js";

// %i|%P|%u|%a|%j|%T|%M|%L|%D|%C|%b|%Q|%V|%S|%R|%q
const SQ = (...f) => f.join("|");

test("expandHostlist handles ranges, lists and bare names", () => {
  assert.deepEqual(expandHostlist("l05"), ["l05"]);
  assert.deepEqual(expandHostlist("l[01-02,06-07]"), ["l01", "l02", "l06", "l07"]);
  assert.deepEqual(expandHostlist("cpu[009-012,015]"), ["cpu009", "cpu010", "cpu011", "cpu012", "cpu015"]);
  assert.deepEqual(expandHostlist("l[01-02],c003"), ["l01", "l02", "c003"]);
  assert.deepEqual(expandHostlist("(Resources)"), []);
});

test("parseTres keeps keys containing '=' free of ambiguity", () => {
  const t = parseTres("cpu=385475,gres/gpu=1357,gres/gpu:a100=0,gres/gpu:h100=1357");
  assert.equal(t.get("cpu"), 385475);
  assert.equal(t.get("gres/gpu:h100"), 1357);
  assert.equal(t.get("gres/gpu:a100"), 0);
  assert.equal(parseTres("").size, 0);
});

test("parseTres scales a memory unit instead of discarding it", () => {
  // scontrol prints mem=6188800M where sshare prints a bare number; treating the
  // suffix as unparsable read every memory TRES as zero.
  assert.equal(parseTres("cpu=992,mem=6188800M,billing=1007").get("mem"), 6188800);
  assert.equal(parseTres("mem=100G").get("mem"), 102400);
  assert.equal(parseTres("mem=1T").get("mem"), 1024 * 1024);
  assert.equal(parseTres("mem=2048K").get("mem"), 2);
  assert.equal(parseTres("mem=500").get("mem"), 500); // bare stays MB
  assert.equal(parseTres("cpu=abc").get("cpu"), 0);
});

test("parseSinfo reads the bar-delimited dump with reasons", () => {
  const { rows } = parseSinfo(
    [
      "PARTITION|AVAIL|TIMELIMIT|NODES|STATE|REASON",
      "l40s*|up|3-00:00:00|3|mix-|none",
      "nvl|up|3-00:00:00|1|drain*|GPU ERR state - under investigation : Not responding",
    ].join("\n"),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { p: rows[0].partition, d: rows[0].isDefault, s: rows[0].state, f: rows[0].flags, g: rows[0].group, r: rows[0].reason },
    { p: "l40s", d: true, s: "mix", f: "-", g: "mix", r: "" },
  );
  assert.equal(rows[1].group, "unavail");
  assert.equal(rows[1].flags, "*");
  assert.match(rows[1].reason, /GPU ERR state/);
});

test("parseCpuState reads the A/I/O/T column", () => {
  assert.deepEqual(parseCpuState("143/113/0/256"), { alloc: 143, idle: 113, other: 0, total: 256 });
  assert.equal(parseCpuState("1/2/3"), null);
  assert.equal(parseCpuState(""), null);
});

test("parseSinfoGres reads GPUs per node with or without a model", () => {
  assert.deepEqual(parseSinfoGres("gpu:l40s:8"), { model: "l40s", count: 8 });
  assert.deepEqual(parseSinfoGres("gpu:4"), { model: null, count: 4 });
  assert.deepEqual(parseSinfoGres("gpu:h100:4(S:0-1)"), { model: "h100", count: 4 });
  assert.deepEqual(parseSinfoGres("(null)"), { model: null, count: 0 });
});

test("parseSinfo reads long-form states, node lists, cores and GRES", () => {
  const { rows } = parseSinfo(
    [
      "PARTITION|AVAIL|TIMELIMIT|NODES|STATE|NODELIST|CPUS(A/I/O/T)|GRES|MEMORY|REASON",
      "l40s*|up|3-00:00:00|2|mixed-|l[01-02]|143/113/0/256|gpu:l40s:8|773600|none",
      "cpu|up|3-00:00:00|2|draining|cpu[002,004]|75/0/149/224|(null)|515434|batch job complete failure",
    ].join("\n"),
  );
  assert.equal(rows.length, 2);
  const [gpu, cpu] = rows;
  assert.equal(gpu.state, "mixed"); // %T long form, still grouped as "mix"
  assert.equal(gpu.group, "mix");
  assert.equal(gpu.flags, "-");
  assert.deepEqual(gpu.nodes, ["l01", "l02"]);
  assert.deepEqual(gpu.cpus, { alloc: 143, idle: 113, other: 0, total: 256 });
  assert.equal(gpu.gpusPerNode, 8);
  assert.equal(gpu.gpuModel, "l40s");
  assert.equal(gpu.memoryMB, 773600);
  assert.equal(gpu.reason, "");

  assert.equal(cpu.group, "unavail"); // "draining"
  assert.equal(cpu.gpusPerNode, 0);
  assert.equal(cpu.cpus.other, 149);
  assert.match(cpu.reason, /batch job complete failure/);
});

test("parseDuration handles every SLURM duration shape", () => {
  assert.equal(parseDuration("0:00"), 0);
  assert.equal(parseDuration("29:41"), 29 * 60 + 41);
  assert.equal(parseDuration("18:11:38"), 18 * 3600 + 11 * 60 + 38);
  assert.equal(parseDuration("1-19:23:23"), 86400 + 19 * 3600 + 23 * 60 + 23);
  assert.equal(parseDuration("N/A"), null);
  assert.equal(parseDuration("UNLIMITED"), null);
  assert.equal(parseDuration(""), null);
});

test("parseGresGpus counts GPUs with or without a model", () => {
  assert.equal(parseGresGpus("gres/gpu:4"), 4);
  assert.equal(parseGresGpus("gres/gpu:a100:8"), 8);
  assert.equal(parseGresGpus("gres/gpu:nvidia_a100_2g.20gb:2"), 2);
  assert.equal(parseGresGpus("gres/gpu:0"), 0);
  assert.equal(parseGresGpus("N/A"), 0);
});

test("parseStamp reads ISO stamps and rejects N/A", () => {
  assert.equal(+parseStamp("2026-07-21T16:18:03"), +new Date("2026-07-21T16:18:03"));
  assert.equal(parseStamp("N/A"), null);
});

test("parseSqueue reads the 16-field bar dump", () => {
  const { rows, warnings } = parseSqueue(
    [
      SQ("1846079","a100","djonna1","tinoosh","gru_chang_fixA","PENDING","0:00","3-00:00:00","1","79","gres/gpu:a100:8","5039","2026-07-21T16:18:03","2026-07-30T11:05:58","(Resources)","normal"),
      SQ("1843876","l40s,a100","xwang378","ayuille1","bash","RUNNING","1-04:36:37","1-19:23:23","1","64","gres/gpu:4","5036","2026-07-20T19:49:10","2026-07-28T08:18:53","c007","ayuille1_batch"),
      SQ("1894893_[0-4%5]","cpu","u3","acct","vr1_cot_eval","PENDING","0:00","1-00:00:00","1","8","N/A","25","2026-05-06T17:12:28","N/A","(Priority)","normal"),
    ].join("\n"),
  );
  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 3);

  const [pd, run, arr] = rows;
  assert.equal(pd.state, "PD");
  assert.deepEqual(pd.partitions, ["a100"]);
  assert.equal(pd.account, "tinoosh");
  assert.equal(pd.name, "gru_chang_fixA");
  assert.equal(pd.cpus, 79);
  assert.equal(pd.gpus, 8);
  assert.equal(pd.priority, 5039);
  assert.equal(pd.qos, "normal");
  assert.equal(pd.reason, "Resources");
  assert.equal(pd.elapsed, 0);
  assert.equal(+pd.submit, +new Date("2026-07-21T16:18:03"));
  assert.equal(+pd.start, +new Date("2026-07-30T11:05:58"));

  assert.equal(run.state, "R");
  assert.deepEqual(run.partitions, ["l40s", "a100"]);
  assert.equal(run.nodelist, "c007"); // %R is the node list once running
  assert.equal(run.reason, null);
  assert.equal(run.qos, "ayuille1_batch"); // no longer truncated at 10 chars
  assert.equal(run.timeLeft, 86400 + 19 * 3600 + 23 * 60 + 23);

  assert.equal(arr.tasks, 5);
  assert.equal(arr.gpus, 0);
  assert.equal(arr.start, null);
});

test("parseSqueue reports a row whose columns no longer line up", () => {
  // The old 7-field layout: STATE is not where it is expected.
  const { rows, warnings } = parseSqueue("1846079,djonna1,gru_chang_fixA,PENDING,0:00,1,(Resources)");
  assert.equal(rows.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /squeue: skipped unparsable row/);
});

test("parseSqueue reads the --Format header spellings, not just the %-code ones", () => {
  // This exact header shift (TRES_PER_NODE / SUBMIT_TIME / START_TIME /
  // NODELIST(REASON)) silently blanked four fields before aliases existed.
  const { rows, warnings } = parseSqueue(
    [
      "JOBID|PARTITION|USER|ACCOUNT|NAME|STATE|TIME|TIME_LEFT|NODES|CPUS|TRES_PER_NODE|MIN_MEMORY|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      "1846079|a100|djonna1|tinoosh|gru_chang_fixA|PENDING|0:00|3-00:00:00|1|79|gres/gpu:a100:8|768G|5039|2026-07-21T16:18:03|2026-07-30T07:07:08|(Resources)|normal",
    ].join("\n"),
  );
  assert.equal(warnings.length, 0);
  const r = rows[0];
  assert.equal(r.gpus, 8);
  assert.equal(r.reason, "Resources");
  assert.equal(+r.submit, +new Date("2026-07-21T16:18:03"));
  assert.equal(+r.start, +new Date("2026-07-30T07:07:08"));
  assert.equal(r.memoryMB, 768 * 1024);
  assert.equal(r.timeLeft, 3 * 86400);
  assert.equal(r.qos, "normal");
});

test("parseSqueue warns when a needed column is missing rather than blanking it quietly", () => {
  const { rows, warnings } = parseSqueue(
    ["JOBID|PARTITION|USER|STATE|NODES", "100|cpu|u1|PENDING|1"].join("\n"),
  );
  assert.equal(rows.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no column found for/);
  assert.match(warnings[0], /submit/);
});

test("parseMemory handles unit suffixes and the per-CPU form", () => {
  assert.deepEqual(parseMemory("768G"), { mb: 768 * 1024, per: null });
  assert.deepEqual(parseMemory("500M"), { mb: 500, per: null });
  assert.deepEqual(parseMemory("4Gc"), { mb: 4096, per: "c" });
  assert.deepEqual(parseMemory("2048"), { mb: 2048, per: null }); // bare = MB
  assert.equal(parseMemory("N/A"), null);
});

test("parseSqueue scales per-CPU memory by the CPU count", () => {
  const { rows } = parseSqueue(
    [
      "JOBID|PARTITION|USER|STATE|NODES|CPUS|MIN_MEMORY|SUBMIT_TIME|START_TIME|NODELIST(REASON)",
      "100|cpu|u1|PENDING|2|8|4Gc|2026-07-01T00:00:00|N/A|(Priority)", // 8 cpus x 4G
      "101|cpu|u1|PENDING|2|8|16G|2026-07-01T00:00:00|N/A|(Priority)", // 2 nodes x 16G
    ].join("\n"),
  );
  assert.equal(rows[0].memoryMB, 8 * 4096);
  assert.equal(rows[1].memoryMB, 2 * 16384);
});

test("parseSqueue prefers a header row when one is present", () => {
  const { rows } = parseSqueue(
    [
      "JOBID|PARTITION|USER|ACCOUNT|NAME|STATE|TIME|TIMELEFT|NODES|CPUS|GRES|PRIORITY|SUBMIT|START|REASON|QOS",
      SQ("100","l40s","u1","acct","job","PENDING","0:00","1:00:00","1","4","N/A","500","2026-07-01T00:00:00","N/A","(Priority)","normal"),
    ].join("\n"),
  );
  assert.deepEqual(rows[0].partitions, ["l40s"]);
  assert.equal(rows[0].reason, "Priority"); // located via the REASON header
  assert.equal(rows[0].cpus, 4);
});

test("arrayTaskCount expands pending array specs", () => {
  assert.equal(arrayTaskCount("1894895"), 1);
  assert.equal(arrayTaskCount("1894897_[0-1%1]"), 2);
  assert.equal(arrayTaskCount("1943057_[0-5]"), 6);
  assert.equal(arrayTaskCount("123_[1-3,7%2]"), 4);
  assert.equal(arrayTaskCount("123_7"), 1);
});

test("parseSprio distinguishes the two PARTITION columns", () => {
  const { rows } = parseSprio(
    [
      "JOBID|PARTITION|USER|ACCOUNT|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|QOSNAME|QOS|NICE|TRES",
      "1843876|a100|xwang378|ayuille1|5035|0|5000|0|0|36|7|ayuille1_b|0|0",
    ].join("\n"),
  );
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.partition, "a100"); // the name
  assert.equal(r.factors.partition, 7); // the priority factor
  assert.equal(r.priority, 5035);
  assert.equal(r.qosname, "ayuille1_b");
  assert.equal(r.factors.age, 5000);
  assert.equal(r.factors.jobsize, 36);
});

test("parseSprio tells duplicate AGE columns apart by shape, not position", () => {
  // Requesting both normalized (%a) and weighted (%A) age gives two AGE columns;
  // the factor must be the weighted integer whichever order they arrive in.
  const norm_first = parseSprio(
    [
      "JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES",
      "1842903|h100|xwang397            |0.2241617           |1147|0|1121|0|0|27|0|0|0|normal|",
    ].join("\n"),
  );
  assert.equal(norm_first.rows[0].factors.age, 1121);
  assert.equal(norm_first.rows[0].normFactors.age, 0.2241617);
  assert.equal(norm_first.rows[0].user, "xwang397"); // %20u padding trimmed

  const weighted_first = parseSprio(
    [
      "JOBID|PARTITION|USER|AGE|PRIORITY|AGE|JOBSIZE",
      "1842903|h100|xwang397|1121|1147|0.2241617|27",
    ].join("\n"),
  );
  assert.equal(weighted_first.rows[0].factors.age, 1121);
  assert.equal(weighted_first.rows[0].normFactors.age, 0.2241617);
});

test("parseSprio keeps the PARTITION name apart from the PARTITION factor", () => {
  const { rows } = parseSprio(
    [
      "JOBID|PARTITION|USER|PRIORITY|JOBSIZE|PARTITION",
      "1|a100|u1|5035|36|7",
      "2|cpu|u2|100|10|9",
    ].join("\n"),
  );
  assert.equal(rows[0].partition, "a100");
  assert.equal(rows[0].factors.partition, 7);
  assert.equal(rows[1].factors.partition, 9);
});

test("parseSprio tolerates the ACCOUNT column being absent", () => {
  const { rows } = parseSprio(["JOBID|PARTITION|USER|PRIORITY|AGE", "1|a100|u1|500|480"].join("\n"));
  assert.equal(rows[0].account, "");
  assert.deepEqual(rows[0].normFactors, {});
});

test("parseSshare reads account depth and TRES columns", () => {
  const { rows } = parseSshare(
    [
      "Account|User|RawShares|NormShares|RawUsage|NormUsage|EffectvUsage|FairShare|LevelFS|GrpTRESMins|TRESRunMins",
      "root||1000000000|0.232831|12849561589||0.000000||0.000000||cpu=22880370,gres/gpu=494535",
      " abattle4||250000|0.005006|885329717||0.000000||0.000000|cpu=15000000,gres/gpu=15000000|cpu=385475,gres/gpu=1357,gres/gpu:h100=1357",
      "  ehunte18|rhausen1|1|0.062500|11973||0.000000|0.000000|0.000000||cpu=0",
    ].join("\n"),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[1].account, "abattle4");
  assert.equal(rows[1].limits.get("cpu"), 15000000);
  assert.equal(rows[1].running.get("gres/gpu:h100"), 1357);
  assert.equal(rows[2].depth, 2);
  assert.equal(rows[2].user, "rhausen1");
});

const SINFO = ["PARTITION|AVAIL|TIMELIMIT|NODES|STATE|REASON", "nvl|up|1-00:00:00|2|idle|none"].join("\n");
const SSHARE = [
  "Account|User|RawShares|NormShares|RawUsage|NormUsage|EffectvUsage|FairShare|LevelFS|GrpTRESMins|TRESRunMins",
  " acct||50000|0.001001|1788350||0.000000||0.000000|cpu=3000000|cpu=1223,gres/gpu=8,gres/gpu:a100=8",
].join("\n");
const NOW = new Date("2026-07-29T12:00:00");

test("buildModel drives the queue from squeue and takes factors from sprio", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      // running: contributes CPUs/GPUs and a time-to-finish, not to the queue
      SQ("100","nvl","u1","acct","a","RUNNING","1:00:00","2:00:00","1","8","gres/gpu:2","900","2026-07-29T09:00:00","2026-07-29T10:00:00","n01","normal"),
      // pending with a full sprio row
      SQ("101","nvl","u2","acct","b","PENDING","0:00","1-00:00:00","1","4","gres/gpu:1","500","2026-07-29T10:00:00","2026-07-29T14:00:00","(Priority)","normal"),
      // pending in two partitions, and absent from sprio entirely
      SQ("103","nvl,cpu","u4","acct","d","PENDING","0:00","1-00:00:00","2","16","N/A","300","2026-07-28T12:00:00","N/A","(DependencyNeverSatisfied)","normal"),
    ].join("\n"),
    sprioText: [
      "JOBID|PARTITION|USER|AGE|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|NICE|QOS|QOSNAME|TRES",
      "100|nvl|u1|0.9|900|0|900|0|0|0|0|0|0|normal|", // already running
      "101|nvl|u2|0.5|498|0|480|0|0|20|0|0|0|normal|", // priority lags squeue's 500
    ].join("\n"),
    sshareText: SSHARE,
  });

  const nvl = m.partitions.find((p) => p.name === "nvl");
  assert.equal(nvl.running, 1);
  assert.equal(nvl.pending, 2);
  assert.equal(nvl.runningCpus, 8);
  assert.equal(nvl.runningGpus, 2);
  assert.equal(nvl.pendingCpus, 20);
  assert.equal(nvl.pendingGpus, 1);
  assert.equal(nvl.endsInSoonest, 7200); // the one running job has 2h left

  // Both pending jobs are queued, ordered by squeue's priority
  assert.deepEqual(
    nvl.queue.map((r) => r.jobid),
    ["101", "103"],
  );
  assert.equal(nvl.queue[0].rank, 1);
  assert.equal(nvl.queue[0].priority, 500); // squeue's value, not sprio's 498
  assert.equal(nvl.queue[0].factors.jobsize, 20); // breakdown from sprio
  assert.equal(nvl.queue[0].waitSeconds, 2 * 3600);
  assert.equal(+nvl.queue[0].start, +new Date("2026-07-29T14:00:00"));
  // Job 103 has no sprio row, so a priority but no breakdown
  assert.equal(nvl.queue[1].factors, null);
  assert.equal(nvl.queue[1].waitSeconds, 24 * 3600);

  // ...and it is queued in cpu as well, ranked there in its own right
  const cpu = m.partitions.find((p) => p.name === "cpu");
  assert.equal(cpu.queue.length, 1);
  assert.equal(cpu.queue[0].rank, 1);

  assert.equal(nvl.waitMedian, 13 * 3600); // median of 2h and 24h
  assert.equal(nvl.waitMax, 24 * 3600);
  assert.equal(+nvl.nextStart, +new Date("2026-07-29T14:00:00"));

  assert.equal(m.notes.withoutFactors, 2); // job 103 in both of its partitions
  assert.equal(m.notes.sprioStale, 1); // job 100 has started
  assert.equal(m.notes.priorityDrift, 1); // job 101: 500 vs 498
  assert.equal(m.notes.unattributedJobs, 0);
  assert.equal(m.notes.squeueHasPartition, true);
  assert.equal(m.notes.hasJobAccounts, true);
  assert.equal(m.notes.hasWaitTimes, true);
  assert.equal(m.notes.hasStartEstimates, true);
  assert.equal(m.notes.hasGpuCounts, true);

  assert.equal(m.cluster.busyNodes, 1);
  assert.equal(m.cluster.pendingCpus, 20);
  assert.equal(m.cluster.runningGpus, 2);
  assert.deepEqual(m.activeFactors, ["age", "jobsize"]);
  assert.deepEqual(m.activeGpuTypes, ["gres/gpu:a100"]);
  assert.equal(m.accounts[0].runCpu, 1223);
});

test("buildModel falls back to sprio for partitions when squeue lacks %P", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|USER|NAME|STATE|TIME|NODES|TAIL",
      "101|u2|b|PENDING|0:00|1|(Priority)",
      "103|u4|d|PENDING|0:00|1|(Priority)", // in no partition anywhere
    ].join("\n"),
    sprioText: [
      "JOBID|PARTITION|USER|ACCOUNT|PRIORITY|SITE|AGE|ASSOC|FAIRSHARE|JOBSIZE|PARTITION|QOSNAME|QOS|NICE|TRES",
      "101|nvl|u2|acct|500|0|480|0|0|20|0|normal|0|0",
    ].join("\n"),
    sshareText: SSHARE,
  });
  const nvl = m.partitions.find((p) => p.name === "nvl");
  assert.equal(nvl.pending, 1);
  assert.equal(nvl.queue.length, 1);
  assert.equal(m.notes.squeueHasPartition, false);
  assert.equal(m.notes.unattributedJobs, 1);
  assert.equal(m.notes.hasWaitTimes, false); // no %V in this layout
});

const QOS = [
  "normal|0||gres/gpu=18|gres/gpu=18|",
  "cpuqueue|0|||cpu=3360|",
  "ayuille1_batch|50||gres/gpu=16||",
].join("\n");

test("parseSacctQos and parseSacctAssoc read the -nP dumps", () => {
  const { rows: qos } = parseSacctQos(QOS);
  assert.equal(qos.length, 3);
  assert.equal(qos[0].name, "normal");
  assert.equal(qos[0].maxPerAccount.get("gres/gpu"), 18);
  assert.equal(qos[1].maxPerAccount.get("cpu"), 3360);
  assert.equal(qos[2].priority, 50);
  assert.equal(qos[2].maxPerUser.get("gres/gpu"), 16);

  const { rows: assoc } = parseSacctAssoc(
    [
      "root||normal|||",
      "ayuille1||ayuille1_batch,ayuille1_interactive|gres/gpu=64||",
      "ayuille1|qchen76|64gpu,ayuille1_batch|gres/gpu=16||0",
    ].join("\n"),
  );
  assert.equal(assoc.length, 3);
  assert.equal(assoc[0].user, ""); // account-level row
  assert.deepEqual(assoc[1].qos, ["ayuille1_batch", "ayuille1_interactive"]);
  assert.equal(assoc[1].grpTres.get("gres/gpu"), 64);
  assert.equal(assoc[2].user, "qchen76");
});

const SC_CONFIG = [
  "Configuration data as of 2026-07-30T14:17:55",
  "AccountingStorageTRES   = cpu,mem,energy,node,billing,gres/gpu",
  "AcctGatherNodeFreq      = 30 sec",
  "ClusterName             = rockfish",
  "MaxArraySize            = 10000",
  "PriorityDecayHalfLife   = 30-00:00:00",
  "PriorityFavorSmall      = no",
  "PriorityFlags           = CALCULATE_RUNNING,MAX_TRES",
  "PriorityMaxAge          = 7-00:00:00",
  "PriorityType            = priority/multifactor",
  "PriorityWeightAge       = 5000",
  "PriorityWeightAssoc     = 0",
  "PriorityWeightFairShare = 20000",
  "PriorityWeightJobSize   = 5000",
  "PriorityWeightQOS       = 0",
  "PriorityWeightTRES      = (null)",
  "",
  "Cgroup Support Configuration:",
  "AllowedRAMSpace         = 100.0%",
  "",
  "Slurmctld(primary) at mprov-aix is UP",
].join("\n");

test("parseScontrolConfig reads KEY = VALUE and ignores everything else", () => {
  const { values } = parseScontrolConfig(SC_CONFIG);
  assert.equal(values.get("PriorityWeightAge"), "5000");
  assert.equal(values.get("PriorityFlags"), "CALCULATE_RUNNING,MAX_TRES");
  // A value may itself contain commas, spaces or an "="-free unit.
  assert.equal(values.get("AcctGatherNodeFreq"), "30 sec");
  assert.equal(values.get("AccountingStorageTRES"), "cpu,mem,energy,node,billing,gres/gpu");
  // The timestamp line, the blank lines, the section heading and the trailer all
  // lack " = " and so never become settings.
  assert.equal(values.has("Configuration data as of 2026-07-30T14:17:55"), false);
  assert.equal(values.has("Cgroup Support Configuration:"), false);
  assert.equal(parseScontrolConfig("").values.size, 0);
});

test("readConfig types the priority settings and keeps zero apart from absent", () => {
  const c = readConfig(parseScontrolConfig(SC_CONFIG).values);
  assert.equal(c.present, true);
  assert.equal(c.ageWeight, 5000);
  assert.equal(c.ageMax, 7 * 86400);
  assert.equal(c.jobSizeWeight, 5000);
  assert.equal(c.fairShareWeight, 20000);
  assert.equal(c.qosWeight, 0); // configured as zero
  assert.equal(c.favorSmall, false);
  assert.equal(c.decayHalfLife, 30 * 86400);
  assert.equal(c.maxArraySize, 10000);
  assert.equal(c.cluster, "rockfish");
  assert.deepEqual(c.flags, ["CALCULATE_RUNNING", "MAX_TRES"]);
  assert.equal(c.maxTres, true);
  // "(null)" and a missing key are both "not configured", not zero.
  assert.equal(c.partitionWeight, null);
  const empty = readConfig(new Map());
  assert.equal(empty.present, false);
  assert.equal(empty.ageWeight, null);
  assert.equal(empty.maxTres, false);
});

test("parseBillingWeights normalizes the memory weight to a per-GB rate", () => {
  const w = parseBillingWeights("CPU=1,Mem=0.1667G,GRES/gpu=2");
  assert.equal(w.get("cpu"), 1);
  assert.equal(w.get("mem"), 0.1667);
  assert.equal(w.get("gres/gpu"), 2);
  // A bare memory weight is per MB, so it is 1024x larger per GB.
  assert.equal(parseBillingWeights("Mem=0.25").get("mem"), 256);
  assert.equal(parseBillingWeights("Mem=0.25G").get("mem"), 0.25);
  assert.equal(parseBillingWeights("(null)").size, 0);
  assert.equal(parseBillingWeights("").size, 0);
});

const SC_PART = [
  "PartitionName=l40s AllowGroups=ALL AllowAccounts=ALL AllowQos=ALL Default=YES QoS=N/A DefaultTime=04:00:00 Hidden=NO MaxNodes=4 MaxTime=3-00:00:00 MinNodes=0 MaxCPUsPerNode=124 Nodes=l[01-08] PriorityJobFactor=1 PriorityTier=1 State=UP TotalCPUs=1024 TotalNodes=8 JobDefaults=DefCpuPerGPU=14 DefMemPerCPU=6000 MaxMemPerCPU=6000 TRES=cpu=992,mem=6188800M,node=8,billing=1007,gres/gpu=64 TRESBillingWeights=CPU=1,Mem=0.1667G,GRES/gpu=2",
  "PartitionName=cpu AllowGroups=ALL AllowAccounts=acctA,acctB AllowQos=cpuqueue Default=NO QoS=cpuqueue DefaultTime=12:00:00 Hidden=NO MaxNodes=10 MaxTime=UNLIMITED MinNodes=1 MaxCPUsPerNode=108 Nodes=cpu[002-004] PriorityJobFactor=1 PriorityTier=1 State=UP TotalCPUs=6720 TotalNodes=60 JobDefaults=(null) DefMemPerCPU=4000 MaxMemPerCPU=4000 TRES=cpu=6480,mem=30926040M,node=60,billing=7550 TRESBillingWeights=CPU=1,Mem=0.25G",
].join("\n");

test("parseScontrolPartition reads the one-line form, including values with '='", () => {
  const { rows, warnings } = parseScontrolPartition(SC_PART);
  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 2);
  const [l40s, cpu] = rows;

  assert.equal(l40s.name, "l40s");
  assert.equal(l40s.isDefault, true);
  assert.equal(l40s.maxNodes, 4);
  assert.equal(l40s.maxTime, 3 * 86400);
  assert.equal(l40s.defaultTime, 4 * 3600);
  assert.equal(l40s.maxCpusPerNode, 124);
  assert.equal(l40s.maxMemPerCpuMB, 6000);
  assert.equal(l40s.defMemPerCpuMB, 6000);
  // JobDefaults and TRESBillingWeights both nest an "=" inside their value.
  assert.equal(l40s.defCpuPerGpu, 14);
  assert.equal(l40s.billingWeights.get("mem"), 0.1667);
  assert.equal(l40s.tres.get("billing"), 1007);
  assert.equal(l40s.tres.get("mem"), 6188800);
  assert.deepEqual(l40s.nodes.slice(0, 3), ["l01", "l02", "l03"]);
  assert.equal(l40s.nodes.length, 8);
  // ALL and N/A both mean "no restriction", and are not lists of one.
  assert.equal(l40s.allowAccounts, null);
  assert.equal(l40s.allowQos, null);
  assert.equal(l40s.qos, "");

  assert.equal(cpu.qos, "cpuqueue"); // the partition QOS, in no other dump
  assert.deepEqual(cpu.allowAccounts, ["acctA", "acctB"]);
  assert.deepEqual(cpu.allowQos, ["cpuqueue"]);
  assert.equal(cpu.maxTime, null); // UNLIMITED is no limit, not zero
  assert.equal(cpu.minNodes, 1);
  assert.equal(cpu.defCpuPerGpu, null); // JobDefaults=(null)
});

test("parseScontrolPartition reports a line it cannot read", () => {
  const { rows, warnings } = parseScontrolPartition("Nodes=n01 State=UP\n");
  assert.equal(rows.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /scontrol partition: skipped/);
});

test("buildModel attaches partition limits and the config to the model", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: "",
    sprioText: "",
    sshareText: SSHARE,
    scontrolConfigText: SC_CONFIG,
    scontrolPartitionText: SC_PART,
  });
  assert.equal(m.config.present, true);
  assert.equal(m.config.ageWeight, 5000);
  assert.equal(m.notes.hasConfig, true);
  assert.equal(m.notes.hasPartitionInfo, true);
  // A partition scontrol knows about is offered even with no nodes or jobs in
  // the other dumps, so the planner can still target it.
  const l40s = m.partitions.find((p) => p.name === "l40s");
  assert.equal(l40s.info.maxNodes, 4);
  assert.equal(l40s.inSinfo, false);
  assert.deepEqual(m.notes.partitionQos, ["cpu → cpuqueue"]);
  assert.equal(m.counts.scontrolPartition, 2);
  // Absent dumps leave the model working and say so.
  const bare = buildModel({ now: NOW, sinfoText: SINFO, squeueText: "", sprioText: "", sshareText: "" });
  assert.equal(bare.config.present, false);
  assert.equal(bare.notes.hasConfig, false);
  assert.equal(bare.partitions.find((p) => p.name === "nvl").info, null);
});

test("buildModel names a partition QOS instead of matching a cap by shape", () => {
  // The same case as the "inferred cap" test above, but with scontrol present:
  // the cap comes from a QOS the jobs do not carry, which the partition attaches.
  const sq = (id, state, cpus, reason) =>
    [id, "cpu", "u1", "kchoudh2", state, "1", cpus, "2026-07-29T10:00:00", "N/A", reason, "normal"].join("|");
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      sq("1", "RUNNING", "3360", "n01"),
      sq("2", "PENDING", "8", "(MaxCpuPerAccount)"),
    ].join("\n"),
    sprioText: "",
    sshareText: SSHARE,
    sacctQosText: QOS,
    sacctAssocText: "kchoudh2||normal|||",
    scontrolPartitionText: SC_PART,
  });
  assert.equal(m.limits.length, 1);
  assert.equal(m.limits[0].cap.value, 3360);
  assert.equal(m.limits[0].cap.source, "QOS cpuqueue (on the partition)");
  assert.equal(m.limits[0].cap.inferred, false); // named, not guessed
  assert.deepEqual(m.limits[0].partQos, ["cpuqueue"]);
});

test("classifyReason maps blocking reasons to a scope and a resource", () => {
  assert.deepEqual(classifyReason("MaxCpuPerAccount"), { scope: "account", tres: "cpu", kind: "count" });
  assert.deepEqual(classifyReason("MaxGRESPerAccount"), { scope: "account", tres: "gres/gpu", kind: "count" });
  assert.deepEqual(classifyReason("QOSMaxGRESPerUser"), { scope: "user", tres: "gres/gpu", kind: "count" });
  assert.deepEqual(classifyReason("MaxCpuPerUser"), { scope: "user", tres: "cpu", kind: "count" });
  assert.equal(classifyReason("Priority"), null);
  assert.equal(classifyReason("Resources"), null);
  assert.equal(classifyReason(null), null);
});

test("classifyReason keeps a TRES-minutes budget apart from a TRES cap", () => {
  // "AssocGrpCPUMinutesLimit" contains "GrpCPU", so matching on that alone read
  // it as a cap on CPUs held at once and paired it with an unrelated QOS cpu=
  // limit — the row came out as "0 of 3360 CPUs" for a job blocked on a
  // quarterly resource-time allowance.
  assert.deepEqual(classifyReason("AssocGrpCPUMinutesLimit"), {
    scope: "account",
    tres: "cpu",
    kind: "minutes",
  });
  assert.equal(classifyReason("AssocGrpGRESMinutes").kind, "minutes");
  assert.equal(classifyReason("AssocGrpGRESMinutes").tres, "gres/gpu");
  assert.equal(classifyReason("AssocGrpBillingMinutes").tres, "billing");
  assert.equal(classifyReason("AssocMaxCpuMinutesPerJobLimit").kind, "minutes");
});

test("buildModel resolves a minutes budget from sshare, not from a TRES cap", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      // Nothing of acct's is running, so its instantaneous CPU usage is 0.
      "1|cpu|u1|acct|PENDING|1|8|2026-07-29T10:00:00|N/A|(AssocGrpCPUMinutesLimit)|normal",
    ].join("\n"),
    sprioText: "",
    sshareText: SSHARE,
    sacctQosText: QOS, // defines cpu=3360 on the cpuqueue QOS
    sacctAssocText: "acct||normal|||",
  });
  assert.equal(m.limits.length, 1);
  const l = m.limits[0];
  assert.equal(l.kind, "minutes");
  // The cap is the account's own GrpTRESMins allowance, not the unrelated 3360.
  assert.equal(l.cap.value, 3000000);
  assert.match(l.cap.source, /GrpTRESMins/);
  // And the figure shown is in-flight TRES-minutes, flagged as such.
  assert.equal(l.used, 1223);
  assert.equal(l.usedIsInFlight, true);
});

test("buildModel finds the cap holding an account back, including a partition QOS", () => {
  const sq = (id, acct, user, state, cpus, gpus, qos, reason) =>
    [id, "cpu", user, acct, "job", state, "0:00", "1:00:00", "1", cpus,
     gpus ? `gres/gpu:${gpus}` : "N/A", "4G", "500",
     "2026-07-29T10:00:00", "N/A", reason, qos].join("|");

  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|PARTITION|USER|ACCOUNT|NAME|STATE|TIME|TIME_LEFT|NODES|CPUS|TRES_PER_NODE|MIN_MEMORY|PRIORITY|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      // kchoudh2 holds exactly 3360 CPUs across two running jobs...
      sq("1", "kchoudh2", "u1", "RUNNING", "3000", 0, "normal", "n01"),
      sq("2", "kchoudh2", "u1", "RUNNING", "360", 0, "normal", "n01"),
      // ...and two more are stopped by a CPU cap its own QOS does not define
      sq("3", "kchoudh2", "u1", "PENDING", "8", 0, "normal", "(MaxCpuPerAccount)"),
      sq("4", "kchoudh2", "u2", "PENDING", "8", 0, "normal", "(MaxCpuPerAccount)"),
      // a GPU cap that the job's own QOS does define
      sq("5", "bhattad", "u3", "RUNNING", "8", 18, "normal", "n02"),
      sq("6", "bhattad", "u3", "PENDING", "8", 2, "normal", "(MaxGRESPerAccount)"),
      // and one that is simply waiting its turn
      sq("7", "other", "u4", "PENDING", "8", 0, "normal", "(Priority)"),
    ].join("\n"),
    sprioText: "",
    sshareText: SSHARE,
    sacctQosText: QOS,
    sacctAssocText: "kchoudh2||normal|||\nbhattad||normal|||",
  });

  assert.equal(m.notes.hasLimits, true);
  assert.equal(m.notes.unresolvedLimits, 0);
  assert.equal(m.limits.length, 2); // the Priority job is not a limit

  const [cpuLimit, gpuLimit] = m.limits;
  assert.equal(cpuLimit.key, "kchoudh2");
  assert.equal(cpuLimit.tres, "cpu");
  assert.equal(cpuLimit.jobs, 2);
  assert.equal(cpuLimit.used, 3360);
  assert.equal(cpuLimit.cap.value, 3360);
  assert.equal(cpuLimit.cap.source, "QOS cpuqueue");
  assert.equal(cpuLimit.cap.inferred, true); // the jobs carry QOS "normal"
  assert.equal(cpuLimit.cap.ambiguous, false);

  assert.equal(gpuLimit.key, "bhattad");
  assert.equal(gpuLimit.used, 18);
  assert.equal(gpuLimit.cap.value, 18);
  assert.equal(gpuLimit.cap.source, "QOS normal");
  assert.equal(gpuLimit.cap.inferred, false); // it is the job's own QOS
});

test("buildModel reports an unresolvable limit rather than inventing a cap", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|PARTITION|USER|ACCOUNT|NAME|STATE|NODES|CPUS|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      "1|cpu|u1|mystery|job|PENDING|1|8|2026-07-29T10:00:00|N/A|(MaxCpuPerAccount)|normal",
    ].join("\n"),
    sprioText: "",
    sshareText: SSHARE,
    sacctQosText: "normal|0||||", // no cpu cap anywhere
    sacctAssocText: "mystery||normal|||",
  });
  assert.equal(m.limits.length, 1);
  assert.equal(m.limits[0].cap, null);
  assert.equal(m.notes.unresolvedLimits, 1);
});

test("buildModel counts a shared node once in cluster capacity", () => {
  // n01 is in both partitions; nvl also has a second, exclusive node.
  const m = buildModel({
    now: NOW,
    sinfoText: [
      "PARTITION|AVAIL|TIMELIMIT|NODES|STATE|NODELIST|CPUS(A/I/O/T)|GRES|MEMORY|REASON",
      "nvl|up|1-00:00:00|2|mixed|n[01-02]|100/156/0/256|gpu:h100:4|1547000|none",
      "shared|up|1-00:00:00|1|mixed|n01|50/78/0/128|gpu:h100:4|1547000|none",
    ].join("\n"),
    squeueText: "",
    sprioText: "",
    sshareText: "",
  });
  assert.equal(m.nodes.length, 2); // n01, n02 — not 3
  assert.equal(m.cluster.nodes, 2);
  assert.equal(m.cluster.cpu.total, 256); // n01 and n02 at 128 each, counted once
  assert.equal(m.cluster.gpuTotal, 8);
  assert.equal(m.notes.hasNodelist, true);
  assert.equal(m.notes.hasNodeCapacity, true);
  // Per-partition totals stay as sinfo reports them for that partition
  assert.equal(m.partitions.find((p) => p.name === "nvl").cpu.total, 256);
  assert.equal(m.partitions.find((p) => p.name === "shared").cpu.total, 128);
  assert.equal(m.nodes.find((nd) => nd.name === "n01").partitions.size, 2);
});

test("buildModel reports drained cores and names the nodes", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: [
      "PARTITION|AVAIL|TIMELIMIT|NODES|STATE|NODELIST|CPUS(A/I/O/T)|GRES|MEMORY|REASON",
      "cpu|up|1-00:00:00|2|drained*|cpu[078,080]|0/0/224/224|(null)|515434|SSD taken for SJ - BG",
      "cpu|up|1-00:00:00|1|idle|cpu021|0/112/0/112|(null)|515434|none",
    ].join("\n"),
    squeueText: "",
    sprioText: "",
    sshareText: "",
  });
  assert.deepEqual(
    m.problemNodes.map((nd) => nd.name),
    ["cpu078", "cpu080"],
  );
  assert.equal(m.problemNodes[0].group, "unavail");
  assert.equal(m.problemNodes[0].flags, "*");
  assert.match(m.problemNodes[0].reason, /SSD taken/);
  assert.equal(m.cluster.cpu.other, 224);
  assert.equal(m.cluster.cpu.idle, 112);
});

test("buildModel does not count cores on unavailable nodes as idle", () => {
  // sinfo reports a maintenance node's cores as idle even though nothing can be
  // scheduled there; a draining node keeps its already-allocated cores.
  const m = buildModel({
    now: NOW,
    sinfoText: [
      "PARTITION|AVAIL|TIMELIMIT|NODES|STATE|NODELIST|CPUS(A/I/O/T)|GRES|MEMORY|REASON",
      "cpu|up|1-00:00:00|2|maint|cpu[005,079]|0/224/0/224|(null)|515434|none",
      "cpu|up|1-00:00:00|2|draining|cpu[002,004]|75/0/149/224|(null)|515434|batch job complete failure",
      "cpu|up|1-00:00:00|1|idle|cpu021|0/112/0/112|(null)|515434|none",
    ].join("\n"),
    squeueText: "",
    sprioText: "",
    sshareText: "",
  });
  const cpu = m.partitions.find((p) => p.name === "cpu").cpu;
  assert.equal(cpu.total, 560);
  assert.equal(cpu.idle, 112); // only the genuinely idle node
  assert.equal(cpu.other, 224 + 149); // maint cores folded in with drained ones
  assert.equal(cpu.alloc, 75); // work still finishing on the draining nodes
  assert.equal(cpu.alloc + cpu.idle + cpu.other, cpu.total);
  assert.equal(m.cluster.cpu.idle, 112);
});

test("buildModel falls back to summed rows when sinfo has no node list", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: ["PARTITION|AVAIL|TIMELIMIT|NODES|STATE|REASON", "nvl|up|1-00:00:00|2|idle|none"].join("\n"),
    squeueText: "",
    sprioText: "",
    sshareText: "",
  });
  assert.equal(m.cluster.nodes, 2);
  assert.equal(m.nodes.length, 0);
  assert.equal(m.notes.hasNodelist, false);
  assert.equal(m.notes.hasNodeCapacity, false);
});

test("buildModel survives a missing file", () => {
  const m = buildModel({ sinfoText: "", squeueText: "", sprioText: "", sshareText: "" });
  assert.deepEqual(m.partitions, []);
  assert.equal(m.cluster.nodes, 0);
  assert.equal(m.accounts.length, 0);
});

const ASSOC_MGR = [
  "Current Association Manager state",
  "",
  "User Records",
  "",
  "UserName=alice(2001) DefAccount=lab DefWckey= AdminLevel=None",
  "",
  "Association Records",
  "",
  "ClusterName=cluster Account=lab UserName= Partition= Priority=0 ID=7",
  "    SharesRaw/Norm/Level/Factor=50000/0.01/1/0.00",
  "    UsageRaw/Norm/Efctv=123.00/1.00/0.00",
  "    ParentAccount= Lineage=/lab/ DefAssoc=No",
  "    GrpJobs=N(12) GrpJobsAccrue=N(3)",
  "    GrpSubmitJobs=100(41) GrpWall=N(500.00)",
  "    GrpTRES=cpu=N(64),gres/gpu=8(8)",
  "    GrpTRESMins=cpu=3000000(3001863),gres/gpu=N(120)",
  "    GrpTRESRunMins=cpu=N(900)",
  "    MaxJobs= MaxJobsAccrue= MaxSubmitJobs= MaxWallPJ=",
  "    MaxTRESPJ=",
  "    Comment=(null)",
  "",
  "QOS Records",
  "",
  "QOS=normal(1)",
  "    UsageRaw=456.00",
  "    GrpJobs=N(10) GrpSubmitJobs=N(20)",
  "    GrpTRES=cpu=N(5)",
  "    MaxWallPJ=",
  "    PreemptMode=OFF",
  "    Priority=0",
  "    Account Limits",
  "      lab",
  "        MaxJobsPA=N(0) MaxSubmitJobsPA=N(2)",
  "        MaxTRESPA=cpu=N(0),gres/gpu=18(18)",
  "    User Limits",
  "      alice(2001)",
  "        MaxJobsPU=N(1) MaxSubmitJobsPU=50(1)",
  "        MaxTRESPU=cpu=N(86),gres/gpu=16(4)",
].join("\n");

test("parseLimitPair and parseLimitTres read the LIMIT(USAGE) form", () => {
  // "N" is no limit, and the parenthesised figure is always the usage — the
  // pairing is what makes assoc_mgr worth reading at all.
  assert.deepEqual(parseLimitPair("N(1294)"), { limit: null, used: 1294 });
  assert.deepEqual(parseLimitPair("18(0)"), { limit: 18, used: 0 });
  assert.deepEqual(parseLimitPair("500.00(1.5)"), { limit: 500, used: 1.5 });
  assert.equal(parseLimitPair(""), null);
  assert.equal(parseLimitPair("18"), null); // a bare number is not a pair
  const t = parseLimitTres("cpu=N(7039),gres/gpu=18(0),gres/gpu:a100=N(24)");
  assert.deepEqual(t.get("cpu"), { limit: null, used: 7039 });
  assert.deepEqual(t.get("gres/gpu"), { limit: 18, used: 0 });
  // A TRES name containing both "/" and ":" must survive the split.
  assert.deepEqual(t.get("gres/gpu:a100"), { limit: null, used: 24 });
});

test("parseAssocMgr reads all three sections and the nested QOS limits", () => {
  const am = parseAssocMgr(ASSOC_MGR);
  assert.equal(am.warnings.length, 0);
  assert.equal(am.users.length, 1);
  assert.deepEqual(am.users[0], { user: "alice", defAccount: "lab", adminLevel: "None" });

  assert.equal(am.assoc.length, 1);
  const a = am.assoc[0];
  assert.equal(a.account, "lab");
  assert.equal(a.user, "");
  assert.deepEqual(a.limits.get("GrpSubmitJobs"), { limit: 100, used: 41 });
  assert.deepEqual(a.limits.get("GrpTRES").get("gres/gpu"), { limit: 8, used: 8 });
  // The consumed side of a GrpTRESMins budget, which no other dump carries.
  assert.deepEqual(a.limits.get("GrpTRESMins").get("cpu"), { limit: 3000000, used: 3001863 });
  // An empty value means the limit is unset, not a limit of zero.
  assert.equal(a.limits.has("MaxJobs"), false);
  // Non-pair values land as plain fields, not limits.
  assert.equal(a.lineage, "/lab/");

  assert.equal(am.qos.length, 1);
  const q = am.qos[0];
  assert.equal(q.name, "normal"); // the "(1)" id is stripped
  assert.equal(q.preemptMode, "OFF");
  assert.deepEqual(q.accountLimits.get("lab").limits.get("MaxTRESPA").get("gres/gpu"), { limit: 18, used: 18 });
  assert.deepEqual(q.userLimits.get("alice").limits.get("MaxSubmitJobsPU"), { limit: 50, used: 1 });
});

test("activeLimits keeps only limits that are set, and names their scope", () => {
  const rows = activeLimits(parseAssocMgr(ASSOC_MGR));
  const key = (r) => `${r.source}|${r.field}|${r.tres ?? ""}`;
  const found = new Set(rows.map(key));
  assert.ok(found.has("association lab|GrpSubmitJobs|"));
  assert.ok(found.has("association lab|GrpTRES|gres/gpu"));
  assert.ok(found.has("association lab|GrpTRESMins|cpu"));
  assert.ok(found.has("QOS normal per-account|MaxTRESPA|gres/gpu"));
  assert.ok(found.has("QOS normal per-user|MaxTRESPU|gres/gpu"));
  // Unset limits (N) and zero limits are not "active".
  assert.ok(!rows.some((r) => r.limit === null || r.limit === 0));
  // The ones sitting on their ceiling are exactly the two contrived to.
  const atCeiling = rows.filter((r) => r.used >= r.limit).map(key).sort();
  assert.deepEqual(atCeiling, [
    "QOS normal per-account|MaxTRESPA|gres/gpu",
    "association lab|GrpTRES|gres/gpu",
    "association lab|GrpTRESMins|cpu",
  ].sort());
});

test("buildModel takes a blocking cap from assoc_mgr in preference to matching by shape", () => {
  const m = buildModel({
    now: NOW,
    sinfoText: SINFO,
    squeueText: [
      "JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|TRES_PER_NODE|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
      "1|cpu|alice|lab|RUNNING|1|8|gres/gpu:8|2026-07-29T10:00:00|N/A|n01|normal",
      "2|cpu|alice|lab|PENDING|1|8|gres/gpu:1|2026-07-29T10:00:00|N/A|(MaxGRESPerAccount)|normal",
    ].join("\n"),
    sprioText: "",
    sshareText: SSHARE,
    sacctQosText: QOS,
    sacctAssocText: "lab||normal|||",
    assocMgrText: ASSOC_MGR,
  });
  assert.equal(m.notes.hasAssocMgr, true);
  assert.equal(m.limits.length, 1);
  const l = m.limits[0];
  // The association's own GrpTRES cap of 8, observed at 8 in use -- not the
  // QOS gres/gpu=18 that shape-matching would have reached for.
  assert.equal(l.cap.value, 8);
  assert.equal(l.cap.fromAssocMgr, true);
  assert.equal(l.cap.inferred, false);
  assert.match(l.cap.source, /association lab/);
  assert.equal(l.observedUsed, 8);
});

test("buildModel corrects a GPU count squeue's %b understates", () => {
  // A --gpus (per job) request shows nothing in TRES_PER_NODE, so squeue reports
  // zero GPUs for a job holding four.
  const job = [
    "JobId=5 JobName=j5",
    "   UserId=alice(2001) GroupId=g(1001) MCS_label=N/A",
    "   JobState=RUNNING Reason=None Dependency=(null)",
    "   AccrueTime=2026-07-30T11:00:00",
    "   Partition=gpu AllocNode:Sid=login01:1",
    "   NumNodes=1 NumCPUs=8 NumTasks=1 CPUs/Task=8 ReqB:S:C:T=0:0:*:*",
    "   ReqTRES=cpu=8,mem=64G,node=1,billing=8,gres/gpu=4",
    "   AllocTRES=cpu=8,mem=64G,node=1,billing=8,gres/gpu=4",
    "   MinMemoryNode=64G",
    "   TresPerJob=gres/gpu:4",
  ].join("\n");
  const squeue = [
    "JOBID|PARTITION|USER|ACCOUNT|STATE|NODES|CPUS|TRES_PER_NODE|SUBMIT_TIME|START_TIME|NODELIST(REASON)|QOS",
    "5|gpu|alice|lab|RUNNING|1|8|N/A|2026-07-30T10:00:00|N/A|g01|normal",
  ].join("\n");
  const before = buildModel({ now: NOW, sinfoText: SINFO, squeueText: squeue, sprioText: "", sshareText: SSHARE });
  const after = buildModel({ now: NOW, sinfoText: SINFO, squeueText: squeue, sprioText: "", sshareText: SSHARE, scontrolJobText: job });
  assert.equal(before.cluster.runningGpus, 0); // %b said nothing
  assert.equal(after.cluster.runningGpus, 4); // AllocTRES says four
  assert.equal(after.notes.gpuCorrected, 1);
  assert.equal(after.notes.gpuDelta, 4);
  assert.equal(after.partitions.find((p) => p.name === "gpu").runningGpus, 4);
});

const SACCT_HIST = [
  "JobID|Partition|Account|User|State|Submit|Start|End|Elapsed|TimelimitRaw|ReqTRES|AllocTRES|MaxRSS|ExitCode",
  // Completed: asked for 3 days and 160G, ran 1 day and touched 40G.
  "100|gpu|lab|alice|COMPLETED|2026-07-20T10:00:00|2026-07-20T12:00:00|2026-07-21T12:00:00|1-00:00:00|4320|billing=16,cpu=16,mem=160G,node=1|billing=18,cpu=18,mem=160G,node=1||0:0",
  "100.batch||lab||COMPLETED|2026-07-20T12:00:00|2026-07-20T12:00:00|2026-07-21T12:00:00|1-00:00:00|||cpu=18,mem=160G,node=1|41943040K|0:0",
  "100.extern||lab||COMPLETED|2026-07-20T12:00:00|2026-07-20T12:00:00|2026-07-21T12:00:00|1-00:00:00|||cpu=18,mem=160G,node=1|256K|0:0",
  // A TIMEOUT used all its walltime by definition, so it must not count.
  "101|gpu|lab|bob|TIMEOUT|2026-07-20T10:00:00|2026-07-20T10:00:00|2026-07-20T11:00:00|01:00:00|60|billing=8,cpu=8,mem=8G,node=1|billing=8,cpu=8,mem=8G,node=1||0:1",
  "101.batch||lab||TIMEOUT|2026-07-20T10:00:00|2026-07-20T10:00:00|2026-07-20T11:00:00|01:00:00|||cpu=8,mem=8G,node=1|4194304K|0:1",
  // "CANCELLED by 2621" -- the state has to survive the trailing words.
  "102|gpu|lab|alice|CANCELLED by 2621|2026-07-20T10:00:00|None|2026-07-20T11:00:00|00:00:00|1440|billing=64,cpu=64,mem=240G,node=1|||0:0",
].join("\n");

test("parseSacctHist joins MaxRSS from step rows onto their parent job", () => {
  const { rows } = parseSacctHist(SACCT_HIST);
  // Step rows are folded in, not returned as jobs of their own.
  assert.deepEqual(rows.map((r) => r.id), ["100", "101", "102"]);
  const [done, timeout, cancelled] = rows;

  assert.equal(done.state, "COMPLETED");
  assert.equal(done.reqMemMB, 160 * 1024);
  // The largest step's peak, not the .extern row's 256K.
  assert.equal(done.peakMemMB, 40 * 1024);
  assert.equal(done.timeLimit, 4320 * 60); // TimelimitRaw is minutes
  assert.equal(done.elapsed, 86400);
  assert.equal(done.wallUsed, 86400 / (4320 * 60));
  assert.equal(done.memUsed, 0.25);
  assert.equal(done.allocCpus, 18); // MaxMemPerCPU raised 16 to 18
  assert.equal(done.queueSeconds, 7200);

  // A job that ran out of time tells us nothing about how much it needed.
  assert.equal(timeout.state, "TIMEOUT");
  assert.equal(timeout.wallUsed, null);
  assert.equal(timeout.memUsed, null);

  assert.equal(cancelled.state, "CANCELLED"); // "by 2621" dropped
  assert.equal(cancelled.wallUsed, null);
  assert.equal(cancelled.peakMemMB, null);
  assert.equal(cancelled.queueSeconds, null); // never started
});

test("historyStats reports only what completed jobs can support", () => {
  const st = historyStats(parseSacctHist(SACCT_HIST).rows);
  assert.equal(st.jobs, 3);
  assert.equal(st.completed, 1);
  assert.equal(st.timeouts, 1);
  assert.equal(st.wallSamples, 1);
  assert.equal(st.memSamples, 1);
  assert.equal(st.memMedian, 0.25);
  assert.equal(st.outOfMemory, 0);
  assert.equal(historyStats([]).jobs, 0);
  assert.equal(historyStats([]).wallMedian, null);
});

test("parseSacctmgrQos reads the fields the narrow dump omits", () => {
  // The two formats are NOT positionally compatible: usagefactor sits where
  // grptres used to, so this needs its own parser.
  const { rows } = parseSacctmgrQos(
    [
      "normal|0|1.000000||gres/gpu=18|gres/gpu=18|||||||",
      "ayuille1_interactive|100|0.500000||gres/gpu=2|||02:00:00||4||DenyOnLimit|",
      "big|0||||||14-00:00:00|||||",
    ].join("\n"),
  );
  assert.equal(rows.length, 3);
  const [normal, inter, big] = rows;
  assert.equal(normal.maxPerUser.get("gres/gpu"), 18);
  assert.equal(normal.maxPerAccount.get("gres/gpu"), 18);
  assert.equal(normal.usageFactor, 1);
  assert.equal(normal.denyOnLimit, false);
  assert.equal(normal.maxWall, null);

  assert.equal(inter.priority, 100);
  assert.equal(inter.usageFactor, 0.5); // halves what its jobs are charged
  assert.equal(inter.maxWall, 7200); // a 2-hour ceiling, in no other dump
  assert.equal(inter.maxSubmitPerUser, 4);
  assert.equal(inter.denyOnLimit, true);

  // An absent UsageFactor means no scaling, not a factor of zero.
  assert.equal(big.usageFactor, 1);
  assert.equal(big.maxWall, 14 * 86400);
});

const NODES = [
  "NodeName=g01 Arch=x86_64 CoresPerSocket=24 ",
  "   CPUAlloc=88 CPUEfctv=88 CPUTot=96 CPULoad=6.59",
  "   AvailableFeatures=(null)",
  "   ActiveFeatures=(null)",
  "   Gres=gpu:a100:8",
  "   RealMemory=1031000 AllocMem=593920 FreeMem=15202 Sockets=2 Boards=1",
  "   CoreSpecCount=4 CPUSpecList=2-9 MemSpecLimit=10000",
  "   State=ALLOCATED ThreadsPerCore=2 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A",
  "   Partitions=gpu ",
  "   CfgTRES=cpu=88,mem=1031000M,billing=100,gres/gpu=8,gres/gpu:a100=8",
  "   AllocTRES=cpu=88,mem=580G,gres/gpu=8,gres/gpu:a100=8",
  "",
  "NodeName=g02 Arch=x86_64 CoresPerSocket=24 ",
  "   CPUAlloc=8 CPUEfctv=88 CPUTot=96 CPULoad=7.90",
  "   Gres=gpu:a100:8",
  "   RealMemory=1031000 AllocMem=64000 FreeMem=900000 Sockets=2 Boards=1",
  "   MemSpecLimit=10000",
  "   State=MIXED ThreadsPerCore=2 Weight=1",
  "   Partitions=gpu ",
  "   AllocTRES=cpu=8,mem=64000M,gres/gpu=1,gres/gpu:a100=1",
  "",
  "NodeName=g03 Arch=x86_64 CoresPerSocket=24 ",
  "   CPUAlloc=0 CPUEfctv=88 CPUTot=96 CPULoad=0.01",
  "   Gres=gpu:a100:8",
  "   RealMemory=1031000 AllocMem=0 FreeMem=1000000",
  "   State=IDLE+DRAIN ThreadsPerCore=2 Weight=1",
  "   Reason=hardware check",
  "   Partitions=gpu ",
  "   AllocTRES=",
].join("\n");

test("parseScontrolNode reads per-node allocation and what the node is doing", () => {
  const { rows, warnings } = parseScontrolNode(NODES);
  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 3);
  const [g01, g02, g03] = rows;

  assert.equal(g01.cpuAlloc, 88);
  // CPUEfctv is what is schedulable after CoreSpecCount is held back, and is the
  // figure a placement decision has to use -- not CPUTot.
  assert.equal(g01.cpuEfctv, 88);
  assert.equal(g01.cpuTot, 96);
  assert.equal(g01.cpuLoad, 6.59);
  assert.equal(g01.gpusTotal, 8);
  assert.equal(g01.gpusAlloc, 8);
  assert.equal(g01.gpuModel, "a100");
  assert.equal(g01.allocMemoryMB, 593920);
  assert.equal(g01.memSpecLimitMB, 10000);
  assert.deepEqual(g01.partitions, ["gpu"]);
  assert.equal(g01.schedulable, true);

  assert.equal(g02.gpusAlloc, 1);

  // A DRAIN flag means nothing can be placed there whatever the free counts say.
  assert.equal(g03.state, "idle");
  assert.deepEqual(g03.stateFlags, ["drain"]);
  assert.equal(g03.schedulable, false);
  assert.equal(g03.reason, "hardware check");
});

test("nodeUtilisation separates cores handed out from cores working", () => {
  const { rows } = parseScontrolNode(NODES);
  const u = nodeUtilisation(rows);
  // g03 has nothing allocated, so it is not part of the comparison at all.
  assert.equal(u.nodes, 2);
  assert.equal(u.cpuAlloc, 96);
  assert.ok(Math.abs(u.cpuLoad - 14.49) < 1e-9);
  // g01: 88 cores at load 6.59 is under a quarter. g02: 8 cores is below the
  // 16-core floor, so it is not flagged however idle it looks.
  assert.deepEqual(u.idleNodes.map((nd) => nd.name), ["g01"]);
  assert.ok(Math.abs(u.strandedCores - (88 - 6.59)) < 1e-9);
  assert.equal(nodeUtilisation([]).busyFraction, null);
});
