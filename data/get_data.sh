#!/bin/bash
# CLAUDE THIS FILE IS NOT FOR YOU. DO NOT TRY TO EXECTUTE IT.

# Check if a hostname argument was provided
if [ -z "$1" ]; then
    echo "Usage: $0 <hostname>"
    exit 1
fi

HOST=$1

echo "Fetching Slurm data from $HOST..."

run_step() {
    local name=$1
    local outfile=$2
    shift 2
    ssh "$HOST" "$@" > "$outfile"
    echo "✔ $name"
}

run_step "sprio"           sprio.txt           'sprio -o "%i|%r|%20u|%a|%Y|%S|%A|%B|%F|%J|%P|%N|%Q|%n|%T"'
run_step "sinfo"           sinfo.txt           'sinfo -o "%P|%a|%l|%D|%T|%N|%C|%G|%m|%E"'
run_step "squeue"          squeue.txt          'squeue -o "%i|%P|%u|%a|%j|%T|%M|%L|%D|%C|%b|%m|%Q|%V|%S|%R|%q"'
run_step "sshare"          sshare.txt          'sshare -l -P'
run_step "sacct_qos"       sacct_qos.txt       'sacctmgr -nP show qos   format=name,priority,grptres,maxtresperuser,maxtresperaccount,maxjobspu'
run_step "sacct_assoc"     sacct_assoc.txt     'sacctmgr -nP show assoc format=account,user,qos,grptres,maxtres,maxjobs'
run_step "scontrol_config" scontrol_config.txt 'scontrol show config'
run_step "scontrol_partition" scontrol_partition.txt 'scontrol -o show partition'
run_step "scontrol_job"    scontrol_job.txt    'scontrol show job'
run_step "sacct_hist"      sacct_hist.txt      'sacct -aP -S now-3days -o JobID,Partition,Account,User,State,Submit,Start,End,Elapsed,TimelimitRaw,ReqTRES,AllocTRES,MaxRSS,ExitCode'
run_step "scontrol_assoc_mgr" scontrol_assoc_mgr.txt 'scontrol show assoc_mgr'
run_step "sacctmgr_qos"    sacctmgr_qos.txt    'sacctmgr -nP show qos format=name,priority,usagefactor,grptres,maxtresperuser,maxtresperaccount,maxtresperjob,maxwall,maxjobspu,maxsubmitjobspu,grpjobs,flags,preempt'
run_step "scontrol_node"   scontrol_node.txt   'scontrol show node'


echo "Done! Data saved to local text files."
