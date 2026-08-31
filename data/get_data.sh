#!/bin/bash
# CLAUDE THIS FILE IS NOT FOR YOU. DO NOT TRY TO EXECTUTE IT.

usage() {
    echo "Usage: $0 <hostname> [--format txt|gz|zip]" >&2
    echo "  txt (default): write the dump files as loose .txt files" >&2
    echo "  gz:            package them into cluster_dump.tar.gz" >&2
    echo "  zip:           package them into cluster_dump.zip" >&2
    exit 1
}

HOST=""
FORMAT="txt"

while [ $# -gt 0 ]; do
    case "$1" in
        --format)
            FORMAT="$2"
            shift 2
            ;;
        --format=*)
            FORMAT="${1#--format=}"
            shift
            ;;
        -h|--help)
            usage
            ;;
        -*)
            usage
            ;;
        *)
            if [ -n "$HOST" ]; then usage; fi
            HOST="$1"
            shift
            ;;
    esac
done

[ -z "$HOST" ] && usage
case "$FORMAT" in
    txt|gz|zip) ;;
    *)
        echo "Unknown --format: $FORMAT (expected txt, gz or zip)" >&2
        exit 1
        ;;
esac
if [ "$FORMAT" = "zip" ] && ! command -v zip >/dev/null; then
    echo "--format zip needs the 'zip' command, which isn't on PATH" >&2
    exit 1
fi

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

# Files land in a scratch directory first so --format gz/zip can package them
# without ever leaving loose .txt files behind next to the archive.
OUTDIR=$(mktemp -d)

# Split the combined output back into the individual per-command files.
CURRENT=""
while IFS= read -r line; do
    case "$line" in
        "${MARK}_BEGIN_"*)
            idx="${line#${MARK}_BEGIN_}"
            CURRENT="$OUTDIR/${OUTFILES[$idx]}"
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

case "$FORMAT" in
    txt)
        mv "$OUTDIR"/*.txt .
        rm -rf "$OUTDIR"
        echo "Done! Data saved to local text files."
        ;;
    gz)
        ARCHIVE="cluster_dump.tar.gz"
        tar -czf "$ARCHIVE" -C "$OUTDIR" "${OUTFILES[@]}"
        rm -rf "$OUTDIR"
        echo "Done! Data saved to $ARCHIVE."
        ;;
    zip)
        ARCHIVE="cluster_dump.zip"
        rm -f "$ARCHIVE"
        zip -q -j "$ARCHIVE" "$OUTDIR"/*.txt
        rm -rf "$OUTDIR"
        echo "Done! Data saved to $ARCHIVE."
        ;;
esac
