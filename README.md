# cluster_assistant

A SLURM status dashboard that is a plain HTML page. No application server, no
database, no build step — the page reads a handful of text files and does all of
its work in the browser.

```
uv run main.py --open        # http://127.0.0.1:8000/web/
```

## How it works

A separate process (not this one) dumps SLURM output into `data/`:

| File                    | Used for                                          |
| ----------------------- | ------------------------------------------------- |
| `data/sinfo.txt`        | node state, drain reasons, cores, GPUs, memory     |
| `data/squeue.txt`       | every job: partition, size, wait, priority, reason |
| `data/sprio.txt`        | the breakdown of each priority into factors        |
| `data/sshare.txt`       | account shares and in-flight usage                 |
| `data/sacct_qos.txt`    | QOS caps — what limits exist                        |
| `data/sacct_assoc.txt`  | per-account and per-user caps                       |
| `data/scontrol_config.txt`    | the priority weights, and `PriorityFlags`     |
| `data/scontrol_partition.txt` | each partition's limits and billing weights   |
| `data/scontrol_job.txt`       | per-job allocated CPUs, accrue time, billing  |
| `data/scontrol_assoc_mgr.txt` | every limit, with the usage counted against it |
| `data/sacct_hist.txt`         | finished jobs: what they used, not what they asked |
| `data/sacctmgr_qos.txt`       | `UsageFactor`, `MaxWall`, `DenyOnLimit`        |
| `data/scontrol_node.txt`      | per-node allocation, and actual `CPULoad`      |

The page fetches those files, parses them client-side, and re-reads them every
60 seconds. Overwrite the files in place and the dashboard follows; it flags the
data as stale if the newest file is more than 15 minutes old. A missing file
degrades that section rather than breaking the page.

Any static web server works — `main.py` is just `http.server` with caching
turned off, so the page always sees the latest dump. Point nginx or Apache at
this directory and drop `main.py` entirely if you prefer.

Write each dump to a temporary file and `mv` it into place: `mv` is atomic, so
the page never reads a half-written file.

### The dump commands

```sh
sinfo    -o '%P|%a|%l|%D|%T|%N|%C|%G|%m|%E'                                  > sinfo.txt
squeue   -o '%i|%P|%u|%a|%j|%T|%M|%L|%D|%C|%b|%m|%Q|%V|%S|%R|%q'             > squeue.txt
sprio    -o '%i|%r|%20u|%a|%Y|%S|%A|%B|%F|%J|%P|%N|%Q|%n|%T'                 > sprio.txt
sshare   -l -P                                                               > sshare.txt
sacctmgr -nP show qos   format=name,priority,grptres,maxtresperuser,maxtresperaccount,maxjobspu \
                                                                             > sacct_qos.txt
sacctmgr -nP show assoc format=account,user,qos,grptres,maxtres,maxjobs      > sacct_assoc.txt
scontrol show config                                                         > scontrol_config.txt
scontrol -o show partition                                                   > scontrol_partition.txt
scontrol show job                                                            > scontrol_job.txt
scontrol show assoc_mgr                                                      > scontrol_assoc_mgr.txt
sacct -aP -S now-3days -o JobID,Partition,Account,User,State,Submit,Start,End,Elapsed,\
              TimelimitRaw,ReqTRES,AllocTRES,MaxRSS,ExitCode                 > sacct_hist.txt
sacctmgr -nP show qos format=name,priority,usagefactor,grptres,maxtresperuser,\
              maxtresperaccount,maxtresperjob,maxwall,maxjobspu,maxsubmitjobspu,\
              grpjobs,flags,preempt                                          > sacctmgr_qos.txt
scontrol show node                                                           > scontrol_node.txt
```

`sacct` over a long window can exceed what the accounting database will return in
one go — 30 days produced an empty file here where 3 days works. Widen it only as
far as it keeps returning rows.

`data/get_data.sh <host>` runs all of these over ssh.

**Run at least `sinfo`, `squeue` and `sprio` in one loop iteration.** Snapshots taken minutes apart disagree:
the age factor grows continuously, so a `sprio.txt` captured five minutes before
`squeue.txt` differs from it on almost every job. The page reports that gap
rather than hiding it, but the fix is at the dump end.

`sacct_qos.txt`, `sacct_assoc.txt` and the two `scontrol` dumps change rarely and
can be taken on a slower cycle if you prefer.

### Column layout

