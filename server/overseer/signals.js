import { createHash } from 'node:crypto';

export const SIGNALS = Object.freeze({
  'inspection-gap': 'Bounded response inspection was incomplete',
  upload: 'Upload-capable action',
  'credential-access': 'Credential-path access',
  'metadata-access': 'Cloud metadata destination',
  'unlisted-destination': 'Destination outside the configured allowlist',
  'security-control-change': 'Security-control modification',
  'encoded-execution': 'Encoded command execution',
  'download-execute': 'Download piped to a shell',
});
const kinds = new Set(['execution', 'tool-proposal', 'coverage-gap', 'model-response']);
const metadataHosts = new Set(['169.254.169.254', '100.100.100.200', 'metadata.google.internal', '[fd00:ec2::254]', '[::ffff:a9fe:a9fe]']);

export function hostname(value) {
  try {
    const host = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, '');
    return /^[a-z0-9.:[\]-]{1,253}$/.test(host) ? host : null;
  } catch { return null; }
}

/** Presentation hint only, NOT a public-suffix/security boundary. Match policy on the full hostname. */
export function destinationHint(value) {
  const host = hostname(value);
  if (!host) return null;
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  return host.split('.').slice(-2).join('.');
}

/** Rules inspect bounded raw arguments locally. Never persist that input. */
export function analyzeAction(input, { allowedHosts = [] } = {}) {
  const parts = [];
  let size = 0;
  function text(value, depth = 0) {
    if (depth > 4 || size >= 65536 || parts.length >= 128) return;
    if (typeof value === 'string') {
      const part = value.slice(0, 65536 - size);
      parts.push(part); size += part.length;
      if (/^\s*[{[]/.test(part)) { try { text(JSON.parse(part), depth + 1); } catch { /* ordinary argument text */ } }
    } else if (Array.isArray(value)) value.slice(0, 128).forEach(item => text(item, depth + 1));
    else if (value && typeof value === 'object') { text(JSON.stringify(value), 5); Object.values(value).slice(0, 128).forEach(item => text(item, depth + 1)); }
  }
  if (input && typeof input === 'object') { const encoded = JSON.stringify(input).slice(0, 32768); parts.push(encoded); size += encoded.length; }
  text(input);
  const raw = parts.join('\n').slice(0, 65536);
  const lower = raw.toLowerCase();
  const signals = new Set();
  if (/--(?:data(?:-binary|-raw|-urlencode)?|upload-file|form)(?:[=\s"']|$)|(?:^|[\s"'])-[dfT](?:[\s"']|$)|\b(?:scp|sftp)\b|\b(?:requests|httpx)\.post\s*\(|["']?method["']?\s*[:=]\s*["']post/i.test(raw)) signals.add('upload');
  if (/(?:^|[\/\s"'])\.env(?:[\s"']|$)|\bid_(?:rsa|ed25519)\b|\.aws[\/]credentials|\/proc\/[^\s"']*environ|\.ssh[\/]/i.test(raw)) signals.add('credential-access');
  if (/\b(?:nft\s+flush|ufw\s+disable|iptables\s+-f)\b|\brm\b[^\n]{0,120}\boverseer\b/i.test(raw)) signals.add('security-control-change');
  if (/base64\s+(?:-d|--decode)|(?:b64decode|frombase64string)\s*\(/i.test(raw)) signals.add('encoded-execution');
  if (/\b(?:curl|wget)\b[^\n]{0,1024}\|\s*(?:sh|bash|zsh)\b/i.test(raw)) signals.add('download-execute');
  const allowed = new Set(allowedHosts.map(hostname).filter(Boolean));
  const destinations = new Set();
  for (const match of raw.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
    if (destinations.size >= 16) break;
    const host = hostname(match[0]);
    if (!host) continue;
    destinations.add(destinationHint(host));
    if (metadataHosts.has(host)) signals.add('metadata-access');
    if (!allowed.has(host)) signals.add('unlisted-destination');
  }
  // Non-URL endpoint spellings are useful indicators but not proof of a request.
  if (lower.includes('169.254.169.254') || lower.includes('metadata.google.internal')) signals.add('metadata-access');
  return { signals: [...signals], destinations: [...destinations], fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 24) };
}

export function safeModel(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._/+-]{0,119}$/i.test(value) ? value : 'unspecified';
}

/** Treat producer journals as untrusted. Never copy arbitrary properties or prose. */
export function safeEvent(value, sparkId, now = Date.now()) {
  if (!value || value.version !== 1 || !kinds.has(value.kind) || !/^[a-f0-9-]{16,64}$/i.test(value.id ?? '')) return null;
  if (!Number.isFinite(value.timestamp) || value.timestamp < now - 86400000 || value.timestamp > now + 30000) return null;
  const signals = [...new Set((Array.isArray(value.signals) ? value.signals : []).filter(s => Object.hasOwn(SIGNALS, s)))];
  return {
    id: createHash('sha256').update(`${sparkId}:${value.id}`).digest('hex').slice(0, 24),
    timestamp: value.timestamp,
    sparkId,
    model: safeModel(value.model),
    kind: value.kind,
    stage: value.kind === 'model-response' ? 'response observed' : value.kind === 'coverage-gap' ? 'inspection partial' : value.kind === 'tool-proposal' ? 'proposed, not executed' : value.finished === true ? 'process exited' : 'process started',
    signals,
    severity: signals.some(s => ['metadata-access', 'credential-access', 'security-control-change'].includes(s)) ? 'high' : signals.length ? 'review' : 'recorded',
    destinations: [...new Set((Array.isArray(value.destinations) ? value.destinations : []).slice(0, 16).map(destinationHint).filter(Boolean))],
    fingerprint: /^[a-f0-9]{24}$/.test(value.fingerprint ?? '') ? value.fingerprint : null,
    exitCode: Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 ? value.exitCode : null,
  };
}
