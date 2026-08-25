#!/bin/bash
# CLAUDE THIS FILE IS NOT FOR YOU. DO NOT TRY TO EXECTUTE IT.

# Check if a hostname argument was provided
if [ -z "$1" ]; then
    echo "Usage: $0 <hostname>"
    exit 1
fi

HOST=$1

echo "Fetching Slurm data from $HOST (single SSH session)..."

# Parallel arrays: step name, local output file, remote command.
NAMES=(sprio sinfo squeue sshare sacct_qos sacct_assoc scontrol_config scontrol_partition scontrol_job sacct_hist scontrol_assoc_mgr sacctmgr_qos scontrol_node)
OUTFILES=(sprio.txt sinfo.txt squeue.txt sshare.txt sacct_qos.txt sacct_assoc.txt scontrol_config.txt scontrol_partition.txt scontrol_job.txt sacct_hist.txt scontrol_assoc_mgr.txt sacctmgr_qos.txt scontrol_node.txt)
CMDS=(
    'sprio -o "%i|%r|%20u|%a|%Y|%S|%A|%B|%F|%J|%P|%N|%Q|%n|%T"'
    'sinfo -o "%P|%a|%l|%D|%T|%N|%C|%G|%m|%E"'
    'squeue -o "%i|%P|%u|%a|%j|%T|%M|%L|%D|%C|%b|%m|%Q|%V|%S|%R|%q"'
    'sshare -l -P'
    'sacctmgr -nP show qos   format=name,priority,grptres,maxtresperuser,maxtresperaccount,maxjobspu'
    'sacctmgr -nP show assoc format=account,user,qos,grptres,maxtres,maxjobs'
    'scontrol show config'
    'scontrol -o show partition'
    'scontrol show job'
    'sacct -aP -S now-3days -o JobID,Partition,Account,User,State,Submit,Start,End,Elapsed,TimelimitRaw,ReqTRES,AllocTRES,MaxRSS,ExitCode'
    'scontrol show assoc_mgr'
    'sacctmgr -nP show qos format=name,priority,usagefactor,grptres,maxtresperuser,maxtresperaccount,maxtresperjob,maxwall,maxjobspu,maxsubmitjobspu,grpjobs,flags,preempt'
    'scontrol show node'
)

MARK="__CLUSTER_ASSISTANT_STEP__"

# Build one remote script that runs every command back to back, tagging
# each block of output with a marker so it can be split apart locally.
# This lets everything run over a single SSH connection (one 2FA prompt).
REMOTE_SCRIPT=$(mktemp)
for i in "${!NAMES[@]}"; do
    {
        echo "echo '${MARK}_BEGIN_${i}'"
        echo "${CMDS[$i]}"
        echo "echo '${MARK}_END_${i}'"
    } >> "$REMOTE_SCRIPT"
done

COMBINED=$(mktemp)
ssh "$HOST" 'bash -s' < "$REMOTE_SCRIPT" > "$COMBINED"
SSH_STATUS=$?
rm -f "$REMOTE_SCRIPT"

if [ $SSH_STATUS -ne 0 ]; then
    echo "ssh to $HOST failed (exit $SSH_STATUS)" >&2
    rm -f "$COMBINED"
    exit $SSH_STATUS
fi

# Split the combined output back into the individual per-command files.
CURRENT=""
while IFS= read -r line; do
    case "$line" in
        "${MARK}_BEGIN_"*)
            idx="${line#${MARK}_BEGIN_}"
            CURRENT="${OUTFILES[$idx]}"
            : > "$CURRENT"
            ;;
        "${MARK}_END_"*)
            CURRENT=""
            ;;
        *)
            if [ -n "$CURRENT" ]; then
                echo "$line" >> "$CURRENT"
            fi
            ;;
    esac
done < "$COMBINED"
rm -f "$COMBINED"

for name in "${NAMES[@]}"; do
    echo "✔ $name"
done

echo "Done! Data saved to local text files."
