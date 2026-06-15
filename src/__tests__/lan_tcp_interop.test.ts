// @vitest-environment node
/**
 * LAN-TCP transport interop.
 *
 * Proves the desktop raw-TCP fallback ({@link LanTcpTransport}) — the transport
 * that lets a Hyperswarm-incapable peer (the Android nodejs-mobile bridge) form
 * a data channel with the desktop — authenticates and routes framed messages
 * end-to-end. Two transports with distinct Ed25519 keypairs connect over
 * loopback exactly the way a phone and a desktop would on a real LAN: the
 * smaller public key dials the other's advertised tcpPort, both run the
 * Ed25519 challenge-response, and an INFERENCE round-trip crosses the channel.
 *
 * The transport's auth context, DER key wrapping, handshake and framing are
 * byte-identical to the Android bridge (p2p-bridge.js), so module↔module
 * interop here equals phone↔desktop interop on the wire.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import { getPublicKeyAsync, utils as ed25519Utils } from "@noble/ed25519";
import { LanTcpTransport } from "@/main/network/lan-tcp";
import type { PeerChannel } from "@/main/network/peer-channel";
import type { LanPeer } from "@/main/network/lan-discovery";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

interface Identity {
  pubHex: string;
  priv: Uint8Array;
}

async function makeIdentity(): Promise<Identity> {
  const priv = ed25519Utils.randomSecretKey();
  const pub = await getPublicKeyAsync(priv);
  return { pubHex: Buffer.from(pub).toString("hex"), priv };
}

function lanPeerFor(id: Identity, port: number): LanPeer {
  return {
    publicKey: id.pubHex,
    displayName: "peer",
    deviceName: "device",
    address: "127.0.0.1",
    lastSeenAt: Date.now(),
    tcpPort: port,
  };
}

describe("LanTcpTransport interop", () => {
  let transports: LanTcpTransport[] = [];
  const openChannels: PeerChannel[] = [];

  afterEach(async () => {
    for (const ch of openChannels) ch.close();
    openChannels.length = 0;
    await Promise.all(transports.map((t) => t.stop().catch(() => undefined)));
    transports = [];
  });

  it("authenticates over TCP and routes a framed INFERENCE round-trip", async () => {
    // Two identities; the smaller pubkey is the designated dialer.
    let a = await makeIdentity();
    let b = await makeIdentity();
    if (a.pubHex > b.pubHex) [a, b] = [b, a]; // ensure a < b → a dials b

    const channels = new Map<string, PeerChannel>();
    const gotChannel = new Map<string, (ch: PeerChannel) => void>();
    const channelPromise = (who: string) =>
      new Promise<PeerChannel>((res) => gotChannel.set(who, res));

    const aReady = channelPromise("a");
    const bReady = channelPromise("b");

    const tA = new LanTcpTransport({
      publicKeyHex: a.pubHex,
      privateKeyBytes: a.priv,
      onChannel: (ch, remoteKeyHex) => {
        expect(remoteKeyHex).toBe(b.pubHex); // A verified B's key
        channels.set("a", ch);
        openChannels.push(ch);
        gotChannel.get("a")!(ch);
      },
      isConnected: () => false,
    });
    const tB = new LanTcpTransport({
      publicKeyHex: b.pubHex,
      privateKeyBytes: b.priv,
      onChannel: (ch, remoteKeyHex) => {
        expect(remoteKeyHex).toBe(a.pubHex); // B verified A's key
        channels.set("b", ch);
        openChannels.push(ch);
        gotChannel.get("b")!(ch);
      },
      isConnected: () => false,
    });
    transports = [tA, tB];

    await tA.start();
    await tB.start();
    expect(tB.getPort()).toBeGreaterThan(0);

    // A hears B's beacon (with B's tcpPort) and dials, since a.pubHex < b.pubHex.
    tA.onPeerSeen(lanPeerFor(b, tB.getPort()));

    const [chA, chB] = await Promise.all([aReady, bReady]);
    expect(chA.isClosed()).toBe(false);
    expect(chB.isClosed()).toBe(false);

    // Route a framed INFERENCE_REQUEST A→B and an INFERENCE_CHUNK back B→A.
    const requestId = crypto.randomUUID();
    const reqAtB = new Promise<string>((res) => {
      chB.on("message", (m: any) => {
        if (m.type === "INFERENCE_REQUEST") res(m.body);
      });
    });
    const chunkAtA = new Promise<string>((res) => {
      chA.on("message", (m: any) => {
        if (m.type === "INFERENCE_CHUNK") res(m.data);
      });
    });

    chA.send({ type: "INFERENCE_REQUEST", requestId, body: '{"prompt":"hi"}' });
    expect(await reqAtB).toBe('{"prompt":"hi"}');

    chB.send({ type: "INFERENCE_CHUNK", requestId, data: "hello from peer" });
    expect(await chunkAtA).toBe("hello from peer");
  });

  it("rejects a peer that cannot prove key ownership (spoofed identity)", async () => {
    const real = await makeIdentity();
    const attacker = await makeIdentity();
    // The attacker claims `real`'s public key but signs with its own key.
    const claimed = await makeIdentity();

    const victim = new LanTcpTransport({
      publicKeyHex: real.pubHex,
      privateKeyBytes: real.priv,
      onChannel: () => {
        throw new Error("must not adopt a channel from an unverified peer");
      },
      isConnected: () => false,
    });
    transports = [victim];
    await victim.start();

    // Hand-roll a raw client that announces `claimed.pubHex` but proves with the
    // attacker's key — the signature won't verify against the claimed key.
    const net = await import("node:net");
    const sock = net.connect({ host: "127.0.0.1", port: victim.getPort() });

    const ED25519_PKCS8_PREFIX = Buffer.from(
      "302e020100300506032b657004220420",
      "hex",
    );
    const attackerPriv = crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(attacker.priv)]),
      format: "der",
      type: "pkcs8",
    });

    let buf = Buffer.alloc(0);
    const send = (obj: unknown) => {
      const json = Buffer.from(JSON.stringify(obj), "utf-8");
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(json.length, 0);
      sock.write(Buffer.concat([header, json]));
    };

    const closed = new Promise<void>((res) => sock.on("close", () => res()));

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.slice(4, 4 + len).toString("utf-8"));
        buf = buf.slice(4 + len);
        if (msg.type === "LAN_AUTH_HELLO") {
          // Sign with attacker's key but over a proof that claims `real`'s key.
          const data = Buffer.from(
            "orion-lan-auth-v1" + msg.nonce + claimed.pubHex,
            "utf-8",
          );
          const sig = crypto.sign(null, data, attackerPriv).toString("hex");
          send({
            type: "LAN_AUTH_HELLO",
            publicKey: claimed.pubHex,
            nonce: crypto.randomBytes(16).toString("hex"),
          });
          send({ type: "LAN_AUTH_PROOF", signature: sig });
        }
      }
    });
    sock.on("error", () => undefined);

    // The victim must close the socket without ever adopting the channel.
    await expect(
      Promise.race([
        closed,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("not closed")), 5000),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});
