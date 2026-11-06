import net from "node:net";

/** The lookup is a bounded observation, never a retained launcher configuration. */
export const NATIVE_CAPACITY_MAX_AGE_MS = 10_000;
export const NATIVE_CAPACITY_SOURCE = "tensorfold-native-dsv41-process";

/**
 * Linux native dsv41 passes its explicit --context to the shared allocator as
 * `.pool = o.context` (families/dsv41/native.zig). This is backend-specific:
 * neither a tokenizer limit nor another TensorFold family's context is a pool.
 * Only the process owning the requested listening socket can establish it.
 * The optional proc root is used by isolated fixtures, never by runtime callers.
 */
export const NATIVE_TENSORFOLD_CAPACITY_PYTHON = String.raw`import hashlib, ipaddress, json, os, pathlib, sys, time, urllib.request
ROOT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else pathlib.Path('/proc')
PORT, HOST = int(sys.argv[1]), ipaddress.ip_address(sys.argv[2])
END = time.monotonic() + 2
def check():
    if time.monotonic() > END:
        raise ValueError('lookup deadline')
def read(p, limit):
    check()
    with p.open('rb') as f:
        b = f.read(limit + 1)
    if len(b) > limit:
        raise ValueError('bounded read')
    return b
def listeners():
    out = set()
    for name in ('tcp', 'tcp6'):
        try:
            rows = read(ROOT / 'net' / name, 524288).decode().splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in rows:
            cols = line.split()
            if len(cols) < 10 or cols[3] != '0A':
                continue
            address, port = cols[1].split(':')
            if int(port, 16) != PORT:
                continue
            raw = bytes.fromhex(address)
            raw = b''.join(raw[i:i+4][::-1] for i in range(0, len(raw), 4))
            ip = ipaddress.ip_address(raw)
            if ip.version == HOST.version and (ip.is_unspecified or ip == HOST):
                out.add(cols[9])
    if len(out) != 1:
        raise ValueError('ambiguous listener')
    return out
def start(p):
    raw = read(p / 'stat', 8192).decode()
    return raw[raw.rfind(')') + 2:].split()[19]
def option(argv, name):
    values = []
    for i, value in enumerate(argv):
        if value == name:
            if i + 1 == len(argv):
                raise ValueError('missing option')
            values.append(argv[i + 1])
        elif value.startswith(name + '='):
            values.append(value[len(name)+1:])
    if len(values) != 1:
        raise ValueError('missing or repeated option')
    return values[0]
def socket_inodes(p):
    result = set()
    count = 0
    for f in (p / 'fd').iterdir():
        check()
        count += 1
        if count > 4096:
            raise ValueError('fd bound')
        try:
            link = os.readlink(f)
        except FileNotFoundError:
            continue
        if link.startswith('socket:[') and link.endswith(']'):
            result.add(link[8:-1])
    return result
def owner(bound):
    matches = []
    count = 0
    for p in ROOT.iterdir():
        check()
        if not p.name.isdigit():
            continue
        count += 1
        if count > 8192:
            raise ValueError('pid bound')
        try:
            if socket_inodes(p) & bound:
                matches.append(p)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    if len(matches) != 1:
        raise ValueError('ambiguous process')
    return matches[0]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
try:
    bound = listeners()
    p = owner(bound)
    initial = start(p)
    cmd = read(p / 'cmdline', 65536)
    argv = cmd.rstrip(bytes([0])).decode().split(chr(0))
    if len(argv) < 3 or pathlib.PurePosixPath(argv[0]).name != 'tensorfold-native' or argv[1] != 'serve':
        raise ValueError('unsupported command')
    exe = os.readlink(p / 'exe')
    exe_stat = (p / 'exe').stat()
    if pathlib.PurePosixPath(exe).name != 'tensorfold-native':
        raise ValueError('unexpected executable')
    if option(argv, '--backend') != 'cuda' or int(option(argv, '--port')) != PORT:
        raise ValueError('unsupported native server')
    window = option(argv, '--context')
    if not window.isdecimal() or not 0 < int(window) <= 9007199254740991:
        raise ValueError('invalid context')
    model = pathlib.PurePosixPath(argv[2])
    if not model.is_absolute() or '..' in model.parts:
        raise ValueError('invalid model root')
    config_path = p / 'root' / str(model).lstrip('/') / 'config.json'
    config_raw = read(config_path, 262144)
    config = json.loads(config_raw)
    if config.get('model_type') != 'deepseek_v41' or config.get('architectures') != ['DeepseekV41ForCausalLM']:
        raise ValueError('unsupported family')
    address = '[' + str(HOST) + ']' if HOST.version == 6 else str(HOST)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open('http://' + address + ':' + str(PORT) + '/health', timeout=1) as response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('health bound')
        health = json.loads(raw)
    if health.get('status') != 'ok' or health.get('warming') is not False:
        raise ValueError('not ready')
    if start(p) != initial or read(p / 'cmdline', 65536) != cmd or read(config_path, 262144) != config_raw:
        raise ValueError('process changed')
    current_exe = (p / 'exe').stat()
    if os.readlink(p / 'exe') != exe or (current_exe.st_dev, current_exe.st_ino) != (exe_stat.st_dev, exe_stat.st_ino):
        raise ValueError('executable changed')
    if listeners() != bound or owner(bound) != p:
        raise ValueError('listener changed')
    check()
    print(json.dumps({'capacityTokens': int(window), 'pid': int(p.name), 'startIdentity': initial,
                      'configSha256': hashlib.sha256(config_raw).hexdigest(),
                      'source': 'tensorfold-native-dsv41-process', 'observedAt': int(time.time() * 1000)}))
except Exception:
    print('null')
`;

const shellQuote = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

export function nativeTensorFoldCapacityCommand(port, host) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !net.isIP(host)) return null;
  return `python3 -c ${shellQuote(NATIVE_TENSORFOLD_CAPACITY_PYTHON)} ${port} ${shellQuote(host)}`;
}

/** Validate an observation before it can become a capacity figure. */
export function parseNativeTensorFoldCapacity(raw, now = Date.now()) {
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || data.source !== NATIVE_CAPACITY_SOURCE ||
        !Number.isSafeInteger(data.capacityTokens) || data.capacityTokens <= 0 ||
        !Number.isSafeInteger(data.pid) || data.pid <= 0 ||
        typeof data.startIdentity !== "string" || !/^\d+$/.test(data.startIdentity) ||
        typeof data.configSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.configSha256) ||
        !Number.isSafeInteger(data.observedAt) || data.observedAt > now + 2000 ||
        now - data.observedAt > NATIVE_CAPACITY_MAX_AGE_MS) return null;
    return { capacityTokens: data.capacityTokens, pid: data.pid, startIdentity: data.startIdentity,
      configSha256: data.configSha256, source: data.source, observedAt: data.observedAt };
  } catch {
    return null;
  }
}