Every file with a header row is read **by column name**, so adding or reordering
fields does not break the page. Because SLURM spells the same field differently
depending on how it was requested (`%b` prints as `TRES_PER_NODE` or `GRES`, `%V`
as `SUBMIT_TIME` or `SUBMIT`, `%R` as `NODELIST(REASON)` or `REASON`), each field
the page needs carries a list of names it may appear under, and **a column the
page wanted but could not find is reported as a parse warning** in "Data notes"
rather than silently coming through blank.

The two `sacctmgr` dumps use `-n` (no header), so their columns are read
positionally in the `format=` order above. Keep those two `format=` lists in the
order shown, or drop `-n` so the header can be used instead.

The three `scontrol` dumps are read by key, so neither ordering nor extra fields
matter. `scontrol show config` is `KEY = VALUE` per line — the timestamp, the
section headings and the trailer have no ` = ` and are skipped by construction.
`scontrol -o show partition` is one line per partition of space-separated
`Key=Value`, where several values nest an `=` of their own
(`JobDefaults=DefCpuPerGPU=14`, `TRESBillingWeights=CPU=1,Mem=0.1667G`), so each
token is split at its *first* `=` only. `scontrol show job` is a blank-line
separated record per job; a token with no `=` continues the previous value, so a
path or job name containing a space survives. `scontrol show assoc_mgr` is keyed
by indentation — a record header at column 0, its fields at 4, and inside a QOS
record a nested `Account Limits` / `User Limits` block at 6 and 8 — and reports
every limit as `LIMIT(USAGE)`, where `N` means no limit and the parenthesised
figure is the usage counted against it.

`sacct_hist.txt` mixes two row shapes: a **job** row carries `ReqTRES`,
`AllocTRES` and `TimelimitRaw` (in minutes), while a **step** row (`123.batch`)
carries `MaxRSS` and little else, so peak memory is joined back onto the parent as
the largest across its steps. It is also two orders of magnitude larger than the
other dumps and describes the past, so the page reads it once per explicit load
rather than on the 60-second refresh; **Refresh** re-reads it.

`sacctmgr_qos.txt` is a superset of `sacct_qos.txt` but **not** positionally
compatible with it — `usagefactor` sits where `grptres` used to — so it has its own
parser and supersedes the narrow dump entirely when present. `scontrol show node`
is a blank-line separated record per node, read like `show job`.

## Layout

| File                 | Contents                                                      |
| -------------------- | ------------------------------------------------------------- |
| `web/index.html`     | page skeleton, and the job planner's form                     |
| `web/parse.js`       | the thirteen parsers and the aggregation into a dashboard model  |
| `web/plan.js`        | the priority model, cost and feasibility estimates, `sbatch`   |
| `web/app.js`         | rendering, filters, tooltips, refresh                         |
| `web/app.css`        | palette and layout                                            |
| `web/parse.test.mjs` | parser tests — `node --test web/parse.test.mjs`                |
| `web/plan.test.mjs`  | planner tests — `node --test web/plan.test.mjs`                |
| `main.py`            | static file server                                            |

`?theme=dark` or `?theme=light` in the URL forces a colour scheme, for a wall
display that should not follow the OS setting. `?tab=plan` opens the job planner
instead of the dashboard.

## The two tabs

**Cluster status** is the dashboard described above. **Plan a job** takes a job
you have not submitted yet — partition, nodes, tasks, CPUs, GPUs, memory,
walltime, array — and answers three questions from the same dumps:

- **Will it run?** Checked against the partition's own limits (`MaxNodes`,
  `MaxTime`, `MaxCPUsPerNode`, `MaxMemPerCPU`, `AllowAccounts`, `AllowQos`), the
  caps on both the job's QOS and the QOS the partition attaches — including
  `MaxWall` and `MaxTRESPerJob`, and whether `DenyOnLimit` turns a breach into a
  refusal rather than a wait — `MaxArraySize`, and **which nodes could actually
  hold it right now**, which is a placement question: cores free a handful per node
  cannot host a job that wants sixty on one.
- **What it costs.** Billing-hours from the partition's `TRESBillingWeights`,
  alongside the CPU-, GPU-, node- and memory-hours that `GrpTRESMins` caps, set
  against the account's remaining allowance. Every figure is the **whole run** —
  the billing weight of an allocation (14 units for one `l40s` GPU) is a rate, and
  quoting it beside CPU-hours invites reading a four-hour job as costing 14 rather
  than 56. Each tile writes its own multiplication out underneath for that reason,
  and the table naming the resource you are charged for gives both: the per-node
  weight, which is what decides *which* resource wins under `MAX_TRES`, and the
  billing-hours it comes to over the run, which is what the row labelled "this is
  what you pay" has to say if the label is to mean anything.
