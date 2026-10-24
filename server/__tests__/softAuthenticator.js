/**
 * A hand-written ES256 WebAuthn authenticator for tests. It produces real
 * registration and assertion responses — CBOR attestation, COSE key, ECDSA
 * signatures — so the server's verifier (@simplewebauthn/server) runs unmocked.
 */
import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// ─── Minimal CBOR encoder (the subset attestation needs) ─────────────────

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value) {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

// ─── Authenticator ───────────────────────────────────────

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  /**
   * @param {{ counterStep?: number }} [opts] counterStep 0 behaves like a synced
   *   passkey (counter stays 0); 1 like a hardware key.
   */
  constructor({ counterStep = 1 } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: "jwk" });
    this.credentialId = crypto.randomBytes(16);
    this.counter = 0;
    this.counterStep = counterStep;
  }

  get id() {
    return b64url(this.credentialId);
  }

  coseKey() {
    return cbor(
      new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(this.jwk.x, "base64url")],
        [-3, Buffer.from(this.jwk.y, "base64url")],
      ])
    );
  }

  authData(rpId, flags, withCredential) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [crypto.createHash("sha256").update(rpId).digest(), Buffer.from([flags]), counter];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** A RegistrationResponseJSON for creation options the server issued. */
  register(options, { origin, rpId = options.rp.id } = {}) {
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, origin);
    const authData = this.authData(rpId, FLAG_UP | FLAG_UV | FLAG_AT, true);
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** An AuthenticationResponseJSON for request options the server issued. */
  authenticate(options, { origin, rpId = options.rpId, advance = true } = {}) {
    if (advance) this.counter += this.counterStep;
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const authData = this.authData(rpId, FLAG_UP | FLAG_UV, false);
    const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
    const signature = crypto.sign("sha256", signed, this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(crypto.createHash("sha256").update("sparkdash-operator").digest()),
      },
    };
  }
}
