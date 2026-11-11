# Sizes of everything under a folder, down to a depth, biggest first. Run with bash.
# $1 folder  $2 depth  $3 seconds before giving up  $4 most rows to report  $5 parallel jobs (1 = one at a time)
# $6 hard deadline in seconds (0 = none): no step runs past it, whatever is left of $3 when a step starts.
#    (A step that ignores TERM gets KILL 5 s later: every timeout here has -k 5.)
# Output: "RESULT=ok", then NUL-separated records, then "@@KEY=value" trailer records. Names may hold any byte
# except NUL, so nothing here is newline-split. Two shapes of record:
#   serial:   "size<TAB>type<TAB>path"                 (type d/f/l/o), biggest first, at most $4 rows; no dates
#   parallel: "A<TAB>type<TAB>bytes<TAB>mtime<TAB>path"   own size and own modification time of one entry
#             "T<TAB>bytes<TAB>path"                   total of a whole folder at the depth limit
#             "S<TAB>bytes<TAB>mtime<TAB>folder"       small files directly in a folder: bytes summed, newest mtime
#             "N<TAB>mtime<TAB>path"                   newest mtime of anything in a folder at the depth limit
#   mtime: whole seconds since 1970 (find's %T@ without the fraction; symlinks their own), or "-" when unknown.
#   Records from before dates were added have no mtime field (A, S); the dashboard reads both: a path always
#   starts with "/", an mtime never does.
#   The dashboard adds these up into folder totals and newest dates (see parseScanOutput). Same sizes as the
#   serial scan.
export LC_ALL=C
P=$1
D=$2
LIMIT=$3
MAXN=$4
PAR=${5:-1}
DEADLINE=${6:-0}
T0=$SECONDS
# $1 seconds a step wants: at most what is left before the deadline (at least 1).
cap() {
  if [ "$DEADLINE" -gt 0 ] 2>/dev/null; then
    c=$((DEADLINE - (SECONDS - T0)))
    [ "$c" -ge 1 ] || c=1
    [ "$1" -le "$c" ] || { echo "$c"; return; }
  fi
  echo "$1"
}
TAB=$(printf '\t')
[ -d "$P" ] || fail not-found "That folder does not exist on this Spark"
if ERRF=$(mktemp 2>/dev/null); then
  TMPS="$ERRF"
else
  ERRF=/dev/null
  TMPS=""