- **Starting priority.** What the job would score at submission, where that puts
  it in the queue, and — because every pending job's age factor grows at the same
  rate — which of the jobs ahead of it can never be passed by waiting.

It also writes the `#SBATCH` preamble.

### What the dashboard adds from history

**What finished jobs actually used** is the only card that can say whether a
request was *right*. On this cluster the answer is that walltime requests run
about 12× longer than needed (median 8% used) and memory about 3× larger (median
33% used) — and the memory half has a price, because `MaxMemPerCPU` satisfies a
memory request by taking more cores and `MAX_TRES` bills the core count. The card
puts that in core-hours and attributes it per account.

`scontrol show node` corroborates it independently: cores are allocated against a
total `CPULoad` far below them, and the nodes furthest adrift are the ones holding
120-odd cores at single-figure load. Two dumps sharing no fields pointing the same
way is worth more than either alone. `CPULoad` is a one-minute average that counts
threads, so the card presents it as evidence, not proof.

Over-requesting **walltime** costs nothing directly, but it stops the backfill
scheduler fitting a job into a gap, so a job asking for three days and running for
four hours waits longer than it needs to.

### Every directive is optional

The form starts with nothing switched on, and the preamble it writes is one line:
`#!/bin/bash`. That is a legal submit script, and the estimates beside it describe
the job it would actually run — because a directive you leave out is not a
directive that goes unanswered. SLURM substitutes its own value, and for several
of them that value is this cluster's configuration:

| Left out            | What SLURM uses instead                                   |
| ------------------- | --------------------------------------------------------- |
| `--partition`       | the partition marked `Default=YES`                         |
| `--time`            | the partition's `DefaultTime`, or its `MaxTime` if unset   |
| `--mem`             | its `DefMemPerCPU`, per allocated core                     |
| `--cpus-per-task`   | one core per task — or `DefCpuPerGPU` cores, for a GPU job |
| `--nodes`, `--ntasks-per-node` | one                                             |
| `--output`          | `slurm-%j.out` beside the submit script                    |
| `--account`, `--qos` | your association's defaults, which no dump reports        |

A switched-off box goes on **showing the value the estimates are using**, and
follows it: change partition and the greyed-out walltime moves from `l40s`'s four
hours to `cpu`'s twelve, ask for another GPU and the greyed-out CPUs-per-task
follows `DefCpuPerGPU` up. A form that displays one number while the cost card is
figured on another is the one thing worse than a form that shows nothing, so a
box is only allowed to display a default that is genuinely SLURM's — the rows
with no configured answer (`--gpus-per-node`, `--array`, `--mail-type`) read as
empty rather than inventing one.

Ticking a directive on therefore writes it into the preamble *at the value already
shown*, and the job does not change — it only becomes explicit, and editable. The
card lists whatever is still left out, and each tick box says on hover what
leaving it out means.

Two of those rows are guesses the page refuses to make: the default account and
the association's `DefaultQOS` live on the submitter's own association, and
neither `sacctmgr show assoc format=...,qos,...` nor any other dump here carries
them. Adding `defaultqos` to the assoc dump and a `sacctmgr -nP show user
format=user,defaultaccount` would close it. Node features, which is what
`--constraint` selects, are equally absent — `sinfo -o '%P|%N|%f'` would supply
them.

### What the request becomes

A partition can change the job you asked for, and both the cost and the priority
depend on the result. `scontrol show job` gives the answer SLURM reached for every
existing job, so these rules are checked against `NumCPUs` rather than assumed —
around 99% of running jobs, on the snapshots checked so far:

- **`MaxMemPerCPU`** is the rule that actually binds, for roughly three quarters
  of them. A memory request can only be met by taking more cores: 64 GB on `l40s`,
  where the limit is 6000 MB per core, is an 11-core job however few you asked for.
- **`DefCpuPerGPU`** is a *default*, so it applies only when `--cpus-per-task` is
  unset — an explicit one wins however small. Applying it regardless was wrong for
  about one running job in twenty. Since every directive on the form is optional,
  this is one the planner models both ways: leave `--cpus-per-task` off and a GPU
  job really does get `DefCpuPerGPU` cores per GPU; tick it on and the number you
  asked for stands, with the rule reported as a note rather than applied — because
  deleting that one line is the easiest way to multiply a job's cost.
