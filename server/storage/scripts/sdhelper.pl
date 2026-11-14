# SparkDash unit-side helper for delete v2 (stage-then-delete) and the quarantine records.
# Shipped inside the shell programs as $SD_PL and run as `perl -e "$SD_PL" -- <op> <args...>`.
# Uses only modules that ship in perl-base, so it runs on any Debian/Ubuntu system (DGX OS included).
# Ops print plain lines on stdout; nothing here reads a path from anywhere but its arguments or stdin.
use strict;
use POSIX ();
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_DIRECTORY O_NOFOLLOW);
use IO::Handle;

my %ERRNAME;
for my $n (qw(EPERM ENOENT EACCES EBUSY EEXIST EXDEV ENOTDIR EISDIR EINVAL EROFS ENOSYS ENOTEMPTY ENOSPC ELOOP)) {
  no strict 'refs';
  my $v = eval { &{"POSIX::$n"}() };
  $ERRNAME{$v} = $n if defined $v;
}
sub errname { my $e = 0 + $_[0]; return $ERRNAME{$e} // "E$e"; }

# "." is the working directory (AT_FDCWD), a number is an inherited directory descriptor.
sub at_fd { my ($f) = @_; return $f eq '.' ? -100 : int($f); }

# renameat2(..., RENAME_NOREPLACE): '' when done, else the errno name. Never copies anything.
sub rename_nr {
  my ($nr, $ofd, $old, $nfd, $new) = @_;
  return 'ENOSYS' unless $nr;
  my ($o, $n) = ("$old", "$new");    # fresh string scalars: syscall passes them as pointers
  my $r = syscall(0 + $nr, at_fd($ofd), $o, at_fd($nfd), $n, 1);
  return $r == 0 ? '' : errname($!);
}

sub type_of { return -l _ ? 'l' : -d _ ? 'd' : -f _ ? 'f' : 'o'; }

# One printable line, short enough for a message.
sub shown {
  my ($s) = @_;
  $s =~ s/[\x00-\x1f\x7f]/?/g;
  $s = substr($s, 0, 117) . '...' if length($s) > 120;
  return $s;
}

sub mounts {
  open(my $f, '<', '/proc/self/mountinfo') or return;
  my @m;
  while (my $l = <$f>) {
    my @x = split / /, $l;
    next unless @x > 4;
    (my $mp = $x[4]) =~ s/\\([0-7]{3})/chr(oct($1))/ge;
    push @m, $mp;
  }
  return @m;
}

sub cwd_abs {
  my $c = readlink('/proc/self/cwd');
  return defined $c ? $c : '';
}

# True when nobody but root and the account belongs to group $gid (a user private group, as Ubuntu makes
# for every account): then group-writable means the same as writable by the account. Local data only.
my %GROUP_OK;
sub group_only_acct {
  my ($gid, $acct) = @_;
  return $GROUP_OK{$gid} if exists $GROUP_OK{$gid};
  my $me = getpwuid($acct) // '';
  my @g = getgrgid($gid);
  my $ok = @g ? 1 : 0;
  for my $n (split ' ', $g[3] // '') { $ok = 0 unless $n eq $me || $n eq 'root'; }
  if ($ok) {
    setpwent();
    while (my @pw = getpwent()) { $ok = 0 if $pw[3] == $gid && $pw[2] != 0 && $pw[2] != $acct; }
    endpwent();
  }
  return $GROUP_OK{$gid} = $ok;
}

# Who other than root and the account may write to a folder with these lstat fields, from its mode:
# '' (nobody), 'group' or 'everyone'.
sub mode_writers {
  my ($s, $acct) = @_;
  my $mode = $s->[2];
  return 'everyone' if $mode & 002;
  return 'group' if ($mode & 020) && !group_only_acct($s->[5], $acct);
  return '';
}

# ─── Pinning a private directory ─────────────────────────────

# Why `$p` cannot be part of a private path, or ''. Every component must be a real folder owned by root or
# the acting account; above the last one, writable by other accounts is allowed only with the sticky bit.
sub dir_problem {
  my ($p, $uid, $final) = @_;
  my @s = lstat($p);
  return "$p cannot be read: $!" unless @s;
  return "$p is a symbolic link" if -l _;
  return "$p is not a folder" unless -d _;
  my ($mode, $owner) = ($s[2] & 07777, $s[4]);
  return "$p belongs to another account" unless $owner == 0 || $owner == $uid;
  if ($final) {
    if ($mode & 077) {
      return "$p is open to other accounts" unless $owner == $> || $> == 0;
      sysopen(my $h, $p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or return "$p cannot be opened: $!";
      chmod(0700, $h) or return "$p cannot be made private: $!";
    }
  } elsif (mode_writers(\@s, $uid) ne '' && !($mode & 01000)) {
    return "$p can be changed by other accounts";
  }
  return '';
}

# Create one folder. As root inside a folder the acting account owns, it is created as that account, so a
# swapped path can only ever lead to something the account could do itself.
sub make_dir {
  my ($p, $parent, $uid, $gid) = @_;
  my @ps = lstat($parent);
  if ($> == 0 && $uid != 0 && @ps && $ps[4] == $uid) {
    my $pid = fork();
    return "cannot fork: $!" unless defined $pid;
    if ($pid == 0) {
      $) = "$gid $gid";
      POSIX::setgid($gid);
      POSIX::setuid($uid);
      POSIX::_exit(1) unless $> == $uid;
      POSIX::_exit(mkdir($p, 0700) || $!{EEXIST} ? 0 : 1);
    }
    waitpid($pid, 0);
    return $? == 0 ? '' : "cannot create $p";
  }
  unless (mkdir($p, 0700)) {
    return "cannot create $p: $!" unless $!{EEXIST};
  }
  if ($> == 0 && $uid != 0) {
    # Best effort: a folder root keeps is just as private.
    if (sysopen(my $h, $p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)) { chown($uid, $gid, $h); }
  }
  return '';
}

sub pin {
  my ($path, $uid, $gid, $maxc) = @_;
  return 'not a clean absolute path' unless $path =~ m{^/} && $path !~ m{//} && $path !~ m{/\.\.?(/|$)};
  my @parts = grep { length } split m{/}, $path;
  return 'not a folder below /' unless @parts;
  my $why = dir_problem('/', $uid, 0);
  return $why if $why;
  my $cur = '';
  for my $i (0 .. $#parts) {
    my $parent = $cur eq '' ? '/' : $cur;
    $cur .= "/$parts[$i]";
    unless (lstat($cur)) {
      return "$cur cannot be read: $!" unless $!{ENOENT};
      return "$cur does not exist" if $#parts - $i >= $maxc;
      $why = make_dir($cur, $parent, $uid, $gid);
      return $why if $why;
    }
    $why = dir_problem($cur, $uid, $i == $#parts);
    return $why if $why;
  }
  my @s = lstat($cur);
  print "$s[0]:$s[1]\n";
  return '';
}

# ─── Protected identities ────────────────────────────────────

# Paths on stdin (one per line, "label<TAB>path" or just a path) to "dev:ino<TAB>label<TAB>real path" for
# those that exist. Symbolic links are followed: a relocated Docker root is protected where it really lives.
# `$mode` "trees": folders nothing may be put inside, so home folders (put back into all the time) are left out.
sub ids {
  my ($mode) = @_;
  require Cwd;
  my %seen;
  my $emit = sub {
    my ($path, $label) = @_;
    return unless defined $path && $path =~ m{^/};
    my @s = stat($path);
    return unless @s;
    my $id = "$s[0]:$s[1]";
    return if $seen{$id}++;
    my $real = Cwd::abs_path($path) // '';
    $real = '' if $real =~ /[\x00-\x1f]/;
    print "$id\t" . shown($label // $path) . "\t$real\n";
  };
  while (my $l = <STDIN>) {
    chomp $l;
    next if $l eq '';
    my ($label, $path) = $l =~ /\t/ ? split(/\t/, $l, 2) : (undef, $l);
    $emit->($path, $label);
  }
  # Every person's home folder, and root's.
  while (($mode // '') ne 'trees' and my @pw = getpwent()) {
    my ($name, $uid, $dir) = @pw[0, 2, 7];
    next unless $uid == 0 || ($uid >= 1000 && $uid != 65534);
    next if !$dir || $dir eq '/' || $dir =~ m{^/nonexistent};
    $emit->($dir, "the home folder of $name");
  }
  endpwent();
  # Docker and containerd keep their data where their configuration says.
  if (open(my $f, '<', '/etc/docker/daemon.json')) {
    local $/;
    my $t = <$f> // '';
    $emit->($1, "Docker's storage ($1)") if $t =~ /"data-root"\s*:\s*"([^"]+)"/;
  }
  if (open(my $f, '<', '/etc/containerd/config.toml')) {
    while (my $l = <$f>) { $emit->($1, "containerd's storage ($1)") if $l =~ /^\s*root\s*=\s*"([^"]+)"/; }
  }
}

# ─── Checks on the staged tree ───────────────────────────────

# 1: an access list lets someone other than root or the account write here; 0: none; -1: cannot tell.
sub acl_write_others {
  my ($p, $acct, $nr) = @_;
  return -1 unless $nr;
  my ($path, $name, $buf) = ("$p", 'system.posix_acl_access', "\0" x 8192);    # syscall needs writable scalars
  my $n = syscall(0 + $nr, $path, $name, $buf, 8192);
  if ($n < 0) {
    return 0 if $!{ENODATA} || $!{EOPNOTSUPP};
    return -1;
  }
  my $data = substr($buf, 0, $n);
  return -1 if length($data) < 4 || unpack('V', $data) != 2;
  my ($mask, $writer) = (7, 0);
  for (my $o = 4; $o + 8 <= length($data); $o += 8) {
    my ($tag, $perm, $id) = unpack('v v V', substr($data, $o, 8));
    if ($tag == 0x10) { $mask = $perm; }
    elsif ($tag == 0x02) { $writer = 1 if ($perm & 2) && $id != 0 && $id != $acct; }
    elsif ($tag == 0x08) { $writer = 1 if ($perm & 2) && !group_only_acct($id, $acct); }
  }
  return $writer && ($mask & 2) ? 1 : 0;
}

sub refuse {
  my ($code, $msg) = @_;
  print "REFUSE\t$code\t" . shown($msg) . "\n";
  exit 0;
}

# check <name> <dev:ino> <privileged 0|1> <account uid> <lgetxattr nr or ''> ; stdin: protected "dev:ino<TAB>label".
# Run with the working directory pinned to the folder holding <name>. Prints OK or REFUSE<TAB>code<TAB>why.
sub check {
  my ($rel, $want, $priv, $acct, $xnr) = @_;
  my %prot;
  while (my $l = <STDIN>) {
    chomp $l;
    my ($id, $label) = split /\t/, $l, 3;
    $prot{$id} //= $label if $id;
  }
  my @r = lstat($rel);
  refuse('changed', 'The item changed while it was being deleted, so nothing was deleted.') unless @r && "$r[0]:$r[1]" eq $want;
  my $rootdev = $r[0];
  my $base = cwd_abs();
  my $abs = ($base eq '/' ? '' : $base) . "/$rel";
  for my $mp (mounts()) {
    refuse('mountpoint', 'This is a separate disk or mount point, not a folder. It cannot be deleted from here.') if $mp eq $abs;
    if (index($mp, "$abs/") == 0) {
      refuse('mountpoint', 'It contains a separate disk or mount point (' . substr($mp, length($abs) + 1)
        . '), so it cannot be deleted from here. Unmount it first.');
    }
  }
  my @stack = ([$rel, '']);
  while (my $e = pop @stack) {
    my ($p, $where) = @$e;
    my @s = lstat($p);
    next unless @s;
    my $top = $where eq '';
    my $id = "$s[0]:$s[1]";
    if (exists $prot{$id}) {
      refuse('protected', "This is $prot{$id}, which is never deleted from here.") if $top;
      refuse('protected-descendant', "It contains $prot{$id} ($where), which is never deleted from here.");
    }
    refuse('mountpoint', "It contains a separate disk or mount point ($where), so it cannot be deleted from here.") if $s[0] != $rootdev;
    unless ($top) {
      my ($name) = $p =~ m{([^/]+)$};
      refuse('protected-descendant', "It contains SSH keys ($where). Deleting them can lock the dashboard out of this Spark.") if $name eq '.ssh';
      refuse('protected-descendant', "It contains SparkDash's own recovery area ($where).") if $name =~ /^\.sparkdash-(staging|trash)/;
    }
    my $dir = -d _ && !-l _;
    if ($priv) {
      my ($mode, $uid) = ($s[2] & 07777, $s[4]);
      my $what = $top ? 'The item' : $where;
      refuse('tree-writable-by-others', "$what belongs to another account (user id $uid).") unless $uid == 0 || $uid == $acct;
      if ($dir) {
        my $w = mode_writers(\@s, $acct);
        refuse('tree-writable-by-others', "$what can be changed by other accounts (it is " . ($w eq 'group' ? 'group' : 'world') . '-writable).') if $w ne '';
        my $acl = acl_write_others($p, $acct, $xnr);
        refuse('tree-writable-by-others', "$what has an access list (ACL) that lets another account write to it.") if $acl > 0;
        refuse('tree-writable-by-others', "Access lists (ACLs) cannot be checked on this Spark.") if $acl < 0;
      }
    }
    next unless $dir;
    my $dh;
    unless (opendir($dh, $p)) {
      refuse('tree-writable-by-others', "$where cannot be read, so it cannot be checked.") if $priv;
      next;    # the account cannot list it, so rm will not get inside it either
    }
    for my $n (readdir $dh) {
      next if $n eq '.' || $n eq '..';
      push @stack, ["$p/$n", $top ? $n : "$where/$n"];
    }
    closedir $dh;
  }
  print "OK\n";
}

# ─── Quarantine records ──────────────────────────────────────

my @KEYS = qw(version id state original originalHex stagingDir stagingDirHex staged stagingDevIno targetDevIno
  parentDevIno type elevated uid createdAt updatedAt reason);
my %NUM = map { $_ => 1 } qw(version uid createdAt updatedAt);

sub jstr {
  my ($s) = @_;
  $s =~ s/(["\\])/\\$1/g;
  $s =~ s/([\x00-\x1f\x7f])/sprintf('\\u%04x', ord $1)/ge;
  return "\"$s\"";
}

sub junesc {
  my ($s) = @_;
  $s =~ s/\\(u([0-9a-fA-F]{4})|.)/defined $2 ? chr(hex $2) : ($1 eq 'n' ? "\n" : $1 eq 't' ? "\t" : $1)/ge;
  return $s;
}

sub mparse {
  my ($f) = @_;
  open(my $h, '<', $f) or return;
  local $/;
  my $t = <$h>;
  close $h;
  return unless defined $t && length($t) < 65536;
  my %m;
  while ($t =~ /"([A-Za-z]+)"\s*:\s*("((?:[^"\\]|\\.)*)"|-?\d+|true|false|null)/g) {
    $m{$1} = defined $3 ? junesc($3) : $2;
  }
  for my $k (qw(original stagingDir)) {
    my $hx = $m{"${k}Hex"};
    $m{$k} = pack('H*', $hx) if defined $hx && $hx =~ /^(?:[0-9a-f]{2})+$/;
  }
  return unless ($m{version} // '') eq '1' && defined $m{id} && defined $m{original} && defined $m{stagingDir};
  return unless $m{original} =~ m{^/} && $m{stagingDir} =~ m{^/};
  return if grep { /[\x00-\x1f]/ } @m{qw(original stagingDir)};
  return \%m;
}

sub fsync_dir {
  sysopen(my $d, '.', O_RDONLY | O_DIRECTORY) or return 0;
  return $d->sync ? 1 : 0;
}

# mput <file> <uid> <gid> key=value... : merge into the record (created when missing), written durably:
# a new file, fsynced, renamed over the old one, then the folder fsynced. Run in the pinned records folder.
sub mput {
  my ($file, $uid, $gid, @kv) = @_;
  die "bad record name\n" unless $file =~ /^[0-9a-f-]{8,64}\.json$/;
  my %m = %{ mparse($file) // {} };
  for my $a (@kv) {
    my ($k, $v) = split /=/, $a, 2;
    $m{$k} = $v // '';
  }
  $m{originalHex} = unpack('H*', $m{original}) if defined $m{original};
  $m{stagingDirHex} = unpack('H*', $m{stagingDir}) if defined $m{stagingDir};
  my %known = map { $_ => 1 } @KEYS;
  my @lines;
  for my $k (@KEYS, sort grep { !$known{$_} } keys %m) {
    next unless defined $m{$k};
    my $v = $m{$k};
    my $out = $NUM{$k} && $v =~ /^\d+$/ ? $v : $k eq 'elevated' ? ($v eq 'true' || $v eq '1' ? 'true' : 'false') : jstr($v);
    push @lines, "  \"$k\": $out";
  }
  my $tmp = ".$file.tmp$$";
  unlink $tmp;
  sysopen(my $h, $tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or die "cannot write the record: $!\n";
  print $h "{\n" . join(",\n", @lines) . "\n}\n" or die "cannot write the record: $!\n";
  $h->flush or die "cannot write the record: $!\n";
  $h->sync or die "cannot save the record: $!\n";
  chown($uid, $gid, $h) if $> == 0 && $uid != 0;
  close($h) or die "cannot write the record: $!\n";
  rename($tmp, $file) or do { unlink $tmp; die "cannot save the record: $!\n" };
  fsync_dir() or die "cannot save the record folder\n";
}

sub mrm {
  my ($file) = @_;
  die "bad record name\n" unless $file =~ /^[0-9a-f-]{8,64}\.json$/;
  unlink($file) or $!{ENOENT} or die "cannot remove the record: $!\n";
  fsync_dir() or die "cannot save the record folder\n";
}

# The fields a program needs, one per line, in a fixed order.
sub mget {
  my ($file) = @_;
  my $m = mparse($file) or exit 1;
  for my $k (qw(state original stagingDir stagingDevIno targetDevIno type elevated createdAt)) {
    my $v = $m->{$k} // '';
    exit 1 if $v =~ /[\x00-\x1f]/;
    print "$v\n";
  }
}

sub hx { return unpack('H*', $_[0] // ''); }

# Every record in the working directory, with what is true on disk now:
# ITEM=id|state|elevated|type|createdAt|hex(original)|hex(staged)|hex(reason)
sub mlist {
  opendir(my $dh, '.') or return;
  my @names = sort grep { /^[0-9a-f-]{8,64}\.json$/ } readdir $dh;
  closedir $dh;
  for my $name (@names) {
    (my $id = $name) =~ s/\.json$//;
    my $m = mparse($name);
    if (!$m || $m->{id} ne $id) {
      print "ITEM=$id|unreadable|0|o|0|" . hx('') . '|' . hx(cwd_abs() . "/$name") . '|' . hx('The recovery record cannot be read.') . "\n";
      next;
    }
    my $staged = "$m->{stagingDir}/$id";
    my $state;
    my @ps = lstat($staged);
    if (@ps) {
      if ("$ps[0]:$ps[1]" ne ($m->{targetDevIno} // '')) { $state = 'unknown'; }
      elsif (($m->{state} // '') eq 'conflict') { $state = 'conflict'; }
      elsif (($m->{state} // '') eq 'deleting') { $state = 'interrupted'; }
      else { $state = 'staged'; }
    } elsif (!$!{ENOENT}) {
      $state = 'unknown';
    } else {
      my @os = lstat($m->{original});
      $state = @os && "$os[0]:$os[1]" eq ($m->{targetDevIno} // '') ? 'in-place' : 'gone';
    }
    my $el = ($m->{elevated} // '') eq 'true' ? 1 : 0;
    my $type = ($m->{type} // 'o') =~ /^[dflo]$/ ? $m->{type} : 'o';
    my $at = ($m->{createdAt} // '0') =~ /^\d+$/ ? $m->{createdAt} : 0;
    print "ITEM=$id|$state|$el|$type|$at|" . hx($m->{original}) . '|' . hx($staged) . '|' . hx($m->{reason}) . "\n";
  }
}

# ─── Dispatch ────────────────────────────────────────────────

my $op = shift(@ARGV) // '';
if ($op eq 'rn') {
  my $e = rename_nr(@ARGV);
  exit 0 if $e eq '';
  print "$e\n";
  exit 1;
} elsif ($op eq 'selftest') {
  # In the working directory: no-replace must refuse an existing name and rename to a free one.
  my $nr = shift @ARGV;
  my @n = map { ".sparkdash-selftest-$$-$_" } qw(a b c);
  unlink @n;
  my $ok = 1;
  for my $f (@n[0, 1]) {
    if (sysopen(my $h, $f, O_WRONLY | O_CREAT | O_EXCL, 0600)) { print $h $f; close $h; } else { $ok = 0; }
  }
  my $e1 = $ok ? rename_nr($nr, '.', $n[0], '.', $n[1]) : 'skip';
  my $kept = '';
  if (open(my $h, '<', $n[1])) { $kept = <$h> // ''; close $h; }
  $ok &&= $e1 eq 'EEXIST' && -e $n[0] && $kept eq $n[1];
  my $e2 = $ok ? rename_nr($nr, '.', $n[0], '.', $n[2]) : 'skip';
  $ok &&= $e2 eq '' && !-e $n[0] && -e $n[2];
  unlink @n;
  print $ok ? "OK\n" : "FAIL $e1 $e2\n";
  exit($ok ? 0 : 1);
} elsif ($op eq 'id') {
  # dev:ino<TAB>type<TAB>uid of each path, without following a final symbolic link; "-" when missing.
  my $missing = 0;
  for my $p (@ARGV) {
    my @s = lstat($p);
    if (@s) { print "$s[0]:$s[1]\t" . type_of() . "\t$s[4]\n"; } else { print "-\n"; $missing = 1; }
  }
  exit($missing ? 2 : 0);
} elsif ($op eq 'pin') {
  my $why = pin(@ARGV);
  if ($why ne '') { print shown($why) . "\n"; exit 1; }
} elsif ($op eq 'mountof') {
  my ($p) = @ARGV;
  my $best = '/';
  for my $mp (mounts()) {
    $best = $mp if ($mp eq $p || index($p, $mp eq '/' ? '/' : "$mp/") == 0) && length($mp) > length($best);
  }
  print "$best\n";
} elsif ($op eq 'mnt') {
  # Mount points at or below <name> in the working directory.
  my ($rel) = @ARGV;
  my $base = cwd_abs();
  my $abs = ($base eq '/' ? '' : $base) . "/$rel";
  for my $mp (mounts()) { print shown($mp) . "\n" if $mp eq $abs || index($mp, "$abs/") == 0; }
} elsif ($op eq 'ids') {
  ids(@ARGV);
} elsif ($op eq 'absent') {
  # 0: nothing at <path> (missing, or a component is not a folder); 1: something is there; 2: cannot tell.
  my ($p) = @ARGV;
  exit 1 if lstat($p);
  exit 0 if $!{ENOENT} || $!{ENOTDIR};
  exit 2;
} elsif ($op eq 'within') {
  # The label of the protected identity (stdin, as `ids` prints them) that <path> or one of the folders above
  # it is, compared by dev:ino so a bind mount or another name for that folder counts too.
  my ($p) = @ARGV;
  my %prot;
  while (my $l = <STDIN>) {
    chomp $l;
    my ($id, $label) = split /\t/, $l, 3;
    $prot{$id} //= $label if $id;
  }
  my $cur = $p;
  while ($cur =~ m{^/}) {
    my @s = stat($cur);
    if (@s && exists $prot{"$s[0]:$s[1]"}) { print $prot{"$s[0]:$s[1]"} . "\n"; last; }
    last if $cur eq '/';
    $cur =~ s{/[^/]*$}{};
    $cur = '/' if $cur eq '';
  }
} elsif ($op eq 'under') {
  # SELF<TAB>label when a protected identity (stdin, as `ids` prints them) is <abs> itself, IN<TAB>label when
  # one is inside it. Checked before anything moves, so a live Docker root is never even renamed.
  my ($abs) = @ARGV;
  my $in;
  while (my $l = <STDIN>) {
    chomp $l;
    my (undef, $label, $real) = split /\t/, $l, 3;
    next unless defined $real && $real ne '';
    if ($real eq $abs) { print "SELF\t$label\n"; exit 0; }
    $in //= $label if index($real, $abs eq '/' ? '/' : "$abs/") == 0;
  }
  print "IN\t$in\n" if defined $in;
} elsif ($op eq 'check') {
  check(@ARGV);
} elsif ($op eq 'mput') {
  eval { mput(@ARGV); 1 } or do { print shown($@ || 'cannot write the record') . "\n"; exit 1; };
} elsif ($op eq 'mrm') {
  eval { mrm(@ARGV); 1 } or do { print shown($@ || 'cannot remove the record') . "\n"; exit 1; };
} elsif ($op eq 'mget') {
  mget(@ARGV);
} elsif ($op eq 'mlist') {
  mlist();
} else {
  print "unknown op\n";
  exit 64;
}
exit 0;