fi
WORK=""
cleanup() {
  [ -z "$TMPS" ] || rm -f "$TMPS"
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap cleanup EXIT
# Stopped from the dashboard: the steps get the same signal; leave through the EXIT trap so temporary files go.
trap 'exit 143' TERM HUP INT
# Be gentle: a scan must not slow down a model that is loading or serving.
LOW=""
command -v nice >/dev/null 2>&1 && LOW="nice -n 15"
command -v ionice >/dev/null 2>&1 && LOW="$LOW ionice -c 2 -n 7"

# Folders at the depth limit are measured in parallel (a disk answers many requests at once much faster
# than one after another); everything shallower is added up from own sizes. Small files are summed per
# folder by perl, so the answer stays small however many files there are.
#
# Hard links: every size above counts each link (`du -l`), so the numbers do not depend on the order folders
# are visited. Then every file with more than one link is looked at on its own: perl groups the links of
# one inode (device + inode number), and for each folder that holds some of them works out the bytes once
# (not once per link) and how many of those bytes are "shared" (the inode has links outside that folder, so
# deleting the folder would not free them). The dashboard applies that correction (see parseScanOutput).
#
# Returns 1, having printed nothing, when this way does not apply (no perl, too many entries, a listing cut
# off by the time limit): the caller then scans one at a time.
parallel_scan() {
  [ "$PAR" -gt 1 ] 2>/dev/null || return 1
  command -v perl >/dev/null 2>&1 || return 1
  command -v xargs >/dev/null 2>&1 || return 1
  WORK=$(mktemp -d 2>/dev/null) || return 1
  DEV=$(stat -c %d -- "$P" 2>/dev/null) || return 1
  NPROC=$(nproc 2>/dev/null || echo 4)
  [ "$PAR" -le "$NPROC" ] || PAR=$NPROC
  START=$SECONDS
  # One pass over the shallow part: perl splits it into the folders to measure (units) and everything else.
  # Fields: depth, type, device, inode, links, 512-byte blocks, modification time (%T@), path.
  # shellcheck disable=SC2016
  PL1='
    $/ = "\0"; $| = 0; my ($units, $atoms, %small, %smallmt, $dev, $depthmax, $dir) = (0, 0);
    ($dev, $depthmax, $dir) = @ARGV;
    open(my $uf, ">", "$dir/units") or exit 3; open(my $af, ">", "$dir/atoms") or exit 3; open(my $mf, ">", "$dir/multi") or exit 3;
    while (my $r = <STDIN>) {
      chomp $r; my ($depth, $y, $d, $ino, $nl, $blocks, $tm, $path) = split(/\t/, $r, 8); my $bytes = $blocks * 512;
      my $mt = $tm =~ /^(\d+)/ ? $1 : "-";
      if ($y eq "d" && $depth == $depthmax) { if ($d eq $dev) { print $uf $path, "\0"; $units++; } next; }
      if ($y eq "f" && $nl > 1) { print $mf "L\t$d\t$ino\t$nl\t$blocks\t$path\0"; if ($bytes >= 1048576) { print $af "X\t$path\0"; $atoms++; } }
      if ($y ne "d" && $depth > 0 && $bytes < 1048576) {
        (my $parent = $path) =~ s{/[^/]*$}{}; $parent = "/" if $parent eq ""; $small{$parent} += $bytes;
        $smallmt{$parent} = $mt if $mt ne "-" && (!defined $smallmt{$parent} || $mt > $smallmt{$parent});
        next;
      }
      my $t = $y eq "d" || $y eq "f" || $y eq "l" ? $y : "o";
      print $af "A\t$t\t$bytes\t$mt\t$path\0"; $atoms++;
    }
    for my $p (keys %small) { print $af "S\t$small{$p}\t" . ($smallmt{$p} // "-") . "\t$p\0"; $atoms++; }
    close $uf; close $af; close $mf;
    open(my $cf, ">", "$dir/counts") or exit 3; print $cf "$units $atoms\n"; close $cf;
  '
  timeout -k 5 "$(cap "$LIMIT")" $LOW find "$P" -xdev -mindepth 0 -maxdepth "$D" -printf '%d\t%y\t%D\t%i\t%n\t%b\t%T@\t%p\0' 2>>"$ERRF" \
    | perl -e "$PL1" "$DEV" "$D" "$WORK"
  # A pipeline reports its last stage only: perl would call a cut-off listing a success. If find was stopped
  # by the time limit, or perl failed, nothing is reported from here and the serial scan takes over.
  PIPE_RC=("${PIPESTATUS[@]}")
  # (124: stopped by the time limit; 137: killed after it, see -k.)
  [ "${PIPE_RC[0]}" != 124 ] && [ "${PIPE_RC[0]}" != 137 ] && [ "${PIPE_RC[1]}" = 0 ] || return 1
  read -r NUNITS NATOMS < "$WORK/counts" || return 1
  # Too many entries for this way to pay off or to report: scan one at a time instead.
  [ "$NUNITS" -le 50000 ] && [ "$NATOMS" -le 150000 ] || return 1
  REMAIN=$((LIMIT - (SECONDS - START)))
  [ "$REMAIN" -ge 30 ] || REMAIN=30
  RC=0
  if [ "$NUNITS" -gt 0 ]; then
    # Newest modification time per folder, worked out in the same walk as the multi-link files below: find's
    # "," runs both parts for every entry, and %H is the folder it was found under. Perl keeps one running
    # maximum per folder, so nothing is held but those few numbers. The "E" record after find says find ran
    # to the end (errors such as an unreadable folder are fine, like for `find` itself); a walk that was cut
    # short reports no date at all rather than an older one.
    # shellcheck disable=SC2016
    PLN='
      $/ = "\0"; my (%mx, $ok);
      while (my $r = <STDIN>) {
        chomp $r; my ($t, $h) = split(/\t/, $r, 2);
        if ($t eq "E") { $ok = defined $h && $h =~ /^\d+$/ && $h < 128; next; }
        next unless defined $h && $t =~ /^(\d+)/;
        $mx{$h} = $1 if !defined $mx{$h} || $1 > $mx{$h};
      }
      exit 0 unless $ok;
      print "N\t$mx{$_}\t$_\0" for keys %mx;
    '
    printf '%s' "$PLN" > "$WORK/newest.pl" || return 1
    # Each worker writes its own files (sizes, multi-link files, dates, errors): many workers sharing one pipe
    # could interleave their records in the middle. Sizes first, then the multi-link files and dates in the
    # same pass so the second look at a folder is served from the disk cache.
    # shellcheck disable=SC2016
    WORKER='W=$1; shift; o="$W/w.$$"
      du -s -l -x -B1 --null -- "$@" 2>"$o.e" | sed -z "s/^/T\t/" > "$o.t"
      { find "$@" -xdev \( -type f -links +1 -fprintf "$o.l" "L\t%D\t%i\t%n\t%b\t%p\0" \) , -printf "%T@\t%H\0" 2>>"$o.e"; printf "E\t%s\0" "$?"; } \
        | perl "$W/newest.pl" > "$o.n"'
    # shellcheck disable=SC2086
    timeout -k 5 "$(cap "$REMAIN")" xargs -0 -r -a "$WORK/units" -n 16 -P "$PAR" $LOW sh -c "$WORKER" sparkdash-unit "$WORK"
    RC=$?
    case "$RC" in 124 | 137) RC=124 ;; *) RC=0 ;; esac
  fi
  # Per folder: bytes counted once, bytes counted per link, and shared bytes (see above). A failure here
  # leaves the sizes as they are (each link counted) and says so, rather than failing the scan.
  # shellcheck disable=SC2016
  PL2='
    $/ = "\0"; my ($root, $dmax) = @ARGV; my (%occ, %once, %shared, %cnt, $key, $nl, $bytes, @links);
    my $fin = sub {
      return unless defined $key;
      %cnt = ();
      for my $path (@links) {
        my $rel = $root eq "/" ? substr($path, 1) : substr($path, length($root) + 1);
        my @c = split(m{/}, $rel); my $n = $#c; my $cur = $root; $cnt{$cur}++;
        my $lim = $n < $dmax ? $n : $dmax;
        for (my $i = 0; $i < $lim; $i++) { $cur = ($cur eq "/" ? "/" : "$cur/") . $c[$i]; $cnt{$cur}++; }
      }
      for my $f (keys %cnt) { $occ{$f} += $cnt{$f} * $bytes; $once{$f} += $bytes; $shared{$f} += $bytes if $cnt{$f} < $nl; }
    };
    while (my $r = <STDIN>) {
      chomp $r; my (undef, $d, $ino, $links, $blocks, $path) = split(/\t/, $r, 6);
      my $k = "$d:$ino";
      if (!defined $key || $k ne $key) { $fin->(); $key = $k; $nl = $links; $bytes = $blocks * 512; @links = (); }
      push @links, $path;
    }
    $fin->();
    print "M\t$occ{$_}\t$once{$_}\t" . ($shared{$_} // 0) . "\t$_\0" for keys %occ;
  '
  HL=exact
  cat "$WORK"/w.*.l "$WORK/multi" 2>/dev/null \
    | timeout -k 5 "$(cap "$REMAIN")" sort -z -t "$TAB" -k2,3 -S 256M -T "$WORK" \
    | perl -e "$PL2" "$P" "$D" > "$WORK/hardlinks"
  HL_RC=("${PIPESTATUS[@]}")
  # cat may find no multi-link files at all (that is fine); sort and perl must have succeeded.
  [ "${HL_RC[1]}" = 0 ] && [ "${HL_RC[2]}" = 0 ] || HL=failed
  printf 'RESULT=ok\n'
  cat "$WORK/atoms"
  cat "$WORK"/w.*.t 2>/dev/null
  cat "$WORK"/w.*.n 2>/dev/null
  [ "$HL" != exact ] || cat "$WORK/hardlinks"
  UNREAD=$(cat "$WORK"/w.*.e "$ERRF" 2>/dev/null | grep -c 'Permission denied' || true)
  printf '@@MODE=parallel\0@@HARDLINKS=%s\0@@RC=%s\0@@UNREADABLE=%s\0' "$HL" "$RC" "${UNREAD:-0}"
  return 0
}

serial_scan() {
  printf 'RESULT=ok\n'
  # What is left of the time limit (a parallel attempt may have used some of it).
  SLEFT=$((LIMIT - (SECONDS - T0)))
  [ "$SLEFT" -ge 30 ] || SLEFT=30
  # shellcheck disable=SC2086
  timeout -k 5 "$(cap "$SLEFT")" $LOW du -a -x -B1 --max-depth="$D" --null -- "$P" 2>"$ERRF" \
    | sort -z -t "$TAB" -k1,1nr \
    | head -z -n "$MAXN" \
    | while IFS="$TAB" read -r -d '' size path; do
        if [ -L "$path" ]; then t=l
        elif [ -d "$path" ]; then t=d
        elif [ -f "$path" ]; then t=f
        else t=o
        fi
        printf '%s\t%s\t%s\0' "$size" "$t" "$path"
      done
  RC=${PIPESTATUS[0]}
  [ "$RC" != 137 ] || RC=124
  UNREAD=$(grep -c 'Permission denied' "$ERRF" 2>/dev/null || true)
  printf '@@MODE=serial\0@@HARDLINKS=approx\0@@RC=%s\0@@UNREADABLE=%s\0' "$RC" "${UNREAD:-0}"
}

parallel_scan || serial_scan