- **`DefMemPerCPU`** fills in memory when you ask for none, per *allocated* core,
  so it is applied after the rule above and not before. The same goes for a
  `--mem-per-cpu` you set yourself: on a GPU job with no `--cpus-per-task` it is
  charged against the cores `DefCpuPerGPU` gave the job, which on `h100` is
  thirty times what the same request means on the `cpu` partition. Ticking
  `--cpus-per-task` on therefore seeds it with those cores, not with 1 — a seed
  that quietly divided the job, and its bill, by the multiplier would defeat the
  point of switching a directive on.
- **`MaxMemPerCPU`** raises the core count to cover a `--mem` request, but a
  `--mem-per-cpu` above it is rejected rather than grown into: every extra core
  would carry the same excess.
- **`DefaultTime`** fills in the walltime when you ask for none — and where a
  partition sets no `DefaultTime`, slurm.conf falls back to its `MaxTime`. A job
  with no `--time` is not an untimed job, so the cost is figured from that number.

### What a job is billed for

`PriorityFlags=MAX_TRES` bills a node for its *largest* weighted resource, not
their sum. Both halves of that are verified against SLURM's own `billing=` figure:
the formula reproduces every partition's `TRES billing=` and *every* running job's
`AllocTRES billing=` exactly.

What it comes to is **the allocated core count**, for every running job — because
`MaxMemPerCPU` raises the core count until it covers the memory, and on every
partition the memory term tops out below the CPU weight of 1, so CPU always wins.
Where it tops out is not uniform, though: `med`, `b200`, `b300`, `h100` and `h200`
size `MaxMemPerCPU` and `Mem` together so a maxed-out core carries 0.976–0.977
points of memory against 1 of CPU — just under. `a100` and `l40s` still run the
older `MaxMemPerCPU=6000` against the same `Mem=0.0833G` the 12000 MB partitions
use, so a maxed-out core there carries only 0.488 — a job pinned to the memory
limit is charged about half as much per GB on those two as the same job would be
on the rest. The conclusion is unaffected (0.488 is still under 1, so CPU still
drives the bill everywhere), but the two partitions are not priced the same as
the other five. Either way, memory is not billed directly; it is billed *through*
the cores it obliges you to take.

A *pending* job can still show a memory-driven `ReqTRES billing=`, because that
figure is computed before the allocation absorbs the memory. The planner reports
the allocated figure, which is what you are actually charged.

### Where the priority weights come from

`scontrol show config` supplies them directly, and the page says so rather than
implying it worked them out:

```
priority = floor( age + jobsize )
age      = PriorityWeightAge x min(1, seconds_since_AccrueTime / PriorityMaxAge)
jobsize  = PriorityWeightJobSize / 2 x (nodes/node_record_count + cpus/cluster_cpus)
```

On this cluster that is age 5000 over 7 days and job size 5000 over 12128 cores.
It reproduces `sprio`'s own `JOBSIZE` column **to within one point for every row
it can be scored against**, and exactly for 95–98% of them depending on the
snapshot; the residual is how SLURM rounds a factor for display. The page prints
the live figure rather than this one — counts here are from whichever dump was in
`data/` at the time and will drift.

Three things are still not simply read off:

- **`node_record_count` is fitted**, because no dump reports it. Both `sinfo` and
  `scontrol show partition` list only nodes belonging to a partition, which comes
  to 103 here; the job-size column needs 105. Two nodes are configured and
  unassigned.
- **Only running jobs can be scored.** `PriorityFlags=CALCULATE_RUNNING` makes
  `sprio` list running jobs too, and for those `NumCPUs` is the count SLURM
  allocated and costed the factor against. For a *pending* job `NumCPUs` is still
  only the request — byte-identical to `squeue`'s `%C`, so neither dump helps —
  while the factor is computed against the allocation the scheduler projects for
  it. Those rows are excluded from the agreement figure rather than counted as
  misses; nothing available reproduces them (`NumCPUs` alone got 62% on the
  snapshot checked, and adding the allocation rules got 70%).
- **A configured weight is not an effective one.** `PriorityWeightFairShare` is
  20000 — four times the age weight — but every account's computed fair-share is
  `0.000000` in `sshare`, so it contributes nothing to any pending job. The page
  names any factor in that state instead of letting the weight imply otherwise.
- **Waiting is not the same as ageing.** The age factor counts from `AccrueTime`,
  not from submission, and a job held by a dependency or a limit has none: it earns
  no age priority and will not climb the queue however long it sits — on this
  cluster consistently one pending job in eight, all of them dependency-held. The
  priority queue shows both columns.

Because job size spans roughly 24–50 against an age weight of 5000, the queue is
very nearly first-in-first-out: submitting earlier beats asking for less.

Without the two `scontrol` dumps the page falls back to recovering the weights
from `sprio` itself — the ratio of its weighted to its normalized `AGE` column
gives `PriorityWeightAge`, and a robust fit of the `JOBSIZE` column gives the rest
— and labels every value with which of the two it came from.

## How the files are used together

`squeue` drives the dashboard: it lists every job, the partitions it requested,
and its current priority, so the queue is complete and partition attribution is
stated rather than inferred. `sprio` supplies only the *breakdown* of each
priority into factors, joined per (job, partition) — a job pending in four
partitions has four sprio rows and is ranked separately in each. Where `sprio`
has no row (it omits jobs it will not schedule, such as those with an
unsatisfiable dependency) the job still appears with its priority, marked *no
breakdown*.

Because `squeue` is the fresher and more complete file, its priority is what
orders the queue.

`sinfo` supplies node state and, through `%N`, node identity — so a node in two
partitions is counted once in cluster totals, and drained hosts are named. `%C`,
`%G` and `%m` give the capacity side: how many cores and GPUs each partition
*holds*, against what running jobs *request*. `sshare` is used only for the
per-account share and in-flight usage table.

## What the current dumps cannot tell you

The dashboard reports each of these in its own "Data notes" section rather than
hiding it:

- **`sinfo` reports configured GRES, not allocated GRES.** There is no `%`
  specifier for GPUs currently in use, so GPU utilisation is derived from what
  running jobs request (`squeue`'s `%b`). A GPU held by an idle interactive
  allocation is therefore not counted as in use, and the figure is a floor.
- **A maintenance node's cores are reported as *idle*.** `sinfo`'s
  `CPUS(A/I/O/T)` puts them in the I column even though nothing can be scheduled
  there, so the dashboard folds the idle cores of any drained, down or
  maintenance node into "unavailable". Without that, idle-core counts read high —
  on this cluster by 224 cores.
- **Not every pending job has an estimated start time.** The backfill scheduler
  only computes one for jobs it can already place; the rest show `-`.
- **The CPU count SLURM costed a *pending* job against is in none of these files.**
  `scontrol show job` settles it for running jobs — `NumCPUs` is the allocation —
  but for a pending job `NumCPUs` is only the request, byte-identical to `squeue`'s
  `%C`, while the factor is computed against the allocation the scheduler projects.
  Those rows are excluded from the priority model's agreement figure rather than
  counted against it.
- **`node_record_count` is in none of these files.** `sinfo` and `scontrol show
  partition` both list only nodes that belong to a partition, so a configured but
  unassigned node is invisible — and the job-size factor divides by the full
  count. It is fitted from `sprio`'s `JOBSIZE` column instead.
- **Which limit is binding no longer has to be guessed.** `scontrol show
  assoc_mgr` reports each limit together with its usage, so the cap holding an
  account back is read rather than matched by shape — and a `GrpTRESMins` budget
  finally has a consumed figure, which `sshare` only aggregates into one weighted
  `RawUsage` number. The dashboard also uses it for a forward-looking view: which
  limits are near their ceiling before anything is blocked.
- **A configured priority weight need not be an effective one.**
  `PriorityWeightFairShare` is 20000 here, yet every account's computed fair-share
  is `0.000000`, so the factor contributes nothing. Reading the config alone would
  give the wrong picture; the page cross-checks each weight against what `sprio`
  actually awards.
- **`sprio`'s `%a` is normalized age, not account** — a mistake in an earlier
  version of this file. The account now comes from `squeue`'s `%a`, which is the
  real thing. The normalized column is not wasted: it shows in the
  priority-composition tooltips.
- **The dumps are not simultaneous.** Priorities differ between `sprio.txt` and
  `squeue.txt` for almost every job whenever the two are captured minutes apart,
  because the age factor grows continuously. Dump `sinfo`, `squeue` and `sprio`
  together.
